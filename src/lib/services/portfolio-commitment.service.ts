// =============================================================================
// VPP-2D-4: Portfolio Commitment Service
// =============================================================================
// Connects the reserved portfolio to the actual buyer obligation.
//
// THE FLOW:
//
//   Buyer request (500 kW, 14:00–16:00)
//         ↓
//   Optimizer → reserve (DER A 120 kW, DER B 90 kW, DER C 75 kW, DER D 215 kW)
//         ↓
//   VppPortfolioCommitment created (status=pending, committedKw=500)
//         ↓
//   Dispatch → individual assignments execute (per-assignment pipeline)
//         ↓
//   Each assignment completes → actualKwh, baselineKwh, performanceKwh recorded
//         ↓
//   evaluatePortfolioCommitment():
//     - Aggregate individual results: Σ actualKwh, Σ baselineKwh, Σ performanceKwh
//     - Convert to aggregate kW (deliveredKw = deliveredKwh / durationHours)
//     - fulfillmentPct = deliveredKw / committedKw * 100
//     - status = fulfilled (≥ tolerance) | partial (< tolerance but > 0) | failed (0)
//         ↓
//   Buyer-facing obligation record:
//     "500 kW committed, 462 kW delivered, 92.4% fulfillment → fulfilled"
//
// =============================================================================
// ARCHITECTURAL RULE (from the reviewer)
// =============================================================================
//
//   The portfolio layer is ABOVE the generic economic kernel:
//
//     VPP Portfolio Commitment (buyer-facing obligation)
//            ↓
//     individual Contributions (per-assignment verified performance)
//            ↓
//     generic Reward (per-contribution, operator payment)
//            ↓
//     generic Ledger (double-entry)
//            ↓
//     generic Settlement (per-reward payout)
//
//   Do NOT create PortfolioLedger, PortfolioReward, or PortfolioSettlement.
//   The individual assignment rewards/settlements remain the source of truth
//   for operator payments. This model is the BUYER-FACING commitment
//   fulfillment record — it evaluates whether the platform delivered what
//   it promised, but it does not create new economic objects.
//
// =============================================================================
// FULFILLMENT POLICY
// =============================================================================
//
//   The buyer's obligation is fulfilled when:
//     fulfillmentPct = (deliveredKw / committedKw) * 100 ≥ toleranceThresholdPct
//
//   Default tolerance: 90% (the platform must deliver at least 90% of the
//   committed capacity for the obligation to count as fulfilled).
//
//   Status mapping:
//     fulfillmentPct ≥ tolerance  → fulfilled
//     0 < fulfillmentPct < tolerance → partial
//     fulfillmentPct = 0 → failed
//
//   The tolerance is configurable per commitment (some buyers may require
//   100%, others may accept 80%).
//
// =============================================================================
// AGGREGATION MATH
// =============================================================================
//
//   Per-assignment (already computed by the baseline engine):
//     actualKwh_i  = total energy discharged by asset i
//     baselineKwh_i = predicted counterfactual energy
//     performanceKwh_i = max(0, actualKwh_i - baselineKwh_i)  [per-asset clipping]
//
//   Portfolio aggregate:
//     totalActualKwh    = Σ actualKwh_i
//     totalBaselineKwh  = Σ baselineKwh_i
//     deliveredKwh      = Σ performanceKwh_i  [NOTE: clipping is per-asset,
//                          NOT max(0, Σactual - Σbaseline). This matters:
//                          an asset that underperforms its baseline
//                          contributes 0, not a negative offset.]
//
//   deliveredKw = deliveredKwh / durationHours
//     (convert aggregate energy to average power over the dispatch window)
//
//   fulfillmentPct = (deliveredKw / committedKw) * 100
//
// =============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The result of creating a portfolio commitment.
 */
export interface PortfolioCommitmentResult {
  commitmentId: string
  dispatchId: string
  requestedKw: number
  committedKw: number
  confidenceLevel: number
  algorithm: string
  optimalityGuarantee: string
  toleranceThresholdPct: number
  status: string
  assignmentCount: number
}

/**
 * The result of evaluating a portfolio commitment (after assignments complete).
 */
