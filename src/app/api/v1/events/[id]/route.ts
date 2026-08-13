import { apiRoute } from '@/lib/domain/api'
import { db } from '@/lib/db'
import { NotFoundError } from '@/lib/domain/errors'

export const GET = apiRoute(async (ctx, _req, params) => {
  const id = (params as { id: string }).id
  const event = await db.event.findFirst({
    where: { id, tenantId: ctx.tenantId },
    include: { verification: true, attestations: true, device: true, asset: true, networkVersion: true },
  })
  if (!event) throw new NotFoundError('event', id)
  return event
})
