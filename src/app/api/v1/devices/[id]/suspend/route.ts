import { apiRoute } from '@/lib/domain/api'
import { suspendDevice } from '@/lib/services/registry.service'

export const POST = apiRoute<{ id: string }>(async (ctx, _req, params) => {
  const id = params.id
  return suspendDevice(ctx.tenantId, id, ctx.actorId)
})