export interface PortfolioFulfillmentResult {
  commitmentId: string
  dispatchId: string
  status: 'fulfilled' | 'partial' | 'failed'
  committedKw: number
  deliveredKw: number
  deliveredKwh: number
  totalActualKwh: number
  totalBaselineKwh: number
  fulfillmentPct: number
  toleranceThresholdPct: number
  assignmentCount: number
  completedAssignments: number
  perAsset: Array<{
    assetId: string
    assignmentId: string
    actualKwh: number
    baselineKwh: number
    performanceKwh: number
    status: string
  }>
}

// ---------------------------------------------------------------------------
// Create a portfolio commitment
// ---------------------------------------------------------------------------

/**
 * Create a portfolio commitment for a VPP dispatch.
 *
 * Called after the optimizer has reserved capacity for a buyer request.
 * Records what was promised (requestedKw, committedKw) and the fulfillment
 * policy (tolerance threshold). The commitment starts in 'pending' status
 * and is evaluated after the dispatch completes.
 *
 * @param tenantId     Tenant scope
 * @param dispatchId   The VppDispatch ID
 * @param input        The commitment parameters
 */
export async function createPortfolioCommitment(
  tenantId: string,
  dispatchId: string,
  input: {
    requestedKw: number
    requestedKwh: number
    confidenceLevel: number
    committedKw: number
    algorithm?: string
    optimalityGuarantee?: string
    toleranceThresholdPct?: number
    assignmentCount: number
  },
  actorId?: string,
): Promise<PortfolioCommitmentResult> {
  // Verify the dispatch exists and belongs to the tenant.
  const dispatch = await db.vppDispatch.findFirst({
    where: { id: dispatchId, tenantId },
  })
  if (!dispatch) throw new NotFoundError('vpp_dispatch', dispatchId)

  // Check if a commitment already exists (idempotent — 1:1 with dispatch).
  const existing = await db.vppPortfolioCommitment.findUnique({
    where: { dispatchId },
  })
  if (existing) {
    return {
      commitmentId: existing.id,
      dispatchId: existing.dispatchId,
      requestedKw: parseFloat(existing.requestedKw),
      committedKw: parseFloat(existing.committedKw),
      confidenceLevel: parseFloat(existing.confidenceLevel),
      algorithm: existing.algorithm,
      optimalityGuarantee: existing.optimalityGuarantee,
      toleranceThresholdPct: parseFloat(existing.toleranceThresholdPct),
      status: existing.status,
      assignmentCount: existing.assignmentCount,
    }
  }

  const commitment = await db.vppPortfolioCommitment.create({
    data: {
      tenantId,
      dispatchId,
      requestedKw: input.requestedKw.toString(),
      requestedKwh: input.requestedKwh.toString(),
      confidenceLevel: input.confidenceLevel.toString(),
      committedKw: input.committedKw.toString(),
      algorithm: input.algorithm ?? 'greedy_lexicographic_marginal_safe_capacity',
      optimalityGuarantee: input.optimalityGuarantee ?? 'heuristic',
      toleranceThresholdPct: (input.toleranceThresholdPct ?? 90).toString(),
      assignmentCount: input.assignmentCount,
    },
  })

  await appendAudit({
    tenantId,
    actorId,
    eventType: 'vpp.portfolio_commitment_created',
    resourceType: 'vpp_portfolio_commitment',
    resourceId: commitment.id,
    metadata: {
      dispatchId,
      requestedKw: input.requestedKw,
      committedKw: input.committedKw,
      confidenceLevel: input.confidenceLevel,
      assignmentCount: input.assignmentCount,
    },
  })

  return {
    commitmentId: commitment.id,
    dispatchId: commitment.dispatchId,
    requestedKw: input.requestedKw,
    committedKw: input.committedKw,
    confidenceLevel: input.confidenceLevel,
    algorithm: commitment.algorithm,
    optimalityGuarantee: commitment.optimalityGuarantee,
    toleranceThresholdPct: input.toleranceThresholdPct ?? 90,
    status: commitment.status,
    assignmentCount: input.assignmentCount,
  }
}

// ---------------------------------------------------------------------------
// Evaluate a portfolio commitment
// ---------------------------------------------------------------------------

/**
 * Evaluate a portfolio commitment after assignments have completed.
 *
 * Aggregates individual assignment results (actualKwh, baselineKwh,
 * performanceKwh) into portfolio-level metrics:
 *   - totalActualKwh = Σ actualKwh_i
 *   - totalBaselineKwh = Σ baselineKwh_i
 *   - deliveredKwh = Σ performanceKwh_i  (per-asset clipping, then summed)
 *   - deliveredKw = deliveredKwh / durationHours
 *   - fulfillmentPct = deliveredKw / committedKw * 100
 *   - status = fulfilled (≥ tolerance) | partial | failed
 *
 * IMPORTANT: This does NOT create new economic objects. The individual
 * assignment Contributions → Rewards → Ledger → Settlements are the source
 * of truth for operator payments. This evaluation is the buyer-facing
 * obligation fulfillment record.
 *
 * @param tenantId      Tenant scope
 * @param dispatchId    The VppDispatch ID
 */
