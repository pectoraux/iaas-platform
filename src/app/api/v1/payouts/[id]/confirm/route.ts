import { apiRoute } from '@/lib/domain/api'
import { completeSettlement } from '@/lib/services/settlement.service'

export const POST = apiRoute(async (ctx, _req, params) => {
  const id = (params as { id: string }).id
  return completeSettlement(ctx.tenantId, id, ctx.actorId)
})
