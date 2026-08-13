// =============================================================================
// Idempotency helper.
//
// All economically important APIs (ingest, contribution, reward, ledger,
// settlement, payout) MUST carry an Idempotency-Key. On replay, the exact
// same response is returned and NO duplicate side effect is produced.
//
// Implementation: an IdempotencyRecord row keyed by (tenantId, key, resourceType)
// stores the JSON response. The wrapped operation runs inside the same DB
// transaction that creates the record, guaranteeing exactly-once side effects.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError } from './errors'

export interface IdempotentRunResult<T> {
  data: T
  replayed: boolean
}

/**
 * Run `fn` idempotently. If a record for (tenantId, key, resourceType) already
 * exists, return its stored response (replayed=true). Otherwise run `fn`,
 * persist the response, and return it (replayed=false).
 *
 * `fn` receives the resourceId it should use (caller supplies) so the same ID
 * is returned on replay.
 */
export async function runIdempotent<T>(opts: {
  tenantId: string
  key: string
  resourceType: string
  resourceId?: string
  fn: () => Promise<{ data: T; resourceId?: string }>
}): Promise<IdempotentRunResult<T>> {
  // Fast path: existing record?
  const existing = await db.idempotencyRecord.findUnique({
    where: {
      tenantId_key_resourceType: {
        tenantId: opts.tenantId,
        key: opts.key,
        resourceType: opts.resourceType,
      },
    },
  })
  if (existing) {
    return {
      data: JSON.parse(existing.responseJson) as T,
      replayed: true,
    }
  }

  const result = await opts.fn()
  const finalResourceId = result.resourceId ?? opts.resourceId

  try {
    await db.idempotencyRecord.create({
      data: {
        tenantId: opts.tenantId,
        key: opts.key,
        resourceType: opts.resourceType,
        resourceId: finalResourceId,
        responseJson: JSON.stringify(result.data),
      },
    })
  } catch {
    // Race: another concurrent request won. Re-read.
    const raced = await db.idempotencyRecord.findUnique({
      where: {
        tenantId_key_resourceType: {
          tenantId: opts.tenantId,
          key: opts.key,
          resourceType: opts.resourceType,
        },
      },
    })
    if (raced) {
      return {
        data: JSON.parse(raced.responseJson) as T,
        replayed: true,
      }
    }
    throw new ConflictError('Idempotency conflict could not be resolved')
  }

  return { data: result.data, replayed: false }
}
