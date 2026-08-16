import { apiRoute } from '@/lib/domain/api'
import { getNetwork } from '@/lib/services/network.service'

export const GET = apiRoute(async (ctx, _req, params) => {
  const id = (params as { id: string }).id
  return getNetwork(ctx.tenantId, id)
})
