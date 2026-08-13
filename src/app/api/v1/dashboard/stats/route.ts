import { apiRoute } from '@/lib/domain/api'
import { getDashboardStats } from '@/lib/services/dashboard.service'

export const GET = apiRoute(async () => getDashboardStats(), { requireTenant: false })
