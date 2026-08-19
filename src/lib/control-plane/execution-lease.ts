// =============================================================================
// Control Plane: Execution Lease (Phase 12B — Slice 5)
// =============================================================================
// The execution ownership + fencing boundary.
//
// INVARIANTS:
//   E1 — SINGLE ACTIVE OWNER: at most one active lease per ExecutionAssignment
//        (DB-enforced via partial unique index on (executionAssignmentId)
//        WHERE status='active').
//   E2 — VERSIONED OWNERSHIP: a lease carries a leaseVersion. Renewal/transfer
//        is CAS-guarded on (leaseId, leaseVersion). A stale worker (wrong
//        version) is rejected.
//   E3 — AUTHORIZED EXECUTION: runtime.executeAssignment() must only execute
//        when the caller holds the current valid lease. (Enforced in the
//        orchestrator, which passes the leaseId to the runtime.)
//   E4 — RENEWAL: a worker may renew only if leaseId + leaseVersion match AND
//        the lease is still active. Atomic CAS.
//   E5 — COMPLETION: completion requires ownership of the current lease.
//        A stale worker (wrong version) cannot complete.
//   E6 — CANCELLATION / FENCING: an owner must be explicitly cancellable/fencible.
//        Recovery transitions ACTIVE → FENCING → FENCED (if adapter can cancel)
//        or → UNSAFE_TO_RETRY (if it cannot) BEFORE capacity is reusable.
//   E7 — NO UNSAFE REUSE: a new execution owner MUST NOT be allowed to execute
//        merely because an old lease expired. Expiry is evidence recovery is
//        needed, NOT proof that physical execution stopped.
//   E8 — RETRY SAFETY: retry after process failure must create a new lease
//        only after the old attempt is fenced (safe) or marked UNSAFE_TO_RETRY
//        (human intervention required).
//   E9 — VERTICAL NEUTRALITY: the lease boundary is generic. No vertical logic.
//   E10 — DATABASE AUTHORITY: the ownership decision is durable + PostgreSQL-backed.
//
// ADAPTER CANCELLATION CAPABILITY:
//   If the adapter supports cancellation (supportsCancellation=true), the
//   fence() operation calls adapter.cancel() and transitions the lease to
//   'fenced' (safe to retry) if cancellation is confirmed.
//   If the adapter does NOT support cancellation, fence() transitions the
//   lease to 'unsafe_to_retry' — physical execution may still be running;
//   retry is NOT authorized; human/ops intervention is required.
// =============================================================================

import { db } from '@/lib/db'
import type { ExtendedTransactionClient } from '@/lib/db'
import { randomUUID } from 'crypto'
import { resolveRuntime } from '@/lib/kernel/runtime'
import { adapterRegistry } from '@/lib/kernel/runtime'
import type { InfrastructureAdapter, CancelCommand } from '@/lib/kernel/adapters/infrastructure-adapter'
import { validateRuntimeKind, type RuntimeKind } from '@/lib/kernel/runtime'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_LEASE_MS = 5 * 60 * 1000 // 5 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LeaseStatus = 'active' | 'released' | 'fenced' | 'unsafe_to_retry'
export type FenceOutcome = 'fenced' | 'unsafe_to_retry'

export interface ExecutionLeaseRecord {
  id: string
  executionAssignmentId: string
  leaseVersion: number
  workerIdentity: string
  leaseUntil: Date
  status: LeaseStatus
  acquiredAt: Date
  renewedAt: Date | null
  releasedAt: Date | null
  fencedAt: Date | null
  fenceReason: string | null
  fenceOutcome: FenceOutcome | null
}

export interface AcquireLeaseResult {
  /** True if this caller acquired the lease. False if another active lease exists. */
  acquired: boolean
  lease?: ExecutionLeaseRecord
  /** The reason acquisition failed (e.g., 'another active lease', 'assignment completed'). */
  reason?: string
}

export interface RenewLeaseResult {
  renewed: boolean
  lease?: ExecutionLeaseRecord
  reason?: string
}

export interface CompleteLeaseResult {
  completed: boolean
  reason?: string
}

export interface FenceLeaseResult {
  fenced: boolean
  outcome: FenceOutcome
  reason?: string
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LeaseConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LeaseConflictError'
  }
}

export class StaleLeaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleLeaseError'
  }
}

export class UnsafeToRetryError extends Error {
  constructor(
    public readonly leaseId: string,
    public readonly assignmentId: string,
    reason: string,
  ) {
    super(
      `UNSAFE_TO_RETRY: lease '${leaseId}' for assignment '${assignmentId}' ` +
        `cannot be fenced because the adapter does not support cancellation. ` +
        `Physical execution may still be running. Retry is NOT authorized ` +
        `without human/ops intervention. Reason: ${reason}`,
    )
    this.name = 'UnsafeToRetryError'
  }
}

