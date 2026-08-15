// =============================================================================
// VPP-3: Buyer Settlement Service
// =============================================================================
// Connects the portfolio commitment (what was delivered) to the buyer's
// commercial obligation (what the buyer pays).
//
// THE FLOW:
//
//   Portfolio commitment evaluated:
//     committedKw, buyerDeliveredKwh, fulfillmentPct, status
//         ↓
//   Buyer contract terms (from VppBuyerProgram):
//     pricePerKwh, currency, toleranceThresholdPct
//         ↓
//   Buyer charge computation:
//     delivered charge = buyerDeliveredKwh × pricePerKwh
//     capacity ceiling = committedKw × durationHours × pricePerKwh
//     shortfall penalty = if fulfillmentPct < tolerance → proportional reduction
//     overdelivery cap = min(delivered charge, capacity ceiling)
//         ↓
//   Ledger posting (buyer_charge):
//     buyer_funds (liability) → debit (reduces prepaid balance)
//     buyer_revenue (revenue) → credit (platform revenue from buyer)
//         ↓
//   BuyerSettlement record (buyer-facing invoice)
//
// =============================================================================
// ARCHITECTURAL RULE (same as VPP-2D-4)
// =============================================================================
//
//   The buyer settlement layer is ABOVE the generic economic kernel:
//
//     Buyer Settlement (buyer-facing charge)
//         ↓
//     generic Ledger (double-entry posting)
//
//   Do NOT create BuyerContribution, BuyerReward, or duplicate the
//   operator pipeline. The buyer charge is a direct ledger posting.
//   Operator rewards/settlements remain on the existing generic pipeline
//   (Contribution → Reward → Ledger → Settlement).
//
// =============================================================================
// CHARGE MODEL (performance-based with cap)
// =============================================================================
//
//   The buyer pays for DELIVERED energy, capped at the commitment ceiling:
//
//   deliveredCharge = buyerDeliveredKwh × pricePerKwh
//   capacityCeiling = committedKw × durationHours × pricePerKwh
//   buyerCharge = min(deliveredCharge, capacityCeiling)
//
//   Shortfall handling:
//     - If fulfillmentPct ≥ tolerance: buyer pays the full buyerCharge
//     - If fulfillmentPct < tolerance: buyer pays buyerCharge × (fulfillmentPct / 100)
//       (proportional reduction — the buyer doesn't pay full price for
//        partial delivery)
//     - If status = 'failed' (0 delivery): buyer pays nothing
//
//   Overdelivery handling:
//     - buyerCharge is capped at capacityCeiling — the buyer never pays
//       more than committedKw × duration × pricePerKwh, even if the
//       portfolio delivered more than committed.
//
//   This is a defensible MVP model. Future versions can add:
//     - Capacity payments (fixed payment for reserved capacity)
//     - Penalty rates below tolerance
//     - Tiered pricing
//     - Time-of-use pricing
// =============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { NotFoundError, ValidationError, ConflictError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { ensureBuyerFundsAccount, ensurePlatformAccount, postBalancedPosting, computeBalance } from './ledger.service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BuyerSettlementStatus =
  | 'pending'
  | 'charging'
  | 'charged'
  | 'failed'

export interface BuyerChargeBreakdown {
  /** The buyer's delivered energy (kWh) from the portfolio commitment. */
  buyerDeliveredKwh: number
  /** The price per kWh from the buyer program. */
  pricePerKwh: number
  /** Raw delivered charge = buyerDeliveredKwh × pricePerKwh. */
  deliveredCharge: number
  /** Capacity ceiling = committedKw × durationHours × pricePerKwh. */
  capacityCeiling: number
  /** Charge after overdelivery cap = min(deliveredCharge, capacityCeiling). */
  cappedCharge: number
  /** Fulfillment percentage from the portfolio commitment. */
  fulfillmentPct: number
  /** Tolerance threshold from the portfolio commitment. */
  toleranceThresholdPct: number
  /** Whether the portfolio met the tolerance threshold. */
  metTolerance: boolean
  /** Final buyer charge after shortfall adjustment. */
  buyerCharge: number
  /** Currency. */
  currency: string
  /** Shortfall amount (capacity ceiling - buyer charge), if any. */
  shortfall: number
}

export interface BuyerSettlementResult {
  settlementId: string
  dispatchId: string
  commitmentId: string
  status: BuyerSettlementStatus
  charge: BuyerChargeBreakdown
  ledgerPostingId: string | null
  buyerFundsBalanceAfter: number
}

// ---------------------------------------------------------------------------
// Compute buyer charge (pure function — testable without DB)
// ---------------------------------------------------------------------------

