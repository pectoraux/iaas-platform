import { apiRoute, readJsonBody } from '@/lib/domain/api'
import { createNetwork, listNetworks } from '@/lib/services/network.service'

export const POST = apiRoute(async (ctx, req) => {
  const body = (await readJsonBody(req)) as { name?: string; slug?: string; vertical?: string }
  return createNetwork(ctx.tenantId, { name: body.name ?? '', slug: body.slug ?? '', vertical: body.vertical }, ctx.actorId)
})

export const GET = apiRoute(async (ctx) => listNetworks(ctx.tenantId))
