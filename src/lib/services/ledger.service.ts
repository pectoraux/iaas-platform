// =============================================================================
// Ledger service — DOUBLE-ENTRY accounting (task 7).
//
// Rule 5: PaySwap is a settlement provider, not the internal accounting system.
// The ledger is the source of truth for balances. Balances are derived by
// summing entries; there is no mutable balance column.
//
// DOUBLE-ENTRY: every posting creates a LedgerPosting + multiple LedgerEntry
// rows. The sum of amounts in a posting MUST equal zero.
//
// Convention: amount is signed. Positive = credit. Negative = debit.
//   - Assets (cash, settlement_clearing): credit reduces, debit increases
//   - Liabilities (buyer_funds, operator_payable): credit increases, debit reduces
//   - Revenue (platform_revenue): credit increases, debit reduces
//
// Example reward posting ($100 to operator, $5 fee, funded by buyer):
//   buyer_funds       (liability): -105  (debit: reduces buyer's prepaid funds)
//   operator_payable  (liability): +100  (credit: increases what we owe operator)
//   platform_revenue  (revenue):   +5    (credit: increases platform revenue)
//   Sum: -105 + 100 + 5 = 0  ✓
//
// Example settlement (pay operator $100):
//   operator_payable  (liability): -100  (debit: reduces what we owe)
//   cash              (asset):     +100  (credit: reduces our cash)
//   Sum: -100 + 100 = 0  ✓
//
// All mutations are idempotent on (tenantId, idempotencyKey) at the posting level.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { emit, DomainEventTypes } from '@/lib/domain/events'

// ---------------------------------------------------------------------------
// Account helpers
// ---------------------------------------------------------------------------

/** Get-or-create the operator's payable (liability) account. */
export async function ensureOperatorAccount(
  tenantId: string,
  operatorId: string,
  currency = 'USD',
  accountType: string = 'liability',
) {
  const existing = await db.ledgerAccount.findUnique({
    where: {
      tenantId_ownerId_ownerType_accountType_currency: {
        tenantId,
        ownerId: operatorId,
        ownerType: 'operator',
        accountType,
        currency,
      },
    },
  })
  if (existing) return existing
  return db.ledgerAccount.create({
    data: { tenantId, ownerId: operatorId, ownerType: 'operator', accountType, currency },
  })
}

/** Get-or-create a platform account (cash, revenue, etc.). */
export async function ensurePlatformAccount(tenantId: string, currency = 'USD', accountType: string = 'asset') {
  const existing = await db.ledgerAccount.findUnique({
    where: {
      tenantId_ownerId_ownerType_accountType_currency: {
        tenantId,
        ownerId: 'platform',
        ownerType: 'platform',
        accountType,
        currency,
      },
    },
  })
  if (existing) return existing
  return db.ledgerAccount.create({
    data: { tenantId, ownerId: 'platform', ownerType: 'platform', accountType, currency },
  })
}

/** Get-or-create the buyer funds (liability) account for a tenant. */
export async function ensureBuyerFundsAccount(tenantId: string, currency = 'USD') {
  const existing = await db.ledgerAccount.findUnique({
    where: {
      tenantId_ownerId_ownerType_accountType_currency: {
        tenantId,
        ownerId: 'buyer',
        ownerType: 'buyer',
        accountType: 'liability',
        currency,
      },
    },
  })
  if (existing) return existing
  return db.ledgerAccount.create({
    data: { tenantId, ownerId: 'buyer', ownerType: 'buyer', accountType: 'liability', currency },
  })
}

// ---------------------------------------------------------------------------
// Balanced posting (the core of double-entry)
// ---------------------------------------------------------------------------

export interface PostingEntryInput {
  accountId: string
  amount: number // signed: +credit / -debit
  entryType: string
}

export interface PostingResult {
  posting_id: string
  entry_ids: string[]
  balanced: boolean
  duplicate: boolean
}

/**
 * Post a balanced double-entry transaction. All entries are created atomically
 * in a single posting. The sum of amounts MUST equal zero.
 *
 * Idempotent on (tenantId, idempotencyKey) at the posting level.
 */
