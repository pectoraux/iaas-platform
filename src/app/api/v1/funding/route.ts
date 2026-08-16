import { apiRoute, readJsonBody, getIdempotencyKey } from '@/lib/domain/api'
import { recordBuyerFunding } from '@/lib/services/ledger.service'
import { runIdempotent } from '@/lib/domain/idempotency'

export const POST = apiRoute(async (ctx, req) => {
  const body = (await readJsonBody(req)) as { amount?: number }
  const amount = body.amount ?? 0
  if (amount <= 0) {
    return { error: 'Amount must be positive' }
  }
  const idempotencyKey = getIdempotencyKey(req, `funding-${Date.now()}`)
  const result = await runIdempotent({
    tenantId: ctx.tenantId,
    key: idempotencyKey,
    resourceType: 'funding',
    fn: async () => {
      const data = await recordBuyerFunding(ctx.tenantId, amount, idempotencyKey)
      return { data, resourceId: data.posting_id }
    },
  })
  return { ...result.data, replayed: result.replayed }
})
