import { apiRoute, readJsonBody, getIdempotencyKey } from '@/lib/domain/api'
import { postRewardToLedger } from '@/lib/services/ledger.service'
import { runIdempotent } from '@/lib/domain/idempotency'

export const POST = apiRoute(async (ctx, req) => {
  const body = (await readJsonBody(req)) as { rewardId?: string }
  const rewardId = body.rewardId ?? ''
  const idempotencyKey = getIdempotencyKey(req, `reward-${rewardId}`)

  const result = await runIdempotent({
    tenantId: ctx.tenantId,
    key: idempotencyKey,
    resourceType: 'ledger_post',
    fn: async () => {
      const data = await postRewardToLedger(ctx.tenantId, { rewardId }, idempotencyKey, ctx.actorId)
      return { data, resourceId: data.reward_credit_entry_id }
    },
  })
  return { ...result.data, replayed: result.replayed }
})

export const GET = apiRoute(async (ctx) => {
  const { listLedgerEntries } = await import('@/lib/services/ledger.service')
  return listLedgerEntries(ctx.tenantId)
})
