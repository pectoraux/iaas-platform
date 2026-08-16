import { apiRoute, readJsonBody } from '@/lib/domain/api'
import { createNetworkVersion, type VersionConfiguration } from '@/lib/services/network.service'

export const POST = apiRoute(async (ctx, req, params) => {
  const networkId = (params as { id: string }).id
  const body = (await readJsonBody(req)) as VersionConfiguration
  return createNetworkVersion(ctx.tenantId, networkId, body, ctx.actorId)
})
