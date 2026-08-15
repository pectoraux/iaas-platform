// =============================================================================
// VPP-2D-2: Portfolio Optimizer
// =============================================================================
// THE CENTRAL QUESTION OF VPP-2D-2:
//
//   Given a pool of N available assets (each with uncertain performance,
//   availability probability, cluster/correlation membership, available
//   capacity, and optional cost), and a buyer requesting X kW at confidence
//   c, WHICH SUBSET of assets should the platform commit to satisfy the
//   request while minimizing risk, cost, and opportunity cost?
//
// This is the DePIN allocation problem: the platform is not merely a risk
// calculator — it is a distributed infrastructure allocator that selects
// which physical assets to commit to each buyer obligation.
//
// DESIGN PRINCIPLES
//
//   1. GENERIC, NOT VPP-SPECIFIC. The optimizer operates on abstract
//      "candidate assets" with uncertainty profiles. It does not import
//      VPP types or know about batteries/dispatches. The VPP layer (or
//      any future vertical) constructs candidates and calls the optimizer.
//
//   2. USES THE RISK ENGINE. Portfolio risk is computed via
//      computeSafeCapacity() from portfolio-risk.service.ts. The optimizer
//      evaluates candidate subsets by their safe-capacity output.
//
//   3. RESPECTS AVAILABLE CAPACITY. Each candidate carries an
//      `availableCapacityKw` (from the generic capacity layer's
//      getAvailableCapacity). The optimizer never commits more than is
//      physically available.
//
//   4. CORRELATION-AWARE DIVERSIFICATION. The optimizer prefers spreading
//      selections across clusters to maximize the diversification benefit.
//      Assets in the same cluster have higher correlation (common-mode
//      failure risk), so concentrating in one cluster raises portfolio
//      variance and lowers safe capacity.
//
//   5. MINIMIZES OPPORTUNITY COST. Each candidate can carry an optional
//      `opportunityCostPerKw` — the value of reserving this asset for other
//      uses. The optimizer breaks ties by preferring lower-opportunity-cost
//      assets (don't tie up high-value assets when lower-value ones suffice).
//
// ALGORITHM
//
//   The portfolio selection problem is NP-hard in general (it's a variant of
//   the knapsack problem with quadratic risk). For 2D-2 we use a GREEDY
//   algorithm with correlation-aware scoring:
//
//   1. Score each candidate by RISK-ADJUSTED MARGINAL CONTRIBUTION:
//        - expected kW (availability × capacity)
//        - inverse of within-cluster concentration (prefer new clusters)
//        - lower opportunity cost preferred
//
//   2. Iteratively add the highest-scoring candidate, recompute the
//      portfolio's safe capacity, and stop when the target is met or no
//      candidates remain.
//
//   3. After greedy selection, run a PRUNING pass: remove any asset whose
//      removal still leaves the portfolio above the target (the greedy
//      approach can over-select).
//
//   This is O(N²) in the number of candidates — fast enough for 1000+ DERs.
//   A future 2D-3 could add LP relaxation or genetic search for tighter
//   optima.
//
// FUTURE EXTENSIONS (not in 2D-2):
//   - Multi-objective optimization (Pareto frontier of risk vs. cost)
//   - LP relaxation with branch-and-bound for provable optimality
//   - Incremental re-optimization when assets are added/removed
//   - Per-asset historical actual-dispatch performance (replacing the
//     reservedKw placeholder from 2D-1)
// =============================================================================

import {
  computeSafeCapacity,
  type DerUncertaintyProfile,
  type CorrelationModel,
  type SafeCapacityResult,
} from './portfolio-risk.service'
import { ValidationError } from '@/lib/domain/errors'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A candidate asset for portfolio selection.
 *
 * This is the GENERIC input to the optimizer — it is NOT VPP-specific.
 * The VPP layer (or any future vertical) constructs candidates from its
 * domain objects (assets, reservations, evaluations) and passes them here.
 *
 * The `clusterId` groups assets that share common-mode failure risk. The
 * optimizer prefers spreading selections across clusters to maximize
 * diversification.
 */
