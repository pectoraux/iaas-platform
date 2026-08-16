import { apiRoute } from '@/lib/domain/api'
import { getReward } from '@/lib/services/reward.service'

export const GET = apiRoute(async (ctx, _req, params) => {
  const id = (params as { id: string }).id
  return getReward(ctx.tenantId, id)
})
