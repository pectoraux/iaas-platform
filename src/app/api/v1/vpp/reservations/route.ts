import { apiRoute, readJsonBody } from '@/lib/domain/api'
import { createCapacityReservation } from '@/lib/services/vpp.service'

export const POST = apiRoute(async (ctx, req) => {
  const body = (await readJsonBody(req)) as any
  return createCapacityReservation(ctx.tenantId, body, ctx.actorId)
})
