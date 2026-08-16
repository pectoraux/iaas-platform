import { apiRoute, readJsonBody, getIdempotencyKey } from '@/lib/domain/api'
import { calculateReward } from '@/lib/services/reward.service'
import { runIdempotent } from '@/lib/domain/idempotency'

export const POST = apiRoute(async (ctx, req) => {
  const body = (await readJsonBody(req)) as { contributionId?: string }
  const contributionId = body.contributionId ?? ''
  const idempotencyKey = getIdempotencyKey(req, `reward-${contributionId}`)

  const result = await runIdempotent({
    tenantId: ctx.tenantId,
    key: idempotencyKey,
    resourceType: 'reward',
    fn: async () => {
      const data = await calculateReward(ctx.tenantId, contributionId, idempotencyKey, ctx.actorId)
      return { data, resourceId: data.id }
    },
  })
  return { ...result.data, replayed: result.replayed }
})

export const GET = apiRoute(async (ctx) => {
  const { listRewards } = await import('@/lib/services/reward.service')
  return listRewards(ctx.tenantId)
})
