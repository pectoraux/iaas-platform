import { apiRoute, readJsonBody } from '@/lib/domain/api'
import { instantiateTemplate } from '@/lib/services/network.service'

export const POST = apiRoute(async (ctx, req, params) => {
  const key = (params as { key: string }).key
  const body = (await readJsonBody(req)) as { name?: string; slug?: string }
  return instantiateTemplate(ctx.tenantId, key, { name: body.name, slug: body.slug }, ctx.actorId)
})