/**
 * Compute the buyer charge from portfolio fulfillment + contract terms.
 *
 * CHARGE MODEL:
 *   deliveredCharge = buyerDeliveredKwh × pricePerKwh
 *   capacityCeiling = committedKw × durationHours × pricePerKwh
 *   cappedCharge = min(deliveredCharge, capacityCeiling)
 *
 *   If fulfillmentPct ≥ tolerance: buyerCharge = cappedCharge
 *   If fulfillmentPct < tolerance: buyerCharge = cappedCharge × (fulfillmentPct / 100)
 *   If buyerDeliveredKwh = 0: buyerCharge = 0
 *
 * Overdelivery is capped — the buyer never pays more than the commitment ceiling.
 * Shortfall is proportional — the buyer pays proportionally less for partial delivery.
 */
export function computeBuyerCharge(input: {
  buyerDeliveredKwh: number
  committedKw: number
  durationHours: number
  pricePerKwh: number
  fulfillmentPct: number
  toleranceThresholdPct: number
  currency: string
}): BuyerChargeBreakdown {
  const { buyerDeliveredKwh, committedKw, durationHours, pricePerKwh, fulfillmentPct, toleranceThresholdPct, currency } = input

  const deliveredCharge = buyerDeliveredKwh * pricePerKwh
  const capacityCeiling = committedKw * durationHours * pricePerKwh
  const cappedCharge = Math.min(deliveredCharge, capacityCeiling)

  const metTolerance = fulfillmentPct >= toleranceThresholdPct

  let buyerCharge: number
  if (buyerDeliveredKwh <= 0) {
    buyerCharge = 0
  } else if (metTolerance) {
    buyerCharge = cappedCharge
  } else {
    // Proportional reduction for partial fulfillment.
    buyerCharge = cappedCharge * (fulfillmentPct / 100)
  }

  const shortfall = Math.max(0, capacityCeiling - buyerCharge)

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
  }
}

// ---------------------------------------------------------------------------
// Create + charge a buyer settlement
// ---------------------------------------------------------------------------

/**
 * Create and charge a buyer settlement for a completed portfolio commitment.
 *
 * This is the buyer-facing commercial layer. It:
 *   1. Reads the portfolio commitment (must be in a final state).
 *   2. Reads the buyer program contract terms (pricePerKwh, currency).
 *   3. Computes the buyer charge (performance-based with cap).
 *   4. Posts a `buyer_charge` ledger entry (buyer_funds debit + buyer_revenue credit).
 *   5. Creates a BuyerSettlement record.
 *
 * IDEMPOTENT: if a settlement already exists for this dispatch, returns it.
 *
 * The buyer charge is a direct ledger posting — NOT a Contribution→Reward chain.
 * Operator payments remain on the existing generic pipeline.
 */