export async function evaluatePortfolioCommitment(
  tenantId: string,
  dispatchId: string,
  actorId?: string,
): Promise<PortfolioFulfillmentResult> {
  const commitment = await db.vppPortfolioCommitment.findUnique({
    where: { dispatchId },
    include: {
      dispatch: {
        include: {
          assignments: {
            include: { baseline: true },
          },
        },
      },
    },
  })
  if (!commitment) throw new NotFoundError('vpp_portfolio_commitment', dispatchId)
  if (commitment.tenantId !== tenantId) throw new NotFoundError('vpp_portfolio_commitment', dispatchId)

  const dispatch = commitment.dispatch
  const assignments = dispatch.assignments

  // Aggregate per-assignment results.
  const perAsset: PortfolioFulfillmentResult['perAsset'] = []
  let totalActualKwh = new Prisma.Decimal(0)
  let totalBaselineKwh = new Prisma.Decimal(0)
  let deliveredKwh = new Prisma.Decimal(0)
  let completedCount = 0

  for (const assignment of assignments) {
    const actualKwh = assignment.actualKwh ? new Prisma.Decimal(assignment.actualKwh) : new Prisma.Decimal(0)
    const baselineKwh = assignment.baselineKwh ? new Prisma.Decimal(assignment.baselineKwh) : new Prisma.Decimal(0)
    const performanceKwh = assignment.performanceKwh ? new Prisma.Decimal(assignment.performanceKwh) : new Prisma.Decimal(0)

    totalActualKwh = totalActualKwh.plus(actualKwh)
    totalBaselineKwh = totalBaselineKwh.plus(baselineKwh)
    // NOTE: performanceKwh is already per-asset clipped (max(0, actual-baseline))
    // by the baseline engine. We sum the clipped values — an asset that
    // underperforms its baseline contributes 0, not a negative offset.
    deliveredKwh = deliveredKwh.plus(performanceKwh)

    if (assignment.status === 'completed') completedCount++

    perAsset.push({
      assetId: assignment.assetId,
      assignmentId: assignment.id,
      actualKwh: actualKwh.toNumber(),
      baselineKwh: baselineKwh.toNumber(),
      performanceKwh: performanceKwh.toNumber(),
      status: assignment.status,
    })
  }

  // Convert aggregate energy to average power over the dispatch window.
  const durationHours = Math.max(
    0.001, // avoid division by zero
    (dispatch.endTime.getTime() - dispatch.startTime.getTime()) / 3600000,
  )
  const deliveredKw = deliveredKwh.div(durationHours)

  // Fulfillment percentage: deliveredKw / committedKw * 100
  const committedKw = new Prisma.Decimal(commitment.committedKw)
  const fulfillmentPct = committedKw.greaterThan(0)
    ? deliveredKw.div(committedKw).mul(100)
    : new Prisma.Decimal(0)

  // Status: fulfilled (≥ tolerance) | partial | failed
  const tolerance = new Prisma.Decimal(commitment.toleranceThresholdPct)
  let status: 'fulfilled' | 'partial' | 'failed'
  if (fulfillmentPct.toNumber() >= tolerance.toNumber()) {
    status = 'fulfilled'
  } else if (deliveredKwh.greaterThan(0)) {
    status = 'partial'
  } else {
    status = 'failed'
  }

  // Update the commitment record.
  await db.vppPortfolioCommitment.update({
    where: { id: commitment.id },
    data: {
      deliveredKw: deliveredKw.toString(),
      deliveredKwh: deliveredKwh.toString(),
      totalBaselineKwh: totalBaselineKwh.toString(),
      totalActualKwh: totalActualKwh.toString(),
      fulfillmentPct: fulfillmentPct.toString(),
      status,
      completedAssignments: completedCount,
      evaluatedAt: new Date(),
      metadataJson: JSON.stringify({
        perAsset,
        durationHours,
        evaluatedAt: new Date().toISOString(),
      }),
    },
  })

  await appendAudit({
    tenantId,
    actorId,
    eventType: 'vpp.portfolio_commitment_evaluated',
    resourceType: 'vpp_portfolio_commitment',
    resourceId: commitment.id,
    metadata: {
      dispatchId,
      status,
      committedKw: committedKw.toString(),
      deliveredKw: deliveredKw.toString(),
      deliveredKwh: deliveredKwh.toString(),
      fulfillmentPct: fulfillmentPct.toString(),
      toleranceThresholdPct: commitment.toleranceThresholdPct,
      completedAssignments: completedCount,
      totalAssignments: assignments.length,
    },
  })

  return {
    commitmentId: commitment.id,
    dispatchId,
    status,
    committedKw: committedKw.toNumber(),
    deliveredKw: deliveredKw.toNumber(),
    deliveredKwh: deliveredKwh.toNumber(),
    totalActualKwh: totalActualKwh.toNumber(),
    totalBaselineKwh: totalBaselineKwh.toNumber(),
    fulfillmentPct: fulfillmentPct.toNumber(),
    toleranceThresholdPct: tolerance.toNumber(),
    assignmentCount: assignments.length,
    completedAssignments: completedCount,
    perAsset,
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Get a portfolio commitment by dispatch ID.
 */
export async function getPortfolioCommitment(
  tenantId: string,
  dispatchId: string,
) {
  const commitment = await db.vppPortfolioCommitment.findUnique({
    where: { dispatchId },
    include: {
      dispatch: {
        include: {
          assignments: {
            select: {
              id: true,
              assetId: true,
              status: true,
              actualKwh: true,
              baselineKwh: true,
              performanceKwh: true,
              assignedKw: true,
            },
          },
        },
      },
    },
  })
  if (!commitment) throw new NotFoundError('vpp_portfolio_commitment', dispatchId)
  if (commitment.tenantId !== tenantId) throw new NotFoundError('vpp_portfolio_commitment', dispatchId)
  return commitment
}

// ---------------------------------------------------------------------------
// Pure computation helper (for testing without DB)
// ---------------------------------------------------------------------------

/**
 * Pure function: compute portfolio fulfillment from per-assignment results.
 *
 * This is the core aggregation math, extracted for testing. It does NOT
 * touch the database.
 *
 * Per-asset clipping: performanceKwh_i = max(0, actualKwh_i - baselineKwh_i).
 * The clipping is per-asset BEFORE summation — an asset that underperforms
 * its baseline contributes 0, not a negative offset to the portfolio.
 *
 * @param perAsset     Per-assignment actual/baseline/performance values
 * @param committedKw  The optimizer's committed kW
 * @param durationHours The dispatch window duration
 * @param toleranceThresholdPct  The fulfillment threshold (default 90)
 */
export function computePortfolioFulfillment(
  perAsset: Array<{
    assetId: string
    actualKwh: number
    baselineKwh: number
    performanceKwh: number
  }>,
  committedKw: number,
  durationHours: number,
  toleranceThresholdPct = 90,
): {
  deliveredKwh: number
  deliveredKw: number
  totalActualKwh: number
  totalBaselineKwh: number
  fulfillmentPct: number
  toleranceThresholdPct: number
  status: 'fulfilled' | 'partial' | 'failed'
} {
  let totalActualKwh = 0
  let totalBaselineKwh = 0
  let deliveredKwh = 0

  for (const asset of perAsset) {
    totalActualKwh += asset.actualKwh
    totalBaselineKwh += asset.baselineKwh
    // Sum the per-asset-clipped performance. An asset that underperforms
    // its baseline contributes 0 (the clipping already happened in the
    // baseline engine), NOT a negative offset.
    deliveredKwh += Math.max(0, asset.performanceKwh)
  }

  const safeDuration = Math.max(0.001, durationHours)
  const deliveredKw = deliveredKwh / safeDuration

  const fulfillmentPct = committedKw > 0 ? (deliveredKw / committedKw) * 100 : 0

  let status: 'fulfilled' | 'partial' | 'failed'
  if (fulfillmentPct >= toleranceThresholdPct) {
    status = 'fulfilled'
  } else if (deliveredKwh > 0) {
    status = 'partial'
  } else {
    status = 'failed'
  }

  return {
    deliveredKwh,
    deliveredKw,
    totalActualKwh,
    totalBaselineKwh,
    fulfillmentPct,
    toleranceThresholdPct,
    status,
  }
}
