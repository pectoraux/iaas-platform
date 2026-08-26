import { apiRoute } from '@/lib/domain/api'
import { retrySettlement } from '@/lib/services/vpp.service'

export const POST = apiRoute<{ id: string }>(async (ctx, _req, params) => {
  const id = params.id
  return retrySettlement(ctx.tenantId, id, ctx.actorId)
})
