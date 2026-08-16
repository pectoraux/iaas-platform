import { apiRoute, readJsonBody } from '@/lib/domain/api'
import { createAsset, listAssets } from '@/lib/services/registry.service'

export const POST = apiRoute(async (ctx, req) => {
  const body = (await readJsonBody(req)) as { operatorId?: string; assetType?: string; name?: string; location?: string; metadata?: Record<string, unknown> }
  return createAsset(ctx.tenantId, {
    operatorId: body.operatorId ?? '',
    assetType: body.assetType ?? '',
    name: body.name ?? '',
    location: body.location,
    metadata: body.metadata,
  }, ctx.actorId)
})

export const GET = apiRoute(async (ctx) => listAssets(ctx.tenantId))
