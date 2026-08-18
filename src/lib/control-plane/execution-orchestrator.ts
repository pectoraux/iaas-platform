// =============================================================================
// Control Plane: Execution Orchestrator (Phase 12B — Slice 3)
// =============================================================================
// Turns a persisted AllocationDecision into the durable execution lifecycle:
//
//   AllocationDecision
//       ↓ (for each AllocationReservation)
//   CapacityCommitment          ← explicit FK: allocationReservationId
//       ↓
//   Execution                   ← one per decision; sourceId = decisionId (idempotent)
//       ↓ (for each commitment)
//   ExecutionAssignment         ← capacityCommitmentId links to the commitment
//       ↓
//   NetworkRuntime              ← resolved via RuntimeRegistry.resolve(runtimeKind)
//       ↓                         (the control plane NEVER imports InfrastructureRuntime
//                                  / ProtocolRuntime / HybridRuntime directly)
//   (future: adapter execution via runtime.executeAssignment)
//
// ATOMICITY (Gate 7): all three creations (commitment + execution + assignment)
// happen inside ONE db.$transaction. Failure anywhere → ROLLBACK → no
// commitment, no execution, no assignment.
//
// IDEMPOTENCY (Gate 8): deterministic source identities — NO Date.now():
//   - Execution: sourceType='network_request', sourceId=decisionId
//     → @@unique([sourceType, sourceId]) enforces DB-level idempotency.
//   - CapacityCommitment: sourceType='network_request_commitment',
//     sourceId=`${decisionId}:${allocationReservationId}`
//     → @@unique([tenantId, sourceType, sourceId]) enforces DB-level idempotency.
//   - ExecutionAssignment: @@unique([capacityCommitmentId]) enforces
//     "one assignment per commitment" at the DB level.
// On retry, the orchestrator detects the existing Execution and returns the
// existing commitments + assignments (no duplicates).
//
// MULTI-CAPABILITY (Gate 9): a decision can allocate multiple capabilities
// (e.g. GPU + cores). Each AllocationReservation becomes its OWN
// CapacityCommitment + ExecutionAssignment, all sharing the SAME Execution.
// Never assume one allocation = one assignment.
//
// RUNTIME SELECTION (Gates 5, 6): the runtime is resolved via
// RuntimeRegistry.resolve(networkVersion.runtimeKind). The control plane
// does NOT import InfrastructureRuntime / ProtocolRuntime / HybridRuntime
// directly. ProtocolRuntime is rejected up front (it throws on all infra-
// shaped methods; protocol execution is a different model, out of scope for
// Slice 3).
//
// RESOURCE BOUNDARY: the assetId + operatorId needed for
// createExecutionAssignment are resolved via CapacityProvider.
// resolveExecutionBinding() — the orchestrator never reads the Asset table
// directly (that would collapse ResourceIdentity → Asset).
//
// FAILURE RELEASE (Gate 10): releaseDecisionExecution() fails all assignments
// for a decision and releases their commitments (restoring the reservations'
// remainingAmount). This is called when physical execution later fails — it
// is NOT a rollback of the original creation transaction (which already
// committed). It follows the existing VPP/Compute pattern: failAssignment
// inside a tx, then releaseCommitment OUTSIDE the tx (because
// releaseCommitment manages its own transaction).
// =============================================================================

import { db } from '@/lib/db'
import type { ExtendedTransactionClient } from '@/lib/db'
import { resolveRuntime, validateRuntimeKind, type RuntimeKind } from '@/lib/kernel/runtime'
import { createDefaultCapacityProviderRegistry } from './capacity-provider'
import type { CapacityProviderRegistry } from './capacity-provider'
import { createCapacityCommitment, releaseCommitment } from '@/lib/services/capacity.service'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrchestratorError'
  }
}

export class ProtocolRuntimeNotSupportedError extends OrchestratorError {
  constructor(networkVersionId: string) {
    super(
      `Protocol runtime execution is not supported by the control-plane orchestrator (Slice 3). ` +
        `NetworkVersion '${networkVersionId}' has runtimeKind='protocol', which operates via ` +
        `on-chain consensus, not direct asset dispatch. Use a protocol-specific entry point. ` +
        `For infrastructure or hybrid networks, the orchestrator is supported.`,
    )
    this.name = 'ProtocolRuntimeNotSupportedError'
  }
}

// ---------------------------------------------------------------------------
// Source-type constants (deterministic, never Date.now())
// ---------------------------------------------------------------------------

