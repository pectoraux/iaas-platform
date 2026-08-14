import { apiRoute } from '@/lib/domain/api'
import { retrySettlement } from '@/lib/services/vpp.service'

export const POST = apiRoute(async (ctx, _req, params) => {
  const id = (params as { id: string }).id
  return retrySettlement(ctx.tenantId, id, ctx.actorId)
})