export interface CandidateAsset {
  assetId: string
  clusterId: string
  /**
   * Maximum capacity (kW) available for commitment from this asset.
   * Typically from the generic capacity layer's getAvailableCapacity().
   * The optimizer will never commit more than this.
   */
  availableCapacityKw: number
  /**
   * Per-asset uncertainty profile (expected kW, std dev, availability).
   * The `expectedPerformanceKw` should be ≤ availableCapacityKw.
   */
  uncertainty: DerUncertaintyProfile
  /**
   * Optional cost per kW committed (e.g., operator price, energy cost).
   * Lower-cost assets are preferred when risk is equal.
   */
  costPerKw?: number
  /**
   * Optional opportunity cost per kW — the value of reserving this asset
   * for other uses. Higher-opportunity-cost assets are deprioritized so
   * the platform doesn't tie up high-value assets when lower-value ones
   * can serve the request.
   */
  opportunityCostPerKw?: number
}

/**
 * The optimization target — what the buyer is asking for.
 */
export interface OptimizationTarget {
  /** Requested capacity (kW). */
  requestedKw: number
  /** Confidence level for the safe-capacity calculation (e.g., 0.99). */
  confidenceLevel: number
  /** Correlation model for inter-asset dependence. */
  correlationModel: CorrelationModel
}

/**
 * A selected asset in the optimization result.
 */
export interface SelectedAsset {
  assetId: string
  clusterId: string
  /** Capacity (kW) committed from this asset. */
  committedKw: number
  /** Expected contribution (kW) after availability. */
  expectedKw: number
}

/**
 * The optimization result.
 */
export interface OptimizationResult {
  /** The selected assets and their committed capacity. */
  selected: SelectedAsset[]
  /** Portfolio-level risk statistics (from the risk engine). */
  risk: SafeCapacityResult
  /**
   * The safe committed capacity (kW) from the risk engine — same as
   * risk.committedKw. This is the normal-approximation safe capacity at
   * the target confidence level, NOT a guaranteed delivery amount.
   */
  committedKw: number
  /** Total physical capacity committed (kW) — sum of selected.committedKw. */
  totalCommittedKw: number
  /** Whether the optimizer could fully serve the request. */
  fullyServed: boolean
  /** Shortfall (kW) if the request could not be fully served. */
  shortfallKw: number
  /** Number of candidates evaluated. */
  candidateCount: number
  /** Number of clusters represented in the selection. */
  clusterCount: number
  /** Total cost (if costPerKw was provided on candidates). */
  totalCost?: number
  /** Total opportunity cost (if opportunityCostPerKw was provided). */
  totalOpportunityCost?: number
}

// ---------------------------------------------------------------------------
// Optimization
// ---------------------------------------------------------------------------

/**
 * Select a portfolio of assets to satisfy a capacity request at a target
 * confidence level, minimizing risk and cost.
 *
 * The optimizer uses a greedy, correlation-aware algorithm:
 *   1. Score candidates by risk-adjusted marginal contribution, preferring
 *      new clusters (diversification) and lower cost/opportunity cost.
 *   2. Iteratively add the best candidate, recompute safe capacity, stop
 *      when the target is met.
 *   3. Prune over-selected assets whose removal still meets the target.
 *
 * @param candidates  The pool of available assets (with uncertainty + capacity)
 * @param target      The buyer's request (kW + confidence + correlation model)
 * @returns           The selected portfolio + risk statistics
 */
export function optimizePortfolio(
  candidates: CandidateAsset[],
  target: OptimizationTarget,
): OptimizationResult {
  if (target.requestedKw < 0) {
    throw new ValidationError(`requestedKw must be non-negative, got ${target.requestedKw}`)
  }
  if (target.confidenceLevel <= 0 || target.confidenceLevel >= 1) {
    throw new ValidationError(`confidenceLevel must be in (0, 1), got ${target.confidenceLevel}`)
  }

  // Filter out candidates with no available capacity.
  const viable = candidates.filter((c) => c.availableCapacityKw > 0)
  if (viable.length === 0 || target.requestedKw === 0) {
    return emptyResult(candidates.length, target)
  }

  // Phase 1: greedy selection.
  const selected = greedySelect(viable, target)

  // Phase 2: prune over-selected assets.
  const pruned = pruneExcess(selected, target)

  // Compute final risk statistics.
  const profiles = pruned.map((s) => s.uncertainty)
  const risk = computeSafeCapacity(
    profiles,
    target.correlationModel,
    target.requestedKw,
    target.confidenceLevel,
  )

  return buildResult(pruned, risk, candidates.length, target)
}

