import { apiRoute } from '@/lib/domain/api'
import { completeSettlement } from '@/lib/services/settlement.service'

export const POST = apiRoute<{ id: string }>(async (ctx, _req, params) => {
  const id = params.id
  return completeSettlement(ctx.tenantId, id, ctx.actorId)
})
