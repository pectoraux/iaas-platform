// =============================================================================
// Ledger service — DOUBLE-ENTRY accounting with DECIMAL arithmetic (tasks 3, 7).
//
// Task 3: all monetary amounts use Prisma.Decimal (PostgreSQL numeric), NOT
// Float. Balance checks use exact decimal comparison, not floating-point
// epsilon. This is safe for micropayments, stablecoins, and high-volume
// billing.
//
// Task 5: enforces sufficient buyer funding before reward posting. If the
// buyer_funds account balance is less than the gross reward amount, the
// posting is rejected. This prevents liabilities from exceeding funded amounts.
//
// Task 7: every posting creates a LedgerPosting + multiple LedgerEntry rows.
// The sum of amounts MUST equal zero (exact decimal comparison).
//
// Convention: amount is signed. Positive = credit. Negative = debit.
// =============================================================================

import { db, type ExtendedTransactionClient } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { emit, DomainEventTypes } from '@/lib/domain/events'

// ---------------------------------------------------------------------------
// Account helpers
// ---------------------------------------------------------------------------

export async function ensureOperatorAccount(
  tenantId: string,
  operatorId: string,
  currency = 'USD',
  accountType: string = 'liability',
  tx?: ExtendedTransactionClient,
) {
  const client = tx ?? db
  const existing = await client.ledgerAccount.findUnique({
    where: {
      tenantId_ownerId_ownerType_accountType_currency: {
        tenantId, ownerId: operatorId, ownerType: 'operator', accountType, currency,
      },
    },
  })
  if (existing) return existing
  return client.ledgerAccount.create({
    data: { tenantId, ownerId: operatorId, ownerType: 'operator', accountType, currency },
  })
}

export async function ensurePlatformAccount(tenantId: string, currency = 'USD', accountType: string = 'asset', tx?: ExtendedTransactionClient) {
  const client = tx ?? db
  const existing = await client.ledgerAccount.findUnique({
    where: {
      tenantId_ownerId_ownerType_accountType_currency: {
        tenantId, ownerId: 'platform', ownerType: 'platform', accountType, currency,
      },
    },
  })
  if (existing) return existing
  return client.ledgerAccount.create({
    data: { tenantId, ownerId: 'platform', ownerType: 'platform', accountType, currency },
  })
}

export async function ensureBuyerFundsAccount(tenantId: string, currency = 'USD', tx?: ExtendedTransactionClient) {
  const client = tx ?? db
  const existing = await client.ledgerAccount.findUnique({
    where: {
      tenantId_ownerId_ownerType_accountType_currency: {
        tenantId, ownerId: 'buyer', ownerType: 'buyer', accountType: 'liability', currency,
      },
    },
  })
  if (existing) return existing
  return client.ledgerAccount.create({
    data: { tenantId, ownerId: 'buyer', ownerType: 'buyer', accountType: 'liability', currency },
  })
}

// ---------------------------------------------------------------------------
// Balanced posting (the core of double-entry) — DECIMAL arithmetic (task 3)
// ---------------------------------------------------------------------------

export interface PostingEntryInput {
  accountId: string
  amount: Prisma.Decimal | number | string // signed: +credit / -debit
  entryType: string
}

export interface PostingResult {
  posting_id: string
  entry_ids: string[]
  balanced: boolean
  duplicate: boolean
}

function toDecimal(v: Prisma.Decimal | number | string): Prisma.Decimal {
  return v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v)
}

/**
 * Post a balanced double-entry transaction. All entries are created atomically
 * in a single posting. The sum of amounts MUST equal zero (EXACT decimal
 * comparison, not floating-point epsilon — task 3).
 *
 * Idempotent on (tenantId, idempotencyKey) at the posting level.
 */
export async function postBalancedPosting(opts: {
  tenantId: string
  idempotencyKey: string
  postingType: string
  referenceType?: string
  referenceId?: string
  entries: PostingEntryInput[]
}): Promise<PostingResult> {
  // Task 3: exact decimal balance validation.
  const decimalEntries = opts.entries.map((e) => ({ ...e, amount: toDecimal(e.amount) }))
  const sum = decimalEntries.reduce((acc, e) => acc.plus(e.amount), new Prisma.Decimal(0))
  if (!sum.equals(0)) {
    throw new ValidationError(`Unbalanced posting: sum=${sum.toString()}, must be 0`)
  }

  // Idempotency.
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

  // ATOMIC (task 1): create posting + entries + outbox event in ONE transaction.
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
    for (const entry of decimalEntries) {
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
    // Emit outbox in the same transaction (task 1).
    await emit(
      {
        event_type: DomainEventTypes.LedgerEntryPosted,
        aggregate_id: post.id,
        tenant_id: opts.tenantId,
        version: 1,
        payload: { postingType: opts.postingType, entryCount: decimalEntries.length },
      },
      tx,
    )
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
      sum: '0',
    },
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
  operator_balance_after: Prisma.Decimal
  currency: string
  duplicate: boolean
  breakdown: {
    gross: string
    operator_credit: string
    platform_fee: string
    buyer_debit: string
    buyer_balance_before: string
    buyer_balance_after: string
    balanced: boolean
    funding_sufficient: boolean
  }
}