/** Execution.sourceType for control-plane-driven executions. */
export const EXECUTION_SOURCE_TYPE = 'network_request'

/** CapacityCommitment.sourceType for control-plane-driven commitments. */
export const COMMITMENT_SOURCE_TYPE = 'network_request_commitment'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommittedAssignment {
  allocationReservationId: string
  capabilityType: string
  unit: string
  allocatedAmount: string
  commitmentId: string
  assignmentId: string
  reservationId: string
}

export interface CommitDecisionToExecutionResult {
  executionId: string
  decisionId: string
  networkVersionId: string
  runtimeKind: RuntimeKind
  assignments: CommittedAssignment[]
  /** True if this call returned a previously-committed execution (idempotent). */
  replayed: boolean
}

// ---------------------------------------------------------------------------
// The atomic orchestration: AllocationDecision → Commitment → Execution → Assignment
// ---------------------------------------------------------------------------

/**
 * Commit a persisted AllocationDecision to the durable execution lifecycle.
 *
 * Atomic transaction:
 *   1. Load AllocationDecision + its NetworkRequest (→ networkVersionId) +
 *      AllocationReservations.
 *   2. Resolve NetworkVersion → runtimeKind → NetworkRuntime (via the
 *      RuntimeRegistry; the control plane never imports the concrete runtime).
 *   3. Reject protocol runtimeKind (out of scope for Slice 3).
 *   4. Idempotency check: if an Execution already exists with
 *      (sourceType='network_request', sourceId=decisionId), load the existing
 *      commitments + assignments and return them (replayed=true).
 *   5. For each AllocationReservation:
 *        a. Resolve execution binding (assetId + operatorId) via the
 *           CapacityProvider — the orchestrator never reads Asset directly.
 *        b. Create a CapacityCommitment with a deterministic sourceId
 *           (`${decisionId}:${allocationReservationId}`) and the explicit
 *           allocationReservationId FK.
 *   6. Create exactly ONE Execution (sourceId = decisionId, deterministic).
 *   7. For each commitment: create an ExecutionAssignment linked via
 *      capacityCommitmentId.
 *   8. Mark the AllocationDecision 'consumed' + NetworkRequest 'fulfilled'.
 *
 * Gates satisfied: 1, 2, 3, 4, 5, 6, 7, 8, 9, 11.
 */
