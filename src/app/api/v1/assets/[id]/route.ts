import { apiRoute } from '@/lib/domain/api'
import { getAsset } from '@/lib/services/registry.service'

export const GET = apiRoute<{ id: string }>(async (ctx, _req, params) => {
  const id = params.id
  return getAsset(ctx.tenantId, id)
})
