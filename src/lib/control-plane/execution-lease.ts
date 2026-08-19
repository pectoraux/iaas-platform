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

export type LeaseStatus = 'active' | 'fencing' | 'released' | 'fenced' | 'unsafe_to_retry'
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
  /**
   * TEST-ONLY HOOK (Phase 12B Slice 5 proof discipline):
   * Called AFTER the assignment FOR UPDATE lock is acquired but BEFORE the
   * lease INSERT + assignment update. This lets a deterministic test pause
   * the actual acquireExecutionLease function inside its critical section —
   * proving the lock is held across the critical section (not just during
   * the SELECT).
   *
   * Production callers MUST NOT pass this hook. It has no effect on
   * production behavior when omitted.
   */
  afterAssignmentLock?: () => Promise<void>
}): Promise<AcquireLeaseResult> {
  // If a transaction client is provided, use it directly. Otherwise, wrap
  // the ENTIRE critical section in a dedicated transaction so the FOR UPDATE
  // lock on the assignment row is held across:
  //   - state check
  //   - existing-lease check
  //   - leaseVersion calculation
  //   - lease INSERT
  //   - assignment → executing update
  //
  // PHASE 12B SLICE 5 TRANSACTION-SCOPE FIX:
  // Without this wrapper, the FOR UPDATE lock is released when the SELECT
  // statement ends (because `db` runs each statement in autocommit mode).
  // A concurrent fence could slip in between the SELECT and the lease INSERT,
  // creating the forbidden state: A=FENCING + B=ACTIVE.
  //
  // By wrapping the whole critical section in a transaction, the FOR UPDATE
  // lock holds until COMMIT, serializing acquire with fence (which locks the
  // same assignment row in transitionLeaseToFencing).
  if (input.tx) {
    return acquireExecutionLeaseInner(input.tx, input)
  }
  return db.$transaction(async (tx) => {
    return acquireExecutionLeaseInner(tx, input)
  })
}

