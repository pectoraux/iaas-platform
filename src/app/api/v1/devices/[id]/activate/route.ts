import { apiRoute } from '@/lib/domain/api'
import { activateDevice } from '@/lib/services/registry.service'

export const POST = apiRoute<{ id: string }>(async (ctx, _req, params) => {
  const id = params.id
  return activateDevice(ctx.tenantId, id, ctx.actorId)
})
