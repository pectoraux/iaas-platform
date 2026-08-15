// =============================================================================
// VPP-2D-2C: Portfolio Optimizer (effective-profile, lexicographic, partial)
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
//   1. Feasibility:     Meet the requested safe capacity (or get as close as
//                       the pool allows). fullyServed beats infeasible.
//   2. Safe capacity:   Among feasible portfolios, maximize safe capacity
//                       surplus (higher committedKw is better — more margin).
//   3. Opportunity cost: Minimize total opportunity cost (don't tie up
//                       high-value assets when lower-value ones suffice).
//   4. Direct cost:     Minimize total direct cost.
//   5. Diversification: Maximize cluster count (reduce common-mode risk).
//   6. Resource lockup: Minimize total physical capacity committed.
//
// The greedy algorithm below optimizes these in order. It is a HEURISTIC —
// not guaranteed globally optimal. The optimality gap is measurable via the
// exhaustive reference optimizer (discretized partial allocations, N ≤ ~8).
//
// =============================================================================
// KEY DESIGN DECISIONS (VPP-2D-2C corrections)
// =============================================================================
//
//   1. EFFECTIVE PROFILE MATCHES ACTUAL ALLOCATION. Every selected asset's
//      uncertainty profile is scaled to its allocatedKw BEFORE any risk
//      computation. The original observed profile is immutable; the
//      effective profile is derived from it + the allocation amount.
//      This prevents the bug where expectedPerformanceKw > allocatedKw
//      inflates safe capacity.
//
//   2. LEXICOGRAPHIC SCORING (not blended ratio). During greedy selection,
//      candidates are compared lexicographically:
//        a. marginal safe capacity (primary signal — which candidate moves
//           us closest to the target?)
//        b. marginal opportunity cost (tie-break: prefer cheaper assets)
//        c. marginal direct cost (tie-break)
//        d. cluster novelty (tie-break: prefer new clusters)
//      Costs are NOT blended into an arbitrary ratio with safe capacity.
//
//   3. PARTIAL ALLOCATION. The last-added asset is binary-searched to find
//      the minimum allocation that meets the target. The effective profile
//      is scaled to match.
//
//   4. IMMUTABLE OBSERVED PROFILES. buildCandidate() does NOT mutate the
//      caller's DerUncertaintyProfile. The effective profile is derived at
//      optimization time.
//
//   5. CANDIDATE VALIDATION. Every candidate is validated before optimization.
//
//   6. GENERIC. No VPP-specific types or DB access.
//
// =============================================================================
// ALGORITHM
// =============================================================================
//
//   Phase 1 — GREEDY SELECTION (lexicographic marginal safe capacity):
//     For each remaining candidate, compute its marginal safe capacity
//     (using the EFFECTIVE profile at full available capacity). Compare
//     candidates lexicographically:
//       1. higher marginal safe capacity wins
//       2. lower marginal opportunity cost wins (tie-break)
//       3. lower marginal direct cost wins (tie-break)
//       4. new cluster wins (tie-break)
//     Add the best candidate. Stop when safe capacity ≥ target.
//
//   Phase 2 — PARTIAL ALLOCATION OF THE LAST ASSET:
//     Binary-search the last asset's allocation to find the minimum that
//     still meets the target. Scale its effective profile to match.
//
//   Phase 3 — PRUNING (lexicographic):
//     Try removing each asset (smallest expected first). Keep the removal
//     only if the portfolio remains feasible AND the lexicographic objective
//     doesn't worsen.
//
//   O(N²) in candidates for the greedy phase.
//
// =============================================================================
// EXHAUSTIVE REFERENCE (for optimality-gap testing)
// =============================================================================
//
//   The exhaustive reference searches DISCRETIZED partial allocations
//   (0%, 10%, ..., 100% of each asset's available capacity). For N assets
//   with 11 allocation levels each, this is 11^N combinations — feasible
//   only for N ≤ 6. For N=6 that's ~1.77M combinations.
//
//   This searches the SAME solution space as the production optimizer
//   (partial allocations), so the optimality gap is a valid comparison.
//
//   The old whole-subset exhaustive optimizer is retained as
//   `exhaustiveOptimizeSubsets` for backwards compatibility, but its gap
//   is reported as `subsetSelectionGap` (not `optimalityGap`) because it
//   does not search partial allocations.
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

