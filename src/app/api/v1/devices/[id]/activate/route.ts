import { apiRoute } from '@/lib/domain/api'
import { activateDevice } from '@/lib/services/registry.service'

export const POST = apiRoute(async (ctx, _req, params) => {
  const id = (params as { id: string }).id
  return activateDevice(ctx.tenantId, id, ctx.actorId)
})
