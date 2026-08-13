import { apiRoute, readJsonBody, getIdempotencyKey } from '@/lib/domain/api'
import { createSettlement, listSettlements } from '@/lib/services/settlement.service'
import { runIdempotent } from '@/lib/domain/idempotency'

export const POST = apiRoute(async (ctx, req) => {
  const body = (await readJsonBody(req)) as { rewardId?: string }
  const rewardId = body.rewardId ?? ''
  const idempotencyKey = getIdempotencyKey(req, `reward-${rewardId}`)

  const result = await runIdempotent({
    tenantId: ctx.tenantId,
    key: idempotencyKey,
    resourceType: 'payout',
    fn: async () => {
      const data = await createSettlement(ctx.tenantId, rewardId, ctx.actorId)
      return { data, resourceId: data.id }
    },
  })
  return { ...result.data, replayed: result.replayed }
})

export const GET = apiRoute(async (ctx) => listSettlements(ctx.tenantId))