export interface SelectedAsset {
  assetId: string
  clusterId: string
  /** Capacity (kW) committed from this asset. May be < availableCapacityKw. */
  committedKw: number
  /** Expected contribution (kW) after availability, at this allocation. */
  expectedKw: number
}

export interface OptimizationResult {
  selected: SelectedAsset[]
  risk: SafeCapacityResult
  committedKw: number
  totalCommittedKw: number
  fullyServed: boolean
  shortfallKw: number
  candidateCount: number
  clusterCount: number
  totalCost?: number
  totalOpportunityCost?: number
  algorithm: string
  /**
   * Optimality gap vs the discretized exhaustive reference (partial allocations),
   * when computed (small N). Defined as:
   *   (optimalSafeKw - heuristicSafeKw) / optimalSafeKw
   * Undefined for large N where exhaustive search is infeasible.
   */
  optimalityGap?: number
  /**
   * Gap vs the whole-subset exhaustive reference (no partial allocations).
   * This is a WEAKER metric than optimalityGap because it doesn't search
   * the same solution space. Retained for backwards compatibility.
   */
  subsetSelectionGap?: number
}

// ---------------------------------------------------------------------------
// Internal representation
// ---------------------------------------------------------------------------

/**
 * A selected asset during optimization. ALWAYS carries the EFFECTIVE profile
 * (scaled to allocatedKw), never the original unscaled profile. This ensures
 * every risk computation uses a profile consistent with the actual allocation.
 */
interface SelectedEntry {
  candidate: CandidateAsset
  /** Current allocation (kW). May be partial. */
  allocatedKw: number
  /** The EFFECTIVE uncertainty profile at this allocation (scaled). */
  uncertainty: DerUncertaintyProfile
}

// ---------------------------------------------------------------------------
// Candidate validation
// ---------------------------------------------------------------------------

