// =============================================================================
// Ledger service — append-only.
//
// Rule 5: PaySwap is a settlement provider, not the internal accounting system.
// The ledger is the source of truth for balances. Balances are derived by
// summing entries; there is no mutable balance column.
//
// All mutations are idempotent on (tenantId, idempotencyKey).
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { emit, DomainEventTypes } from '@/lib/domain/events'

export interface PostLedgerInput {
  rewardId: string
  // entryType derived automatically; platform_fee + reward_credit posted together.
}

export interface LedgerPostingResult {
  reward_credit_entry_id: string
  platform_fee_entry_id: string
  account_id: string
  balance_after: number
  currency: string
  duplicate: boolean
}

/** Get-or-create the operator's ledger account for a currency. */
export async function ensureOperatorAccount(tenantId: string, operatorId: string, currency = 'USD') {
  const existing = await db.ledgerAccount.findUnique({
    where: { tenantId_ownerId_ownerType_currency: { tenantId, ownerId: operatorId, ownerType: 'operator', currency } },
  })
  if (existing) return existing
  return db.ledgerAccount.create({
    data: { tenantId, ownerId: operatorId, ownerType: 'operator', currency },
  })
}

/** Get-or-create the platform fee account. */
export async function ensurePlatformAccount(tenantId: string, currency = 'USD') {
  const existing = await db.ledgerAccount.findUnique({
    where: { tenantId_ownerId_ownerType_currency: { tenantId, ownerId: 'platform', ownerType: 'platform', currency } },
  })
  if (existing) return existing
  return db.ledgerAccount.create({
    data: { tenantId, ownerId: 'platform', ownerType: 'platform', currency },
  })
}

/**
 * Post a reward to the ledger: credits the operator's account with the net
 * reward amount and debits (records) the platform fee in a separate account.
 *
 * Idempotent on (tenantId, idempotencyKey). Replays return the same entry ids.
 */
export async function postRewardToLedger(
  tenantId: string,
  input: PostLedgerInput,
  idempotencyKey: string,
  actorId?: string,
): Promise<LedgerPostingResult> {
  // Idempotency: a composite key per entry type avoids duplicates.
  const creditKey = `${idempotencyKey}:credit`
  const feeKey = `${idempotencyKey}:fee`

  const existingCredit = await db.ledgerEntry.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: creditKey } },
  })
  if (existingCredit) {
    const existingFee = await db.ledgerEntry.findUnique({
      where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: feeKey } },
    })
    const account = await db.ledgerAccount.findUnique({ where: { id: existingCredit.accountId } })
    const balance = await computeBalance(tenantId, existingCredit.accountId)
    return {
      reward_credit_entry_id: existingCredit.id,
      platform_fee_entry_id: existingFee?.id ?? '',
      account_id: existingCredit.accountId,
      balance_after: balance,
      currency: account?.currency ?? 'USD',
      duplicate: true,
    }
  }

  const reward = await db.reward.findFirst({
    where: { id: input.rewardId, tenantId },
    include: { contribution: true, rule: true },
  })
  if (!reward) throw new NotFoundError('reward', input.rewardId)
  if (reward.status === 'posted' || reward.status === 'settled') {
    throw new ConflictError(`Reward ${reward.id} already posted`)
  }

  const account = await ensureOperatorAccount(tenantId, reward.operatorId, reward.currency)
  const platformAccount = await ensurePlatformAccount(tenantId, reward.currency)

  // Recompute the platform fee from the rule (don't trust stored reward only).
  const rate = parseFloat(reward.rule.rate)
  const grossAmount = reward.contribution.quantity * rate
  const platformFee = grossAmount - reward.amount

  const [creditEntry, feeEntry] = await db.$transaction([
    db.ledgerEntry.create({
      data: {
        tenantId,
        accountId: account.id,
        amount: reward.amount,
        currency: reward.currency,
        entryType: 'reward_credit',
        referenceType: 'reward',
        referenceId: reward.id,
        idempotencyKey: creditKey,
      },
    }),
    db.ledgerEntry.create({
      data: {
        tenantId,
        accountId: platformAccount.id,
        amount: platformFee,
        currency: reward.currency,
        entryType: 'platform_fee',
        referenceType: 'reward',
        referenceId: reward.id,
        idempotencyKey: feeKey,
      },
    }),
    db.reward.update({ where: { id: reward.id }, data: { status: 'posted' } }),
  ])

  const balance = await computeBalance(tenantId, account.id)

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.LedgerPosted,
    resourceType: 'ledger_entry',
    resourceId: creditEntry.id,
    metadata: {
      rewardId: reward.id,
      accountId: account.id,
      amount: reward.amount,
      platformFee,
      currency: reward.currency,
    },
  })
  await emit({
    event_type: DomainEventTypes.LedgerEntryPosted,
    aggregate_id: creditEntry.id,
    tenant_id: tenantId,
    version: 1,
    payload: { rewardId: reward.id, amount: reward.amount, accountId: account.id },
  })

  return {
    reward_credit_entry_id: creditEntry.id,
    platform_fee_entry_id: feeEntry.id,
    account_id: account.id,
    balance_after: balance,
    currency: reward.currency,
    duplicate: false,
  }
}

/** Compute an account balance by summing append-only entries. */
export async function computeBalance(tenantId: string, accountId: string): Promise<number> {
  const account = await db.ledgerAccount.findFirst({ where: { id: accountId, tenantId } })
  if (!account) throw new NotFoundError('ledger_account', accountId)
  const entries = await db.ledgerEntry.findMany({ where: { accountId, tenantId } })
  return entries.reduce((sum, e) => sum + e.amount, 0)
}

export async function listLedgerEntries(tenantId: string) {
  return db.ledgerEntry.findMany({
    where: { tenantId },
    include: { tenant: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
}

export async function listLedgerAccounts(tenantId: string) {
  const accounts = await db.ledgerAccount.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } })
  const withBalances = await Promise.all(
    accounts.map(async (a) => ({
      ...a,
      balance: await computeBalance(tenantId, a.id),
    })),
  )
  return withBalances
}
