// =============================================================================
// Kernel: Universal Concurrency Primitive
// =============================================================================
// Extracted from the VPP-2D-4 + VPP-3B fencing pattern. This is the platform-
// level concurrency primitive that ALL worker-owned state transitions must use.
//
// The pattern:
//   1. CLAIM: pending → processing (with claimId + leaseExpiresAt)
//   2. EXECUTE: do the work
//   3. COMMIT: processing → final (fenced on claimId)
//   4. On failure: processing → pending (fenced on claimId) + retry event
//   5. On crash: expired lease is reclaimable by another worker
//
// This replaces the ad-hoc lease/fencing implementations that were duplicated
// across portfolio evaluation, event processing, and buyer settlement.
// =============================================================================

import { db } from '@/lib/db'
import type { ExtendedTransactionClient } from '@/lib/db'
import { randomUUID } from 'crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The result of a lease claim attempt.
 */
export interface ClaimResult {
  /** Whether this caller successfully claimed the resource. */
  claimed: boolean
  /** The fencing token for this claim. Must be passed to all subsequent writes. */
  claimId: string | null
  /** The current status of the resource (for logging/diagnostics). */
  currentStatus: string
}

/**
 * The result of a fenced write (commit or revert).
 */
export interface FencedWriteResult {
  /** Whether the write affected 1 row (success) or 0 rows (lost the lease). */
  affected: number
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

const DEFAULT_LEASE_MS = 60000

/**
 * Atomically claim a resource for processing.
 *
 * Transitions: pending → processing (with new claimId + lease)
 * Or: processing(expired) → processing (with new claimId + new lease)
 *
 * @param table    The Prisma model name (e.g., 'vppPortfolioCommitment')
 * @param id       The resource ID
 * @param pendingStatus   The status that means "ready to process" (e.g., 'pending')
 * @param processingStatus  The status that means "being processed" (e.g., 'evaluating', 'charging')
 * @param leaseMs  Lease duration in milliseconds (default 60s)
 * @param tx       Optional transaction client
 */
export async function claimResource(
  table: string,
  id: string,
  pendingStatus: string,
  processingStatus: string,
  leaseMs: number = DEFAULT_LEASE_MS,
  tx?: ExtendedTransactionClient,
): Promise<ClaimResult> {
  const client = tx ?? db
  const claimId = randomUUID()
  const now = new Date()
  const leaseExpiry = new Date(now.getTime() + leaseMs)

  // Try claiming from pending status.
  const claimed = await (client as any)[table].updateMany({
    where: { id, status: pendingStatus },
    data: {
      status: processingStatus,
      claimId,
      claimedAt: now,
      leaseExpiresAt: leaseExpiry,
    },
  })

  if (claimed.count > 0) {
    return { claimed: true, claimId, currentStatus: processingStatus }
  }

  // CAS failed — check if the current resource has an expired lease.
  const current = await (client as any)[table].findUnique({
    where: { id },
    select: { status: true, leaseExpiresAt: true },
  })

  if (!current) {
    return { claimed: false, claimId: null, currentStatus: 'not_found' }
  }

  // If the resource is in processing status with an expired lease, reclaim it.
  if (current.status === processingStatus && current.leaseExpiresAt && current.leaseExpiresAt < now) {
    const reclaimed = await (client as any)[table].updateMany({
      where: {
        id,
        status: processingStatus,
        leaseExpiresAt: { lt: now },
      },
      data: {
        claimId,
        claimedAt: now,
        leaseExpiresAt: leaseExpiry,
      },
    })

    if (reclaimed.count > 0) {
      return { claimed: true, claimId, currentStatus: processingStatus }
    }
  }

  return { claimed: false, claimId: null, currentStatus: current.status }
}

// ---------------------------------------------------------------------------
// Fenced commit
// ---------------------------------------------------------------------------

/**
 * Atomically commit a final state transition, fenced on the claim token.
 *
 * The write only succeeds if the resource is still in `processingStatus`
 * AND the `claimId` matches. If another worker reclaimed the lease,
 * this returns affected=0 (stale worker rejected).
 *
 * @param table           The Prisma model name
 * @param id              The resource ID
 * @param processingStatus  The current status (must match)
 * @param claimId         The fencing token from the claim
 * @param finalStatus     The target final status
 * @param extraData       Additional fields to update
 * @param tx              Optional transaction client
 */
export async function fencedCommit(
  table: string,
  id: string,
  processingStatus: string,
  claimId: string,
  finalStatus: string,
  extraData?: Record<string, unknown>,
  tx?: ExtendedTransactionClient,
): Promise<FencedWriteResult> {
  const client = tx ?? db

  const result = await (client as any)[table].updateMany({
    where: {
      id,
      status: processingStatus,
      claimId, // fencing token
    },
    data: {
      status: finalStatus,
      claimId: null,
      claimedAt: null,
      leaseExpiresAt: null,
      ...extraData,
    },
  })

  return { affected: result.count }
}

// ---------------------------------------------------------------------------
// Fenced revert
// ---------------------------------------------------------------------------

/**
 * Atomically revert to a retryable state, fenced on the claim token.
 *
 * Used when processing fails but no irreversible action occurred.
 * The resource goes back to `retryStatus` (usually 'pending') and a
 * retry event should be emitted.
 *
 * @param table           The Prisma model name
 * @param id              The resource ID
 * @param processingStatus  The current status (must match)
 * @param claimId         The fencing token from the claim
 * @param retryStatus     The target retryable status (usually 'pending')
 * @param failureReason   Optional failure reason to persist
 * @param tx              Optional transaction client
 */
export async function fencedRevert(
  table: string,
  id: string,
  processingStatus: string,
  claimId: string,
  retryStatus: string,
  failureReason?: string,
  tx?: ExtendedTransactionClient,
): Promise<FencedWriteResult> {
  const client = tx ?? db

  const result = await (client as any)[table].updateMany({
    where: {
      id,
      status: processingStatus,
      claimId, // fencing token
    },
    data: {
      status: retryStatus,
      claimId: null,
      claimedAt: null,
      leaseExpiresAt: null,
      ...(failureReason ? { failureReason } : {}),
    },
  })

  return { affected: result.count }
}

// ---------------------------------------------------------------------------
// Fenced transition (generic)
// ---------------------------------------------------------------------------

/**
 * Generic fenced state transition. Use this for any worker-owned write
 * that must be conditioned on the claim token.
 *
 * @param table           The Prisma model name
 * @param id              The resource ID
 * @param expectedStatus  The status that must match (usually processingStatus)
 * @param claimId         The fencing token
 * @param data            The update data (status + any fields)
 * @param tx              Optional transaction client
 */
export async function fencedTransition(
  table: string,
  id: string,
  expectedStatus: string,
  claimId: string,
  data: Record<string, unknown>,
  tx?: ExtendedTransactionClient,
): Promise<FencedWriteResult> {
  const client = tx ?? db

  const result = await (client as any)[table].updateMany({
    where: {
      id,
      status: expectedStatus,
      claimId,
    },
    data,
  })

  return { affected: result.count }
}

// ---------------------------------------------------------------------------
// Lease expiry check
// ---------------------------------------------------------------------------

/**
 * Check if a resource's lease has expired (reclaimable by another worker).
 *
 * @param leaseExpiresAt  The lease expiry timestamp
 * @returns true if the lease has expired (or is null)
 */
export function isLeaseExpired(leaseExpiresAt: Date | null): boolean {
  if (!leaseExpiresAt) return true
  return leaseExpiresAt < new Date()
}
