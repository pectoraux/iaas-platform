import { apiRoute, readJsonBody } from '@/lib/domain/api'
import { assignAssetToNetwork } from '@/lib/services/registry.service'

export const POST = apiRoute<{ id: string }>(async (ctx, req, params) => {
  const id = params.id
  const body = (await readJsonBody(req)) as { networkId?: string; capabilityType?: string }
  return assignAssetToNetwork(ctx.tenantId, id, body.networkId ?? '', body.capabilityType ?? 'measured_output', ctx.actorId)
})
