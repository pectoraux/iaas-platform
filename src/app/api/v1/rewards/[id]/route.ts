import { apiRoute } from '@/lib/domain/api'
import { getReward } from '@/lib/services/reward.service'

export const GET = apiRoute<{ id: string }>(async (ctx, _req, params) => {
  const id = params.id
  return getReward(ctx.tenantId, id)
})
