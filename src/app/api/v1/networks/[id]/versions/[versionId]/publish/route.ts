import { apiRoute } from '@/lib/domain/api'
import { publishNetworkVersion } from '@/lib/services/network.service'

export const POST = apiRoute<{ id: string; versionId: string }>(async (ctx, _req, params) => {
  const p = params
  return publishNetworkVersion(ctx.tenantId, p.id, p.versionId, ctx.actorId)
})
