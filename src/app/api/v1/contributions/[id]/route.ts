import { apiRoute } from '@/lib/domain/api'
import { getContribution } from '@/lib/services/contribution.service'

export const GET = apiRoute(async (ctx, _req, params) => {
  const id = (params as { id: string }).id
  return getContribution(ctx.tenantId, id)
})
