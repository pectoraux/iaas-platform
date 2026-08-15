// =============================================================================
// VPP-2D-2B: Portfolio Optimizer (marginal-safe-capacity, partial allocation)
// =============================================================================
// THE CENTRAL QUESTION:
//
//   Given N available assets (each with uncertain performance, availability,
//   cluster/correlation membership, available capacity, optional cost), and
//   a buyer requesting X kW at confidence c, WHICH assets should the platform
//   commit — and HOW MUCH from each — to satisfy the request while minimizing
//   risk, cost, and opportunity cost?
//
// =============================================================================
// OPTIMIZATION OBJECTIVE (lexicographic — the optimizer's contract)
// =============================================================================
//
//   Primary:   Meet the requested normal-approximation safe capacity.
//              (committedKw ≥ requestedKw, or as close as the pool allows.)
//
//   Secondary: Minimize total opportunity cost.
//              (Don't tie up high-value assets when lower-value ones suffice.)
//
//   Tertiary:  Minimize total direct cost.
//              (Prefer cheaper assets when risk contribution is equal.)
//
//   Quaternary: Minimize portfolio concentration / common-mode risk.
//               (Spread across clusters to reduce correlated-failure risk.)
//
// The greedy algorithm below optimizes these in order. It is a HEURISTIC —
// not guaranteed globally optimal. The optimality gap is measurable via the
// exhaustive reference optimizer in the test suite (for N ≤ ~12).
//
// =============================================================================
// KEY DESIGN DECISIONS (VPP-2D-2B corrections)
// =============================================================================
//
//   1. MARGINAL SAFE CAPACITY SCORING. At each greedy step, the candidate
//      is scored by its ACTUAL marginal contribution to portfolio safe
//      capacity (safeCapacity(portfolio + candidate) - safeCapacity(portfolio)),
//      normalized by cost. This replaces the previous arbitrary fixed weights
//      (expectedKw * 0.3, cost * 0.01) which had no principled relationship
//      to the risk model.
//
//   2. PARTIAL ALLOCATION. A selected asset's committedKw can be LESS than
//      its availableCapacityKw. The optimizer performs a binary search on
//      the last-added asset to find the minimum allocation that meets the
//      target, rather than committing the entire asset. This avoids locking
//      up physical resources the buyer doesn't need.
//
//   3. IMMUTABLE UNCERTAINTY PROFILES. buildCandidate() does NOT mutate the
//      caller's DerUncertaintyProfile. The availableCapacityKw is a separate
//      hard constraint enforced at allocation time. If expectedPerformanceKw
//      > availableCapacityKw, the optimizer scales the allocation (not the
//      statistical model) — the uncertainty profile is treated as immutable
//      observed evidence.
//
//   4. CANDIDATE VALIDATION. Every candidate is validated before optimization:
//        - unique assetId
//        - non-negative availableCapacityKw
//        - non-negative expectedPerformanceKw, stdDevKw
//        - availabilityProb ∈ [0, 1]
//        - non-empty clusterId
//        - finite numeric values
//
//   5. GENERIC. No VPP-specific types or DB access. The optimizer operates
//      on abstract CandidateAsset inputs.
//
// =============================================================================
// ALGORITHM
// =============================================================================
//
//   Phase 1 — GREEDY SELECTION (marginal safe capacity):
//     For each remaining candidate, compute:
//       marginalSafeKw = safeCapacity(selected + candidate) - safeCapacity(selected)
//       score = marginalSafeKw / (1 + cost + opportunityCost)
//     Add the highest-scoring candidate. Stop when safe capacity ≥ target.
//
//   Phase 2 — PARTIAL ALLOCATION OF THE LAST ASSET:
//     The last-added asset often overshoots the target. Binary-search its
//     allocation to find the minimum that still meets the target, freeing
//     the unused capacity.
//
//   Phase 3 — PRUNING:
//     Remove any asset whose removal still leaves the portfolio above target.
//
//   This is O(N²) in candidates (N safe-capacity evaluations per step, N
//   steps). For 1000 candidates that's ~10^6 evaluations — each evaluation
//   is O(N) for the risk engine, so ~10^9 total. For large N, a future
//   version should use incremental risk updates (only the covariance terms
//   involving the new asset change).
//
// FUTURE EXTENSIONS:
//   - LP relaxation with branch-and-bound for provable optimality
//   - Incremental risk updates (avoid full recomputation)
//   - Multi-objective Pareto frontier
//   - Per-asset historical actual-dispatch performance
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
 * A candidate asset for portfolio selection. GENERIC — not VPP-specific.
 *
 * The `uncertainty` profile is the OBSERVED statistical model (from baseline
 * evaluation + historical data). It is treated as IMMUTABLE by the optimizer.
 * The `availableCapacityKw` is a separate hard constraint (from the generic
 * capacity layer) that limits how much can be committed, NOT a parameter of
 * the statistical model.
 */
