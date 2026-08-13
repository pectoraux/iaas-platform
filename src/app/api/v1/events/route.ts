import { apiRoute } from '@/lib/domain/api'
import { db } from '@/lib/db'

export const GET = apiRoute(async (ctx, req) => {
  const url = new URL(req.url)
  const status = url.searchParams.get('status')
  const take = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200)
  return db.event.findMany({
    where: { tenantId: ctx.tenantId, ...(status ? { status } : {}) },
    include: { verification: true, attestations: true, device: true, asset: true },
    orderBy: { receivedAt: 'desc' },
    take,
  })
})
