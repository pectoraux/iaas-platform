import { apiRoute } from '@/lib/domain/api'
import { getAttestation } from '@/lib/services/attestation.service'

export const GET = apiRoute(async (ctx, _req, params) => {
  const id = (params as { id: string }).id
  return getAttestation(ctx.tenantId, id)
})
