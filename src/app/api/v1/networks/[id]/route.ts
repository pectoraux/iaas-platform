import { apiRoute } from '@/lib/domain/api'
import { getNetwork } from '@/lib/services/network.service'

export const GET = apiRoute<{ id: string }>(async (ctx, _req, params) => {
  const id = params.id
  return getNetwork(ctx.tenantId, id)
})