// ---------------------------------------------------------------------------
// Phase 1: Greedy selection
// ---------------------------------------------------------------------------

/**
 * Greedily select assets until the safe capacity meets the target.
 *
 * Scoring: each candidate is scored by a combination of:
 *   - Expected kW (availability × capacity) — more is better
 *   - Cluster novelty — assets in clusters not yet selected score higher
 *     (diversification benefit)
 *   - Lower cost — preferred when risk contribution is similar
 *   - Lower opportunity cost — don't tie up high-value assets
 *
 * After each addition, the safe capacity is recomputed. Selection stops
 * when safe capacity ≥ requested, or no candidates remain.
 */
function greedySelect(
  candidates: CandidateAsset[],
  target: OptimizationTarget,
): CandidateAsset[] {
  const remaining = [...candidates]
  const selected: CandidateAsset[] = []
  const selectedClusters = new Set<string>()

  while (remaining.length > 0) {
    // Score each remaining candidate.
    let bestIdx = -1
    let bestScore = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const score = scoreCandidate(remaining[i], selectedClusters, selected)
      if (score > bestScore) {
        bestScore = score
        bestIdx = i
      }
    }

    if (bestIdx < 0) break

    const candidate = remaining.splice(bestIdx, 1)[0]!
    selected.push(candidate)
    selectedClusters.add(candidate.clusterId)

    // Check if we've met the target.
    const profiles = selected.map((s) => s.uncertainty)
    const result = computeSafeCapacity(
      profiles,
      target.correlationModel,
      target.requestedKw,
      target.confidenceLevel,
    )

    if (result.committedKw >= target.requestedKw) {
      // Target met — stop selecting.
      break
    }
  }

  return selected
}

/**
 * Score a candidate asset for greedy selection.
 *
 * Higher score = more desirable to add next.
 *
 * The score combines:
 *   - Expected kW (availability × capacity): the primary driver
 *   - Cluster novelty bonus: assets in new clusters get a diversification
 *     boost (correlation-aware)
 *   - Cost penalty: higher cost is slightly penalized
 *   - Opportunity cost penalty: higher opportunity cost is penalized
 */
function scoreCandidate(
  candidate: CandidateAsset,
  selectedClusters: Set<string>,
  _currentlySelected: CandidateAsset[],
): number {
  const expectedKw = candidate.uncertainty.availabilityProb * candidate.availableCapacityKw

  // Cluster novelty: if this cluster isn't yet in the selection, boost the
  // score. Diversification across clusters reduces portfolio variance
  // (correlated failures are clustered).
  const clusterBonus = selectedClusters.has(candidate.clusterId) ? 0 : expectedKw * 0.3

  // Cost penalty (normalized): prefer cheaper assets when risk is similar.
  const costPenalty = (candidate.costPerKw ?? 0) * 0.01

  // Opportunity cost penalty: don't tie up high-value assets.
  const oppCostPenalty = (candidate.opportunityCostPerKw ?? 0) * 0.01

  return expectedKw + clusterBonus - costPenalty - oppCostPenalty
}

// ---------------------------------------------------------------------------
// Phase 2: Pruning
// ---------------------------------------------------------------------------

/**
 * Remove assets whose removal still leaves the portfolio above the target.
 *
 * The greedy algorithm can over-select (especially when the last asset added
 * overshoots the target significantly). This pass removes redundant assets,
 * starting from the lowest-scoring (smallest expected contribution).
 *
 * This also reduces opportunity cost — fewer assets are tied up.
 */
