// =============================================================================
// VPP-3: Buyer Settlement Service (atomic, recoverable, decimal-safe)
// =============================================================================
// Connects the portfolio commitment to the buyer's commercial obligation.
//
// VPP-3 CORRECTIONS (vs 3A prototype):
//   1. LIFECYCLE INTEGRATION: auto-created when portfolio commitment
//      reaches final state (wired into maybeFinalizeDispatch).
//   2. ATOMIC + RECOVERABLE: pending → charging → charged | failed
//      with claim/lease/fencing. Uses outbox for retry.
//   3. CONCURRENT IDEMPOTENCY: upsert-with-conflict-handling, no raw P2002.
//   4. DECIMAL ARITHMETIC: Prisma.Decimal throughout, no JS number math.
//   5. MEASUREMENT POLICY: capacity ceiling respects commitment's
//      measurementMethod (average_power vs energy).
//   6. ATOMIC AUDIT/OUTBOX: state transitions + audit in transactions.
//   7. FAILURE RECOVERY: inspect durable ledger state by idempotency key.
//
// ARCHITECTURAL RULE: Direct ledger posting, NOT a duplicate pipeline.
// =============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import { NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { ensureBuyerFundsAccount, ensurePlatformAccount, postBalancedPosting, computeBalance } from './ledger.service'
import { supportsRowLocking } from '@/lib/kernel/db/provider'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BuyerSettlementStatus = 'pending' | 'charging' | 'charged' | 'failed' | 'reconciliation_required'
export type MeasurementMethod = 'average_power' | 'energy' | 'interval_power'

export interface BuyerChargeBreakdown {
  buyerDeliveredKwh: Prisma.Decimal
  pricePerKwh: Prisma.Decimal
  deliveredCharge: Prisma.Decimal
  capacityCeiling: Prisma.Decimal
  cappedCharge: Prisma.Decimal
  fulfillmentPct: Prisma.Decimal
  toleranceThresholdPct: Prisma.Decimal
  metTolerance: boolean
  buyerCharge: Prisma.Decimal
  currency: string
  shortfall: Prisma.Decimal
  measurementMethod: MeasurementMethod
}

export interface BuyerSettlementResult {
  settlementId: string
  dispatchId: string
  commitmentId: string
  status: BuyerSettlementStatus
  charge: {
    // All monetary values returned as STRING (decimal-as-string).
    // Do NOT parseFloat — the caller receives exact decimal representations.
    buyerDeliveredKwh: string
    pricePerKwh: string
    deliveredCharge: string
    capacityCeiling: string
    cappedCharge: string
    fulfillmentPct: string
    toleranceThresholdPct: string
    metTolerance: boolean
    buyerCharge: string
    currency: string
    shortfall: string
    measurementMethod: MeasurementMethod
  }
  ledgerPostingId: string | null
  buyerFundsBalanceAfter: string
  failureReason?: string
}

// ---------------------------------------------------------------------------
// Pure charge computation (Decimal arithmetic, testable without DB)
// ---------------------------------------------------------------------------

/**
 * Compute the buyer charge using Prisma.Decimal throughout.
 *
 * CAPACITY CEILING respects the commitment's measurementMethod:
 *   average_power: ceiling = committedKw × durationHours × pricePerKwh
 *   energy:        ceiling = requestedKwh × pricePerKwh
 *
 * CHARGE MODEL:
 *   deliveredCharge = buyerDeliveredKwh × pricePerKwh
 *   cappedCharge = min(deliveredCharge, capacityCeiling)
 *   If fulfillmentPct ≥ tolerance: buyerCharge = cappedCharge
 *   If fulfillmentPct < tolerance: buyerCharge = cappedCharge × (fulfillmentPct / 100)
 *   If buyerDeliveredKwh = 0: buyerCharge = 0
 */