// ---------------------------------------------------------------------------
// E1 — Acquire: claim ownership of an execution attempt
// ---------------------------------------------------------------------------

/**
 * Acquire an execution lease for an assignment.
 *
 * Creates a new ExecutionLease row with status='active'. The partial unique
 * index on (executionAssignmentId) WHERE status='active' ensures that two
 * concurrent acquire calls cannot both succeed — the second will fail with
 * P2002 (unique constraint violation), which this function catches and
 * returns as { acquired: false, reason: 'another active lease' }.
 *
 * The leaseVersion is monotonic per assignment: it is the max existing version
 * + 1. This distinguishes attempts over time.
 *
 * A lease can ONLY be acquired if the assignment is NOT terminal (not
 * 'completed' or 'failed'). A terminal assignment cannot be re-executed.
 *
 * A lease can ONLY be acquired if there is no active lease, OR the existing
 * active lease has expired AND the previous attempt was fenced (safe to
 * retry). If the previous lease is expired but NOT fenced, acquisition is
 * REJECTED with 'unsafe_to_retry' — the previous physical execution may still
 * be running.
 */
export async function acquireExecutionLease(input: {
  executionAssignmentId: string
  workerIdentity: string
  leaseMs?: number
  tx?: ExtendedTransactionClient
}): Promise<AcquireLeaseResult> {
  const client = input.tx ?? db
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
  const leaseId = randomUUID()
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + leaseMs)

  // Lock the assignment row FOR UPDATE to prevent concurrent acquire from
  // reading stale state.
  const locked = await client.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT id, status FROM "ExecutionAssignment"
    WHERE id = ${input.executionAssignmentId}
    FOR UPDATE
  `
  if (locked.length === 0) {
    return { acquired: false, reason: 'assignment not found' }
  }

  const assignmentStatus = locked[0].status

  // A terminal assignment cannot be re-leased. 'fence_required' is terminal
  // — it means the previous lease was unsafe_to_retry and human/ops
  // intervention is required before the assignment can be re-executed.
  if (
    assignmentStatus === 'completed' ||
    assignmentStatus === 'failed' ||
    assignmentStatus === 'fence_required'
  ) {
    return { acquired: false, reason: `assignment is terminal (${assignmentStatus})` }
  }

  // Check for an existing active lease.
  const existingActive = await client.executionLease.findFirst({
    where: { executionAssignmentId: input.executionAssignmentId, status: 'active' },
  })

  if (existingActive) {
    // Is the existing lease expired?
    if (existingActive.leaseUntil < now) {
      // The lease is expired but still 'active' in the DB. Recovery has not
      // yet fenced it. We CANNOT acquire a new lease — the previous physical
      // execution may still be running. The caller must call
      // recoverStuckAssignments first to fence/unsafe_to_retry the old lease.
      return {
        acquired: false,
        reason: `existing lease ${existingActive.id} is expired but not fenced (recovery required)`,
      }
    }
    // The existing lease is still valid — another worker owns it.
    return {
      acquired: false,
      reason: `existing active lease ${existingActive.id} (worker: ${existingActive.workerIdentity})`,
    }
  }

  // No active lease — safe to acquire. Compute the next leaseVersion.
  const maxVersionRow = await client.$queryRaw<Array<{ max: number | null }>>`
    SELECT MAX("leaseVersion") AS max FROM "ExecutionLease"
    WHERE "executionAssignmentId" = ${input.executionAssignmentId}
  `
  const nextVersion = (maxVersionRow[0]?.max ?? 0) + 1

  // Create the lease. The partial unique index will reject a concurrent insert.
  try {
    const lease = await client.executionLease.create({
      data: {
        id: leaseId,
        executionAssignmentId: input.executionAssignmentId,
        leaseVersion: nextVersion,
        workerIdentity: input.workerIdentity,
        leaseUntil,
        status: 'active',
        acquiredAt: now,
      },
    })

    // Transition the assignment to 'executing' (fixes the Slice 4 bug where
    // beginAssignmentExecution only updated the parent Execution, not the
    // assignment).
    await client.executionAssignment.update({
      where: { id: input.executionAssignmentId },
      data: { status: 'executing' },
    })

    return {
      acquired: true,
      lease: dbLeaseToRecord(lease),
    }
  } catch (err: unknown) {
    // P2002 = unique constraint violation on the partial unique index.
    // Another concurrent acquire won the race.
    const code = (err as { code?: string }).code
    if (code === 'P2002') {
      return {
        acquired: false,
        reason: 'another concurrent acquire won the lease race',
      }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// E4 — Renew: extend the lease (heartbeat)
// ---------------------------------------------------------------------------

/**
 * Renew an active execution lease.
 *
 * CAS on (leaseId, leaseVersion, status='active'). A stale worker (wrong
 * leaseVersion, or a lease that has been fenced/released) is rejected.
 *
 * The leaseUntil is extended by leaseMs from now (not from the old expiry).
 */
export async function renewExecutionLease(input: {
  leaseId: string
  leaseVersion: number
  workerIdentity: string
  leaseMs?: number
  tx?: ExtendedTransactionClient
}): Promise<RenewLeaseResult> {
  const client = input.tx ?? db
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
  const now = new Date()
  const newLeaseUntil = new Date(now.getTime() + leaseMs)

  // CAS: only succeeds if leaseId + leaseVersion + status='active' + workerIdentity all match.
  const result = await client.executionLease.updateMany({
    where: {
      id: input.leaseId,
      leaseVersion: input.leaseVersion,
      workerIdentity: input.workerIdentity,
      status: 'active',
    },
    data: {
      leaseUntil: newLeaseUntil,
      renewedAt: now,
    },
  })

  if (result.count === 0) {
    // The lease was either: fenced, released, unsafe_to_retry, or the version
    // doesn't match (stale worker). Either way, the caller no longer owns it.
    return {
      renewed: false,
      reason: 'lease not found, not active, or leaseVersion mismatch (stale worker)',
    }
  }

  const lease = await client.executionLease.findUnique({
    where: { id: input.leaseId },
  })

  return {
    renewed: true,
    lease: lease ? dbLeaseToRecord(lease) : undefined,
  }
}

// ---------------------------------------------------------------------------
// E5 — Complete: the worker finished successfully
// ---------------------------------------------------------------------------

/**
 * Complete an execution lease.
 *
 * Transitions the lease to 'released' and the assignment to 'completed'.
 * CAS on (leaseId, leaseVersion, status='active'). A stale worker (wrong
 * version) is rejected — it cannot complete a newer attempt.
 *
 * The caller must also call runtime.completeAssignment separately to record
 * the actuals + finalize the parent Execution. This function only manages the
 * lease state.
 */
export async function completeExecutionLease(input: {
  leaseId: string
  leaseVersion: number
  workerIdentity: string
  tx?: ExtendedTransactionClient
}): Promise<CompleteLeaseResult> {
  const client = input.tx ?? db
  const now = new Date()

  // Lock the lease row FOR UPDATE + verify ownership.
  const locked = await client.$queryRaw<Array<{ id: string; status: string; leaseVersion: number; workerIdentity: string }>>`
    SELECT id, status, "leaseVersion", "workerIdentity" FROM "ExecutionLease"
    WHERE id = ${input.leaseId}
    FOR UPDATE
  `

  if (locked.length === 0) {
    return { completed: false, reason: 'lease not found' }
  }

  const row = locked[0]

  if (row.status !== 'active') {
    return { completed: false, reason: `lease is '${row.status}' (not active)` }
  }

  if (row.leaseVersion !== input.leaseVersion || row.workerIdentity !== input.workerIdentity) {
    throw new StaleLeaseError(
      `stale worker: leaseVersion ${input.leaseVersion} (expected ${row.leaseVersion}) ` +
        `or workerIdentity mismatch`,
    )
  }

  // Transition the lease to 'released'.
  await client.executionLease.update({
    where: { id: input.leaseId },
    data: {
      status: 'released',
      releasedAt: now,
    },
  })

  return { completed: true }
}

// ---------------------------------------------------------------------------
// E6, E7 — Fence: cancel/fence a lost or failed lease
// ---------------------------------------------------------------------------

/**
 * Fence an execution lease.
 *
 * Called by recovery (recoverStuckAssignments) when a lease is lost (expired
 * or process crash), or by executeDecision when an adapter returns failure.
 *
 * If the adapter supports cancellation (supportsCancellation=true), this calls
 * adapter.cancel() and transitions the lease to 'fenced' if cancellation is
 * confirmed. If the adapter returns confirmed=false, the lease is marked
 * 'unsafe_to_retry' (physical execution may still be running).
 *
 * If the adapter does NOT support cancellation, the lease is marked
 * 'unsafe_to_retry' directly — no cancel() call is made.
 *
 * CRITICAL: fence() does NOT release capacity for 'unsafe_to_retry' outcomes.
 * Capacity is only released after a confirmed fence. An unsafe_to_retry lease
 * requires human/ops intervention before the capacity can be reused.
 */
export async function fenceExecutionLease(input: {
  leaseId: string
  leaseVersion: number
  reason: string
  /** The adapter selection — needed to call cancel(). */
  adapterSelection?: {
    assetId: string
    assetType: string
    capabilityType: string
    adapterType?: string
  }
  tx?: ExtendedTransactionClient
}): Promise<FenceLeaseResult> {
  const client = input.tx ?? db
  const now = new Date()

  // Lock the lease row FOR UPDATE.
  const locked = await client.$queryRaw<Array<{
    id: string
    status: string
    leaseVersion: number
    executionAssignmentId: string
  }>>`
    SELECT id, status, "leaseVersion", "executionAssignmentId" FROM "ExecutionLease"
    WHERE id = ${input.leaseId}
    FOR UPDATE
  `

  if (locked.length === 0) {
    return { fenced: false, outcome: 'unsafe_to_retry', reason: 'lease not found' }
  }

  const row = locked[0]

  // Already terminal — no-op.
  if (row.status === 'released' || row.status === 'fenced' || row.status === 'unsafe_to_retry') {
    return {
      fenced: true,
      outcome: row.status === 'fenced' ? 'fenced' : 'unsafe_to_retry',
      reason: `lease already ${row.status}`,
    }
  }

  // Determine the adapter's cancellation capability.
  let supportsCancellation = false
  let adapter: InfrastructureAdapter | null = null
  if (input.adapterSelection) {
    try {
      const descriptor = adapterRegistry.resolveDescriptor({
        assetType: input.adapterSelection.assetType,
        adapterType: input.adapterSelection.adapterType,
        capabilityType: input.adapterSelection.capabilityType,
      })
      supportsCancellation = descriptor.adapter.supportsCancellation ?? false
      adapter = descriptor.adapter
    } catch {
      // Adapter not found — cannot fence. Mark unsafe_to_retry.
      supportsCancellation = false
    }
  }

  let outcome: FenceOutcome
  if (supportsCancellation && adapter && adapter.cancel) {
    // Call the adapter's cancel() to stop the physical operation.
    try {
      const cancelCommand: CancelCommand = {
        assetId: input.adapterSelection!.assetId,
        capabilityType: input.adapterSelection!.capabilityType,
        leaseId: input.leaseId,
        reason: input.reason,
      }
      const cancelResult = await adapter.cancel(cancelCommand)
      outcome = cancelResult.confirmed ? 'fenced' : 'unsafe_to_retry'
    } catch {
      // cancel() threw — physical execution may still be running.
      outcome = 'unsafe_to_retry'
    }
  } else {
    // Adapter cannot cancel — physical execution may still be running.
    outcome = 'unsafe_to_retry'
  }

  // Transition the lease.
  await client.executionLease.update({
    where: { id: input.leaseId },
    data: {
      status: outcome,
      fencedAt: now,
      fenceReason: input.reason,
      fenceOutcome: outcome,
    },
  })

  // If fenced (safe), transition the assignment to 'failed' so capacity can
  // be released. If unsafe_to_retry, mark the assignment 'fence_required' —
  // capacity is NOT released.
  if (outcome === 'fenced') {
    await client.executionAssignment.update({
      where: { id: row.executionAssignmentId },
      data: { status: 'failed' },
    })
  } else {
    // unsafe_to_retry — mark the assignment as 'fence_required' (a new status
    // that blocks re-execution until human/ops intervention).
    await client.executionAssignment.update({
      where: { id: row.executionAssignmentId },
      data: { status: 'fence_required' },
    })
  }

  return { fenced: true, outcome, reason: input.reason }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dbLeaseToRecord(row: {
  id: string
  executionAssignmentId: string
  leaseVersion: number
  workerIdentity: string
  leaseUntil: Date
  status: string
  acquiredAt: Date
  renewedAt: Date | null
  releasedAt: Date | null
  fencedAt: Date | null
  fenceReason: string | null
  fenceOutcome: string | null
}): ExecutionLeaseRecord {
  return {
    id: row.id,
    executionAssignmentId: row.executionAssignmentId,
    leaseVersion: row.leaseVersion,
    workerIdentity: row.workerIdentity,
    leaseUntil: row.leaseUntil,
    status: row.status as LeaseStatus,
    acquiredAt: row.acquiredAt,
    renewedAt: row.renewedAt,
    releasedAt: row.releasedAt,
    fencedAt: row.fencedAt,
    fenceReason: row.fenceReason,
    fenceOutcome: row.fenceOutcome as FenceOutcome | null,
  }
}

// ---------------------------------------------------------------------------
// Export the lease status constants for the orchestrator + tests
// ---------------------------------------------------------------------------

export const LEASE_STATUS = {
  ACTIVE: 'active',
  RELEASED: 'released',
  FENCED: 'fenced',
  UNSAFE_TO_RETRY: 'unsafe_to_retry',
} as const

export const ASSIGNMENT_STATUS = {
  ASSIGNED: 'assigned',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  FENCE_REQUIRED: 'fence_required',
} as const

// Re-export for the orchestrator's convenience.
export { resolveRuntime, validateRuntimeKind, type RuntimeKind }
