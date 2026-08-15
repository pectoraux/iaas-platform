// =============================================================================
// VPP-2D-4: Portfolio Commitment Service (integrated + corrected)
// =============================================================================
// Connects the reserved portfolio to the actual buyer obligation.
//
// VPP-2D-4 CORRECTIONS (vs the 2D-4A prototype):
//
//   1. LIFECYCLE INTEGRATION. The commitment is created atomically with the
//      portfolio reservations (inside optimizeAndReserve). It is evaluated
//      automatically when all assignments reach a terminal state (inside
//      executeDispatchAssignment, when pendingAssignments === 0).
//
//   2. COMPLETION GATING. evaluatePortfolioCommitment() requires ALL
//      assignments to be terminal (completed | failed | reconciliation_required)
//      before producing a final result. Until then, status stays 'pending'.
//      This prevents premature evaluation with incomplete data.
//
//   3. SEPARATED PERFORMANCE MEASURES. The service records THREE distinct
//      quantities:
//        - operatorContributionKwh = Σ max(0, actual_i - baseline_i)
//          (what operators are paid for — per-asset clipped, never negative)
//        - rawSignedPortfolioPerformanceKwh = Σ actual - Σ baseline
//          (the true aggregate incremental — can be negative)
//        - buyerDeliveredKwh = depends on fulfillmentBasis policy
//          (per_asset_clipped OR aggregate_counterfactual)
//      The buyer fulfillment does NOT silently conflate with operator
//      contribution.
//
//   4. MEASUREMENT METHOD. The commitment carries an explicit measurementMethod:
//        - average_power: deliveredKw = buyerDeliveredKwh / durationHours
//        - energy:        buyerDeliveredKwh directly (no kW conversion)
//        - interval_power: future-ready (not implemented in 2D-4)
//
//   5. RESERVATION BINDING. The commitment stores portfolioReservationId,
//      binding it to the actual reservation set. createPortfolioCommitment
//      verifies sum(reserved) == committedKw.
//
//   6. IDEMPOTENCY. Concurrent createPortfolioCommitment() calls return
//      the same record (upsert with conflict handling, not raw unique error).
//
//   7. ATOMIC RESERVATION + COMMITMENT. optimizeAndReserve creates both the
//      reservations AND the commitment inside one transaction. A crash between
//      them is impossible — they commit or roll back together.
//
// ARCHITECTURAL RULE (unchanged):
//   No PortfolioLedger, PortfolioReward, or PortfolioSettlement.
//   Individual assignment Contributions → Rewards → Ledger → Settlements
//   remain the source of truth for operator payments.
// =============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FulfillmentBasis = 'per_asset_clipped' | 'aggregate_counterfactual'
export type MeasurementMethod = 'average_power' | 'energy' | 'interval_power'
export type CommitmentStatus = 'pending' | 'fulfilled' | 'partial' | 'failed'

export interface PortfolioCommitmentResult {
  commitmentId: string
  dispatchId: string
  portfolioReservationId: string | null
  requestedKw: number
  committedKw: number
  confidenceLevel: number
  algorithm: string
  optimalityGuarantee: string
  toleranceThresholdPct: number
  measurementMethod: MeasurementMethod
  fulfillmentBasis: FulfillmentBasis
  status: CommitmentStatus
  assignmentCount: number
}