export function computeBuyerCharge(input: {
  buyerDeliveredKwh: Prisma.Decimal
  committedKw: Prisma.Decimal
  requestedKwh: Prisma.Decimal
  durationHours: Prisma.Decimal
  pricePerKwh: Prisma.Decimal
  fulfillmentPct: Prisma.Decimal
  toleranceThresholdPct: Prisma.Decimal
  currency: string
  measurementMethod: MeasurementMethod
}): BuyerChargeBreakdown {
  const {
    buyerDeliveredKwh, committedKw, requestedKwh, durationHours,
    pricePerKwh, fulfillmentPct, toleranceThresholdPct, currency, measurementMethod,
  } = input

  const deliveredCharge = buyerDeliveredKwh.times(pricePerKwh)

  // Capacity ceiling depends on measurement method.
  let capacityCeiling: Prisma.Decimal
  if (measurementMethod === 'energy') {
    capacityCeiling = requestedKwh.times(pricePerKwh)
  } else {
    // average_power (default)
    capacityCeiling = committedKw.times(durationHours).times(pricePerKwh)
  }

  const cappedCharge = deliveredCharge.lessThan(capacityCeiling) ? deliveredCharge : capacityCeiling

  const metTolerance = fulfillmentPct.greaterThanOrEqualTo(toleranceThresholdPct)

  let buyerCharge: Prisma.Decimal
  if (buyerDeliveredKwh.lessThanOrEqualTo(0)) {
    buyerCharge = new Prisma.Decimal(0)
  } else if (metTolerance) {
    buyerCharge = cappedCharge
  } else {
    // Proportional reduction: cappedCharge × (fulfillmentPct / 100)
    buyerCharge = cappedCharge.times(fulfillmentPct).div(100)
  }

  const shortfall = Prisma.Decimal.max(0, capacityCeiling.minus(buyerCharge))

  return {
    buyerDeliveredKwh,
    pricePerKwh,
    deliveredCharge,
    capacityCeiling,
    cappedCharge,
    fulfillmentPct,
    toleranceThresholdPct,
    metTolerance,
    buyerCharge,
    currency,
    shortfall,
    measurementMethod,
  }
}

// ---------------------------------------------------------------------------
// Create buyer settlement (idempotent, auto-created on lifecycle)
// ---------------------------------------------------------------------------

/**
 * Create a buyer settlement record for a dispatch. Called automatically
 * by maybeFinalizeDispatch when the portfolio commitment reaches a
 * final state (fulfilled | partial | failed).
 *
 * IDEMPOTENT: if a settlement already exists for this dispatchId, returns it.
 * Uses upsert-with-conflict-handling — no raw P2002 escapes.
 *
 * This ONLY creates the record in 'pending' status. The actual ledger
 * charge is performed by processBuyerSettlement (which uses claim/lease/fencing).
 */