export async function commitDecisionToExecution(
  decisionId: string,
  opts?: { providerRegistry?: CapacityProviderRegistry },
): Promise<CommitDecisionToExecutionResult> {
  const providerRegistry = opts?.providerRegistry ?? createDefaultCapacityProviderRegistry()

  // --- Load the decision + request + reservations (read, outside the tx) ---
  const decision = await db.allocationDecision.findUnique({
    where: { id: decisionId },
    include: {
      request: true,
      reservations: true,
    },
  })

  if (!decision) {
    throw new OrchestratorError(
      `AllocationDecision '${decisionId}' not found. The decision must be persisted by submitNetworkRequest before committing to execution.`,
    )
  }

  if (decision.status === 'consumed') {
    // Idempotent replay: an execution may already exist. Let the transaction
    // path below detect + return it. (We don't short-circuit here because the
    // execution might not exist yet if a prior commit failed after marking
    // consumed — but the decision status is the source of truth for "has this
    // been handed to execution". We load + return existing if present.)
  }

  const networkVersionId = decision.request.networkVersionId
  const networkId = decision.networkId
  const tenantId = await resolveTenantIdForNetwork(networkId)

  // --- Resolve the NetworkVersion → runtimeKind → NetworkRuntime ---
  const networkVersion = await db.networkVersion.findUnique({
    where: { id: networkVersionId },
  })
  if (!networkVersion) {
    throw new OrchestratorError(
      `NetworkVersion '${networkVersionId}' not found (referenced by NetworkRequest for decision '${decisionId}').`,
    )
  }

  const runtimeKindRaw = networkVersion.runtimeKind ?? 'infrastructure'
  validateRuntimeKind(runtimeKindRaw)
  const runtimeKind = runtimeKindRaw as RuntimeKind

  // Gate 5: runtimeKind selects the runtime. Gate 6: no direct import.
  // ProtocolRuntime throws on all infrastructure-shaped methods — reject up front.
  if (runtimeKind === 'protocol') {
    throw new ProtocolRuntimeNotSupportedError(networkVersionId)
  }

  const runtime = resolveRuntime(runtimeKind)

  if (decision.reservations.length === 0) {
    throw new OrchestratorError(
      `AllocationDecision '${decisionId}' has no AllocationReservations. Nothing to commit to execution.`,
    )
  }

  // --- Atomic transaction: commitments + execution + assignments ---
  const result = await db.$transaction(async (tx) => {
    // --- Idempotency: check for an existing Execution for this decision ---
    const existingExecution = await tx.execution.findUnique({
      where: {
        sourceType_sourceId: {
          sourceType: EXECUTION_SOURCE_TYPE,
          sourceId: decisionId,
        },
      },
      include: {
        assignments: true,
      },
    })

    if (existingExecution) {
      // Replay: load the existing commitments via the AllocationReservations'
      // explicit FK (the architectural improvement — no sourceType/sourceId
      // semantic lookup needed).
      const allocReservations = await tx.allocationReservation.findMany({
        where: { decisionId },
        include: { capacityCommitments: true },
      })

      const assignments: CommittedAssignment[] = []
      for (const ar of allocReservations) {
        const commitment = ar.capacityCommitments[0]
        if (!commitment) continue // shouldn't happen, but defensive
        const ea = existingExecution.assignments.find(
          (a) => a.capacityCommitmentId === commitment.id,
        )
        if (!ea) continue
        assignments.push({
          allocationReservationId: ar.id,
          capabilityType: ar.capabilityType,
          unit: ar.unit,
          allocatedAmount: ar.allocatedAmount,
          commitmentId: commitment.id,
          assignmentId: ea.id,
          reservationId: ar.reservationId,
        })
      }

      return {
        executionId: existingExecution.id,
        decisionId,
        networkVersionId,
        runtimeKind,
        assignments,
        replayed: true,
      }
    }

    // --- Step 5: create a CapacityCommitment per AllocationReservation ---
    const commitments: {
      commitmentId: string
      allocationReservationId: string
      capabilityType: string
      unit: string
      allocatedAmount: string
      reservationId: string
      resourceId: string
      assetId: string
      operatorId: string
    }[] = []

    for (const ar of decision.reservations) {
      // Resolve the NetworkResourceMembership → ResourceIdentity → resourceKind
      // to pick the right CapacityProvider.
      const membership = await tx.networkResourceMembership.findUnique({
        where: { id: decision.selectedMembershipId },
        include: { resource: true },
      })
      if (!membership) {
        throw new OrchestratorError(
          `Selected NetworkResourceMembership '${decision.selectedMembershipId}' not found.`,
        )
      }

      const provider = providerRegistry.resolve(membership.resource.resourceKind)

      // Resolve the execution binding (assetId + operatorId) via the provider.
      const binding = await provider.resolveExecutionBinding({
        resourceId: membership.resourceId,
        tx: tx as unknown as ExtendedTransactionClient,
      })

      // Deterministic sourceId — NO Date.now().
      const commitmentSourceId = `${decisionId}:${ar.id}`

      const commitment = await createCapacityCommitment({
        tenantId,
        reservationId: ar.reservationId,
        committedAmount: ar.allocatedAmount,
        unit: ar.unit,
        startTime: decision.allocationWindowStart,
        endTime: decision.allocationWindowEnd,
        sourceType: COMMITMENT_SOURCE_TYPE,
        sourceId: commitmentSourceId,
        // The capacity service's CreateCommitmentInput doesn't have an
        // allocationReservationId field, so we set the FK via a direct update
        // after creation (or via the create below). For now, createCapacityCommitment
        // creates the row; we patch the FK in the same transaction.
      }, tx as unknown as ExtendedTransactionClient)

      // Patch the explicit FK (allocationReservationId) onto the commitment.
      await tx.capacityCommitment.update({
        where: { id: commitment.commitmentId },
        data: { allocationReservationId: ar.id },
      })

      commitments.push({
        commitmentId: commitment.commitmentId,
        allocationReservationId: ar.id,
        capabilityType: ar.capabilityType,
        unit: ar.unit,
        allocatedAmount: ar.allocatedAmount,
        reservationId: ar.reservationId,
        resourceId: membership.resourceId,
        assetId: binding.assetId,
        operatorId: binding.operatorId,
      })
    }

    // --- Step 6: create exactly ONE Execution (deterministic sourceId) ---
    // The total requested quantity is the sum across capabilities (a rough
    // aggregate; the per-capability detail lives on the assignments). The
    // unit is the unit of the first capability (Execution.requestedUnit is
    // a single string; multi-unit detail is on the assignments + commitments).
    const totalQuantity = decision.reservations
      .reduce((sum, r) => sum + parseFloat(r.allocatedAmount), 0)
      .toString()
    const primaryUnit = decision.reservations[0].unit

    const execution = await runtime.createExecution(tx, {
      tenantId,
      networkId,
      networkVersionId, // Slice 3: bind to the immutable version
      requestedQuantity: totalQuantity,
      requestedUnit: primaryUnit,
      startTime: decision.allocationWindowStart,
      endTime: decision.allocationWindowEnd,
      sourceType: EXECUTION_SOURCE_TYPE,
      sourceId: decisionId, // deterministic → DB-level idempotency
      metadataJson: {
        decisionId,
        decisionSnapshotHash: decision.decisionSnapshotHash,
        schedulerVersion: decision.schedulerVersion,
        evaluatorVersion: decision.evaluatorVersion,
        capabilities: decision.reservations.map((r) => ({
          capabilityType: r.capabilityType,
          unit: r.unit,
          amount: r.allocatedAmount,
        })),
      },
    })

    // --- Step 7: create an ExecutionAssignment per commitment ---
    const assignments: CommittedAssignment[] = []
    for (const c of commitments) {
      const assignment = await runtime.createExecutionAssignment(tx, {
        tenantId,
        executionId: execution.id,
        assetId: c.assetId,
        operatorId: c.operatorId,
        capabilityType: c.capabilityType,
        assignedQuantity: c.allocatedAmount,
        assignedUnit: c.unit,
        capacityCommitmentId: c.commitmentId, // Gate 4: the explicit link
      })

      assignments.push({
        allocationReservationId: c.allocationReservationId,
        capabilityType: c.capabilityType,
        unit: c.unit,
        allocatedAmount: c.allocatedAmount,
        commitmentId: c.commitmentId,
        assignmentId: assignment.id,
        reservationId: c.reservationId,
      })
    }

    // --- Step 8: mark the decision consumed + request fulfilled ---
    await tx.allocationDecision.update({
      where: { id: decisionId },
      data: { status: 'consumed' },
    })
    await tx.networkRequest.update({
      where: { id: decision.requestId },
      data: { status: 'fulfilled' },
    })

    return {
      executionId: execution.id,
      decisionId,
      networkVersionId,
      runtimeKind,
      assignments,
      replayed: false,
    }
  }, { timeout: 30000 })

  return result
}

