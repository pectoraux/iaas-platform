import { apiRoute } from '@/lib/domain/api'
import { listAttestations } from '@/lib/services/attestation.service'

export const GET = apiRoute(async (ctx) => listAttestations(ctx.tenantId))