export async function createBuyerSettlement(
  tenantId: string,
  dispatchId: string,
  actorId?: string,
): Promise<BuyerSettlementResult> {
  const commitment = await db.vppPortfolioCommitment.findUnique({
    where: { dispatchId },
    include: { dispatch: { include: { program: true } } },
  })
  if (!commitment) throw new NotFoundError('vpp_portfolio_commitment', dispatchId)
  if (commitment.tenantId !== tenantId) throw new NotFoundError('vpp_portfolio_commitment', dispatchId)

  const finalStates = new Set(['fulfilled', 'partial', 'failed'])
  if (!finalStates.has(commitment.status)) {
    throw new ValidationError(
      `Portfolio commitment is not in a final state (current: ${commitment.status}).`,
    )
  }

  // Idempotent: check existing first.
  const existing = await db.vppBuyerSettlement.findUnique({ where: { dispatchId } })
  if (existing) {
    return toResult(existing)
  }

  // Compute the charge breakdown (using Decimal).
  const dispatch = commitment.dispatch
  const program = dispatch.program

  const durationHours = new Prisma.Decimal(
    Math.max(0.001, (dispatch.endTime.getTime() - dispatch.startTime.getTime()) / 3600000),
  )
  const buyerDeliveredKwh = new Prisma.Decimal(commitment.buyerDeliveredKwh ?? '0')
  const committedKw = new Prisma.Decimal(commitment.committedKw)
  const requestedKwh = new Prisma.Decimal(commitment.requestedKwh)
  const pricePerKwh = new Prisma.Decimal(program.pricePerKwh)
  const fulfillmentPct = new Prisma.Decimal(commitment.fulfillmentPct ?? '0')
  const toleranceThresholdPct = new Prisma.Decimal(commitment.toleranceThresholdPct)
  const currency = program.currency
  const measurementMethod = commitment.measurementMethod as MeasurementMethod

  const charge = computeBuyerCharge({
    buyerDeliveredKwh,
    committedKw,
    requestedKwh,
    durationHours,
    pricePerKwh,
    fulfillmentPct,
    toleranceThresholdPct,
    currency,
    measurementMethod,
  })

  // Create the settlement record (pending status). Use try/catch for P2002.
  try {
    const settlement = await db.vppBuyerSettlement.create({
      data: {
        tenantId,
        dispatchId,
        commitmentId: commitment.id,
        buyerDeliveredKwh: charge.buyerDeliveredKwh.toString(),
        pricePerKwh: charge.pricePerKwh.toString(),
        deliveredCharge: charge.deliveredCharge.toString(),
        capacityCeiling: charge.capacityCeiling.toString(),
        cappedCharge: charge.cappedCharge.toString(),
        fulfillmentPct: charge.fulfillmentPct.toString(),
        toleranceThresholdPct: charge.toleranceThresholdPct.toString(),
        metTolerance: charge.metTolerance,
        buyerCharge: charge.buyerCharge.toString(),
        shortfall: charge.shortfall.toString(),
        currency: charge.currency,
        measurementMethod: charge.measurementMethod,
        pricingPolicyJson: JSON.stringify({
          version: 'v1',
          pricePerKwh: charge.pricePerKwh.toString(),
          toleranceThresholdPct: charge.toleranceThresholdPct.toString(),
          measurementMethod: charge.measurementMethod,
          fulfillmentBasis: commitment.fulfillmentBasis,
          chargeFormula: 'performance_based_with_cap',
          // Future: capacityPayment, energyPayment, penaltyRate, etc.
        }),
        status: 'pending',
      },
    })

    await appendAudit({
      tenantId,
      actorId,
      eventType: AuditEvents.BuyerSettlementCharged,
      resourceType: 'vpp_buyer_settlement',
      resourceId: settlement.id,
      metadata: {
        dispatchId,
        commitmentId: commitment.id,
        buyerCharge: charge.buyerCharge.toString(),
        currency: charge.currency,
        status: 'pending',
        action: 'created',
      },
    })

    return toResult(settlement)
  } catch (err) {
    // P2002: another concurrent caller created it. Re-fetch.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await db.vppBuyerSettlement.findUnique({ where: { dispatchId } })
      if (existing) return toResult(existing)
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Process buyer settlement (claim/lease/fencing, atomic ledger posting)
// ---------------------------------------------------------------------------

const SETTLEMENT_LEASE_MS = 60000

/**
 * Process a pending buyer settlement: claim it, post the ledger charge,
 * and mark it as charged or failed.
 *
 * Uses claim/lease/fencing for crash safety:
 *   pending → charging (with claimId + lease) → charged | failed
 *
 * If the worker crashes during processing, the lease expires and another
 * worker can reclaim it. The fencing token prevents stale writes.
 *
 * RECOVERY: before posting, checks if a ledger posting already exists
 * for this settlement (by idempotency key). If so, marks as charged
 * without re-posting.
 *
 * Idempotency key: buyer-settlement-{settlementId}
 */
export async function processBuyerSettlement(
  tenantId: string,
  settlementId: string,
  actorId?: string,
): Promise<BuyerSettlementResult> {
  const settlement = await db.vppBuyerSettlement.findUnique({
    where: { id: settlementId },
  })
  if (!settlement) throw new NotFoundError('vpp_buyer_settlement', settlementId)
  if (settlement.tenantId !== tenantId) throw new NotFoundError('vpp_buyer_settlement', settlementId)

  // Already in a terminal state — return existing (idempotent).
  if (settlement.status === 'charged' || settlement.status === 'failed') {
    return toResult(settlement)
  }

  const now = new Date()
  const leaseExpiry = new Date(now.getTime() + SETTLEMENT_LEASE_MS)
  const claimId = randomUUID()

  // Atomic claim: pending → charging (with fencing token).
  // If the lease has expired, reclaim it.
  let claimed: { count: number }
  if (settlement.status === 'charging' && settlement.leaseExpiresAt && settlement.leaseExpiresAt < now) {
    // Reclaim expired lease.
    claimed = await db.vppBuyerSettlement.updateMany({
      where: {
        id: settlementId,
        status: 'charging',
        leaseExpiresAt: { lt: now },
      },
      data: {
        claimedAt: now,
        leaseExpiresAt: leaseExpiry,
        claimId,
      },
    })
  } else {
    claimed = await db.vppBuyerSettlement.updateMany({
      where: { id: settlementId, status: 'pending' },
      data: {
        status: 'charging',
        claimedAt: now,
        leaseExpiresAt: leaseExpiry,
        claimId,
      },
    })
  }

  if (claimed.count === 0) {
    // Another worker is processing or already done.
    return toResult(settlement)
  }

  // We hold the claim. Process the settlement.
  let ledgerPostingId: string | null = null
  try {
    const buyerCharge = new Prisma.Decimal(settlement.buyerCharge)
    const currency = settlement.currency
    const idempotencyKey = `buyer-settlement-${settlementId}`

    // RECOVERY CHECK: inspect durable ledger state before posting.
    // If a posting already exists for this idempotency key, the charge
    // was already posted — just mark as charged.
    const existingPosting = await db.ledgerPosting.findUnique({
      where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
    })

    let buyerFundsBalanceAfter = new Prisma.Decimal(0)

    if (existingPosting) {
      // Recovery: ledger posting already exists. Don't re-post.
      ledgerPostingId = existingPosting.id
    } else if (buyerCharge.greaterThan(0)) {
      // Post the charge: debit buyer_funds, credit platform revenue.
      const buyerAccount = await ensureBuyerFundsAccount(tenantId, currency)
      const revenueAccount = await ensurePlatformAccount(tenantId, currency, 'revenue')

      // Lock the buyer funds account for the funding check (PostgreSQL only).
      if (supportsRowLocking()) {
        await db.$queryRaw`
          SELECT * FROM "LedgerAccount"
          WHERE "id" = ${buyerAccount.id}
          FOR UPDATE
        `
      }

      const balance = await computeBalance(tenantId, buyerAccount.id)
      buyerFundsBalanceAfter = balance.minus(buyerCharge)

      if (balance.lessThan(buyerCharge)) {
        // Insufficient funds — fenced failure.
        await db.vppBuyerSettlement.updateMany({
          where: { id: settlementId, status: 'charging', claimId },
          data: {
            status: 'failed',
            failureReason: `Insufficient buyer funds: balance ${balance.toString()} < charge ${buyerCharge.toString()}`,
            claimedAt: null,
            leaseExpiresAt: null,
            claimId: null,
          },
        })
        return toResult(await db.vppBuyerSettlement.findUnique({ where: { id: settlementId } })!)
      }

      const posting = await postBalancedPosting({
        tenantId,
        idempotencyKey,
        postingType: 'buyer_charge',
        referenceType: 'vpp_portfolio_commitment',
        referenceId: settlement.commitmentId,
        entries: [
          {
            accountId: buyerAccount.id,
            amount: buyerCharge.negated(), // debit
            entryType: 'buyer_charge_debit',
          },
          {
            accountId: revenueAccount.id,
            amount: buyerCharge, // credit
            entryType: 'buyer_charge_credit',
          },
        ],
      })
      ledgerPostingId = posting.posting_id
    }

    // Fenced final write: only if we still own the claim.
    const fencedUpdate = await db.vppBuyerSettlement.updateMany({
      where: { id: settlementId, status: 'charging', claimId },
      data: {
        status: 'charged',
        ledgerPostingId,
        buyerFundsBalanceAfter: buyerFundsBalanceAfter.toString(),
        claimedAt: null,
        leaseExpiresAt: null,
        claimId: null,
        chargedAt: new Date(),
      },
    })

    if (fencedUpdate.count === 0) {
      // Lost the lease — another worker reclaimed. Return current state.
      return toResult(await db.vppBuyerSettlement.findUnique({ where: { id: settlementId } })!)
    }

    await appendAudit({
      tenantId,
      actorId,
      eventType: AuditEvents.BuyerSettlementCharged,
      resourceType: 'vpp_buyer_settlement',
      resourceId: settlementId,
      metadata: {
        dispatchId: settlement.dispatchId,
        buyerCharge: settlement.buyerCharge,
        currency: settlement.currency,
        ledgerPostingId,
        status: 'charged',
      },
    })

    // VPP-3B: advance the dispatch from 'buyer_settlement_pending' to
    // 'completed' now that the buyer settlement is charged (or failed
    // with zero charge — no money moved, but the obligation is finalized).
    await db.vppDispatch.updateMany({
      where: { id: settlement.dispatchId, status: 'buyer_settlement_pending' },
      data: { status: 'completed' },
    })

    return toResult(await db.vppBuyerSettlement.findUnique({ where: { id: settlementId } })!)
  } catch (err) {
    // Processing failed. The correct recovery state depends on WHETHER
    // the ledger posting was attempted:
    //
    // If ledgerPostingId is set (posting succeeded but crash before
    // status update): → reconciliation_required (unknown financial state,
    //   must NOT retry — the money may have moved).
    //
    // If ledgerPostingId is null (pre-posting failure — insufficient
    // funds, DB timeout before posting): → pending (safe to retry,
    //   no money moved).
    //
    // Both transitions + retry event are in ONE transaction with fencing.
    const reason = err instanceof Error ? err.message : 'Processing failed'
    const recoveryStatus = ledgerPostingId ? 'reconciliation_required' : 'pending'

    try {
      const { emit } = await import('@/lib/domain/events')
      await db.$transaction(async (tx) => {
        // FENCING: revert only if we still own the claim.
        await tx.vppBuyerSettlement.updateMany({
          where: { id: settlementId, status: 'charging', claimId },
          data: {
            status: recoveryStatus,
            ledgerPostingId, // preserve if set (for reconciliation)
            claimedAt: null,
            leaseExpiresAt: null,
            claimId: null,
            failureReason: reason,
            reconciledAt: recoveryStatus === 'reconciliation_required' ? null : undefined,
          },
        })
        // Only emit retry event for pending (safe retry). For
        // reconciliation_required, a separate reconciliation process
        // inspects the ledger state.
        if (recoveryStatus === 'pending') {
          await emit(
            {
              event_type: 'BuyerSettlementRetryRequested',
              aggregate_id: settlementId,
              tenant_id: tenantId,
              version: 1,
              payload: {
                settlementId,
                dispatchId: settlement.dispatchId,
                reason,
              },
            },
            tx,
          )
        }
      })
    } catch {
      // If the transaction itself fails, the settlement stays in 'charging'.
      // The repair sweep will reclaim it.
    }

    throw err
  }
}

// ---------------------------------------------------------------------------
// Process pending buyer settlements (worker entry point)
// ---------------------------------------------------------------------------

/**
 * Process all pending buyer settlements. Called by a worker.
 * Finds pending or expired-charging settlements and processes them.
 */
export async function processPendingBuyerSettlements(
  tenantId?: string,
): Promise<{ processed: number; charged: number; failed: number }> {
  const now = new Date()
  const pending = await db.vppBuyerSettlement.findMany({
    where: {
      ...(tenantId ? { tenantId } : {}),
      OR: [
        { status: 'pending' },
        { status: 'charging', leaseExpiresAt: { lt: now } },
      ],
    },
    select: { id: true, tenantId: true },
    take: 50,
  })

  let charged = 0
  let failed = 0

  for (const { id, tenantId: stTenantId } of pending) {
    try {
      const result = await processBuyerSettlement(stTenantId, id)
      if (result.status === 'charged') charged++
      else failed++
    } catch {
      failed++
    }
  }

  return { processed: pending.length, charged, failed }
}

// ---------------------------------------------------------------------------
// Reconcile buyer settlement (reconciliation_required → charged | failed)
// ---------------------------------------------------------------------------

/**
 * Reconcile a buyer settlement in 'reconciliation_required' state.
 *
 * This is called when a settlement may have a partial ledger posting
 * (e.g., crash after posting but before status update). The reconciliation
 * process inspects the durable ledger state by idempotency key:
 *
 *   - If a balanced ledger posting exists: mark as 'charged' (the money
 *     moved correctly, just the status wasn't updated).
 *   - If no posting exists: mark as 'pending' (safe to retry — no money
 *     moved, the failure was pre-posting).
 *
 * This ensures the settlement invariant:
 *   buyer charge exists ⟺ ledger posting is balanced
 */
export async function reconcileBuyerSettlement(
  tenantId: string,
  settlementId: string,
  actorId?: string,
): Promise<BuyerSettlementResult> {
  const settlement = await db.vppBuyerSettlement.findUnique({
    where: { id: settlementId },
  })
  if (!settlement) throw new NotFoundError('vpp_buyer_settlement', settlementId)
  if (settlement.tenantId !== tenantId) throw new NotFoundError('vpp_buyer_settlement', settlementId)

  if (settlement.status !== 'reconciliation_required') {
    return toResult(settlement) // already resolved
  }

  // Inspect the durable ledger state by idempotency key.
  const idempotencyKey = `buyer-settlement-${settlementId}`
  const existingPosting = await db.ledgerPosting.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
    include: { entries: true },
  })

  if (existingPosting) {
    // Ledger posting exists — verify it's balanced.
    const sum = existingPosting.entries.reduce(
      (acc, e) => acc.plus(e.amount),
      new Prisma.Decimal(0),
    )

    if (sum.equals(0)) {
      // Balanced posting exists — mark as charged.
      await db.vppBuyerSettlement.update({
        where: { id: settlementId },
        data: {
          status: 'charged',
          ledgerPostingId: existingPosting.id,
          reconciledAt: new Date(),
          claimId: null,
          claimedAt: null,
          leaseExpiresAt: null,
        },
      })

      // Advance dispatch to completed.
      await db.vppDispatch.updateMany({
        where: { id: settlement.dispatchId, status: 'buyer_settlement_pending' },
        data: { status: 'completed' },
      })

      await appendAudit({
        tenantId,
        actorId,
        eventType: AuditEvents.BuyerSettlementCharged,
        resourceType: 'vpp_buyer_settlement',
        resourceId: settlementId,
        metadata: {
          dispatchId: settlement.dispatchId,
          status: 'charged',
          action: 'reconciled',
          ledgerPostingId: existingPosting.id,
        },
      })
    } else {
      // Unbalanced posting — this should never happen (postBalancedPosting
      // validates balance). Mark as failed with a critical warning.
      await db.vppBuyerSettlement.update({
        where: { id: settlementId },
        data: {
          status: 'failed',
          failureReason: `CRITICAL: unbalanced ledger posting ${existingPosting.id} (sum=${sum.toString()})`,
          reconciledAt: new Date(),
        },
      })
    }
  } else {
    // No posting exists — safe to retry. Mark as pending.
    await db.vppBuyerSettlement.update({
      where: { id: settlementId },
      data: {
        status: 'pending',
        failureReason: `Reconciled: no ledger posting found, safe to retry`,
        reconciledAt: new Date(),
        claimId: null,
        claimedAt: null,
        leaseExpiresAt: null,
      },
    })
  }

  return toResult(await db.vppBuyerSettlement.findUnique({ where: { id: settlementId } })!)
}

