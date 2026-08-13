import { apiRoute } from '@/lib/domain/api'
import { suspendDevice } from '@/lib/services/registry.service'

export const POST = apiRoute(async (ctx, _req, params) => {
  const id = (params as { id: string }).id
  return suspendDevice(ctx.tenantId, id, ctx.actorId)
})