/**
 * Post a reward to the ledger as a BALANCED double-entry posting.
 *
 * Task 5: enforces sufficient buyer funding. If buyer_funds balance < gross
 * amount, the posting is REJECTED. This prevents liabilities from exceeding
 * funded amounts.
 *
 *   buyer_funds       (liability): -gross   (debit: reduces buyer's prepaid funds)
 *   operator_payable  (liability): +net     (credit: increases what we owe operator)
 *   platform_revenue  (revenue):   +fee     (credit: increases platform revenue)
 *   Sum = 0 ✓
 *
 * Task 3: all arithmetic uses Prisma.Decimal (exact, no floating-point loss).
 */
export async function postRewardToLedger(
  tenantId: string,
  input: PostLedgerInput,
  idempotencyKey: string,
  actorId?: string,
): Promise<LedgerPostingResult> {
  void actorId

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
        gross: '0',
        operator_credit: reward.amount.toString(),
        platform_fee: '0',
        buyer_debit: '0',
        buyer_balance_before: '0',
        buyer_balance_after: '0',
        balanced: true,
        funding_sufficient: true,
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

  // Task 3: Decimal arithmetic for all monetary calculations.
  const rate = new Prisma.Decimal(reward.rule.rate)
  const grossAmount = new Prisma.Decimal(reward.contribution.quantity).times(rate)
  const netAmount = new Prisma.Decimal(reward.amount)
  const platformFee = grossAmount.minus(netAmount)

  // Ensure all required accounts exist (outside transaction — idempotent containers).
  // The actual financial entries are created inside the transaction with tx.
  const payableAccount = await ensureOperatorAccount(tenantId, reward.operatorId, reward.currency, 'liability')
  const revenueAccount = await ensurePlatformAccount(tenantId, reward.currency, 'revenue')
  const buyerFundsAccount = await ensureBuyerFundsAccount(tenantId, reward.currency)

  // Issue 2: concurrency-safe buyer funding check.
  // The balance check AND the ledger debit MUST happen inside the same
  // transaction, with the buyer_funds account locked FOR UPDATE. This
  // prevents two concurrent rewards from both passing the balance check
  // and over-debiting the buyer.
  //
  // Flow:
  //   BEGIN
  //   SELECT * FROM LedgerEntry WHERE accountId = buyer FOR UPDATE
  //   compute balance
  //   if balance < gross → ROLLBACK (reject)
  //   INSERT posting + entries
  //   UPDATE reward status = 'posted'
  //   COMMIT
  let buyerBalanceBefore: Prisma.Decimal
  let buyerBalanceAfter: Prisma.Decimal
  let postingId: string
  let entryIds: string[]

  try {
    const result = await db.$transaction(async (tx) => {
      // Issue 2: lock the buyer's LedgerAccount row FOR UPDATE. This prevents
      // any concurrent transaction from posting to the same buyer account
      // until we commit. We lock the ACCOUNT row (not the entries) because:
      //   - it's always exactly one row (fast lock)
      //   - it serializes all postings to this account
      //   - it works even when the account has zero entries
      await tx.$queryRaw`SELECT * FROM "LedgerAccount" WHERE "id" = ${buyerFundsAccount.id} FOR UPDATE`

      // Compute the buyer's current balance (inside the lock).
      const buyerEntries = await tx.ledgerEntry.findMany({ where: { accountId: buyerFundsAccount.id } })
      buyerBalanceBefore = buyerEntries.reduce((sum, e) => sum.plus(e.amount), new Prisma.Decimal(0))

      // Check sufficient funds (inside the lock — no race possible).
      if (buyerBalanceBefore.lessThan(grossAmount)) {
        throw new ValidationError(
          `Insufficient buyer funding: balance ${buyerBalanceBefore.toString()} < gross ${grossAmount.toString()}. ` +
          `Fund the buyer account via POST /api/v1/funding first.`,
        )
      }

      // Create the balanced posting + entries (inside the same transaction).
      const post = await tx.ledgerPosting.create({
        data: {
          tenantId,
          postingType: 'reward',
          referenceType: 'reward',
          referenceId: reward.id,
          idempotencyKey,
        },
      })
      const entries = await Promise.all([
        tx.ledgerEntry.create({
          data: {
            tenantId, postingId: post.id, accountId: buyerFundsAccount.id,
            amount: grossAmount.negated(), currency: reward.currency, entryType: 'buyer_debit',
          },
        }),
        tx.ledgerEntry.create({
          data: {
            tenantId, postingId: post.id, accountId: payableAccount.id,
            amount: netAmount, currency: reward.currency, entryType: 'reward_credit',
          },
        }),
        tx.ledgerEntry.create({
          data: {
            tenantId, postingId: post.id, accountId: revenueAccount.id,
            amount: platformFee, currency: reward.currency, entryType: 'platform_fee',
          },
        }),
      ])

      // Emit outbox in the same transaction (issue 4: atomic outbox).
      await emit(
        {
          event_type: DomainEventTypes.LedgerEntryPosted,
          aggregate_id: post.id,
          tenant_id: tenantId,
          version: 1,
          payload: { postingType: 'reward', entryCount: entries.length },
        },
        tx,
      )

      // Mark reward as posted (inside the same transaction).
      await tx.reward.update({ where: { id: reward.id }, data: { status: 'posted' } })

      // Compute buyer balance after (inside the lock).
      const buyerEntriesAfter = await tx.ledgerEntry.findMany({ where: { accountId: buyerFundsAccount.id } })
      buyerBalanceAfter = buyerEntriesAfter.reduce((sum, e) => sum.plus(e.amount), new Prisma.Decimal(0))

      return { postingId: post.id, entryIds: entries.map((e) => e.id) }
    })

    postingId = result.postingId
    entryIds = result.entryIds
  } catch (err) {
    // Re-throw ValidationError (funding insufficient) as-is.
    if (err instanceof ValidationError) throw err
    // Other errors (e.g. unique constraint on idempotency) — re-throw.
    throw err
  }

  await appendAudit({
    tenantId,
    eventType: AuditEvents.LedgerPosted,
    resourceType: 'ledger_posting',
    resourceId: postingId,
    metadata: {
      postingType: 'reward',
      referenceType: 'reward',
      referenceId: reward.id,
      entryCount: entryIds.length,
      sum: '0',
    },
  })

  const operatorBalance = await computeBalance(tenantId, payableAccount.id)

  return {
    posting_id: postingId,
    reward_credit_entry_id: entryIds[1],
    platform_fee_entry_id: entryIds[2],
    buyer_debit_entry_id: entryIds[0],
    operator_balance_after: operatorBalance,
    currency: reward.currency,
    duplicate: false,
    breakdown: {
      gross: grossAmount.toString(),
      operator_credit: netAmount.toString(),
      platform_fee: platformFee.toString(),
      buyer_debit: grossAmount.toString(),
      buyer_balance_before: buyerBalanceBefore!.toString(),
      buyer_balance_after: buyerBalanceAfter!.toString(),
      balanced: true,
      funding_sufficient: true,
    },
  }
}

