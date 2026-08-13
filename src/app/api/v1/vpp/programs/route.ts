import { apiRoute, readJsonBody } from '@/lib/domain/api'
import { createBuyerProgram, listBuyerPrograms } from '@/lib/services/vpp.service'

export const POST = apiRoute(async (ctx, req) => {
  const body = (await readJsonBody(req)) as any
  return createBuyerProgram(ctx.tenantId, body, ctx.actorId)
})

export const GET = apiRoute(async (ctx) => listBuyerPrograms(ctx.tenantId))
