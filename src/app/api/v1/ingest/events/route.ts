import { apiRoute, readJsonBody, getIdempotencyKey } from '@/lib/domain/api'
import { ingestEvent, type IngestEventInput } from '@/lib/services/ingestion.service'
import { runIdempotent } from '@/lib/domain/idempotency'

export const POST = apiRoute(async (ctx, req) => {
  const body = (await readJsonBody(req)) as IngestEventInput
  // Idempotency-Key required for ingestion. Falls back to event_id.
  const idempotencyKey = getIdempotencyKey(req, `ingest-${body.event_id}`)

  const result = await runIdempotent({
    tenantId: ctx.tenantId,
    key: idempotencyKey,
    resourceType: 'ingest',
    fn: async () => {
      const data = await ingestEvent(ctx.tenantId, body, ctx.actorId)
      return { data, resourceId: data.event_id }
    },
  })
  return { ...result.data, replayed: result.replayed }
})