// ---------------------------------------------------------------------------
// Buyer funding (lets buyers prepay into the system)
// ---------------------------------------------------------------------------

export interface FundingResult {
  posting_id: string
  balance_after: Prisma.Decimal
  duplicate: boolean
}

export async function recordBuyerFunding(
  tenantId: string,
  amount: Prisma.Decimal | number | string,
  idempotencyKey: string,
): Promise<FundingResult> {
  const decimalAmount = toDecimal(amount)
  if (decimalAmount.lte(0)) {
    throw new ValidationError('Funding amount must be positive')
  }

  const cashAccount = await ensurePlatformAccount(tenantId, 'USD', 'asset')
  const buyerFundsAccount = await ensureBuyerFundsAccount(tenantId, 'USD')

  const posting = await postBalancedPosting({
    tenantId,
    idempotencyKey,
    postingType: 'funding',
    referenceType: 'funding',
    referenceId: idempotencyKey,
    entries: [
      { accountId: cashAccount.id, amount: decimalAmount.negated(), entryType: 'funding_debit' },
      { accountId: buyerFundsAccount.id, amount: decimalAmount, entryType: 'funding_credit' },
    ],
  })

  const balance = await computeBalance(tenantId, buyerFundsAccount.id)
  return { posting_id: posting.posting_id, balance_after: balance, duplicate: posting.duplicate }
}

// ---------------------------------------------------------------------------
// Queries — return Decimal
// ---------------------------------------------------------------------------

/** Compute an account balance by summing append-only entries. Returns Decimal. */
export async function computeBalance(tenantId: string, accountId: string): Promise<Prisma.Decimal> {
  const account = await db.ledgerAccount.findFirst({ where: { id: accountId, tenantId } })
  if (!account) throw new NotFoundError('ledger_account', accountId)
  const entries = await db.ledgerEntry.findMany({ where: { accountId, tenantId } })
  return entries.reduce((sum, e) => sum.plus(e.amount), new Prisma.Decimal(0))
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
  // Verify balance for each posting (transparency) — Decimal sum.
  return postings.map((p) => ({
    ...p,
    sum: p.entries.reduce((acc, e) => acc.plus(e.amount), new Prisma.Decimal(0)),
  }))
}