function pruneExcess(
  selected: CandidateAsset[],
  target: OptimizationTarget,
): CandidateAsset[] {
  // Sort by expected contribution ascending (try removing smallest first).
  const sorted = [...selected].sort(
    (a, b) =>
      a.uncertainty.availabilityProb * a.availableCapacityKw -
      b.uncertainty.availabilityProb * b.availableCapacityKw,
  )

  const result = [...selected]

  for (const candidate of sorted) {
    if (result.length <= 1) break // never prune to empty

    // Try removing this candidate.
    const trial = result.filter((c) => c.assetId !== candidate.assetId)
    const profiles = trial.map((s) => s.uncertainty)
    const risk = computeSafeCapacity(
      profiles,
      target.correlationModel,
      target.requestedKw,
      target.confidenceLevel,
    )

    if (risk.committedKw >= target.requestedKw) {
      // Removal still meets target — remove this asset (reduces opportunity cost).
      result.length = 0
      result.push(...trial)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Result construction
// ---------------------------------------------------------------------------

function buildResult(
  selected: CandidateAsset[],
  risk: SafeCapacityResult,
  candidateCount: number,
  target: OptimizationTarget,
): OptimizationResult {
  const selectedAssets: SelectedAsset[] = selected.map((c) => ({
    assetId: c.assetId,
    clusterId: c.clusterId,
    committedKw: c.availableCapacityKw,
    expectedKw: c.uncertainty.availabilityProb * c.availableCapacityKw,
  }))

  const totalCommittedKw = selectedAssets.reduce((sum, s) => sum + s.committedKw, 0)
  const clusters = new Set(selected.map((s) => s.clusterId))

  const hasCost = selected.some((c) => c.costPerKw !== undefined)
  const hasOppCost = selected.some((c) => c.opportunityCostPerKw !== undefined)

  return {
    selected: selectedAssets,
    risk,
    committedKw: risk.committedKw,
    totalCommittedKw,
    fullyServed: risk.committedKw >= target.requestedKw,
    shortfallKw: Math.max(0, target.requestedKw - risk.committedKw),
    candidateCount,
    clusterCount: clusters.size,
    totalCost: hasCost
      ? selected.reduce((sum, c) => sum + (c.costPerKw ?? 0) * c.availableCapacityKw, 0)
      : undefined,
    totalOpportunityCost: hasOppCost
      ? selected.reduce((sum, c) => sum + (c.opportunityCostPerKw ?? 0) * c.availableCapacityKw, 0)
      : undefined,
  }
}

function emptyResult(candidateCount: number, target: OptimizationTarget): OptimizationResult {
  const risk = computeSafeCapacity([], target.correlationModel, target.requestedKw, target.confidenceLevel)
  return {
    selected: [],
    risk,
    committedKw: risk.committedKw,
    totalCommittedKw: 0,
    fullyServed: target.requestedKw === 0,
    shortfallKw: target.requestedKw,
    candidateCount,
    clusterCount: 0,
  }
}

// ---------------------------------------------------------------------------
// Candidate construction helper (from capacity layer data)
// ---------------------------------------------------------------------------

/**
 * Build a CandidateAsset from the generic capacity layer's available-capacity
 * query result + a per-asset uncertainty profile.
 *
 * This helper bridges the generic capacity layer (getAvailableCapacity) and
 * the optimizer. The caller provides:
 *   - the asset's available capacity (from the capacity layer)
 *   - the uncertainty profile (from baseline evaluation + historical data)
 *   - optional cost / opportunity cost
 *
 * The helper caps expectedPerformanceKw at availableCapacityKw so the
 * optimizer never plans to commit more than is physically available.
 */
export function buildCandidate(input: {
  assetId: string
  clusterId: string
  availableCapacityKw: number
  uncertainty: DerUncertaintyProfile
  costPerKw?: number
  opportunityCostPerKw?: number
}): CandidateAsset {
  const { assetId, clusterId, availableCapacityKw, uncertainty, costPerKw, opportunityCostPerKw } = input

  // Cap expected performance at available capacity — never plan to deliver
  // more than the asset can physically provide in this window.
  const cappedUncertainty: DerUncertaintyProfile = {
    ...uncertainty,
    expectedPerformanceKw: Math.min(uncertainty.expectedPerformanceKw, availableCapacityKw),
  }

  return {
    assetId,
    clusterId,
    availableCapacityKw,
    uncertainty: cappedUncertainty,
    costPerKw,
    opportunityCostPerKw,
  }
}
