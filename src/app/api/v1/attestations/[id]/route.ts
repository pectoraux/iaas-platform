import { apiRoute } from '@/lib/domain/api'
import { getAttestation } from '@/lib/services/attestation.service'

export const GET = apiRoute<{ id: string }>(async (ctx, _req, params) => {
  const id = params.id
  return getAttestation(ctx.tenantId, id)
})
