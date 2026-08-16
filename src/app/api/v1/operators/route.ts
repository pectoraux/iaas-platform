import { apiRoute, readJsonBody } from '@/lib/domain/api'
import { createOperator, listOperators } from '@/lib/services/registry.service'

export const POST = apiRoute(async (ctx, req) => {
  const body = (await readJsonBody(req)) as { displayName?: string; organizationName?: string; trustScore?: number }
  return createOperator(ctx.tenantId, { displayName: body.displayName ?? '', organizationName: body.organizationName, trustScore: body.trustScore }, ctx.actorId)
})

export const GET = apiRoute(async (ctx) => listOperators(ctx.tenantId))
