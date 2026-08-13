import { apiRoute, readJsonBody } from '@/lib/domain/api'
import { createCapability, listCapabilities } from '@/lib/services/registry.service'

export const POST = apiRoute(async (ctx, req) => {
  const body = (await readJsonBody(req)) as { networkVersionId?: string; capabilityType?: string; schemaVersion?: number; fields?: Record<string, string>; unit?: string }
  return createCapability(ctx.tenantId, {
    networkVersionId: body.networkVersionId,
    capabilityType: body.capabilityType ?? '',
    schemaVersion: body.schemaVersion,
    fields: body.fields,
    unit: body.unit,
  })
})

export const GET = apiRoute(async (ctx) => listCapabilities(ctx.tenantId))
