import { apiRoute } from '@/lib/domain/api'
import { db } from '@/lib/db'

export const GET = apiRoute(async (ctx, req) => {
  const url = new URL(req.url)
  const eventType = url.searchParams.get('event_type')
  const resourceType = url.searchParams.get('resource_type')
  const take = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10), 500)
  return db.auditLog.findMany({
    where: {
      tenantId: ctx.tenantId,
      ...(eventType ? { eventType } : {}),
      ...(resourceType ? { resourceType } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take,
  })
})