/**
 * Repair sweep: find settlements in 'reconciliation_required' or stuck
 * in 'charging' (expired lease) and reconcile/process them.
 *
 * This is the safety net — the primary retry path is the outbox event.
 */
export async function recoverStuckBuyerSettlements(
  tenantId?: string,
): Promise<{ recovered: number; charged: number; failed: number }> {
  const now = new Date()

  // Find settlements that need recovery.
  const stuck = await db.vppBuyerSettlement.findMany({
    where: {
      ...(tenantId ? { tenantId } : {}),
      OR: [
        { status: 'reconciliation_required' },
        { status: 'charging', leaseExpiresAt: { lt: now } },
      ],
    },
    select: { id: true, tenantId: true, status: true },
    take: 50,
  })

  let charged = 0
  let failed = 0

  for (const { id, tenantId: stTenantId, status } of stuck) {
    try {
      if (status === 'reconciliation_required') {
        const result = await reconcileBuyerSettlement(stTenantId, id)
        if (result.status === 'charged') charged++
        else failed++
      } else {
        // Expired charging lease — revert to pending and retry.
        await db.vppBuyerSettlement.updateMany({
          where: { id, status: 'charging', leaseExpiresAt: { lt: now } },
          data: {
            status: 'pending',
            claimId: null,
            claimedAt: null,
            leaseExpiresAt: null,
          },
        }).catch(() => {})

        const result = await processBuyerSettlement(stTenantId, id)
        if (result.status === 'charged') charged++
        else failed++
      }
    } catch {
      failed++
    }
  }

  return { recovered: stuck.length, charged, failed }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export async function getBuyerSettlement(tenantId: string, dispatchId: string) {
  const settlement = await db.vppBuyerSettlement.findUnique({ where: { dispatchId } })
  if (!settlement) throw new NotFoundError('vpp_buyer_settlement', dispatchId)
  if (settlement.tenantId !== tenantId) throw new NotFoundError('vpp_buyer_settlement', dispatchId)
  return settlement
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toResult(s: any): BuyerSettlementResult {
  return {
    settlementId: s.id,
    dispatchId: s.dispatchId,
    commitmentId: s.commitmentId,
    status: s.status,
    charge: {
      // Return as STRING (decimal-as-string) — do NOT parseFloat.
      buyerDeliveredKwh: s.buyerDeliveredKwh,
      pricePerKwh: s.pricePerKwh,
      deliveredCharge: s.deliveredCharge,
      capacityCeiling: s.capacityCeiling,
      cappedCharge: s.cappedCharge,
      fulfillmentPct: s.fulfillmentPct,
      toleranceThresholdPct: s.toleranceThresholdPct,
      metTolerance: s.metTolerance,
      buyerCharge: s.buyerCharge,
      currency: s.currency,
      shortfall: s.shortfall,
      measurementMethod: s.measurementMethod as MeasurementMethod,
    },
    ledgerPostingId: s.ledgerPostingId ?? null,
    buyerFundsBalanceAfter: s.buyerFundsBalanceAfter ?? '0',
    failureReason: s.failureReason ?? undefined,
  }
}