// ---------------------------------------------------------------------------
// Failure release: ExecutionAssignment failed → release the commitment
// ---------------------------------------------------------------------------

/**
 * Release the committed capacity for a decision whose execution failed.
 *
 * Gate 10: "Execution failure releases committed capacity correctly."
 *
 * This is NOT a rollback of the original commitDecisionToExecution transaction
 * (which already committed). It is the operational failure path: physical
 * execution later failed, so the commitments must be released to restore the
 * reservations' remainingAmount.
 *
 * PHASE 12B SLICE 3 HARDENING — ATOMIC FAILURE RELEASE:
 * For each assignment, failAssignment + releaseCommitment happen in ONE
 * transaction. This eliminates the split-brain window where
 * `assignment=failed` but `commitment=active` could persist if the process
 * crashed between two separate transactions (the old VPP pattern). The
 * durable invariant is: the state is EITHER (assignment=assigned,
 * commitment=active) OR (assignment=failed, commitment=released,
 * reservation.remainingAmount restored) — NEVER the split-brain state.
 *
 * releaseCommitment now accepts an optional `tx` parameter; when provided, it
 * runs its FOR UPDATE + restore + status-update steps on the caller's
 * transaction instead of managing its own.
 *
 * This is idempotent: releasing an already-released commitment is a no-op
 * (releaseCommitment checks status inside its FOR UPDATE lock). Failing an
 * already-failed assignment is a no-op (failAssignment uses a CAS on
 * status != 'completed').
 */
