import { apiRoute, readJsonBody } from '@/lib/domain/api'
import { createDispatch, listDispatches } from '@/lib/services/vpp.service'

export const POST = apiRoute(async (ctx, req) => {
  const body = (await readJsonBody(req)) as any
  return createDispatch(ctx.tenantId, body, ctx.actorId)
})

export const GET = apiRoute(async (ctx) => listDispatches(ctx.tenantId))
