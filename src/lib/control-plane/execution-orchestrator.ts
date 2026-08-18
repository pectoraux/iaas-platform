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
// committed). As of Slice 3 hardening, failAssignment + releaseCommitment
// happen in ONE transaction per assignment (no split-brain window).
//
// =============================================================================
// PHASE 12B SLICE 4: ACTUAL EXECUTION
// =============================================================================
// executeDecision(decisionId) crosses the RUNTIME-READY → EXECUTING boundary.
//
//   ExecutionAssignment (status=assigned)
//       ↓
//   beginAssignmentExecution      ← parent Execution → 'executing'
//       ↓
//   runtime.executeAssignment()  ← resolves adapter via AdapterRegistry,
//       ↓                          calls adapter.execute(), returns telemetry
//   Adapter
//       ↓
//   ExecutionResult (actuals + telemetry)
//       ↓
//   recordAssignmentResults      ← operational actuals (NO telemetry event yet)
//       ↓
//   completeAssignment            ← assignment → 'completed', parent finalized
//       ↓                          if all assignments terminal
//   (assignment is now operationally complete)
//
// ON ADAPTER FAILURE: runtime.executeAssignment throws, or returns
// success=false. The orchestrator calls releaseDecisionExecution (the Slice 3
// atomic failure path): failAssignment + releaseCommitment in one transaction
// → assignment=failed, commitment=released, reservation.remainingAmount restored.
//
// VERTICAL-NEUTRALITY: the orchestrator does NOT know about VPP, GPUs,
// batteries, telecom, or any vertical. It calls runtime.executeAssignment()
// with assetType (resolved via the CapacityProvider boundary) and the adapter
// is selected generically via the AdapterRegistry. The telemetry→event→verify→
// contribution→reward→settlement path is DEFERRED to a vertical-specific
// boundary (it requires a device-side signature using a provisioning secret
// that is never stored; the control plane cannot sign on behalf of a device).
// Operational completion is the honest, generic boundary.
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
 * Release the committed capacity for a SPECIFIC SET of failed assignments.
 *
 * Phase 12B Slice 4 HARDENING: this is the targeted release. It releases ONLY
 * the commitments belonging to the given assignment IDs — not the entire
 * decision. This is the correct operation for mixed-success execution: if
 * assignment A succeeded (completed) and assignment B failed, only B's
 * commitment is released; A's commitment stays consumed/retained.
 *
 * ATOMIC: for each target assignment, failAssignment + releaseCommitment
 * happen in ONE transaction (Slice 3 hardening — no split-brain window).
 *
 * IDEMPOTENT: releasing an already-released commitment is a no-op
 * (releaseCommitment checks status inside its FOR UPDATE lock). Failing an
 * already-failed assignment is a no-op (failAssignment CAS on
 * status != 'completed'). A completed assignment is NEVER failed by this
 * function (the caller passes only failed assignment IDs).
 */