export async function createBuyerSettlement(
  tenantId: string,
  dispatchId: string,
  actorId?: string,
): Promise<BuyerSettlementResult> {
  // Load the portfolio commitment (must be final).
  const commitment = await db.vppPortfolioCommitment.findUnique({
    where: { dispatchId },
    include: {
      dispatch: {
        include: {
          program: true,
        },
      },
    },
  })
  if (!commitment) throw new NotFoundError('vpp_portfolio_commitment', dispatchId)
  if (commitment.tenantId !== tenantId) throw new NotFoundError('vpp_portfolio_commitment', dispatchId)

  const finalStates = new Set(['fulfilled', 'partial', 'failed'])
  if (!finalStates.has(commitment.status)) {
    throw new ValidationError(
      `Portfolio commitment is not in a final state (current: ${commitment.status}). ` +
        `Wait for evaluation to complete before creating a buyer settlement.`,
    )
  }

  // Check for existing settlement (idempotent).
  const existing = await db.vppBuyerSettlement.findUnique({
    where: { dispatchId },
  })
  if (existing) {
    return await getBuyerSettlementResult(existing, commitment)
  }

  const dispatch = commitment.dispatch
  const program = dispatch.program

  // Compute the charge.
  const durationHours = Math.max(
    0.001,
    (dispatch.endTime.getTime() - dispatch.startTime.getTime()) / 3600000,
  )
  const buyerDeliveredKwh = commitment.buyerDeliveredKwh ? parseFloat(commitment.buyerDeliveredKwh) : 0
  const committedKw = parseFloat(commitment.committedKw)
  const pricePerKwh = parseFloat(program.pricePerKwh)
  const fulfillmentPct = commitment.fulfillmentPct ? parseFloat(commitment.fulfillmentPct) : 0
  const toleranceThresholdPct = parseFloat(commitment.toleranceThresholdPct)
  const currency = program.currency

  const charge = computeBuyerCharge({
    buyerDeliveredKwh,
    committedKw,
    durationHours,
    pricePerKwh,
    fulfillmentPct,
    toleranceThresholdPct,
    currency,
  })

  // Create the settlement record (pending → charged).
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
      status: 'charging',
    },
  })

  // Post the buyer charge to the ledger (if charge > 0).
  let ledgerPostingId: string | null = null
  let buyerFundsBalanceAfter = 0

  if (charge.buyerCharge > 0) {
    const buyerAccount = await ensureBuyerFundsAccount(tenantId, currency)
    const revenueAccount = await ensurePlatformAccount(tenantId, currency, 'revenue')

    // Lock the buyer funds account for the funding check.
    await db.$queryRaw`
      SELECT * FROM "LedgerAccount"
      WHERE "id" = ${buyerAccount.id}
      FOR UPDATE
    `

    const balance = await computeBalance(tenantId, buyerAccount.id)
    const balanceNum = balance.toNumber()
    buyerFundsBalanceAfter = balanceNum - charge.buyerCharge

    if (balanceNum < charge.buyerCharge) {
      // Insufficient buyer funds — mark settlement as failed.
      await db.vppBuyerSettlement.update({
        where: { id: settlement.id },
        data: { status: 'failed' },
      })
      throw new ValidationError(
        `Insufficient buyer funds for settlement: balance ${balanceNum.toFixed(2)} ${currency} ` +
          `< charge ${charge.buyerCharge.toFixed(2)} ${currency}. Buyer must be pre-funded.`,
      )
    }

    // Post the charge: debit buyer_funds, credit buyer_revenue.
    const posting = await postBalancedPosting({
      tenantId,
      idempotencyKey: `buyer-settlement-${settlement.id}`,
      postingType: 'buyer_charge',
      referenceType: 'vpp_portfolio_commitment',
      referenceId: commitment.id,
      entries: [
        {
          accountId: buyerAccount.id,
          amount: new Prisma.Decimal(-charge.buyerCharge), // debit (reduces liability)
          entryType: 'buyer_charge_debit',
        },
        {
          accountId: revenueAccount.id,
          amount: new Prisma.Decimal(charge.buyerCharge), // credit (increases revenue)
          entryType: 'buyer_charge_credit',
        },
      ],
    })
    ledgerPostingId = posting.posting_id
  }

  // Mark settlement as charged.
  await db.vppBuyerSettlement.update({
    where: { id: settlement.id },
    data: {
      status: 'charged',
      ledgerPostingId,
      buyerFundsBalanceAfter: buyerFundsBalanceAfter.toString(),
      chargedAt: new Date(),
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
      buyerCharge: charge.buyerCharge,
      currency: charge.currency,
      fulfillmentPct: charge.fulfillmentPct,
      metTolerance: charge.metTolerance,
      shortfall: charge.shortfall,
      ledgerPostingId,
    },
  })

  return {
    settlementId: settlement.id,
    dispatchId,
    commitmentId: commitment.id,
    status: 'charged',
    charge,
    ledgerPostingId,
    buyerFundsBalanceAfter,
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export async function getBuyerSettlement(tenantId: string, dispatchId: string) {
  const settlement = await db.vppBuyerSettlement.findUnique({
    where: { dispatchId },
  })
  if (!settlement) throw new NotFoundError('vpp_buyer_settlement', dispatchId)
  if (settlement.tenantId !== tenantId) throw new NotFoundError('vpp_buyer_settlement', dispatchId)
  return settlement
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getBuyerSettlementResult(
  settlement: any,
  commitment: any,
): Promise<BuyerSettlementResult> {
  return {
    settlementId: settlement.id,
    dispatchId: settlement.dispatchId,
    commitmentId: settlement.commitmentId,
    status: settlement.status,
    charge: {
      buyerDeliveredKwh: parseFloat(settlement.buyerDeliveredKwh),
      pricePerKwh: parseFloat(settlement.pricePerKwh),
      deliveredCharge: parseFloat(settlement.deliveredCharge),
      capacityCeiling: parseFloat(settlement.capacityCeiling),
      cappedCharge: parseFloat(settlement.cappedCharge),
      fulfillmentPct: parseFloat(settlement.fulfillmentPct),
      toleranceThresholdPct: parseFloat(settlement.toleranceThresholdPct),
      metTolerance: settlement.metTolerance,
      buyerCharge: parseFloat(settlement.buyerCharge),
      currency: settlement.currency,
      shortfall: parseFloat(settlement.shortfall),
    },
    ledgerPostingId: settlement.ledgerPostingId,
    buyerFundsBalanceAfter: settlement.buyerFundsBalanceAfter ? parseFloat(settlement.buyerFundsBalanceAfter) : 0,
  }
}
