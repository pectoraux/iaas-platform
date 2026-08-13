import { apiRoute } from '@/lib/domain/api'
import { getDevice } from '@/lib/services/registry.service'

export const GET = apiRoute(async (ctx, _req, params) => {
  const id = (params as { id: string }).id
  return getDevice(ctx.tenantId, id)
})