export async function postBalancedPosting(opts: {
  tenantId: string
  idempotencyKey: string
  postingType: string // reward | settlement | funding | adjustment
  referenceType?: string
  referenceId?: string
  entries: PostingEntryInput[]
}): Promise<PostingResult> {
  // Validate balance.
  const sum = opts.entries.reduce((acc, e) => acc + e.amount, 0)
  if (Math.abs(sum) > 0.001) {
    throw new ValidationError(`Unbalanced posting: sum=${sum}, must be 0. Entries: ${JSON.stringify(opts.entries)}`)
  }

  // Idempotency: check for existing posting.
  const existing = await db.ledgerPosting.findUnique({
    where: { tenantId_idempotencyKey: { tenantId: opts.tenantId, idempotencyKey: opts.idempotencyKey } },
    include: { entries: true },
  })
  if (existing) {
    return {
      posting_id: existing.id,
      entry_ids: existing.entries.map((e) => e.id),
      balanced: true,
      duplicate: true,
    }
  }

  // Create the posting + all entries atomically.
  const posting = await db.$transaction(async (tx) => {
    const post = await tx.ledgerPosting.create({
      data: {
        tenantId: opts.tenantId,
        postingType: opts.postingType,
        referenceType: opts.referenceType ?? null,
        referenceId: opts.referenceId ?? null,
        idempotencyKey: opts.idempotencyKey,
      },
    })
    for (const entry of opts.entries) {
      await tx.ledgerEntry.create({
        data: {
          tenantId: opts.tenantId,
          postingId: post.id,
          accountId: entry.accountId,
          amount: entry.amount,
          currency: 'USD',
          entryType: entry.entryType,
        },
      })
    }
    return post
  })

  const entries = await db.ledgerEntry.findMany({ where: { postingId: posting.id } })

  await appendAudit({
    tenantId: opts.tenantId,
    eventType: AuditEvents.LedgerPosted,
    resourceType: 'ledger_posting',
    resourceId: posting.id,
    metadata: {
      postingType: opts.postingType,
      referenceType: opts.referenceType,
      referenceId: opts.referenceId,
      entryCount: entries.length,
      sum: 0,
    },
  })
  await emit({
    event_type: DomainEventTypes.LedgerEntryPosted,
    aggregate_id: posting.id,
    tenant_id: opts.tenantId,
    version: 1,
    payload: { postingType: opts.postingType, entryCount: entries.length },
  })

  return {
    posting_id: posting.id,
    entry_ids: entries.map((e) => e.id),
    balanced: true,
    duplicate: false,
  }
}

// ---------------------------------------------------------------------------
// Reward posting (the main economic entry point)
// ---------------------------------------------------------------------------

export interface PostLedgerInput {
  rewardId: string
}

export interface LedgerPostingResult {
  posting_id: string
  reward_credit_entry_id: string
  platform_fee_entry_id: string
  buyer_debit_entry_id: string
  operator_balance_after: number
  currency: string
  duplicate: boolean
  // Breakdown for transparency
  breakdown: {
    gross: number
    operator_credit: number
    platform_fee: number
    buyer_debit: number
    balanced: boolean
  }
}

/**
 * Post a reward to the ledger as a BALANCED double-entry posting (task 7).
 *
 *   buyer_funds       (liability): -gross   (debit: reduces buyer's prepaid funds)
 *   operator_payable  (liability): +net     (credit: increases what we owe operator)
 *   platform_revenue  (revenue):   +fee     (credit: increases platform revenue)
 *   Sum = 0 ✓
 *
 * Idempotent on (tenantId, idempotencyKey).
 */