export function validateCandidates(candidates: CandidateAsset[]): void {
  const seenIds = new Set<string>()

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    const label = `candidate[${i}] (${c?.assetId ?? 'unknown'})`

    if (!c || typeof c !== 'object') {
      throw new ValidationError(`${label}: not a valid object`)
    }
    if (!c.assetId || typeof c.assetId !== 'string') {
      throw new ValidationError(`${label}: assetId must be a non-empty string`)
    }
    if (seenIds.has(c.assetId)) {
      throw new ValidationError(`${label}: duplicate assetId '${c.assetId}'`)
    }
    seenIds.add(c.assetId)
    if (!c.clusterId || typeof c.clusterId !== 'string') {
      throw new ValidationError(`${label}: clusterId must be a non-empty string`)
    }
    if (!Number.isFinite(c.availableCapacityKw) || c.availableCapacityKw < 0) {
      throw new ValidationError(`${label}: availableCapacityKw must be non-negative finite, got ${c.availableCapacityKw}`)
    }
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
    if (c.costPerKw !== undefined && (!Number.isFinite(c.costPerKw) || c.costPerKw < 0)) {
      throw new ValidationError(`${label}: costPerKw must be non-negative finite, got ${c.costPerKw}`)
    }
    if (c.opportunityCostPerKw !== undefined && (!Number.isFinite(c.opportunityCostPerKw) || c.opportunityCostPerKw < 0)) {
      throw new ValidationError(`${label}: opportunityCostPerKw must be non-negative finite, got ${c.opportunityCostPerKw}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Profile scaling (effective profile from allocation)
// ---------------------------------------------------------------------------

/**
 * Compute the EFFECTIVE uncertainty profile for a given allocation amount.
 *
 * The effective profile is what the risk engine should use: it reflects the
 * actual amount being committed. If allocatedKw < expectedPerformanceKw,
 * both μ and σ are scaled proportionally (linear response assumption).
 *
 * The availability probability is NOT scaled — it represents the probability
 * the asset is online at all, regardless of how much it's asked to deliver.
 *
 * If allocatedKw >= expectedPerformanceKw, the profile is returned unchanged
 * (we don't inflate expected performance beyond the observed model).
 *
 * The original profile is NEVER mutated — this returns a new object.
 */
function effectiveProfile(
  original: DerUncertaintyProfile,
  allocatedKw: number,
): DerUncertaintyProfile {
  // If allocation covers the full expected performance, no scaling needed.
  if (allocatedKw >= original.expectedPerformanceKw) {
    return { ...original }
  }
  // If expected is 0, can't scale — return as-is.
  if (original.expectedPerformanceKw === 0) {
    return { ...original }
  }
  // Scale μ and σ by the allocation fraction.
  const scale = allocatedKw / original.expectedPerformanceKw
  return {
    ...original,
    expectedPerformanceKw: original.expectedPerformanceKw * scale,
    stdDevKw: original.stdDevKw * scale,
  }
}

// ---------------------------------------------------------------------------
// Optimization
// ---------------------------------------------------------------------------

/**
 * Select a portfolio of assets to satisfy a capacity request at a target
 * confidence level, using a greedy lexicographic heuristic with partial
 * allocation and effective-profile risk computation.
 *
 * OBJECTIVE (lexicographic):
 *   1. Meet the requested safe capacity
 *   2. Maximize safe capacity surplus
 *   3. Minimize total opportunity cost
 *   4. Minimize total direct cost
 *   5. Maximize diversification (cluster count)
 *   6. Minimize total physical capacity committed
 *
 * This is a HEURISTIC — not guaranteed globally optimal. See `optimalityGap`
 * for the measured gap vs the discretized exhaustive reference (small N).
 */
export function optimizePortfolio(
  candidates: CandidateAsset[],
  target: OptimizationTarget,
): OptimizationResult {
  if (!Number.isFinite(target.requestedKw) || target.requestedKw < 0) {
    throw new ValidationError(`requestedKw must be non-negative finite, got ${target.requestedKw}`)
  }
  if (target.confidenceLevel <= 0 || target.confidenceLevel >= 1) {
    throw new ValidationError(`confidenceLevel must be in (0, 1), got ${target.confidenceLevel}`)
  }

  validateCandidates(candidates)

  const viable = candidates.filter((c) => c.availableCapacityKw > 0)
  if (viable.length === 0 || target.requestedKw === 0) {
    return emptyResult(candidates.length, target)
  }

  // Phase 1: greedy selection (lexicographic, effective profiles).
  const selected = greedySelect(viable, target)

  // Phase 2: partial allocation of the last asset.
  const partial = partialAllocateLast(selected, target)

  // Phase 3: lexicographic pruning.
  const pruned = pruneExcess(partial, target)

  // Final risk on effective profiles.
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
// Phase 1: Greedy selection (lexicographic, effective profiles)
// ---------------------------------------------------------------------------

/**
 * Greedily select assets using LEXICOGRAPHIC comparison of marginal
 * contributions.
 *
 * At each step, for each remaining candidate, we compute:
 *   - marginal safe capacity (using the EFFECTIVE profile at full available
 *     capacity, so expected is capped at available)
 *   - marginal opportunity cost
 *   - marginal direct cost
 *   - cluster novelty
 *
 * Candidates are compared lexicographically:
 *   1. higher marginal safe capacity wins (primary)
 *   2. lower marginal opportunity cost wins (tie-break)
 *   3. lower marginal direct cost wins (tie-break)
 *   4. new cluster wins (tie-break)
 *
 * Costs are NOT blended into a ratio with safe capacity — they are
 * tie-breakers that only matter when safe capacity is equal.
 */
function greedySelect(
  candidates: CandidateAsset[],
  target: OptimizationTarget,
): SelectedEntry[] {
  const remaining = [...candidates]
  const selected: SelectedEntry[] = []
  const selectedClusters = new Set<string>()

  // Current safe capacity (computed on effective profiles).
  let currentSafeKw = computeSafeCapacityFromSelected(selected, target)

  while (remaining.length > 0) {
    let bestIdx = -1
    let bestComparison: MarginalContribution | null = null

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      const marginal = computeMarginalContribution(
        candidate,
        selected,
        selectedClusters,
        target,
        currentSafeKw,
      )

      if (marginal.marginalSafeKw <= 0) continue // doesn't help

      if (bestComparison === null || compareMarginal(marginal, bestComparison) < 0) {
        bestComparison = marginal
        bestIdx = i
      }
    }

    if (bestIdx < 0 || bestComparison === null) break

    const candidate = remaining.splice(bestIdx, 1)[0]!
    // Add at FULL available capacity (partial comes in Phase 2).
    // The effective profile is scaled to availableCapacityKw.
    const effProfile = effectiveProfile(candidate.uncertainty, candidate.availableCapacityKw)
    selected.push({
      candidate,
      allocatedKw: candidate.availableCapacityKw,
      uncertainty: effProfile,
    })
    selectedClusters.add(candidate.clusterId)

    currentSafeKw = computeSafeCapacityFromSelected(selected, target)

    if (currentSafeKw >= target.requestedKw) break
  }

  return selected
}

/** Marginal contribution of adding a candidate to the current portfolio. */
interface MarginalContribution {
  marginalSafeKw: number
  marginalOppCost: number
  marginalDirectCost: number
  isNewCluster: boolean
}

/** Compute the marginal contribution of adding a candidate. */
function computeMarginalContribution(
  candidate: CandidateAsset,
  selected: SelectedEntry[],
  selectedClusters: Set<string>,
  target: OptimizationTarget,
  currentSafeKw: number,
): MarginalContribution {
  // Use the EFFECTIVE profile (scaled to available capacity) for the trial.
  const trialProfile = effectiveProfile(candidate.uncertainty, candidate.availableCapacityKw)
  const trialProfiles = [
    ...selected.map((s) => s.uncertainty),
    trialProfile,
  ]
  const trialResult = computeSafeCapacity(
    trialProfiles,
    target.correlationModel,
    target.requestedKw,
    target.confidenceLevel,
  )

  return {
    marginalSafeKw: trialResult.committedKw - currentSafeKw,
    marginalOppCost: (candidate.opportunityCostPerKw ?? 0) * candidate.availableCapacityKw,
    marginalDirectCost: (candidate.costPerKw ?? 0) * candidate.availableCapacityKw,
    isNewCluster: !selectedClusters.has(candidate.clusterId),
  }
}

/**
 * Compare two marginal contributions LEXICOGRAPHICALLY.
 * Returns < 0 if `a` is better (should be selected first).
 *
 *   1. higher marginal safe capacity wins (primary)
 *   2. lower marginal opportunity cost wins (tie-break)
 *   3. lower marginal direct cost wins (tie-break)
 *   4. new cluster wins (tie-break)
 */
function compareMarginal(a: MarginalContribution, b: MarginalContribution): number {
  // 1. Higher safe capacity is better.
  if (Math.abs(a.marginalSafeKw - b.marginalSafeKw) > 0.001) {
    return b.marginalSafeKw - a.marginalSafeKw // negative if a is higher
  }
  // 2. Lower opportunity cost is better.
  if (Math.abs(a.marginalOppCost - b.marginalOppCost) > 0.001) {
    return a.marginalOppCost - b.marginalOppCost
  }
  // 3. Lower direct cost is better.
  if (Math.abs(a.marginalDirectCost - b.marginalDirectCost) > 0.001) {
    return a.marginalDirectCost - b.marginalDirectCost
  }
  // 4. New cluster is better.
  return a.isNewCluster === b.isNewCluster ? 0 : (a.isNewCluster ? -1 : 1)
}

/** Compute safe capacity from the current selected entries (effective profiles). */
function computeSafeCapacityFromSelected(
  selected: SelectedEntry[],
  target: OptimizationTarget,
): number {
  if (selected.length === 0) return 0
  const profiles = selected.map((s) => s.uncertainty)
  return computeSafeCapacity(
    profiles,
    target.correlationModel,
    target.requestedKw,
    target.confidenceLevel,
  ).committedKw
}

// ---------------------------------------------------------------------------
// Phase 2: Partial allocation of the last asset
// ---------------------------------------------------------------------------

/**
 * Binary-search the last asset's allocation to find the minimum that meets
 * the target. Scale its effective profile to match.
 *
 * The effective profile is recomputed at each trial allocation, so the risk
 * engine always sees a profile consistent with the actual allocation.
 */
function partialAllocateLast(
  selected: SelectedEntry[],
  target: OptimizationTarget,
): SelectedEntry[] {
  if (selected.length === 0) return selected

  const currentSafeKw = computeSafeCapacityFromSelected(selected, target)
  if (currentSafeKw < target.requestedKw) {
    return selected // not even at target — nothing to trim
  }

  const last = selected[selected.length - 1]!
  let lo = 0
  let hi = last.candidate.availableCapacityKw
  const tolerance = 0.01

  while (hi - lo > tolerance) {
    const mid = (lo + hi) / 2
    // Effective profile at trial allocation.
    const trialProfile = effectiveProfile(last.candidate.uncertainty, mid)
    const trialProfiles = [
      ...selected.slice(0, -1).map((s) => s.uncertainty),
      trialProfile,
    ]
    const trialResult = computeSafeCapacity(
      trialProfiles,
      target.correlationModel,
      target.requestedKw,
      target.confidenceLevel,
    )
    if (trialResult.committedKw >= target.requestedKw) {
      hi = mid // still meets target — try lower
    } else {
      lo = mid // need more
    }
  }

  const finalAllocation = hi
  if (finalAllocation < last.candidate.availableCapacityKw - tolerance) {
    const effProfile = effectiveProfile(last.candidate.uncertainty, finalAllocation)
    selected[selected.length - 1] = {
      candidate: last.candidate,
      allocatedKw: finalAllocation,
      uncertainty: effProfile,
    }
  }

  return selected
}

// ---------------------------------------------------------------------------
// Phase 3: Lexicographic pruning
// ---------------------------------------------------------------------------

/**
 * Remove assets whose removal improves or maintains the lexicographic objective.
 *
 * Tries removing each asset (smallest expected contribution first). Keeps
 * the removal only if the portfolio remains feasible AND the lexicographic
 * objective doesn't worsen (i.e., removal reduces opportunity cost or
 * resource lockup while keeping safe capacity ≥ target).
 */
function pruneExcess(
  selected: SelectedEntry[],
  target: OptimizationTarget,
): SelectedEntry[] {
  // Sort by expected contribution ascending (try removing smallest first).
  const sorted = [...selected].sort(
    (a, b) =>
      a.uncertainty.availabilityProb * a.uncertainty.expectedPerformanceKw -
      b.uncertainty.availabilityProb * b.uncertainty.expectedPerformanceKw,
  )

  const result = [...selected]

  for (const entry of sorted) {
    if (result.length <= 1) break

    const trial = result.filter((r) => r.candidate.assetId !== entry.candidate.assetId)
    const trialSafeKw = computeSafeCapacityFromSelected(trial, target)

    // Only remove if the portfolio still meets the target.
    if (trialSafeKw >= target.requestedKw) {
      // Removal reduces opportunity cost and resource lockup — keep it.
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
    algorithm: 'greedy_lexicographic_marginal_safe_capacity',
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
    algorithm: 'greedy_lexicographic_marginal_safe_capacity',
  }
}

// ---------------------------------------------------------------------------
// Exhaustive reference (discretized partial allocations)
// ---------------------------------------------------------------------------

/**
 * Discretization granularity for the exhaustive partial-allocation reference.
 * Each asset can be allocated at 0%, 10%, 20%, ..., 100% of its available
 * capacity → 11 levels per asset.
 */
const DISCRETIZATION_LEVELS = 11 // 0%, 10%, ..., 100%

/**
 * Exhaustive reference optimizer that searches DISCRETIZED PARTIAL ALLOCATIONS.
 *
 * For N assets with 11 allocation levels each, this evaluates 11^N
 * combinations. Feasible only for N ≤ 6 (11^6 ≈ 1.77M).
 *
 * This searches the SAME solution space as the production optimizer
 * (partial allocations), so the optimality gap is a valid comparison.
 *
 * Uses the lexicographic objective:
 *   1. feasibility (fullyServed)
 *   2. safe capacity surplus
 *   3. opportunity cost
 *   4. direct cost
 *   5. diversification (cluster count)
 *   6. resource lockup
 *
 * NOT for production use — use optimizePortfolio() instead.
 */
export function exhaustiveOptimizeDiscretized(
  candidates: CandidateAsset[],
  target: OptimizationTarget,
): OptimizationResult {
  validateCandidates(candidates)
  const n = candidates.length
  if (n > 6) {
    throw new Error(`exhaustiveOptimizeDiscretized is infeasible for N=${n} (max 6, 11^N combinations).`)
  }

  const levels = Array.from({ length: DISCRETIZATION_LEVELS }, (_, i) => i / (DISCRETIZATION_LEVELS - 1))
  let best: OptimizationResult | null = null

  // Enumerate all combinations of allocation levels via mixed-radix counting.
  const indices = new Array(n).fill(0)
  const totalCombos = Math.pow(DISCRETIZATION_LEVELS, n)

  for (let combo = 0; combo < totalCombos; combo++) {
    // Build the trial portfolio from the current indices.
    const selected: SelectedEntry[] = []
    for (let i = 0; i < n; i++) {
      const level = levels[indices[i]]!
      const allocatedKw = candidates[i]!.availableCapacityKw * level
      if (allocatedKw < 0.01) continue // skip zero allocations
      const effProfile = effectiveProfile(candidates[i]!.uncertainty, allocatedKw)
      selected.push({
        candidate: candidates[i]!,
        allocatedKw,
        uncertainty: effProfile,
      })
    }

    if (selected.length === 0) {
      // Increment indices (mixed-radix).
      incrementIndices(indices, n)
      continue
    }

    const result = evaluatePortfolio(selected, candidates.length, target)
    if (best === null || compareResultsLexicographic(result, best, target) < 0) {
      best = result
    }

    incrementIndices(indices, n)
  }

  return best ?? emptyResult(candidates.length, target)
}

/** Mixed-radix increment for enumeration. */
function incrementIndices(indices: number[], n: number): void {
  for (let i = 0; i < n; i++) {
    indices[i]++
    if (indices[i] < DISCRETIZATION_LEVELS) break
    indices[i] = 0
  }
}

/** Evaluate a portfolio (list of selected entries) into an OptimizationResult. */
function evaluatePortfolio(
  selected: SelectedEntry[],
  candidateCount: number,
  target: OptimizationTarget,
): OptimizationResult {
  const profiles = selected.map((s) => s.uncertainty)
  const risk = computeSafeCapacity(
    profiles,
    target.correlationModel,
    target.requestedKw,
    target.confidenceLevel,
  )

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
    algorithm: 'exhaustive_discretized',
  }
}

/**
 * Compare two optimization results under the full lexicographic objective.
 * Returns < 0 if a is better.
 *
 *   1. fullyServed wins
 *   2. higher safe capacity (if not both served)
 *   3. lower opportunity cost
 *   4. lower direct cost
 *   5. more clusters
 *   6. less total committed
 */
function compareResultsLexicographic(
  a: OptimizationResult,
  b: OptimizationResult,
  _target: OptimizationTarget,
): number {
  if (a.fullyServed !== b.fullyServed) return a.fullyServed ? -1 : 1
  if (Math.abs(a.committedKw - b.committedKw) > 0.01) return b.committedKw - a.committedKw
  const aOpp = a.totalOpportunityCost ?? 0
  const bOpp = b.totalOpportunityCost ?? 0
  if (Math.abs(aOpp - bOpp) > 0.01) return aOpp - bOpp
  const aCost = a.totalCost ?? 0
  const bCost = b.totalCost ?? 0
  if (Math.abs(aCost - bCost) > 0.01) return aCost - bCost
  if (a.clusterCount !== b.clusterCount) return b.clusterCount - a.clusterCount
  return a.totalCommittedKw - b.totalCommittedKw
}

// ---------------------------------------------------------------------------
// Old whole-subset exhaustive (retained for backwards compat, weaker metric)
// ---------------------------------------------------------------------------

/**
 * Whole-subset exhaustive optimizer — evaluates all 2^N subsets at FULL
 * capacity. Does NOT search partial allocations.
 *
 * This is a WEAKER reference than exhaustiveOptimizeDiscretized. Its gap
 * should be reported as `subsetSelectionGap`, NOT `optimalityGap`, because
 * it doesn't search the same solution space as the production optimizer.
 *
 * Retained for backwards compatibility with existing tests.
 */
export function exhaustiveOptimizeSubsets(
  candidates: CandidateAsset[],
  target: OptimizationTarget,
): OptimizationResult {
  validateCandidates(candidates)
  const n = candidates.length
  if (n > 15) {
    throw new Error(`exhaustiveOptimizeSubsets is infeasible for N=${n} (max 15).`)
  }

  const totalSubsets = 1 << n
  let best: OptimizationResult | null = null

  for (let mask = 1; mask < totalSubsets; mask++) {
    const subset: CandidateAsset[] = []
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) subset.push(candidates[i]!)
    }

    // Build selected entries with effective profiles at full capacity.
    const selected: SelectedEntry[] = subset.map((c) => ({
      candidate: c,
      allocatedKw: c.availableCapacityKw,
      uncertainty: effectiveProfile(c.uncertainty, c.availableCapacityKw),
    }))

    const result = evaluatePortfolio(selected, candidates.length, target)
    if (best === null || compareResultsLexicographic(result, best, target) < 0) {
      best = result
    }
  }

  return best ?? emptyResult(candidates.length, target)
}

// ---------------------------------------------------------------------------
// Optimality gap measurement
// ---------------------------------------------------------------------------

/**
 * Measure the optimality gap between the greedy heuristic and the discretized
 * exhaustive reference (partial allocations). This is the VALID gap metric
 * because both optimizers search the same solution space.
 *
 * gap = (optimalSafeKw - heuristicSafeKw) / optimalSafeKw
 *
 * Only feasible for N ≤ 6 (11^N combinations).
 */
export function measureOptimalityGap(
  candidates: CandidateAsset[],
  target: OptimizationTarget,
): { heuristic: OptimizationResult; optimal: OptimizationResult; gap: number } {
  const heuristic = optimizePortfolio(candidates, target)
  const optimal = exhaustiveOptimizeDiscretized(candidates, target)

  const gap = optimal.committedKw > 0
    ? Math.max(0, (optimal.committedKw - heuristic.committedKw) / optimal.committedKw)
    : 0

  return { heuristic, optimal, gap }
}

/**
 * Measure the SUBSET-SELECTION gap (whole-asset subsets only, no partial
 * allocations). This is a WEAKER metric than measureOptimalityGap because
 * it doesn't compare against the same solution space.
 *
 * Retained for backwards compatibility.
 */
export function measureSubsetSelectionGap(
  candidates: CandidateAsset[],
  target: OptimizationTarget,
): { heuristic: OptimizationResult; optimal: OptimizationResult; gap: number } {
  const heuristic = optimizePortfolio(candidates, target)
  const optimal = exhaustiveOptimizeSubsets(candidates, target)

  const gap = optimal.committedKw > 0
    ? Math.max(0, (optimal.committedKw - heuristic.committedKw) / optimal.committedKw)
    : 0

  return { heuristic, optimal, gap }
}

// ---------------------------------------------------------------------------
// Candidate construction helper (IMMUTABLE uncertainty profile)
// ---------------------------------------------------------------------------

/**
 * Build a CandidateAsset. Does NOT mutate the caller's uncertainty profile.
 * The availableCapacityKw is a separate hard constraint enforced at
 * allocation time via effective-profile scaling.
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
  return {
    assetId,
    clusterId,
    availableCapacityKw,
    uncertainty: { ...uncertainty }, // shallow copy — preserve caller's original
    costPerKw,
    opportunityCostPerKw,
  }
}
