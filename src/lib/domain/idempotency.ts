// =============================================================================
// Idempotency helper — RESERVATION-BASED (task 3).
//
// Closes the check-then-execute race window. The old implementation did:
//   1. SELECT existing → nothing
//   2. EXECUTE operation
//   3. INSERT idempotency record
// Two concurrent requests could both pass step 1 and execute twice.
//
// New flow:
//   1. INSERT idempotency record with status='pending' (unique constraint = lock)
//      - Winner: INSERT succeeds → proceed to execute
//      - Loser: INSERT fails (unique violation) → poll for completion
//   2. Winner executes the operation
//   3. Winner UPDATEs the record to status='completed' with the response
//   4. Loser polls until status='completed', then returns the stored response
//
// If the winner crashes before completing, the record stays 'pending'. A later
// request detects the stale pending record (age > STALE_THRESHOLD_MS) and can
// reclaim it by deleting + re-inserting, or return a conflict.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, DomainError } from './errors'

const STALE_THRESHOLD_MS = 30_000 // 30s — if pending longer, something crashed
const POLL_INTERVAL_MS = 50
const POLL_TIMEOUT_MS = 15_000

export interface IdempotentRunResult<T> {
  data: T
  replayed: boolean
}

/**
 * Run `fn` idempotently using the reservation pattern.
 *
 * 1. Attempt to INSERT a pending idempotency record.
 * 2. If INSERT succeeds → we're the winner → execute fn → record result.
 * 3. If INSERT fails (unique violation) → we're a loser → poll for completion.
 */
export async function runIdempotent<T>(opts: {
  tenantId: string
  key: string
  resourceType: string
  resourceId?: string
  fn: () => Promise<{ data: T; resourceId?: string }>
}): Promise<IdempotentRunResult<T>> {
  const { tenantId, key, resourceType } = opts

  // Step 1: Try to INSERT a pending reservation. The unique constraint on
  // (tenantId, key, resourceType) acts as a distributed lock.
  let isWinner = false
  try {
    await db.idempotencyRecord.create({
      data: {
        tenantId,
        key,
        resourceType,
        status: 'pending',
        responseJson: '',
      },
    })
    isWinner = true
  } catch (err: any) {
    // Prisma unique constraint violation code = P2002
    if (err?.code !== 'P2002') throw err
    // We're the loser — fall through to polling.
  }

  if (isWinner) {
    // Step 2: Execute the operation.
    try {
      const result = await opts.fn()
      const finalResourceId = result.resourceId ?? opts.resourceId

      // Step 3: Record the result.
      await db.idempotencyRecord.update({
        where: {
          tenantId_key_resourceType: { tenantId, key, resourceType },
        },
        data: {
          status: 'completed',
          responseJson: JSON.stringify(result.data),
          resourceId: finalResourceId,
          completedAt: new Date(),
        },
      })
      return { data: result.data, replayed: false }
    } catch (err) {
      // Execution failed — clean up the pending reservation so retries can work.
      await db.idempotencyRecord.delete({
        where: {
          tenantId_key_resourceType: { tenantId, key, resourceType },
        },
      }).catch(() => {})
      throw err
    }
  }

  // Step 4: We're a loser — poll for the winner's result.
  const startTime = Date.now()
  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    const record = await db.idempotencyRecord.findUnique({
      where: {
        tenantId_key_resourceType: { tenantId, key, resourceType },
      },
    })

    if (!record) {
      // Record was deleted (winner failed) — retry the whole operation.
      return runIdempotent(opts)
    }

    if (record.status === 'completed') {
      return {
        data: JSON.parse(record.responseJson) as T,
        replayed: true,
      }
    }

    // Still pending — check for staleness.
    const age = Date.now() - record.createdAt.getTime()
    if (age > STALE_THRESHOLD_MS) {
      // Stale pending — the winner likely crashed. Reclaim by deleting.
      await db.idempotencyRecord.delete({
        where: {
          tenantId_key_resourceType: { tenantId, key, resourceType },
        },
      }).catch(() => {})
      // Retry the whole operation.
      return runIdempotent(opts)
    }

    // Wait and poll again.
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  throw new ConflictError('Idempotency operation timed out waiting for completion')
}