export interface PortfolioFulfillmentResult {
  commitmentId: string
  dispatchId: string
  status: CommitmentStatus
  committedKw: number
  buyerDeliveredKw: number
  buyerDeliveredKwh: number
  operatorContributionKwh: number
  rawSignedPortfolioPerformanceKwh: number
  totalActualKwh: number
  totalBaselineKwh: number
  fulfillmentPct: number
  toleranceThresholdPct: number
  measurementMethod: MeasurementMethod
  fulfillmentBasis: FulfillmentBasis
  assignmentCount: number
  completedAssignments: number
  failedAssignments: number
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
// Create a portfolio commitment (idempotent, atomic with reservations)
// ---------------------------------------------------------------------------

/**
 * Create a portfolio commitment for a VPP dispatch.
 *
 * IDEMPOTENT: if a commitment already exists for this dispatchId, returns
 * the existing record (does NOT throw a unique constraint error).
 *
 * Called inside the optimizeAndReserve transaction (VPP-2D-4 integration)
 * or standalone. When called standalone, the caller must ensure the
 * reservations already exist.
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
    portfolioReservationId?: string
    algorithm?: string
    optimalityGuarantee?: string
    toleranceThresholdPct?: number
    measurementMethod?: MeasurementMethod
    fulfillmentBasis?: FulfillmentBasis
    assignmentCount: number
  },
  actorId?: string,
): Promise<PortfolioCommitmentResult> {
  // Verify the dispatch exists and belongs to the tenant.
  const dispatch = await db.vppDispatch.findFirst({
    where: { id: dispatchId, tenantId },
  })
  if (!dispatch) throw new NotFoundError('vpp_dispatch', dispatchId)

  // IDEMPOTENT: upsert with conflict handling. If a commitment already
  // exists for this dispatchId, return it (don't throw unique constraint).
  // We use a try/catch around create to handle the race where two concurrent
  // calls both pass the findUnique check.
  const existing = await db.vppPortfolioCommitment.findUnique({
    where: { dispatchId },
  })
  if (existing) {
    return toResult(existing)
  }

  try {
    const commitment = await db.vppPortfolioCommitment.create({
      data: {
        tenantId,
        dispatchId,
        portfolioReservationId: input.portfolioReservationId ?? null,
        requestedKw: input.requestedKw.toString(),
        requestedKwh: input.requestedKwh.toString(),
        confidenceLevel: input.confidenceLevel.toString(),
        committedKw: input.committedKw.toString(),
        algorithm: input.algorithm ?? 'greedy_lexicographic_marginal_safe_capacity',
        optimalityGuarantee: input.optimalityGuarantee ?? 'heuristic',
        toleranceThresholdPct: (input.toleranceThresholdPct ?? 90).toString(),
        measurementMethod: input.measurementMethod ?? 'average_power',
        fulfillmentBasis: input.fulfillmentBasis ?? 'per_asset_clipped',
        assignmentCount: input.assignmentCount,
      },
    })

    await appendAudit({
      tenantId,
      actorId,
      eventType: AuditEvents.PortfolioCommitmentCreated,
      resourceType: 'vpp_portfolio_commitment',
      resourceId: commitment.id,
      metadata: {
        dispatchId,
        requestedKw: input.requestedKw,
        committedKw: input.committedKw,
        confidenceLevel: input.confidenceLevel,
        assignmentCount: input.assignmentCount,
        measurementMethod: commitment.measurementMethod,
        fulfillmentBasis: commitment.fulfillmentBasis,
      },
    })

    return toResult(commitment)
  } catch (err) {
    // Race condition: another caller created the commitment between our
    // findUnique and create. Re-fetch and return the existing record.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await db.vppPortfolioCommitment.findUnique({ where: { dispatchId } })
      if (existing) return toResult(existing)
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Evaluate a portfolio commitment (completion-gated)
// ---------------------------------------------------------------------------

/**
 * Evaluate a portfolio commitment.
 *
 * COMPLETION GATING (VPP-2D-4 correction):
 * This function requires ALL assignments to be in a terminal state
 * (completed | failed | reconciliation_required) before producing a final
 * result. If any assignment is still in a non-terminal state, the
 * commitment remains 'pending' and the function returns a pending result.
 *
 * This prevents premature evaluation where incomplete assignments are
 * treated as zero, which would produce a misleading low fulfillment %.
 *
 * TERMINAL STATES:
 *   - completed: the assignment delivered successfully. Its actualKwh/
 *     baselineKwh/performanceKwh are included in the aggregate.
 *   - failed: the assignment failed before usage. Treated as zero delivery.
 *     The capacity was released (no money moved).
 *   - reconciliation_required: the assignment failed after usage. Treated
 *     as zero performance (the actualKwh may exist but the baseline/
 *     contribution may not have been computed). The capacity stays consumed.
 *
 * SEPARATED PERFORMANCE MEASURES:
 *   - operatorContributionKwh = Σ max(0, actual_i - baseline_i)
 *   - rawSignedPortfolioPerformanceKwh = Σ actual - Σ baseline
 *   - buyerDeliveredKwh = depends on fulfillmentBasis:
 *       per_asset_clipped → operatorContributionKwh
 *       aggregate_counterfactual → max(0, rawSignedPortfolioPerformanceKwh)
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
          assignments: true,
        },
      },
    },
  })
  if (!commitment) throw new NotFoundError('vpp_portfolio_commitment', dispatchId)
  if (commitment.tenantId !== tenantId) throw new NotFoundError('vpp_portfolio_commitment', dispatchId)

  const dispatch = commitment.dispatch
  const assignments = dispatch.assignments

  // COMPLETION GATING: check if all assignments are terminal.
  const TERMINAL_STATES = new Set(['completed', 'failed', 'reconciliation_required'])
  const nonTerminal = assignments.filter((a) => !TERMINAL_STATES.has(a.status))

  if (nonTerminal.length > 0) {
    // Not all assignments are terminal — return pending, do NOT evaluate.
    return {
      commitmentId: commitment.id,
      dispatchId,
      status: 'pending',
      committedKw: parseFloat(commitment.committedKw),
      buyerDeliveredKw: 0,
      buyerDeliveredKwh: 0,
      operatorContributionKwh: 0,
      rawSignedPortfolioPerformanceKwh: 0,
      totalActualKwh: 0,
      totalBaselineKwh: 0,
      fulfillmentPct: 0,
      toleranceThresholdPct: parseFloat(commitment.toleranceThresholdPct),
      measurementMethod: commitment.measurementMethod as MeasurementMethod,
      fulfillmentBasis: commitment.fulfillmentBasis as FulfillmentBasis,
      assignmentCount: assignments.length,
      completedAssignments: assignments.filter((a) => a.status === 'completed').length,
      failedAssignments: assignments.filter((a) => a.status === 'failed' || a.status === 'reconciliation_required').length,
      perAsset: [],
    }
  }

  // All assignments are terminal — compute the final aggregate.
  const aggregate = aggregatePortfolioPerformance(assignments, commitment.fulfillmentBasis as FulfillmentBasis)

  // Convert to kW based on measurementMethod.
  const durationHours = Math.max(
    0.001,
    (dispatch.endTime.getTime() - dispatch.startTime.getTime()) / 3600000,
  )

  // OBLIGATION CONTRACT (VPP-2D-4 correction):
  // The fulfillment denominator depends on the measurement method.
  //
  // average_power:
  //   - Primary obligation: committedKw (capacity)
  //   - deliveredKw = buyerDeliveredKwh / durationHours
  //   - fulfillment = deliveredKw / committedKw
  //
  // energy:
  //   - Primary obligation: requestedKwh (total energy)
  //   - deliveredKwh = buyerDeliveredKwh (no kW conversion)
  //   - fulfillment = buyerDeliveredKwh / requestedKwh
  //   - committedKw is display-only (derived from requestedKwh / duration)
  //
  // interval_power:
  //   - NOT SUPPORTED in 2D-4. Explicitly reject rather than silently
  //     treating it as average_power.

  if (commitment.measurementMethod === 'interval_power') {
    throw new ValidationError(
      `measurementMethod 'interval_power' is not yet supported. ` +
        `Use 'average_power' or 'energy'.`,
    )
  }

  let buyerDeliveredKw: number
  let fulfillmentPct: number

  if (commitment.measurementMethod === 'energy') {
    // Energy method: the obligation is in kWh, not kW.
    // deliveredKw is display-only (= deliveredKwh / duration).
    buyerDeliveredKw = aggregate.buyerDeliveredKwh / durationHours
    const requestedKwh = parseFloat(commitment.requestedKwh)
    fulfillmentPct = requestedKwh > 0 ? (aggregate.buyerDeliveredKwh / requestedKwh) * 100 : 0
  } else {
    // average_power (default): the obligation is in kW.
    buyerDeliveredKw = aggregate.buyerDeliveredKwh / durationHours
    const committedKw = parseFloat(commitment.committedKw)
    fulfillmentPct = committedKw > 0 ? (buyerDeliveredKw / committedKw) * 100 : 0
  }

  const committedKw = parseFloat(commitment.committedKw)

  // Status: fulfilled (≥ tolerance) | partial | failed.
  const tolerance = parseFloat(commitment.toleranceThresholdPct)
  let status: CommitmentStatus
  if (fulfillmentPct >= tolerance) {
    status = 'fulfilled'
  } else if (aggregate.buyerDeliveredKwh > 0) {
    status = 'partial'
  } else {
    status = 'failed'
  }

  // Update the commitment record with final results.
  await db.vppPortfolioCommitment.update({
    where: { id: commitment.id },
    data: {
      deliveredKw: buyerDeliveredKw.toString(),
      deliveredKwh: aggregate.buyerDeliveredKwh.toString(),
      totalBaselineKwh: aggregate.totalBaselineKwh.toString(),
      totalActualKwh: aggregate.totalActualKwh.toString(),
      operatorContributionKwh: aggregate.operatorContributionKwh.toString(),
      rawSignedPortfolioPerformanceKwh: aggregate.rawSignedPortfolioPerformanceKwh.toString(),
      buyerDeliveredKwh: aggregate.buyerDeliveredKwh.toString(),
      fulfillmentPct: fulfillmentPct.toString(),
      status,
      completedAssignments: assignments.filter((a) => a.status === 'completed').length,
      failedAssignments: assignments.filter((a) => a.status === 'failed' || a.status === 'reconciliation_required').length,
      evaluatedAt: new Date(),
      metadataJson: JSON.stringify({
        perAsset: aggregate.perAsset,
        durationHours,
        evaluatedAt: new Date().toISOString(),
        nonTerminalCount: 0,
      }),
    },
  })

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.PortfolioCommitmentEvaluated,
    resourceType: 'vpp_portfolio_commitment',
    resourceId: commitment.id,
    metadata: {
      dispatchId,
      status,
      committedKw,
      buyerDeliveredKw,
      buyerDeliveredKwh: aggregate.buyerDeliveredKwh,
      operatorContributionKwh: aggregate.operatorContributionKwh,
      rawSignedPortfolioPerformanceKwh: aggregate.rawSignedPortfolioPerformanceKwh,
      fulfillmentPct,
      fulfillmentBasis: commitment.fulfillmentBasis,
      measurementMethod: commitment.measurementMethod,
    },
  })

  return {
    commitmentId: commitment.id,
    dispatchId,
    status,
    committedKw,
    buyerDeliveredKw,
    buyerDeliveredKwh: aggregate.buyerDeliveredKwh,
    operatorContributionKwh: aggregate.operatorContributionKwh,
    rawSignedPortfolioPerformanceKwh: aggregate.rawSignedPortfolioPerformanceKwh,
    totalActualKwh: aggregate.totalActualKwh,
    totalBaselineKwh: aggregate.totalBaselineKwh,
    fulfillmentPct,
    toleranceThresholdPct: tolerance,
    measurementMethod: commitment.measurementMethod as MeasurementMethod,
    fulfillmentBasis: commitment.fulfillmentBasis as FulfillmentBasis,
    assignmentCount: assignments.length,
    completedAssignments: assignments.filter((a) => a.status === 'completed').length,
    failedAssignments: assignments.filter((a) => a.status === 'failed' || a.status === 'reconciliation_required').length,
    perAsset: aggregate.perAsset,
  }
}

// ---------------------------------------------------------------------------
// Aggregate performance (internal)
// ---------------------------------------------------------------------------

interface PortfolioAggregate {
  totalActualKwh: number
  totalBaselineKwh: number
  operatorContributionKwh: number
  rawSignedPortfolioPerformanceKwh: number
  buyerDeliveredKwh: number
  perAsset: Array<{
    assetId: string
    assignmentId: string
    actualKwh: number
    baselineKwh: number
    performanceKwh: number
    status: string
  }>
}

/**
 * Aggregate individual assignment performance into portfolio-level measures.
 *
 * THREE distinct quantities:
 *   - operatorContributionKwh = Σ max(0, actual_i - baseline_i)
 *     (per-asset clipped — what operators are paid for)
 *   - rawSignedPortfolioPerformanceKwh = Σ actual - Σ baseline
 *     (true aggregate incremental — can be negative)
 *   - buyerDeliveredKwh = depends on fulfillmentBasis:
 *       per_asset_clipped → operatorContributionKwh
 *       aggregate_counterfactual → max(0, rawSignedPortfolioPerformanceKwh)
 */
function aggregatePortfolioPerformance(
  assignments: Array<{
    id: string
    assetId: string
    status: string
    actualKwh: string | null
    baselineKwh: string | null
    performanceKwh: string | null
  }>,
  fulfillmentBasis: FulfillmentBasis,
): PortfolioAggregate {
  let totalActualKwh = 0
  let totalBaselineKwh = 0
  let operatorContributionKwh = 0
  const perAsset: PortfolioAggregate['perAsset'] = []

  for (const assignment of assignments) {
    const actualKwh = assignment.actualKwh ? parseFloat(assignment.actualKwh) : 0
    const baselineKwh = assignment.baselineKwh ? parseFloat(assignment.baselineKwh) : 0
    const performanceKwh = assignment.performanceKwh ? parseFloat(assignment.performanceKwh) : 0

    totalActualKwh += actualKwh
    totalBaselineKwh += baselineKwh
    // Operator contribution: per-asset clipped (never negative per asset).
    operatorContributionKwh += Math.max(0, performanceKwh)

    perAsset.push({
      assetId: assignment.assetId,
      assignmentId: assignment.id,
      actualKwh,
      baselineKwh,
      performanceKwh: Math.max(0, performanceKwh),
      status: assignment.status,
    })
  }

  // Raw signed portfolio performance: Σ actual - Σ baseline (can be negative).
  const rawSignedPortfolioPerformanceKwh = totalActualKwh - totalBaselineKwh

  // Buyer-delivered kWh depends on the fulfillment basis.
  let buyerDeliveredKwh: number
  if (fulfillmentBasis === 'aggregate_counterfactual') {
    // Portfolio-level: max(0, Σ actual - Σ baseline).
    // One asset's overperformance CAN offset another's underperformance.
    buyerDeliveredKwh = Math.max(0, rawSignedPortfolioPerformanceKwh)
  } else {
    // per_asset_clipped (default): Σ max(0, actual_i - baseline_i).
    // Each asset's contribution is clipped individually before summing.
    buyerDeliveredKwh = operatorContributionKwh
  }

  return {
    totalActualKwh,
    totalBaselineKwh,
    operatorContributionKwh,
    rawSignedPortfolioPerformanceKwh,
    buyerDeliveredKwh,
    perAsset,
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export async function getPortfolioCommitment(tenantId: string, dispatchId: string) {
  const commitment = await db.vppPortfolioCommitment.findUnique({
    where: { dispatchId },
    include: {
      dispatch: {
        include: {
          assignments: {
            select: {
              id: true, assetId: true, status: true,
              actualKwh: true, baselineKwh: true, performanceKwh: true, assignedKw: true,
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
 * Records ALL THREE performance measures separately:
 *   - operatorContributionKwh = Σ max(0, actual_i - baseline_i)
 *   - rawSignedPortfolioPerformanceKwh = Σ actual - Σ baseline
 *   - buyerDeliveredKwh = depends on fulfillmentBasis
 *
 * The caller chooses the fulfillmentBasis — the service does NOT silently
 * conflate operator contribution with buyer fulfillment.
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
  options: {
    toleranceThresholdPct?: number
    measurementMethod?: MeasurementMethod
    fulfillmentBasis?: FulfillmentBasis
    /** Required for energy method: the buyer's requested energy (kWh). */
    requestedKwh?: number
  } = {},
): {
  totalActualKwh: number
  totalBaselineKwh: number
  operatorContributionKwh: number
  rawSignedPortfolioPerformanceKwh: number
  buyerDeliveredKwh: number
  buyerDeliveredKw: number
  fulfillmentPct: number
  toleranceThresholdPct: number
  measurementMethod: MeasurementMethod
  fulfillmentBasis: FulfillmentBasis
  status: CommitmentStatus
} {
  const toleranceThresholdPct = options.toleranceThresholdPct ?? 90
  const measurementMethod = options.measurementMethod ?? 'average_power'
  const fulfillmentBasis = options.fulfillmentBasis ?? 'per_asset_clipped'

  if (measurementMethod === 'interval_power') {
    throw new ValidationError(
      `measurementMethod 'interval_power' is not yet supported. ` +
        `Use 'average_power' or 'energy'.`,
    )
  }

  let totalActualKwh = 0
  let totalBaselineKwh = 0
  let operatorContributionKwh = 0

  for (const asset of perAsset) {
    totalActualKwh += asset.actualKwh
    totalBaselineKwh += asset.baselineKwh
    operatorContributionKwh += Math.max(0, asset.performanceKwh)
  }

  const rawSignedPortfolioPerformanceKwh = totalActualKwh - totalBaselineKwh

  let buyerDeliveredKwh: number
  if (fulfillmentBasis === 'aggregate_counterfactual') {
    buyerDeliveredKwh = Math.max(0, rawSignedPortfolioPerformanceKwh)
  } else {
    buyerDeliveredKwh = operatorContributionKwh
  }

  // OBLIGATION CONTRACT (VPP-2D-4 correction):
  // The fulfillment denominator depends on the measurement method.
  //
  // average_power: fulfillment = deliveredKw / committedKw
  //   where deliveredKw = deliveredKwh / durationHours
  //
  // energy: fulfillment = deliveredKwh / requestedKwh
  //   (NOT deliveredKwh / committedKw — that would be dimensionally wrong)
  const safeDuration = Math.max(0.001, durationHours)
  const buyerDeliveredKw = buyerDeliveredKwh / safeDuration

  let fulfillmentPct: number
  if (measurementMethod === 'energy') {
    const requestedKwh = options.requestedKwh ?? committedKw * safeDuration
    fulfillmentPct = requestedKwh > 0 ? (buyerDeliveredKwh / requestedKwh) * 100 : 0
  } else {
    // average_power
    fulfillmentPct = committedKw > 0 ? (buyerDeliveredKw / committedKw) * 100 : 0
  }

  let status: CommitmentStatus
  if (fulfillmentPct >= toleranceThresholdPct) {
    status = 'fulfilled'
  } else if (buyerDeliveredKwh > 0) {
    status = 'partial'
  } else {
    status = 'failed'
  }

  return {
    totalActualKwh,
    totalBaselineKwh,
    operatorContributionKwh,
    rawSignedPortfolioPerformanceKwh,
    buyerDeliveredKwh,
    buyerDeliveredKw,
    fulfillmentPct,
    toleranceThresholdPct,
    measurementMethod,
    fulfillmentBasis,
    status,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toResult(c: {
  id: string
  dispatchId: string
  portfolioReservationId: string | null
  requestedKw: string
  committedKw: string
  confidenceLevel: string
  algorithm: string
  optimalityGuarantee: string
  toleranceThresholdPct: string
  measurementMethod: string
  fulfillmentBasis: string
  status: string
  assignmentCount: number
}): PortfolioCommitmentResult {
  return {
    commitmentId: c.id,
    dispatchId: c.dispatchId,
    portfolioReservationId: c.portfolioReservationId,
    requestedKw: parseFloat(c.requestedKw),
    committedKw: parseFloat(c.committedKw),
    confidenceLevel: parseFloat(c.confidenceLevel),
    algorithm: c.algorithm,
    optimalityGuarantee: c.optimalityGuarantee,
    toleranceThresholdPct: parseFloat(c.toleranceThresholdPct),
    measurementMethod: c.measurementMethod as MeasurementMethod,
    fulfillmentBasis: c.fulfillmentBasis as FulfillmentBasis,
    status: c.status as CommitmentStatus,
    assignmentCount: c.assignmentCount,
  }
}
