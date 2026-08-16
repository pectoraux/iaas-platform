import { apiRoute, readJsonBody, getIdempotencyKey } from '@/lib/domain/api'
import { createDevice, listDevices } from '@/lib/services/registry.service'

export const POST = apiRoute(async (ctx, req) => {
  const body = (await readJsonBody(req)) as { assetId?: string; deviceType?: string; manufacturer?: string; model?: string; metadata?: Record<string, unknown> }
  // Idempotency key optional for device creation (provisioning secrets are one-time).
  const idempotencyKey = req.headers.get('idempotency-key') ?? `device-${Date.now()}-${Math.random().toString(36).slice(2)}`
  void idempotencyKey
  return createDevice(ctx.tenantId, {
    assetId: body.assetId ?? '',
    deviceType: body.deviceType ?? '',
    manufacturer: body.manufacturer,
    model: body.model,
    metadata: body.metadata,
  }, ctx.actorId)
})

export const GET = apiRoute(async (ctx) => listDevices(ctx.tenantId))