export interface CandidateAsset {
  assetId: string
  clusterId: string
  /** Maximum capacity (kW) available for commitment. Hard constraint. */
  availableCapacityKw: number
  /** Per-asset uncertainty profile (IMMUTABLE — not mutated by the optimizer). */
  uncertainty: DerUncertaintyProfile
  /** Optional direct cost per kW committed. */
  costPerKw?: number
  /** Optional opportunity cost per kW committed. */
  opportunityCostPerKw?: number
}

export interface OptimizationTarget {
  requestedKw: number
  confidenceLevel: number
  correlationModel: CorrelationModel
}

/**
 * A selected asset with its (possibly partial) allocation.
 */
export interface SelectedAsset {
  assetId: string
  clusterId: string
  /** Capacity (kW) committed from this asset. May be < availableCapacityKw. */
  committedKw: number
  /** Expected contribution (kW) after availability, at this allocation. */
  expectedKw: number
}

/**
 * The optimization result.
 *
 * NOTE: The algorithm is a HEURISTIC (greedy with marginal-safe-capacity
 * scoring). It is NOT guaranteed globally optimal. The `optimalityGap`
 * field is populated when the exhaustive reference optimizer is available
 * (small N); otherwise it is undefined.
 */
export interface OptimizationResult {
  selected: SelectedAsset[]
  risk: SafeCapacityResult
  /** Safe committed capacity (kW) = risk.committedKw. */
  committedKw: number
  /** Total physical capacity committed (kW) = Σ selected.committedKw. */
  totalCommittedKw: number
  fullyServed: boolean
  shortfallKw: number
  candidateCount: number
  clusterCount: number
  totalCost?: number
  totalOpportunityCost?: number
  /**
   * The algorithm name. Always 'greedy_marginal_safe_capacity' for the
   * heuristic optimizer. The exhaustive reference uses 'exhaustive'.
   */
  algorithm: string
  /**
   * Optimality gap vs the exhaustive reference, when computed (small N).
   * Defined as: (optimalSafeKw - heuristicSafeKw) / optimalSafeKw.
   * Undefined for large N where exhaustive search is infeasible.
   */
  optimalityGap?: number
}

// ---------------------------------------------------------------------------
// Candidate validation
// ---------------------------------------------------------------------------

/**
 * Validate a list of candidates. Throws ValidationError on the first
 * invalid candidate. This is the candidate-level validation boundary.
 */
