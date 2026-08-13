import { apiRoute } from '@/lib/domain/api'
import { listLedgerPostings } from '@/lib/services/ledger.service'

export const GET = apiRoute(async (ctx) => listLedgerPostings(ctx.tenantId))