async function acquireExecutionLeaseInner(
  client: ExtendedTransactionClient,
  input: {
    executionAssignmentId: string
    workerIdentity: string
    leaseMs?: number
    afterAssignmentLock?: () => Promise<void>
  },
): Promise<AcquireLeaseResult> {
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
  const leaseId = randomUUID()
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + leaseMs)

  // Lock the assignment row FOR UPDATE. This lock holds until the transaction
  // commits, preventing a concurrent fence (transitionLeaseToFencing) from
  // running between this check and the lease INSERT below.
  const locked = await client.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT id, status FROM "ExecutionAssignment"
    WHERE id = ${input.executionAssignmentId}
    FOR UPDATE
  `
  if (locked.length === 0) {
    return { acquired: false, reason: 'assignment not found' }
  }

  // TEST-ONLY HOOK: pause inside the actual acquireExecutionLease critical
  // section, AFTER the FOR UPDATE lock is acquired. This lets the E16 test
  // prove that a concurrent transitionLeaseToFencing is BLOCKED while
  // acquire holds the assignment lock across its critical section. If the
  // lock were released after the SELECT (the old bug), the concurrent fence
  // would proceed immediately.
  if (input.afterAssignmentLock) {
    await input.afterAssignmentLock()
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

  // Check for ANY existing non-terminal lease. A lease is "non-terminal" if
  // it represents unresolved ownership:
  //   - 'active' → another worker currently owns it (or it's expired-but-unfenced)
  //   - 'fencing' → fencing is in progress (adapter.cancel() may be running)
  //   - 'unsafe_to_retry' → physical execution may still be running; human
  //     intervention required before the resource can be reused
  //
  // A 'fenced' lease IS terminal — the adapter confirmed cancellation, the
  // assignment is 'failed', and capacity was released. A new lease can be
  // acquired after fencing (the assignment is terminal 'failed', so the
  // terminal-status check above catches it — a 'failed' assignment cannot be
  // re-leased).
  //
  // CRITICAL: this prevents the unsafe interleaving where Worker B acquires
  // a new lease while Worker A's lease is FENCING (adapter.cancel() in
  // progress). Without this check, Worker B could execute the physical
  // resource while Worker A's cancel is still running → double execution.
  //
  // This check is now concurrency-safe because the assignment row is locked
  // FOR UPDATE (held across the whole transaction). A concurrent fence cannot
  // transition a lease to FENCING between this check and the lease INSERT.
  const existingNonTerminal = await client.executionLease.findFirst({
    where: {
      executionAssignmentId: input.executionAssignmentId,
      status: { in: ['active', 'fencing', 'unsafe_to_retry'] },
    },
  })

  if (existingNonTerminal) {
    if (existingNonTerminal.status === 'active' && existingNonTerminal.leaseUntil < now) {
      // The lease is expired but still 'active' in the DB. Recovery has not
      // yet fenced it. We CANNOT acquire a new lease — the previous physical
      // execution may still be running. The caller must call
      // recoverStuckAssignments first to fence/unsafe_to_retry the old lease.
      return {
        acquired: false,
        reason: `existing lease ${existingNonTerminal.id} is expired but not fenced (recovery required)`,
      }
    }
    if (existingNonTerminal.status === 'fencing') {
      // Fencing is in progress — adapter.cancel() may be running. A new
      // lease would enable double physical execution.
      return {
        acquired: false,
        reason: `existing lease ${existingNonTerminal.id} is FENCING (cancellation in progress; cannot acquire until fencing resolves)`,
      }
    }
    if (existingNonTerminal.status === 'unsafe_to_retry') {
      // The previous lease was unsafe_to_retry — physical execution may
      // still be running. Human/ops intervention is required.
      return {
        acquired: false,
        reason: `existing lease ${existingNonTerminal.id} is UNSAFE_TO_RETRY (physical execution may still be running; human/ops intervention required)`,
      }
    }
    // The existing lease is still valid (active + not expired) — another worker owns it.
    return {
      acquired: false,
      reason: `existing active lease ${existingNonTerminal.id} (worker: ${existingNonTerminal.workerIdentity})`,
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
  // PHASE 1: durable transition ACTIVE → FENCING (in a transaction).
  // This records that fencing has started. If the process crashes after
  // this commit but before adapter.cancel(), the lease stays FENCING —
  // not falsely ACTIVE (which would allow another worker to execute)
  // and not falsely FENCED (which would release capacity prematurely).
  const transitionResult = await transitionLeaseToFencing({
    leaseId: input.leaseId,
    leaseVersion: input.leaseVersion,
    reason: input.reason,
  })

  if (!transitionResult.transitioned) {
    // The lease was not active (or version mismatch). Check if it's already
    // terminal and return the existing outcome.
    const existing = await db.executionLease.findUnique({
      where: { id: input.leaseId },
      select: { status: true, fenceOutcome: true },
    })
    if (existing && (existing.status === 'fenced' || existing.status === 'unsafe_to_retry' || existing.status === 'released')) {
      return {
        fenced: true,
        outcome: (existing.fenceOutcome ?? 'unsafe_to_retry') as FenceOutcome,
        reason: `lease already ${existing.status}`,
      }
    }
    return {
      fenced: false,
      outcome: 'unsafe_to_retry',
      reason: transitionResult.reason ?? 'could not transition to FENCING',
    }
  }

  // PHASE 2: adapter.cancel() OUTSIDE the transaction.
  // The cancel() call may be slow (network I/O to the physical resource).
  // It must NOT hold a DB transaction open. If it fails or the process
  // crashes here, the lease remains FENCING — recovery can retry.
  const cancelOutcome = await performAdapterCancel(input)

  // PHASE 3: durable CAS transition FENCING → FENCED/UNSAFE_TO_RETRY.
  // CAS on (leaseId, status='fencing') — if another recovery process
  // already finalized it, this is a no-op.
  const finalizeResult = await finalizeLeaseFence({
    leaseId: input.leaseId,
    outcome: cancelOutcome,
    reason: input.reason,
  })

  return {
    fenced: finalizeResult.finalized,
    outcome: cancelOutcome,
    reason: input.reason,
  }
}

/**
 * PHASE 1 of fencing: durably transition the lease from ACTIVE → FENCING.
 *
 * This is a CAS on (leaseId, leaseVersion, status='active') → status='fencing'.
 * If the lease is not active or the version doesn't match, the transition
 * fails (returns transitioned=false). This prevents a stale worker or a
 * concurrent fence from racing.
 *
 * After this commit, the lease is durably FENCING. A crash here leaves the
 * lease in FENCING — not ACTIVE (which would allow re-execution) and not
 * FENCED (which would release capacity).
 *
 * PHASE 12B SLICE 5 CONCURRENCY FIX:
 * This function locks the ExecutionAssignment row FOR UPDATE before the
 * ACTIVE→FENCING transition. This serializes fencing with acquisition:
 * `acquireExecutionLease` also locks the assignment row FOR UPDATE. Since
 * both operations acquire the same row lock, they cannot run concurrently —
 * a fencing transition blocks a concurrent acquire (and vice versa).
 *
 * Without this lock, the partial unique index on (executionAssignmentId)
 * WHERE status='active' only prevents two ACTIVE leases — it does NOT prevent
 * a FENCING lease + a new ACTIVE lease from coexisting, because FENCING is
 * not ACTIVE. The assignment-row lock closes this gap: while fencing holds
 * the assignment lock, acquire cannot create a new ACTIVE lease.
 */
async function transitionLeaseToFencing(input: {
  leaseId: string
  leaseVersion: number
  reason: string
  tx?: ExtendedTransactionClient
}): Promise<{ transitioned: boolean; reason?: string }> {
  // If a transaction client is provided, use it directly. Otherwise, wrap
  // the lock + CAS in a dedicated transaction so the FOR UPDATE lock on the
  // assignment row is held for the duration of the CAS.
  if (input.tx) {
    return transitionLeaseToFencingInner(input.tx, input)
  }
  return db.$transaction(async (tx) => {
    return transitionLeaseToFencingInner(tx, input)
  })
}

async function transitionLeaseToFencingInner(
  client: ExtendedTransactionClient,
  input: { leaseId: string; leaseVersion: number; reason: string },
): Promise<{ transitioned: boolean; reason?: string }> {
  // 1. Load the lease to find its executionAssignmentId.
  const lease = await client.executionLease.findUnique({
    where: { id: input.leaseId },
    select: { id: true, executionAssignmentId: true, status: true, leaseVersion: true },
  })

  if (!lease) {
    return { transitioned: false, reason: 'lease not found' }
  }

  // 2. Lock the ExecutionAssignment row FOR UPDATE. This is the ownership
  //    serialization boundary — acquireExecutionLease locks the same row.
  //    While we hold this lock, no concurrent acquire can create a new
  //    ACTIVE lease for this assignment.
  await client.$queryRaw`
    SELECT id FROM "ExecutionAssignment"
    WHERE id = ${lease.executionAssignmentId}
    FOR UPDATE
  `

  // 3. Re-check the lease state while holding the assignment lock.
  //    A concurrent fence may have already transitioned it.
  if (lease.status !== 'active') {
    return {
      transitioned: false,
      reason: `lease status is '${lease.status}' (not active)`,
    }
  }

  if (lease.leaseVersion !== input.leaseVersion) {
    return {
      transitioned: false,
      reason: `leaseVersion mismatch: caller has ${input.leaseVersion}, lease has ${lease.leaseVersion}`,
    }
  }

  // 4. CAS: status='active' + leaseVersion match → status='fencing'.
  //    The assignment lock ensures no concurrent acquire created a new ACTIVE
  //    lease between our check and this update.
  const result = await client.executionLease.updateMany({
    where: {
      id: input.leaseId,
      leaseVersion: input.leaseVersion,
      status: 'active',
    },
    data: {
      status: 'fencing',
      fenceReason: input.reason,
    },
  })

  if (result.count === 0) {
    return {
      transitioned: false,
      reason: 'lease not found, not active, or leaseVersion mismatch (stale worker)',
    }
  }
  return { transitioned: true }
}

/**
 * PHASE 2 of fencing: call adapter.cancel() OUTSIDE any transaction.
 *
 * If the adapter supports cancellation, calls adapter.cancel(). Returns
 * 'fenced' if cancellation was confirmed, 'unsafe_to_retry' otherwise.
 * If the adapter does NOT support cancellation, returns 'unsafe_to_retry'
 * directly (no cancel() call).
 *
 * CRASH SAFETY: if the process crashes during this call, the lease remains
 * FENCING (from phase 1). Recovery can retry the cancel.
 */
async function performAdapterCancel(input: {
  leaseId: string
  adapterSelection?: {
    assetId: string
    assetType: string
    capabilityType: string
    adapterType?: string
  }
  reason: string
}): Promise<FenceOutcome> {
  if (!input.adapterSelection) {
    return 'unsafe_to_retry'
  }

  let adapter: InfrastructureAdapter | null = null
  let supportsCancellation = false

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
    return 'unsafe_to_retry'
  }

  if (supportsCancellation && adapter && adapter.cancel) {
    try {
      const cancelCommand: CancelCommand = {
        assetId: input.adapterSelection.assetId,
        capabilityType: input.adapterSelection.capabilityType,
        leaseId: input.leaseId,
        reason: input.reason,
      }
      const cancelResult = await adapter.cancel(cancelCommand)
      return cancelResult.confirmed ? 'fenced' : 'unsafe_to_retry'
    } catch {
      // cancel() threw — physical execution may still be running.
      return 'unsafe_to_retry'
    }
  }

  // Adapter cannot cancel — physical execution may still be running.
  return 'unsafe_to_retry'
}

/**
 * PHASE 3 of fencing: durably CAS transition FENCING → FENCED/UNSAFE_TO_RETRY.
 *
 * CAS on (leaseId, status='fencing') → status=outcome. If another recovery
 * process already finalized it (status is no longer 'fencing'), this is a
 * no-op (idempotent).
 *
 * If outcome='fenced', transitions the assignment to 'failed' (capacity
 * releasable). If 'unsafe_to_retry', transitions the assignment to
 * 'fence_required' (capacity NOT released).
 *
 * CRASH SAFETY: if the process crashes after phase 2 (cancel confirmed) but
 * before this commit, the lease remains FENCING. Recovery can retry phase 3
 * — the assignment is NOT yet marked 'failed'/'fence_required', and capacity
 * is NOT released. This is the safe state.
 */
async function finalizeLeaseFence(input: {
  leaseId: string
  outcome: FenceOutcome
  reason: string
  tx?: ExtendedTransactionClient
}): Promise<{ finalized: boolean }> {
  const client = input.tx ?? db
  const now = new Date()

  // CAS: status='fencing' → status=outcome. Idempotent if already finalized.
  const result = await client.executionLease.updateMany({
    where: {
      id: input.leaseId,
      status: 'fencing',
    },
    data: {
      status: input.outcome,
      fencedAt: now,
      fenceReason: input.reason,
      fenceOutcome: input.outcome,
    },
  })

  if (result.count === 0) {
    // Already finalized by another caller — idempotent.
    return { finalized: true }
  }

  // Transition the assignment based on the outcome.
  const lease = await client.executionLease.findUnique({
    where: { id: input.leaseId },
    select: { executionAssignmentId: true },
  })

  if (lease) {
    if (input.outcome === 'fenced') {
      // Safe — capacity can be released.
      await client.executionAssignment.update({
        where: { id: lease.executionAssignmentId },
        data: { status: 'failed' },
      })
    } else {
      // unsafe_to_retry — capacity NOT released. Human/ops intervention.
      await client.executionAssignment.update({
        where: { id: lease.executionAssignmentId },
        data: { status: 'fence_required' },
      })
    }
  }

  return { finalized: true }
}

/**
 * Validate that a lease is active + owned by the caller, for runtime execution.
 *
 * Phase 12B Slice 5 hardening: the runtime's executeAssignment() calls this
 * BEFORE invoking the adapter. A stale worker (wrong leaseVersion) or a
 * non-active lease (fencing/fenced/unsafe_to_retry/released) is rejected.
 *
 * This makes the lease validation part of the NetworkRuntime execution
 * boundary — a direct call to runtime.executeAssignment() without a valid
 * lease is rejected, even when bypassing executeDecision.
 *
 * @returns { valid: true } if the lease is active + version matches.
 * @returns { valid: false, reason } otherwise.
 */
export async function validateLeaseForExecution(input: {
  leaseId: string
  leaseVersion: number
  workerIdentity: string
  tx?: ExtendedTransactionClient
}): Promise<{ valid: boolean; reason?: string }> {
  const client = input.tx ?? db

  // Lock the lease row FOR UPDATE + verify ownership + active status.
  const locked = await client.$queryRaw<Array<{
    id: string
    status: string
    leaseVersion: number
    workerIdentity: string
    leaseUntil: Date
  }>>`
    SELECT id, status, "leaseVersion", "workerIdentity", "leaseUntil"
    FROM "ExecutionLease"
    WHERE id = ${input.leaseId}
    FOR UPDATE
  `

  if (locked.length === 0) {
    return { valid: false, reason: 'lease not found' }
  }

  const row = locked[0]

  if (row.status !== 'active') {
    return { valid: false, reason: `lease status is '${row.status}' (not active)` }
  }

  if (row.leaseVersion !== input.leaseVersion) {
    return { valid: false, reason: `leaseVersion mismatch: caller has ${input.leaseVersion}, lease has ${row.leaseVersion} (stale worker)` }
  }

  if (row.workerIdentity !== input.workerIdentity) {
    return { valid: false, reason: `workerIdentity mismatch: caller is '${input.workerIdentity}', lease is owned by '${row.workerIdentity}'` }
  }

  // Check lease expiry. An expired lease is NOT valid for execution —
  // recovery must fence it first.
  if (row.leaseUntil < new Date()) {
    return { valid: false, reason: `lease expired (leaseUntil=${row.leaseUntil.toISOString()})` }
  }

  return { valid: true }
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
  FENCING: 'fencing',
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
