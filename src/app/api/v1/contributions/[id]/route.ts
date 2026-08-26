import { apiRoute } from '@/lib/domain/api'
import { getContribution } from '@/lib/services/contribution.service'

export const GET = apiRoute<{ id: string }>(async (ctx, _req, params) => {
  const id = params.id
  return getContribution(ctx.tenantId, id)
})
