import { NextRequest } from 'next/server'
import { apiRoute, readJsonBody } from '@/lib/domain/api'
import { createTenant, listTenants } from '@/lib/services/tenant.service'

export const POST = apiRoute(async (ctx, req) => {
  const body = (await readJsonBody(req)) as { name?: string; slug?: string; plan?: string }
  return createTenant({ name: body.name ?? '', slug: body.slug ?? '', plan: body.plan }, ctx.actorId)
})

export const GET = apiRoute(async () => listTenants())
