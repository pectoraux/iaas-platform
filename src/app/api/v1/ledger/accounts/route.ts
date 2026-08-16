import { apiRoute } from '@/lib/domain/api'
import { listLedgerAccounts } from '@/lib/services/ledger.service'

export const GET = apiRoute(async (ctx) => listLedgerAccounts(ctx.tenantId))
