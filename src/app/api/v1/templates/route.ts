import { apiRoute } from '@/lib/domain/api'
import { NETWORK_TEMPLATES } from '@/lib/domain/templates'

export const GET = apiRoute(async () => ({ templates: NETWORK_TEMPLATES }), { requireTenant: false, requireAuth: false })
