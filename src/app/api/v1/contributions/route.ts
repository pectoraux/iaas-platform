import { apiRoute, readJsonBody, getIdempotencyKey } from '@/lib/domain/api'
import { createContribution, type CreateContributionInput } from '@/lib/services/contribution.service'
import { runIdempotent } from '@/lib/domain/idempotency'

export const POST = apiRoute(async (ctx, req) => {
  const body = (await readJsonBody(req)) as CreateContributionInput
  const idempotencyKey = getIdempotencyKey(req, `contrib-${Date.now()}`)

  const result = await runIdempotent({
    tenantId: ctx.tenantId,
    key: idempotencyKey,
    resourceType: 'contribution',
    fn: async () => {
      const data = await createContribution(ctx.tenantId, body, idempotencyKey, ctx.actorId)
      return { data, resourceId: data.id }
    },
  })
  return { ...result.data, replayed: result.replayed }
})

export const GET = apiRoute(async (ctx) => {
  const { listContributions } = await import('@/lib/services/contribution.service')
  return listContributions(ctx.tenantId)
})
