import { apiRoute } from '@/lib/domain/api'
import { getOperator } from '@/lib/services/registry.service'

export const GET = apiRoute(async (ctx, _req, params) => {
  const id = (params as { id: string }).id
  return getOperator(ctx.tenantId, id)
})