export async function releaseDecisionExecution(
  decisionId: string,
  reason: string,
  opts?: { providerRegistry?: CapacityProviderRegistry },
): Promise<void> {
  const tenantId = await resolveTenantIdForDecision(decisionId)

  // Load the Execution + its assignments.
  const execution = await db.execution.findUnique({
    where: {
      sourceType_sourceId: {
        sourceType: EXECUTION_SOURCE_TYPE,
        sourceId: decisionId,
      },
    },
    include: { assignments: true },
  })

  if (!execution) {
    throw new OrchestratorError(
      `No Execution found for decision '${decisionId}' (sourceType='${EXECUTION_SOURCE_TYPE}'). ` +
        `commitDecisionToExecution must be called first.`,
    )
  }

  // Load the decision to resolve the runtimeKind (for failAssignment).
  const decision = await db.allocationDecision.findUnique({
    where: { id: decisionId },
    include: { request: true, reservations: true },
  })
  if (!decision) {
    throw new OrchestratorError(`AllocationDecision '${decisionId}' not found.`)
  }

  const networkVersion = await db.networkVersion.findUnique({
    where: { id: decision.request.networkVersionId },
  })
  if (!networkVersion) {
    throw new OrchestratorError(
      `NetworkVersion '${decision.request.networkVersionId}' not found.`,
    )
  }

  const runtimeKindRaw = networkVersion.runtimeKind ?? 'infrastructure'
  validateRuntimeKind(runtimeKindRaw)
  const runtimeKind = runtimeKindRaw as RuntimeKind

  if (runtimeKind === 'protocol') {
    throw new ProtocolRuntimeNotSupportedError(networkVersion.id)
  }

  const runtime = resolveRuntime(runtimeKind)

  // Load the commitments (via the explicit FK — no sourceType/sourceId lookup).
  const allocReservations = await db.allocationReservation.findMany({
    where: { decisionId },
    include: { capacityCommitments: true },
  })

  // PHASE 12B SLICE 3 HARDENING: failAssignment + releaseCommitment happen
  // in ONE transaction PER ASSIGNMENT. This eliminates the split-brain window
  // where `assignment=failed` but `commitment=active` could persist if the
  // process crashed between two separate transactions (the old VPP pattern).
  //
  // We cannot put ALL assignments in a single transaction because
  // runtime.failAssignment internally calls finalizeExecutionIfTerminal, which
  // transitions the parent Execution to 'completed' once the last assignment is
  // terminal — and the runtime's CAS logic expects each failAssignment to be
  // its own atomic unit. So: one transaction per assignment, but within that
  // transaction BOTH the fail AND the release happen atomically.
  //
  // The durable invariant: after releaseDecisionExecution returns (or after any
  // individual per-assignment transaction commits), the state is EITHER:
  //   - assignment=assigned, commitment=active (tx hasn't run yet), OR
  //   - assignment=failed, commitment=released, reservation.remainingAmount restored (tx committed)
  // NEVER: assignment=failed + commitment=active (the split-brain state).
  for (const ar of allocReservations) {
    const commitment = ar.capacityCommitments[0]
    if (!commitment) continue

    const assignment = execution.assignments.find(
      (a) => a.capacityCommitmentId === commitment.id,
    )
    if (!assignment) continue

    const commitmentSourceId = `${decisionId}:${ar.id}`

    await db.$transaction(async (tx) => {
      // 1. Fail the assignment (transitions → 'failed', finalizes parent if terminal).
      await runtime.failAssignment(
        tx,
        tenantId,
        assignment.id,
        execution.id,
      )
      // 2. Release the commitment IN THE SAME TRANSACTION — restores the
      //    reservation's remainingAmount. Now atomic with the fail above.
      await releaseCommitment(
        tenantId,
        COMMITMENT_SOURCE_TYPE,
        commitmentSourceId,
        tx as unknown as ExtendedTransactionClient,
      )
    }, { timeout: 30000 })
  }

  // The parent Execution is finalized by the last failAssignment call
  // (finalizeExecutionIfTerminal is called inside failAssignment). No
  // explicit finalize needed here.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveTenantIdForNetwork(networkId: string): Promise<string> {
  const network = await db.networkDefinition.findUnique({
    where: { id: networkId },
    select: { tenantId: true },
  })
  if (!network) {
    throw new OrchestratorError(`Network '${networkId}' not found.`)
  }
  return network.tenantId
}

async function resolveTenantIdForDecision(decisionId: string): Promise<string> {
  const decision = await db.allocationDecision.findUnique({
    where: { id: decisionId },
    select: { networkId: true },
  })
  if (!decision) {
    throw new OrchestratorError(`AllocationDecision '${decisionId}' not found.`)
  }
  return resolveTenantIdForNetwork(decision.networkId)
}
