import { apiRoute } from '@/lib/domain/api'
import { publishNetworkVersion } from '@/lib/services/network.service'

export const POST = apiRoute(async (ctx, _req, params) => {
  const p = params as { id: string; versionId: string }
  return publishNetworkVersion(ctx.tenantId, p.id, p.versionId, ctx.actorId)
})