export async function postRewardToLedger(
  tenantId: string,
  input: PostLedgerInput,
  idempotencyKey: string,
  actorId?: string,
): Promise<LedgerPostingResult> {
  void actorId // audit handled in postBalancedPosting

  // Idempotency: check for existing posting.
  const existingPosting = await db.ledgerPosting.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
    include: { entries: true },
  })
  if (existingPosting) {
    const reward = await db.reward.findFirst({
      where: { id: input.rewardId, tenantId },
      include: { contribution: true, rule: true },
    })
    if (!reward) throw new NotFoundError('reward', input.rewardId)
    const operatorAccount = await ensureOperatorAccount(tenantId, reward.operatorId, reward.currency)
    const balance = await computeBalance(tenantId, operatorAccount.id)
    return {
      posting_id: existingPosting.id,
      reward_credit_entry_id: existingPosting.entries.find((e) => e.entryType === 'reward_credit')?.id ?? '',
      platform_fee_entry_id: existingPosting.entries.find((e) => e.entryType === 'platform_fee')?.id ?? '',
      buyer_debit_entry_id: existingPosting.entries.find((e) => e.entryType === 'buyer_debit')?.id ?? '',
      operator_balance_after: balance,
      currency: reward.currency,
      duplicate: true,
      breakdown: {
        gross: 0,
        operator_credit: reward.amount,
        platform_fee: 0,
        buyer_debit: 0,
        balanced: true,
      },
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

  // Recompute the gross + fee from the rule (don't trust stored reward only).
  const rate = parseFloat(reward.rule.rate)
  const grossAmount = reward.contribution.quantity * rate
  const platformFee = grossAmount - reward.amount
  const netAmount = reward.amount

  // Ensure all required accounts exist.
  const payableAccount = await ensureOperatorAccount(tenantId, reward.operatorId, reward.currency, 'liability')
  const revenueAccount = await ensurePlatformAccount(tenantId, reward.currency, 'revenue')
  const buyerFundsAccount = await ensureBuyerFundsAccount(tenantId, reward.currency)

  // Post the balanced transaction.
  const posting = await postBalancedPosting({
    tenantId,
    idempotencyKey,
    postingType: 'reward',
    referenceType: 'reward',
    referenceId: reward.id,
    entries: [
      {
        accountId: buyerFundsAccount.id,
        amount: -grossAmount, // debit: reduces buyer's prepaid funds
        entryType: 'buyer_debit',
      },
      {
        accountId: payableAccount.id,
        amount: netAmount, // credit: increases what we owe operator
        entryType: 'reward_credit',
      },
      {
        accountId: revenueAccount.id,
        amount: platformFee, // credit: increases platform revenue
        entryType: 'platform_fee',
      },
    ],
  })

  // Mark reward as posted.
  await db.reward.update({ where: { id: reward.id }, data: { status: 'posted' } })

  const balance = await computeBalance(tenantId, payableAccount.id)

  return {
    posting_id: posting.posting_id,
    reward_credit_entry_id: posting.entry_ids[1],
    platform_fee_entry_id: posting.entry_ids[2],
    buyer_debit_entry_id: posting.entry_ids[0],
    operator_balance_after: balance,
    currency: reward.currency,
    duplicate: posting.duplicate,
    breakdown: {
      gross: grossAmount,
      operator_credit: netAmount,
      platform_fee: platformFee,
      buyer_debit: grossAmount,
      balanced: true,
    },
  }
}

// ---------------------------------------------------------------------------
// Buyer funding (lets buyers prepay into the system)
// ---------------------------------------------------------------------------

export interface FundingResult {
  posting_id: string
  balance_after: number
  duplicate: boolean
}

/**
 * Record a buyer funding (prepayment). Balanced:
 *   cash (asset):             -amount  (debit: increases cash — we received money)
 *   buyer_funds (liability):  +amount  (credit: increases what we owe the buyer)
 *   Sum = 0 ✓
 */
export async function recordBuyerFunding(
  tenantId: string,
  amount: number,
  idempotencyKey: string,
): Promise<FundingResult> {
  const cashAccount = await ensurePlatformAccount(tenantId, 'USD', 'asset')
  const buyerFundsAccount = await ensureBuyerFundsAccount(tenantId, 'USD')

  const posting = await postBalancedPosting({
    tenantId,
    idempotencyKey,
    postingType: 'funding',
    referenceType: 'funding',
    referenceId: idempotencyKey,
    entries: [
      {
        accountId: cashAccount.id,
        amount: -amount, // debit: increases cash (asset)
        entryType: 'funding_debit',
      },
      {
        accountId: buyerFundsAccount.id,
        amount: amount, // credit: increases buyer funds (liability)
        entryType: 'funding_credit',
      },
    ],
  })

  const balance = await computeBalance(tenantId, buyerFundsAccount.id)
  return { posting_id: posting.posting_id, balance_after: balance, duplicate: posting.duplicate }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

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
    include: { account: true, posting: true },
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

export async function listLedgerPostings(tenantId: string) {
  const postings = await db.ledgerPosting.findMany({
    where: { tenantId },
    include: { entries: { include: { account: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  // Verify balance for each posting (transparency).
  return postings.map((p) => ({
    ...p,
    sum: p.entries.reduce((acc, e) => acc + e.amount, 0),
  }))
}