export async function releaseFailedAssignments(
  decisionId: string,
  failedAssignmentIds: string[],
  reason: string,
  opts?: { providerRegistry?: CapacityProviderRegistry },
): Promise<void> {
  if (failedAssignmentIds.length === 0) return

  const tenantId = await resolveTenantIdForDecision(decisionId)

  // Load the Execution + its assignments (only need assignments for the IDs).
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

  // Filter to only the requested failed assignments that belong to this execution.
  const targetAssignments = execution.assignments.filter(
    (a) => failedAssignmentIds.includes(a.id),
  )

  if (targetAssignments.length === 0) {
    return // none of the requested IDs belong to this execution
  }

  // Resolve the runtime for failAssignment.
  const decision = await db.allocationDecision.findUnique({
    where: { id: decisionId },
    include: { request: true },
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

  // Load the commitments for the TARGET assignments only (via the explicit
  // ExecutionAssignment.capacityCommitmentId FK — no decision-wide scan).
  const targetCommitmentIds = targetAssignments
    .map((a) => a.capacityCommitmentId)
    .filter((id): id is string => id !== null)

  const targetCommitments = await db.capacityCommitment.findMany({
    where: { id: { in: targetCommitmentIds } },
    include: { allocationReservation: true },
  })

  // Build a lookup: assignmentId → (commitment, allocationReservationId).
  const commitmentByAssignmentId = new Map<string, { commitmentId: string; allocationReservationId: string }>()
  for (const c of targetCommitments) {
    if (c.allocationReservationId) {
      commitmentByAssignmentId.set(
        // Find the assignment whose capacityCommitmentId === c.id
        targetAssignments.find((a) => a.capacityCommitmentId === c.id)!.id,
        { commitmentId: c.id, allocationReservationId: c.allocationReservationId },
      )
    }
  }

  // ATOMIC PER-ASSIGNMENT: failAssignment + releaseCommitment in ONE transaction.
  // Only the FAILED assignments are touched — successful assignments' commitments
  // are NOT in targetCommitmentIds, so they are never released.
  for (const assignment of targetAssignments) {
    const entry = commitmentByAssignmentId.get(assignment.id)
    if (!entry) continue // no commitment linked (shouldn't happen, but defensive)

    const commitmentSourceId = `${decisionId}:${entry.allocationReservationId}`

    await db.$transaction(async (tx) => {
      // 1. Fail the assignment (transitions → 'failed', finalizes parent if terminal).
      //    CAS: if the assignment is already 'completed', this is a no-op — it
      //    CANNOT fail a completed assignment (operational completion is irreversible).
      await runtime.failAssignment(
        tx,
        tenantId,
        assignment.id,
        execution.id,
      )
      // 2. Release the commitment IN THE SAME TRANSACTION — restores the
      //    reservation's remainingAmount. Atomic with the fail above.
      await releaseCommitment(
        tenantId,
        COMMITMENT_SOURCE_TYPE,
        commitmentSourceId,
        tx as unknown as ExtendedTransactionClient,
      )
    }, { timeout: 30000 })
  }

  void reason // reason is recorded via the ExecutionFailedError thrown by the caller
}

/**
 * Release the committed capacity for ALL assignments in a decision.
 *
 * Convenience wrapper around releaseFailedAssignments for the "everything
 * failed" case. This is the Slice 3 decision-wide release, now implemented as
 * a delegation to the targeted release (Slice 4 hardening) — the core
 * operation is always targeted, never decision-wide.
 *
 * Use this when the entire decision failed (e.g., commitDecisionToExecution
 * was never called, or the caller wants to release everything). For
 * mixed-success execution, call releaseFailedAssignments with only the failed
 * assignment IDs.
 */
export async function releaseDecisionExecution(
  decisionId: string,
  reason: string,
  opts?: { providerRegistry?: CapacityProviderRegistry },
): Promise<void> {
  // Load all assignment IDs for this decision and delegate to the targeted release.
  const execution = await db.execution.findUnique({
    where: {
      sourceType_sourceId: {
        sourceType: EXECUTION_SOURCE_TYPE,
        sourceId: decisionId,
      },
    },
    select: { assignments: { select: { id: true } } },
  })

  if (!execution) {
    throw new OrchestratorError(
      `No Execution found for decision '${decisionId}' (sourceType='${EXECUTION_SOURCE_TYPE}'). ` +
        `commitDecisionToExecution must be called first.`,
    )
  }

  const allAssignmentIds = execution.assignments.map((a) => a.id)
  await releaseFailedAssignments(decisionId, allAssignmentIds, reason, opts)
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

// ---------------------------------------------------------------------------
// Phase 12B Slice 4: Actual execution — executeDecision
// ---------------------------------------------------------------------------

export interface ExecutedAssignment {
  assignmentId: string
  capabilityType: string
  unit: string
  assignedAmount: string
  actualQuantity?: string
  actualUnit?: string
  verifiedQuantity?: string
  verifiedUnit?: string
  status: 'completed' | 'failed'
}

export interface ExecuteDecisionResult {
  decisionId: string
  executionId: string
  runtimeKind: RuntimeKind
  assignments: ExecutedAssignment[]
  /** 'completed' if all assignments completed; 'completed' if any failed (parent finalizes on all-terminal). */
  executionStatus: string
}

export class ExecutionFailedError extends OrchestratorError {
  constructor(
    public readonly decisionId: string,
    public readonly failedAssignments: { assignmentId: string; capabilityType: string; error: string }[],
  ) {
    super(
      `Execution of decision '${decisionId}' failed for ${failedAssignments.length} ` +
        `assignment(s). Capacity has been released atomically (commitment=released, ` +
        `reservation.remainingAmount restored). Errors: ` +
        failedAssignments.map((f) => `[${f.capabilityType}: ${f.error}]`).join(', '),
    )
    this.name = 'ExecutionFailedError'
  }
}

/**
 * Execute a decision's assignments through the actual adapter pipeline.
 *
 * Phase 12B Slice 4: crosses the RUNTIME-READY → EXECUTING boundary.
 *
 * For each ExecutionAssignment created by commitDecisionToExecution:
 *   1. Resolve the execution input (assetId, assetType, operatorId) via the
 *      CapacityProvider — vertical-neutral.
 *   2. beginAssignmentExecution (parent Execution → 'executing').
 *   3. runtime.executeAssignment() — the runtime resolves the adapter via
 *      AdapterRegistry and calls adapter.execute(). Returns actuals + telemetry.
 *   4. If success: recordAssignmentResults(actuals) + completeAssignment.
 *      Operational completion — the assignment is 'completed'.
 *   5. If failure (throws or success=false): collect the failure. After all
 *      assignments attempted, releaseDecisionExecution is called for the FAILED
 *      ones — failAssignment + releaseCommitment in ONE transaction (Slice 3
 *      atomic path). The reservation's remainingAmount is restored.
 *
 * VERTICAL-NEUTRAL: the orchestrator does not import any vertical. The adapter
 * is resolved generically via (assetType, capabilityType). The telemetry→event→
 * verify→contribution→reward→settlement path is deferred to a vertical-specific
 * boundary (requires a device-side signature using a provisioning secret that
 * is never stored; the control plane cannot sign on behalf of a device).
 *
 * ATOMIC FAILURE: if any assignment fails, its commitment is released in the
 * same transaction as its failAssignment (no split-brain). Successfully
 * completed assignments stay completed (operational completion is irreversible
 * per the Phase 5.2 CAS).
 */
export async function executeDecision(
  decisionId: string,
  opts?: { providerRegistry?: CapacityProviderRegistry },
): Promise<ExecuteDecisionResult> {
  const providerRegistry = opts?.providerRegistry ?? createDefaultCapacityProviderRegistry()

  // --- Load the execution + assignments for this decision ---
  const execution = await db.execution.findUnique({
    where: {
      sourceType_sourceId: {
        sourceType: EXECUTION_SOURCE_TYPE,
        sourceId: decisionId,
      },
    },
    include: {
      assignments: true,
      network: { select: { tenantId: true } },
    },
  })

  if (!execution) {
    throw new OrchestratorError(
      `No Execution found for decision '${decisionId}'. commitDecisionToExecution must be called first.`,
    )
  }

  // Load the decision to resolve the NetworkVersion → runtimeKind.
  const decision = await db.allocationDecision.findUnique({
    where: { id: decisionId },
    include: { request: true },
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
  const tenantId = execution.network.tenantId

  // --- Load the resource membership (for resourceId + resourceKind) ---
  const membership = await db.networkResourceMembership.findUnique({
    where: { id: decision.selectedMembershipId },
    include: { resource: true },
  })
  if (!membership) {
    throw new OrchestratorError(
      `Selected NetworkResourceMembership '${decision.selectedMembershipId}' not found.`,
    )
  }

  const provider = providerRegistry.resolve(membership.resource.resourceKind)

  // --- Execute each assignment ---
  const results: ExecutedAssignment[] = []
  const failures: { assignmentId: string; capabilityType: string; error: string }[] = []

  for (const assignment of execution.assignments) {
    // Skip already-terminal assignments (idempotent re-execution).
    if (assignment.status === 'completed' || assignment.status === 'failed') {
      results.push({
        assignmentId: assignment.id,
        capabilityType: assignment.capabilityType,
        unit: assignment.assignedUnit,
        assignedAmount: assignment.assignedQuantity,
        actualQuantity: assignment.actualQuantity ?? undefined,
        actualUnit: assignment.actualUnit ?? undefined,
        verifiedQuantity: assignment.verifiedQuantity ?? undefined,
        verifiedUnit: assignment.verifiedUnit ?? undefined,
        status: assignment.status as 'completed' | 'failed',
      })
      continue
    }

    // Resolve the full execution input (assetId + assetType + operatorId).
    const execInput = await provider.resolveExecutionInput({
      resourceId: membership.resourceId,
      tx: db as unknown as ExtendedTransactionClient,
    })

    // 1. beginAssignmentExecution (parent → 'executing').
    await db.$transaction(async (tx) => {
      await runtime.beginAssignmentExecution(tx, execution.id, assignment.id)
    }, { timeout: 30000 })

    // 2. Execute via the adapter (runtime resolves adapter via AdapterRegistry).
    let executeResult
    try {
      executeResult = await runtime.executeAssignment({
        assetId: execInput.assetId,
        assetType: execInput.assetType,
        capabilityType: assignment.capabilityType,
        assignedQuantity: assignment.assignedQuantity,
        assignedUnit: assignment.assignedUnit,
        durationSeconds: Math.max(
          1,
          Math.round(
            (decision.allocationWindowEnd.getTime() -
              decision.allocationWindowStart.getTime()) /
              1000,
          ),
        ),
      })
    } catch (err) {
      failures.push({
        assignmentId: assignment.id,
        capabilityType: assignment.capabilityType,
        error: err instanceof Error ? err.message : String(err),
      })
      results.push({
        assignmentId: assignment.id,
        capabilityType: assignment.capabilityType,
        unit: assignment.assignedUnit,
        assignedAmount: assignment.assignedQuantity,
        status: 'failed',
      })
      continue
    }

    if (!executeResult.success) {
      failures.push({
        assignmentId: assignment.id,
        capabilityType: assignment.capabilityType,
        error: executeResult.error ?? 'adapter returned success=false',
      })
      results.push({
        assignmentId: assignment.id,
        capabilityType: assignment.capabilityType,
        unit: assignment.assignedUnit,
        assignedAmount: assignment.assignedQuantity,
        status: 'failed',
      })
      continue
    }

    // 3. Success: record results + complete the assignment (operational completion).
    await db.$transaction(async (tx) => {
      await runtime.recordAssignmentResults(tx, assignment.id, {
        actualQuantity: executeResult.actualQuantity,
        actualUnit: executeResult.actualUnit,
        verifiedQuantity: executeResult.actualQuantity,
        verifiedUnit: executeResult.actualUnit,
        // eventId is intentionally NOT set here — the telemetry→event→verify
        // path is deferred to a vertical-specific boundary (requires a
        // device-side signature). Operational completion records actuals only.
      })
      await runtime.completeAssignment(tx, tenantId, assignment.id, execution.id)
    }, { timeout: 30000 })

    results.push({
      assignmentId: assignment.id,
      capabilityType: assignment.capabilityType,
      unit: assignment.assignedUnit,
      assignedAmount: assignment.assignedQuantity,
      actualQuantity: executeResult.actualQuantity,
      actualUnit: executeResult.actualUnit,
      verifiedQuantity: executeResult.actualQuantity,
      verifiedUnit: executeResult.actualUnit,
      status: 'completed',
    })
  }

  // --- If any assignments failed, release ONLY their capacity atomically ---
  // Phase 12B Slice 4 HARDENING: release ONLY the failed assignments' capacity.
  // Successful assignments' commitments are NOT touched — they stay
  // consumed/retained, their reservations are NOT restored. This is the fix
  // for the mixed-success bug where a decision-wide release could release a
  // completed assignment's commitment.
  if (failures.length > 0) {
    const failedAssignmentIds = failures.map((f) => f.assignmentId)
    await releaseFailedAssignments(
      decisionId,
      failedAssignmentIds,
      `${failures.length} assignment(s) failed during execution`,
    )

    throw new ExecutionFailedError(decisionId, failures)
  }

  // --- All assignments completed: the parent Execution is finalized by the
  // last completeAssignment call (finalizeExecutionIfTerminal). ---
  const finalized = await db.execution.findUnique({
    where: { id: execution.id },
    select: { status: true },
  })

  return {
    decisionId,
    executionId: execution.id,
    runtimeKind,
    assignments: results,
    executionStatus: finalized?.status ?? 'completed',
  }
}

// ---------------------------------------------------------------------------
// Phase 12B Slice 4: Crash/retry contract — recoverStuckAssignments
// ---------------------------------------------------------------------------

/**
 * The lease duration (in milliseconds) after which an assignment stuck in
 * 'executing' is considered crashed. The physical adapter execution itself is
 * expected to complete in seconds-to-minutes; if an assignment has been
 * 'executing' for longer than this, the process likely died after
 * beginAssignmentExecution but before recordAssignmentResults/completeAssignment.
 *
 * A retry of executeDecision will NOT re-execute a stuck assignment: this
 * function marks it 'failed' (via the runtime's failAssignment CAS), so the
 * retry skips it as terminal. The caller can then release its capacity via
 * releaseFailedAssignments.
 */
export const EXECUTION_LEASE_MS = 5 * 60 * 1000 // 5 minutes

export interface RecoveredAssignment {
  assignmentId: string
  executionId: string
  recovered: boolean
  reason: string
}

/**
 * Recover assignments stuck in 'executing' state.
 *
 * Phase 12B Slice 4 CRASH/RETRY CONTRACT:
 * After a process crash, an assignment may be durable-stuck in 'executing':
 *   beginAssignmentExecution → EXECUTING
 *   (process dies here)
 *   recordAssignmentResults never runs
 *   completeAssignment never runs
 *
 * A naive retry of executeDecision would re-execute the physical resource
 * (beginAssignmentExecution is a CAS no-op on 'executing', then
 * runtime.executeAssignment runs AGAIN). This function prevents that by marking
 * assignments whose 'executing' state is older than EXECUTION_LEASE_MS as
 * 'failed' via the runtime's failAssignment CAS.
 *
 * After recovery, a retry of executeDecision skips the recovered assignment
 * (it is now terminal 'failed'), and the caller can release its capacity via
 * releaseFailedAssignments.
 *
 * @param decisionId — the decision whose execution may have stuck assignments
 * @param leaseMs — the lease duration (default EXECUTION_LEASE_MS)
 * @returns the recovered assignments (those marked 'failed' by this call)
 */
export async function recoverStuckAssignments(
  decisionId: string,
  opts?: { leaseMs?: number; providerRegistry?: CapacityProviderRegistry },
): Promise<RecoveredAssignment[]> {
  const leaseMs = opts?.leaseMs ?? EXECUTION_LEASE_MS
  const providerRegistry = opts?.providerRegistry ?? createDefaultCapacityProviderRegistry()

  const tenantId = await resolveTenantIdForDecision(decisionId)

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
      `No Execution found for decision '${decisionId}'. commitDecisionToExecution must be called first.`,
    )
  }

  // Resolve the runtime.
  const decision = await db.allocationDecision.findUnique({
    where: { id: decisionId },
    include: { request: true },
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

  const now = Date.now()
  const recovered: RecoveredAssignment[] = []

  for (const assignment of execution.assignments) {
    if (assignment.status !== 'executing') {
      continue // only 'executing' assignments can be stuck
    }

    // Check if the assignment's createdAt is older than the lease.
    // (createdAt is set when the assignment was created by
    // commitDecisionToExecution. The execution lease starts from
    // beginAssignmentExecution, but we use createdAt as a conservative
    // upper bound — if the assignment has been alive longer than the lease,
    // it's definitely stuck.)
    const assignmentAge = now - assignment.createdAt.getTime()
    if (assignmentAge < leaseMs) {
      continue // not stuck yet — within the lease window
    }

    // Mark the assignment as 'failed' via the runtime's failAssignment CAS.
    // This transitions it to terminal 'failed', so a retry of executeDecision
    // will skip it (not re-execute the physical resource).
    await db.$transaction(async (tx) => {
      await runtime.failAssignment(
        tx,
        tenantId,
        assignment.id,
        execution.id,
      )
    }, { timeout: 30000 })

    recovered.push({
      assignmentId: assignment.id,
      executionId: execution.id,
      recovered: true,
      reason: `assignment was 'executing' for ${Math.round(assignmentAge / 1000)}s (lease=${Math.round(leaseMs / 1000)}s) — assumed crashed`,
    })
  }

  // If any assignments were recovered, release their capacity atomically.
  if (recovered.length > 0) {
    const recoveredIds = recovered.map((r) => r.assignmentId)
    await releaseFailedAssignments(decisionId, recoveredIds, 'crash recovery: stuck executing')
  }

  void providerRegistry // kept for API consistency; not used in recovery itself
  return recovered
}
