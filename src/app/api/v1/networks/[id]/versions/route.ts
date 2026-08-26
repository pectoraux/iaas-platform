import { apiRoute, readJsonBody } from '@/lib/domain/api'
import { createNetworkVersion, type VersionConfiguration } from '@/lib/services/network.service'

export const POST = apiRoute<{ id: string }>(async (ctx, req, params) => {
  const networkId = params.id
  const body = (await readJsonBody(req)) as VersionConfiguration
  return createNetworkVersion(ctx.tenantId, networkId, body, ctx.actorId)
})
