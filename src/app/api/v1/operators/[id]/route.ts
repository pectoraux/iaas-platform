import { apiRoute } from '@/lib/domain/api'
import { getOperator } from '@/lib/services/registry.service'

export const GET = apiRoute<{ id: string }>(async (ctx, _req, params) => {
  const id = params.id
  return getOperator(ctx.tenantId, id)
})