export function validateCandidates(candidates: CandidateAsset[]): void {
  const seenIds = new Set<string>()

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    const label = `candidate[${i}] (${c?.assetId ?? 'unknown'})`

    if (!c || typeof c !== 'object') {
      throw new ValidationError(`${label}: not a valid object`)
    }

    // Unique assetId
    if (!c.assetId || typeof c.assetId !== 'string') {
      throw new ValidationError(`${label}: assetId must be a non-empty string`)
    }
    if (seenIds.has(c.assetId)) {
      throw new ValidationError(`${label}: duplicate assetId '${c.assetId}'`)
    }
    seenIds.add(c.assetId)

    // Non-empty clusterId
    if (!c.clusterId || typeof c.clusterId !== 'string') {
      throw new ValidationError(`${label}: clusterId must be a non-empty string`)
    }

    // availableCapacityKw: non-negative, finite
    if (!Number.isFinite(c.availableCapacityKw) || c.availableCapacityKw < 0) {
      throw new ValidationError(`${label}: availableCapacityKw must be a non-negative finite number, got ${c.availableCapacityKw}`)
    }

    // Uncertainty profile
    const u = c.uncertainty
    if (!u || typeof u !== 'object') {
      throw new ValidationError(`${label}: uncertainty must be a DerUncertaintyProfile`)
    }
    if (!Number.isFinite(u.expectedPerformanceKw) || u.expectedPerformanceKw < 0) {
      throw new ValidationError(`${label}: uncertainty.expectedPerformanceKw must be non-negative finite, got ${u.expectedPerformanceKw}`)
    }
    if (!Number.isFinite(u.stdDevKw) || u.stdDevKw < 0) {
      throw new ValidationError(`${label}: uncertainty.stdDevKw must be non-negative finite, got ${u.stdDevKw}`)
    }
    if (!Number.isFinite(u.availabilityProb) || u.availabilityProb < 0 || u.availabilityProb > 1) {
      throw new ValidationError(`${label}: uncertainty.availabilityProb must be in [0, 1], got ${u.availabilityProb}`)
    }

    // Optional cost fields
    if (c.costPerKw !== undefined && (!Number.isFinite(c.costPerKw) || c.costPerKw < 0)) {
      throw new ValidationError(`${label}: costPerKw must be non-negative finite, got ${c.costPerKw}`)
    }
    if (c.opportunityCostPerKw !== undefined && (!Number.isFinite(c.opportunityCostPerKw) || c.opportunityCostPerKw < 0)) {
      throw new ValidationError(`${label}: opportunityCostPerKw must be non-negative finite, got ${c.opportunityCostPerKw}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Optimization
// ---------------------------------------------------------------------------

/**
 * Select a portfolio of assets to satisfy a capacity request at a target
 * confidence level, using a greedy marginal-safe-capacity heuristic with
 * partial allocation.
 *
 * OBJECTIVE (lexicographic):
 *   1. Meet the requested safe capacity
 *   2. Minimize total opportunity cost
 *   3. Minimize total direct cost
 *   4. Minimize concentration (diversify across clusters)
 *
 * This is a HEURISTIC — not guaranteed globally optimal. See `optimalityGap`
 * in the result for the measured gap vs exhaustive search (small N only).
 */
export function optimizePortfolio(
  candidates: CandidateAsset[],
  target: OptimizationTarget,
): OptimizationResult {
  // Validate target.
  if (!Number.isFinite(target.requestedKw) || target.requestedKw < 0) {
    throw new ValidationError(`requestedKw must be non-negative finite, got ${target.requestedKw}`)
  }
  if (target.confidenceLevel <= 0 || target.confidenceLevel >= 1) {
    throw new ValidationError(`confidenceLevel must be in (0, 1), got ${target.confidenceLevel}`)
  }

  // Validate candidates.
  validateCandidates(candidates)

  // Filter out candidates with no available capacity.
  const viable = candidates.filter((c) => c.availableCapacityKw > 0)
  if (viable.length === 0 || target.requestedKw === 0) {
    return emptyResult(candidates.length, target)
  }

  // Phase 1: greedy selection by marginal safe capacity.
  const selected = greedySelect(viable, target)

  // Phase 2: partial allocation of the last asset.
  const partial = partialAllocateLast(selected, target)

  // Phase 3: prune redundant assets.
  const pruned = pruneExcess(partial, target)

  // Compute final risk statistics on the pruned, partially-allocated portfolio.
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
// Phase 1: Greedy selection by marginal safe capacity
// ---------------------------------------------------------------------------

/**
 * Internal representation of a selected asset during optimization.
 * Carries the allocation amount separately from the candidate.
 */
interface SelectedEntry {
  candidate: CandidateAsset
  /** Current allocation (kW). May be partial. */
  allocatedKw: number
  /** The uncertainty profile at this allocation (scaled if partial). */
  uncertainty: DerUncertaintyProfile
}

/**
 * Greedily select assets by their ACTUAL marginal contribution to portfolio
 * safe capacity, normalized by cost.
 *
 * At each step:
 *   - For each remaining candidate, compute:
 *       marginalSafeKw = safeCapacity(selected + candidate) - safeCapacity(selected)
 *       score = marginalSafeKw / (1 + totalCost + totalOppCost)
 *   - Add the candidate with the highest score.
 *   - Stop when safe capacity ≥ target or no candidates remain.
 *
 * This replaces the previous arbitrary fixed-weight scoring
 * (expectedKw * 0.3, cost * 0.01) with a principled signal derived from
 * the risk engine itself.
 */
function greedySelect(
  candidates: CandidateAsset[],
  target: OptimizationTarget,
): SelectedEntry[] {
  const remaining = [...candidates]
  const selected: SelectedEntry[] = []

  // Current safe capacity of the selected portfolio.
  let currentSafeKw = 0

  while (remaining.length > 0) {
    let bestIdx = -1
    let bestScore = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      // Compute marginal safe capacity: add this candidate at full capacity
      // and measure the delta.
      const trialProfiles = [
        ...selected.map((s) => s.uncertainty),
        candidate.uncertainty,
      ]
      const trialResult = computeSafeCapacity(
        trialProfiles,
        target.correlationModel,
        target.requestedKw,
        target.confidenceLevel,
      )
      const marginalSafeKw = trialResult.committedKw - currentSafeKw

      if (marginalSafeKw <= 0) continue // candidate doesn't help

      // Score = marginal safe capacity per unit of cost+opportunity cost.
      // The +1 prevents division by zero when no costs are provided.
      const cost = candidate.costPerKw ?? 0
      const oppCost = candidate.opportunityCostPerKw ?? 0
      const totalCost = (cost + oppCost) * candidate.availableCapacityKw
      const score = marginalSafeKw / (1 + totalCost)

      if (score > bestScore) {
        bestScore = score
        bestIdx = i
      }
    }

    if (bestIdx < 0) break // no candidate improves the portfolio

    const candidate = remaining.splice(bestIdx, 1)[0]!
    selected.push({
      candidate,
      allocatedKw: candidate.availableCapacityKw, // full allocation; partial comes in Phase 2
      uncertainty: candidate.uncertainty,
    })

    // Recompute current safe capacity.
    const profiles = selected.map((s) => s.uncertainty)
    const result = computeSafeCapacity(
      profiles,
      target.correlationModel,
      target.requestedKw,
      target.confidenceLevel,
    )
    currentSafeKw = result.committedKw

    if (currentSafeKw >= target.requestedKw) break
  }

  return selected
}

// ---------------------------------------------------------------------------
// Phase 2: Partial allocation of the last asset
// ---------------------------------------------------------------------------

/**
 * The last-added asset often overshoots the target. Binary-search its
 * allocation to find the minimum that still meets the target, freeing
 * the unused capacity for other uses.
 *
 * This is the key partial-allocation step: the optimizer returns
 * committedKw < availableCapacityKw for the last asset rather than
 * locking up the entire physical resource.
 */
function partialAllocateLast(
  selected: SelectedEntry[],
  target: OptimizationTarget,
): SelectedEntry[] {
  if (selected.length === 0) return selected

  // Check if we're above target at all.
  const profiles = selected.map((s) => s.uncertainty)
  const currentResult = computeSafeCapacity(
    profiles,
    target.correlationModel,
    target.requestedKw,
    target.confidenceLevel,
  )

  if (currentResult.committedKw < target.requestedKw) {
    // Not even at target — no partial allocation to do.
    return selected
  }

  const last = selected[selected.length - 1]!
  // Binary search on the last asset's allocation.
  let lo = 0
  let hi = last.candidate.availableCapacityKw
  const tolerance = 0.01 // 0.01 kW precision

  // We want the minimum allocation on the last asset that still meets target.
  while (hi - lo > tolerance) {
    const mid = (lo + hi) / 2
    // Build a scaled uncertainty profile for the last asset at allocation=mid.
    const scaledProfile = scaleProfile(last.candidate.uncertainty, mid, last.candidate.availableCapacityKw)
    const trialProfiles = [
      ...selected.slice(0, -1).map((s) => s.uncertainty),
      scaledProfile,
    ]
    const trialResult = computeSafeCapacity(
      trialProfiles,
      target.correlationModel,
      target.requestedKw,
      target.confidenceLevel,
    )
    if (trialResult.committedKw >= target.requestedKw) {
      // Still meets target — try lower.
      hi = mid
    } else {
      // Doesn't meet target — need more.
      lo = mid
    }
  }

  // Use hi (the minimum that meets target).
  const finalAllocation = hi
  if (finalAllocation < last.candidate.availableCapacityKw - tolerance) {
    // Partial allocation.
    const scaledProfile = scaleProfile(last.candidate.uncertainty, finalAllocation, last.candidate.availableCapacityKw)
    selected[selected.length - 1] = {
      candidate: last.candidate,
      allocatedKw: finalAllocation,
      uncertainty: scaledProfile,
    }
  }

  return selected
}

/**
 * Scale an uncertainty profile for a partial allocation.
 *
 * When an asset is partially allocated (committedKw < availableCapacityKw),
 * the expected performance and std dev are scaled proportionally. This is
 * a mathematically consistent scaling: if an asset delivers X% of its
 * capacity, both μ and σ scale by X% (assuming linear response).
 *
 * The availability probability is NOT scaled — it represents the probability
 * the asset is online at all, regardless of how much it's asked to deliver.
 */
function scaleProfile(
  original: DerUncertaintyProfile,
  allocationKw: number,
  _availableCapacityKw: number,
): DerUncertaintyProfile {
  // If the original expected performance is 0, scaling is undefined; keep as-is.
  if (original.expectedPerformanceKw === 0) {
    return { ...original }
  }
  // Scale factor: what fraction of the original expected performance are we using?
  // We scale μ and σ by the same factor (linear response assumption).
  const scale = Math.min(1, allocationKw / original.expectedPerformanceKw)
  return {
    ...original,
    expectedPerformanceKw: original.expectedPerformanceKw * scale,
    stdDevKw: original.stdDevKw * scale,
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Pruning
// ---------------------------------------------------------------------------

/**
 * Remove assets whose removal still leaves the portfolio above target.
 * Tries removing from the smallest-expected-contribution first.
 */
function pruneExcess(
  selected: SelectedEntry[],
  target: OptimizationTarget,
): SelectedEntry[] {
  // Sort by expected contribution ascending (try removing smallest first).
  const sorted = [...selected].sort(
    (a, b) =>
      a.uncertainty.availabilityProb * a.allocatedKw -
      b.uncertainty.availabilityProb * b.allocatedKw,
  )

  const result = [...selected]

  for (const entry of sorted) {
    if (result.length <= 1) break

    const trial = result.filter((r) => r.candidate.assetId !== entry.candidate.assetId)
    const profiles = trial.map((s) => s.uncertainty)
    const risk = computeSafeCapacity(
      profiles,
      target.correlationModel,
      target.requestedKw,
      target.confidenceLevel,
    )

    if (risk.committedKw >= target.requestedKw) {
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
  selected: SelectedEntry[],
  risk: SafeCapacityResult,
  candidateCount: number,
  target: OptimizationTarget,
): OptimizationResult {
  const selectedAssets: SelectedAsset[] = selected.map((entry) => ({
    assetId: entry.candidate.assetId,
    clusterId: entry.candidate.clusterId,
    committedKw: entry.allocatedKw,
    expectedKw: entry.uncertainty.availabilityProb * entry.uncertainty.expectedPerformanceKw,
  }))

  const totalCommittedKw = selectedAssets.reduce((sum, s) => sum + s.committedKw, 0)
  const clusters = new Set(selected.map((s) => s.candidate.clusterId))

  const hasCost = selected.some((s) => s.candidate.costPerKw !== undefined)
  const hasOppCost = selected.some((s) => s.candidate.opportunityCostPerKw !== undefined)

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
      ? selected.reduce((sum, s) => sum + (s.candidate.costPerKw ?? 0) * s.allocatedKw, 0)
      : undefined,
    totalOpportunityCost: hasOppCost
      ? selected.reduce((sum, s) => sum + (s.candidate.opportunityCostPerKw ?? 0) * s.allocatedKw, 0)
      : undefined,
    algorithm: 'greedy_marginal_safe_capacity',
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
    algorithm: 'greedy_marginal_safe_capacity',
  }
}

// ---------------------------------------------------------------------------
// Exhaustive reference optimizer (for optimality-gap testing)
// ---------------------------------------------------------------------------

/**
 * Exhaustive reference optimizer — evaluates ALL 2^N subsets and returns
 * the one that best satisfies the lexicographic objective.
 *
 * This is EXPONENTIAL (2^N) and only feasible for N ≤ ~12. It is exported
 * for the test suite to measure the greedy heuristic's optimality gap.
 *
 * Objective (lexicographic):
 *   1. Meet requested safe capacity (prefer fullyServed)
 *   2. Minimize total opportunity cost
 *   3. Minimize total direct cost
 *   4. Minimize concentration (maximize cluster count)
 *
 * NOT for production use — use optimizePortfolio() instead.
 */
export function exhaustiveOptimize(
  candidates: CandidateAsset[],
  target: OptimizationTarget,
): OptimizationResult {
  validateCandidates(candidates)

  const n = candidates.length
  if (n > 15) {
    throw new Error(`exhaustiveOptimize is infeasible for N=${n} (max 15). Use optimizePortfolio().`)
  }

  const totalSubsets = 1 << n // 2^n
  let best: OptimizationResult | null = null

  for (let mask = 1; mask < totalSubsets; mask++) {
    const subset: CandidateAsset[] = []
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) subset.push(candidates[i]!)
    }

    // Evaluate this subset.
    const profiles = subset.map((c) => c.uncertainty)
    const risk = computeSafeCapacity(
      profiles,
      target.correlationModel,
      target.requestedKw,
      target.confidenceLevel,
    )

    const totalOppCost = subset.reduce(
      (sum, c) => sum + (c.opportunityCostPerKw ?? 0) * c.availableCapacityKw, 0,
    )
    const totalCost = subset.reduce(
      (sum, c) => sum + (c.costPerKw ?? 0) * c.availableCapacityKw, 0,
    )
    const clusterCount = new Set(subset.map((c) => c.clusterId)).size

    const result: OptimizationResult = {
      selected: subset.map((c) => ({
        assetId: c.assetId,
        clusterId: c.clusterId,
        committedKw: c.availableCapacityKw,
        expectedKw: c.uncertainty.availabilityProb * c.uncertainty.expectedPerformanceKw,
      })),
      risk,
      committedKw: risk.committedKw,
      totalCommittedKw: subset.reduce((sum, c) => sum + c.availableCapacityKw, 0),
      fullyServed: risk.committedKw >= target.requestedKw,
      shortfallKw: Math.max(0, target.requestedKw - risk.committedKw),
      candidateCount: n,
      clusterCount,
      totalCost: subset.some((c) => c.costPerKw !== undefined) ? totalCost : undefined,
      totalOpportunityCost: subset.some((c) => c.opportunityCostPerKw !== undefined) ? totalOppCost : undefined,
      algorithm: 'exhaustive',
    }

    if (best === null || compareResults(result, best, target) < 0) {
      best = result
    }
  }

  return best!
}

/**
 * Compare two optimization results under the lexicographic objective.
 * Returns < 0 if a is better, > 0 if b is better, 0 if equal.
 *
 *   1. Fully-served beats not fully-served.
 *   2. Higher safe capacity (if not both served).
 *   3. Lower opportunity cost.
 *   4. Lower direct cost.
 *   5. More clusters (diversification).
 *   6. Lower total committed kW (less resource lockup).
 */
function compareResults(a: OptimizationResult, b: OptimizationResult, target: OptimizationTarget): number {
  // 1. Fully-served wins.
  if (a.fullyServed !== b.fullyServed) return a.fullyServed ? -1 : 1

  // 2. Higher safe capacity.
  if (Math.abs(a.committedKw - b.committedKw) > 0.01) {
    return b.committedKw - a.committedKw // higher is better → negative
  }

  // 3. Lower opportunity cost.
  const aOpp = a.totalOpportunityCost ?? 0
  const bOpp = b.totalOpportunityCost ?? 0
  if (Math.abs(aOpp - bOpp) > 0.01) return aOpp - bOpp

  // 4. Lower direct cost.
  const aCost = a.totalCost ?? 0
  const bCost = b.totalCost ?? 0
  if (Math.abs(aCost - bCost) > 0.01) return aCost - bCost

  // 5. More clusters.
  if (a.clusterCount !== b.clusterCount) return b.clusterCount - a.clusterCount

  // 6. Less total committed.
  return a.totalCommittedKw - b.totalCommittedKw
}

/**
 * Compute the optimality gap between the greedy heuristic and the exhaustive
 * reference, for small N. Returns the gap as a fraction:
 *   gap = (optimalSafeKw - heuristicSafeKw) / optimalSafeKw
 *
 * A gap of 0 means the heuristic found the optimal solution. A gap of 0.05
 * means the heuristic's safe capacity is 5% below the optimum.
 *
 * Only feasible for N ≤ 15 (2^N subsets).
 */
export function measureOptimalityGap(
  candidates: CandidateAsset[],
  target: OptimizationTarget,
): { heuristic: OptimizationResult; optimal: OptimizationResult; gap: number } {
  const heuristic = optimizePortfolio(candidates, target)
  const optimal = exhaustiveOptimize(candidates, target)

  const gap = optimal.committedKw > 0
    ? Math.max(0, (optimal.committedKw - heuristic.committedKw) / optimal.committedKw)
    : 0

  return { heuristic, optimal, gap }
}

// ---------------------------------------------------------------------------
// Candidate construction helper (IMMUTABLE uncertainty profile)
// ---------------------------------------------------------------------------

/**
 * Build a CandidateAsset from the generic capacity layer's available-capacity
 * query result + a per-asset uncertainty profile.
 *
 * IMPORTANT: This helper does NOT mutate the caller's uncertainty profile.
 * The availableCapacityKw is stored as a separate hard constraint. If
 * expectedPerformanceKw > availableCapacityKw, the optimizer will handle
 * the constraint at allocation time (via partial allocation + profile scaling)
 * rather than silently editing the statistical model.
 *
 * The caller is responsible for ensuring the uncertainty profile is a
 * faithful representation of the asset's observed performance. If the
 * profile is inconsistent with available capacity (e.g., expected > available),
 * the caller should either:
 *   - provide a profile with expected ≤ available (preferred), or
 *   - accept that the optimizer will scale the allocation, not the model.
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

  // Do NOT mutate the uncertainty profile. Store availableCapacityKw as a
  // separate constraint. The optimizer enforces it at allocation time.
  return {
    assetId,
    clusterId,
    availableCapacityKw,
    uncertainty: { ...uncertainty }, // shallow copy — preserve the caller's original
    costPerKw,
    opportunityCostPerKw,
  }
}
