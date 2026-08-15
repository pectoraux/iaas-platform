/**
 * VPP-2D-2C: Portfolio Optimizer tests (effective-profile, lexicographic, partial).
 *
 * Tests the corrected optimizer:
 *   - Effective profile matches actual allocation (every asset, not just last)
 *   - Lexicographic objective (not blended ratio)
 *   - Discretized exhaustive reference (searches partial allocations)
 *   - Immutable uncertainty profiles
 *   - Candidate validation
 *   - Optimality gap (valid — same solution space)
 *
 * Run: bun test tests/portfolio-optimizer.test.ts --timeout 120000
 */
import { describe, it, expect } from 'bun:test'
import {
  optimizePortfolio,
  exhaustiveOptimizeDiscretized,
  exhaustiveOptimizeSubsets,
  measureOptimalityGap,
  measureSubsetSelectionGap,
  validateCandidates,
  buildCandidate,
  type CandidateAsset,
  type OptimizationTarget,
} from '../src/lib/services/portfolio-optimizer.service'
import type { DerUncertaintyProfile, CorrelationModel } from '../src/lib/services/portfolio-risk.service'
import { ValidationError } from '@/lib/domain/errors'

// Helpers

function makeProfile(overrides: Partial<DerUncertaintyProfile> & { assetId: string }): DerUncertaintyProfile {
  return {
    clusterId: 'default',
    expectedPerformanceKw: 50,
    stdDevKw: 5,
    availabilityProb: 0.97,
    ...overrides,
  }
}

function makeCandidate(overrides: Partial<CandidateAsset> & { assetId: string; expectedPerformanceKw?: number }): CandidateAsset {
  const assetId = overrides.assetId
  const clusterId = overrides.clusterId ?? 'default'
  const availableCapacityKw = overrides.availableCapacityKw ?? 50
  const expectedKw = overrides.expectedPerformanceKw ?? availableCapacityKw
  return {
    assetId,
    clusterId,
    availableCapacityKw,
    uncertainty: overrides.uncertainty ?? makeProfile({
      assetId,
      clusterId,
      expectedPerformanceKw: expectedKw,
    }),
    costPerKw: overrides.costPerKw,
    opportunityCostPerKw: overrides.opportunityCostPerKw,
  }
}

const NO_CORRELATION: CorrelationModel = { withinCluster: 0, crossCluster: 0 }
const REALISTIC: CorrelationModel = { withinCluster: 0.6, crossCluster: 0.1 }

function makeTarget(requestedKw: number, model: CorrelationModel = NO_CORRELATION, confidenceLevel = 0.99): OptimizationTarget {
  return { requestedKw, confidenceLevel, correlationModel: model }
}

// ---------------------------------------------------------------------------
// Candidate validation
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: candidate validation', () => {
  it('accepts valid candidates', () => {
    expect(() => validateCandidates([
      makeCandidate({ assetId: 'a', clusterId: 'x', availableCapacityKw: 50 }),
      makeCandidate({ assetId: 'b', clusterId: 'y', availableCapacityKw: 30 }),
    ])).not.toThrow()
  })

  it('rejects duplicate assetId', () => {
    expect(() => validateCandidates([makeCandidate({ assetId: 'a' }), makeCandidate({ assetId: 'a' })])).toThrow(ValidationError)
  })

  it('rejects negative availableCapacityKw', () => {
    expect(() => validateCandidates([makeCandidate({ assetId: 'a', availableCapacityKw: -5 })])).toThrow(ValidationError)
  })

  it('rejects availabilityProb outside [0, 1]', () => {
    expect(() => validateCandidates([makeCandidate({ assetId: 'a', uncertainty: makeProfile({ assetId: 'a', availabilityProb: 1.5 }) })])).toThrow(ValidationError)
  })

  it('rejects negative stdDevKw', () => {
    expect(() => validateCandidates([makeCandidate({ assetId: 'a', uncertainty: makeProfile({ assetId: 'a', stdDevKw: -1 }) })])).toThrow(ValidationError)
  })

  it('rejects empty clusterId', () => {
    expect(() => validateCandidates([makeCandidate({ assetId: 'a', clusterId: '' })])).toThrow(ValidationError)
  })

  it('rejects non-finite values', () => {
    expect(() => validateCandidates([makeCandidate({ assetId: 'a', availableCapacityKw: NaN })])).toThrow(ValidationError)
  })

  it('rejects negative costPerKw', () => {
    expect(() => validateCandidates([makeCandidate({ assetId: 'a', costPerKw: -0.1 })])).toThrow(ValidationError)
  })
})

// ---------------------------------------------------------------------------
// Effective profile consistency (the key 2D-2C fix)
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: effective profile matches allocation', () => {
  it('never lets expectedPerformanceKw exceed allocatedKw in the risk computation', () => {
    // Asset with expected=80, available=50. The optimizer must use an
    // effective profile where expected ≤ 50 in ALL risk computations —
    // not just the last asset.
    const candidates = [
      makeCandidate({
        assetId: 'a',
        availableCapacityKw: 50,
        uncertainty: makeProfile({ assetId: 'a', expectedPerformanceKw: 80, stdDevKw: 10, availabilityProb: 1.0 }),
      }),
      makeCandidate({
        assetId: 'b',
        availableCapacityKw: 50,
        uncertainty: makeProfile({ assetId: 'b', expectedPerformanceKw: 80, stdDevKw: 10, availabilityProb: 1.0 }),
      }),
      makeCandidate({
        assetId: 'c',
        availableCapacityKw: 50,
        uncertainty: makeProfile({ assetId: 'c', expectedPerformanceKw: 80, stdDevKw: 10, availabilityProb: 1.0 }),
      }),
    ]

    const result = optimizePortfolio(candidates, makeTarget(100))

    // The committed safe capacity must NOT exceed what 3 assets of 50 kW
    // can physically deliver. If the effective profile weren't applied,
    // expected=80 would inflate the safe capacity beyond 150 kW.
    // With effective profiles, expected is capped at 50 per asset.
    expect(result.committedKw).toBeLessThanOrEqual(150)
    // But it should still meet the target (3 × 50 = 150 kW expected, low risk).
    expect(result.committedKw).toBeGreaterThanOrEqual(100)
  })

  it('scales std dev proportionally when expected > available', () => {
    // expected=80, stdDev=10, available=50 → effective expected=50, effective stdDev=6.25
    // (scale = 50/80 = 0.625, stdDev = 10 × 0.625 = 6.25)
    const candidates = [
      makeCandidate({
        assetId: 'a',
        availableCapacityKw: 50,
        uncertainty: makeProfile({ assetId: 'a', expectedPerformanceKw: 80, stdDevKw: 10, availabilityProb: 1.0 }),
      }),
    ]

    const result = optimizePortfolio(candidates, makeTarget(30))

    // With 1 asset at effective expected=50, stdDev=6.25, the safe capacity
    // at 99% should be 50 - 2.326 × 6.25 ≈ 35.5 kW.
    // (If the profile weren't scaled, it would be 80 - 2.326 × 10 = 56.7,
    //  which is physically impossible for a 50 kW asset.)
    expect(result.committedKw).toBeLessThan(50) // can't exceed physical capacity
    expect(result.committedKw).toBeGreaterThan(30) // should meet the 30 kW target
  })

  it('does not inflate expected when available > expected', () => {
    // expected=30, available=100 → effective expected stays 30 (no inflation).
    const candidates = [
      makeCandidate({
        assetId: 'a',
        availableCapacityKw: 100,
        uncertainty: makeProfile({ assetId: 'a', expectedPerformanceKw: 30, stdDevKw: 2, availabilityProb: 1.0 }),
      }),
    ]

    const result = optimizePortfolio(candidates, makeTarget(20))

    // Safe capacity should be based on expected=30, not 100.
    // 30 - 2.326 × 2 = 25.3 kW.
    expect(result.committedKw).toBeLessThan(30)
    expect(result.committedKw).toBeGreaterThan(20)
  })
})

// ---------------------------------------------------------------------------
// Basic selection
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: basic selection', () => {
  it('selects enough assets to meet the target', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ assetId: `a${i}`, uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 1, availabilityProb: 1.0 }) }),
    )

    const result = optimizePortfolio(candidates, makeTarget(200))

    expect(result.fullyServed).toBe(true)
    expect(result.committedKw).toBeGreaterThanOrEqual(200)
    expect(result.algorithm).toBe('greedy_lexicographic_marginal_safe_capacity')
  })
})

// ---------------------------------------------------------------------------
// Partial allocation
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: partial allocation', () => {
  it('can commit less than the full available capacity on the last asset', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        clusterId: `c${i}`,
        availableCapacityKw: 100,
        uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 100, stdDevKw: 1, availabilityProb: 1.0 }),
      }),
    )

    const result = optimizePortfolio(candidates, makeTarget(250))

    expect(result.fullyServed).toBe(true)
    const partial = result.selected.filter((s) => s.committedKw < 100)
    expect(partial.length).toBeGreaterThan(0)
    expect(result.totalCommittedKw).toBeLessThan(300)
  })
})

// ---------------------------------------------------------------------------
// Lexicographic objective
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: lexicographic objective', () => {
  it('prefers higher marginal safe capacity over lower opportunity cost', () => {
    // Candidate A: high marginal safe capacity, high opportunity cost
    // Candidate B: lower marginal safe capacity, low opportunity cost
    // The optimizer should prefer A (safe capacity is primary).
    const candidates = [
      makeCandidate({
        assetId: 'A',
        clusterId: 'A',
        availableCapacityKw: 100,
        uncertainty: makeProfile({ assetId: 'A', expectedPerformanceKw: 100, stdDevKw: 2, availabilityProb: 1.0 }),
        opportunityCostPerKw: 100, // high opp cost
      }),
      makeCandidate({
        assetId: 'B',
        clusterId: 'B',
        availableCapacityKw: 50,
        uncertainty: makeProfile({ assetId: 'B', expectedPerformanceKw: 50, stdDevKw: 2, availabilityProb: 1.0 }),
        opportunityCostPerKw: 1, // low opp cost
      }),
    ]

    const result = optimizePortfolio(candidates, makeTarget(100))

    // A should be selected first (higher marginal safe capacity) despite
    // its high opportunity cost.
    expect(result.selected.some((s) => s.assetId === 'A')).toBe(true)
  })

  it('uses opportunity cost as a tie-breaker when safe capacity is equal', () => {
    // Two candidates with identical risk profiles but different opp costs.
    // The cheaper one should be preferred.
    const candidates = [
      makeCandidate({
        assetId: 'expensive',
        clusterId: 'e',
        availableCapacityKw: 100,
        uncertainty: makeProfile({ assetId: 'expensive', expectedPerformanceKw: 100, stdDevKw: 5, availabilityProb: 0.95 }),
        opportunityCostPerKw: 10,
      }),
      makeCandidate({
        assetId: 'cheap',
        clusterId: 'c',
        availableCapacityKw: 100,
        uncertainty: makeProfile({ assetId: 'cheap', expectedPerformanceKw: 100, stdDevKw: 5, availabilityProb: 0.95 }),
        opportunityCostPerKw: 1,
      }),
    ]

    const result = optimizePortfolio(candidates, makeTarget(50))

    // Both have equal marginal safe capacity. The cheaper one should win.
    expect(result.selected.some((s) => s.assetId === 'cheap')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Immutable profiles
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: immutable profiles', () => {
  it('buildCandidate does not mutate the caller uncertainty profile', () => {
    const original = makeProfile({ assetId: 'a', clusterId: 'x', expectedPerformanceKw: 80 })
    const originalCopy = { ...original }

    buildCandidate({
      assetId: 'a',
      clusterId: 'x',
      availableCapacityKw: 50,
      uncertainty: original,
    })

    expect(original).toEqual(originalCopy)
  })
})

// ---------------------------------------------------------------------------
// Insufficient capacity + edge cases
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: insufficient capacity', () => {
  it('reports shortfall when the pool cannot meet the target', () => {
    const candidates = [makeCandidate({ assetId: 'a', availableCapacityKw: 50 }), makeCandidate({ assetId: 'b', availableCapacityKw: 50 })]
    const result = optimizePortfolio(candidates, makeTarget(500))

    expect(result.fullyServed).toBe(false)
    expect(result.shortfallKw).toBeGreaterThan(0)
  })

  it('reports full shortfall when pool is empty', () => {
    const result = optimizePortfolio([], makeTarget(100))
    expect(result.fullyServed).toBe(false)
    expect(result.shortfallKw).toBe(100)
  })
})

describe('Portfolio Optimizer: edge cases', () => {
  it('zero request → empty selection, fully served', () => {
    const result = optimizePortfolio([makeCandidate({ assetId: 'a' })], makeTarget(0))
    expect(result.fullyServed).toBe(true)
    expect(result.selected.length).toBe(0)
  })

  it('candidates with zero available capacity are skipped', () => {
    const candidates = [makeCandidate({ assetId: 'a', availableCapacityKw: 0 }), makeCandidate({ assetId: 'b', availableCapacityKw: 50 })]
    const result = optimizePortfolio(candidates, makeTarget(40))
    expect(result.selected.some((s) => s.assetId === 'a')).toBe(false)
    expect(result.selected.some((s) => s.assetId === 'b')).toBe(true)
  })

  it('throws for negative requestedKw', () => {
    expect(() => optimizePortfolio([], makeTarget(-1))).toThrow(ValidationError)
  })

  it('throws for confidence outside (0, 1)', () => {
    expect(() => optimizePortfolio([], { requestedKw: 100, confidenceLevel: 0, correlationModel: NO_CORRELATION })).toThrow(ValidationError)
  })
})

// ---------------------------------------------------------------------------
// Correlation diversification
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: correlation diversification', () => {
  it('prefers spreading across clusters when correlation is high within-cluster', () => {
    const oneCluster = Array.from({ length: 10 }, (_, i) => makeCandidate({ assetId: `a${i}`, clusterId: 'single', uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 5, availabilityProb: 0.97 }) }))
    const manyClusters = Array.from({ length: 10 }, (_, i) => makeCandidate({ assetId: `a${i}`, clusterId: `c${i}`, uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 5, availabilityProb: 0.97 }) }))

    const target = makeTarget(400, REALISTIC)
    const result1 = optimizePortfolio(oneCluster, target)
    const result2 = optimizePortfolio(manyClusters, target)

    expect(result2.committedKw).toBeGreaterThanOrEqual(result1.committedKw)
    expect(result2.clusterCount).toBeGreaterThanOrEqual(result1.clusterCount)
  })
})

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: pruning', () => {
  it('removes redundant assets that overshoot the target', () => {
    const candidates = Array.from({ length: 20 }, (_, i) => makeCandidate({ assetId: `a${i}`, clusterId: `c${i}`, uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 1, availabilityProb: 1.0 }) }))
    const result = optimizePortfolio(candidates, makeTarget(100))
    expect(result.fullyServed).toBe(true)
    expect(result.selected.length).toBeLessThan(20)
  })
})

// ---------------------------------------------------------------------------
// Optimality gap (discretized exhaustive — valid comparison)
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: optimality gap (discretized exhaustive)', () => {
  it('exhaustiveOptimizeDiscretized returns a valid result for small N', () => {
    const candidates = Array.from({ length: 4 }, (_, i) =>
      makeCandidate({ assetId: `a${i}`, clusterId: `c${i}`, uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 5, availabilityProb: 0.95 }) }),
    )

    const optimal = exhaustiveOptimizeDiscretized(candidates, makeTarget(100))
    expect(optimal.algorithm).toBe('exhaustive_discretized')
    expect(optimal.selected.length).toBeGreaterThan(0)
  })

  it('greedy result is close to optimal for simple cases (valid comparison)', () => {
    // 5 candidates, all in different clusters, low variance.
    const candidates = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({ assetId: `a${i}`, clusterId: `c${i}`, uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 3, availabilityProb: 0.97 }) }),
    )

    const { heuristic, optimal, gap } = measureOptimalityGap(candidates, makeTarget(150))

    expect(heuristic.algorithm).toBe('greedy_lexicographic_marginal_safe_capacity')
    expect(optimal.algorithm).toBe('exhaustive_discretized')
    // Both search partial allocations — the gap is a valid comparison.
    expect(gap).toBeLessThan(0.15)
  })

  it('greedy gap is reasonable under realistic correlation', () => {
    // 5 candidates across 2 clusters, realistic correlation.
    const candidates = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({ assetId: `a${i}`, clusterId: `c${i % 2}`, uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 5, availabilityProb: 0.95 }) }),
    )

    const { gap } = measureOptimalityGap(candidates, makeTarget(150, REALISTIC))
    expect(gap).toBeLessThan(0.25)
  })

  it('exhaustiveOptimizeDiscretized rejects N > 6', () => {
    const candidates = Array.from({ length: 7 }, (_, i) => makeCandidate({ assetId: `a${i}`, clusterId: `c${i}` }))
    expect(() => exhaustiveOptimizeDiscretized(candidates, makeTarget(100))).toThrow()
  })

  it('partial-allocation optimum can differ from whole-subset optimum', () => {
    // Construct a case where partial allocation does better than whole-subset.
    // 3 assets of 100 kW each, request 150 kW. Whole-subset picks 2 assets
    // (200 kW committed). Partial can pick 2 assets at 75 kW each (150 kW
    // committed) — less resource lockup.
    const candidates = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        clusterId: `c${i}`,
        availableCapacityKw: 100,
        uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 100, stdDevKw: 1, availabilityProb: 1.0 }),
      }),
    )

    const target = makeTarget(150)
    const { heuristic, optimal } = measureOptimalityGap(candidates, target)
    const subsetResult = exhaustiveOptimizeSubsets(candidates, target)

    // The partial-allocation optimizer should commit less total physical
    // capacity than the whole-subset optimizer (for the same safe capacity).
    if (heuristic.fullyServed && subsetResult.fullyServed) {
      expect(heuristic.totalCommittedKw).toBeLessThanOrEqual(subsetResult.totalCommittedKw + 1) // +1 for discretization tolerance
    }

    // The discretized optimal should also be <= subset.
    if (optimal.fullyServed && subsetResult.fullyServed) {
      expect(optimal.totalCommittedKw).toBeLessThanOrEqual(subsetResult.totalCommittedKw + 1)
    }
  })
})

// ---------------------------------------------------------------------------
// Subset-selection gap (weaker metric, backwards compat)
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: subset-selection gap (weaker metric)', () => {
  it('exhaustiveOptimizeSubsets returns a valid result for N ≤ 15', () => {
    const candidates = Array.from({ length: 6 }, (_, i) => makeCandidate({ assetId: `a${i}`, clusterId: `c${i}` }))
    const optimal = exhaustiveOptimizeSubsets(candidates, makeTarget(150))
    expect(optimal.algorithm).toBe('exhaustive_discretized') // evaluatePortfolio sets this
  })

  it('measureSubsetSelectionGap returns non-negative gap', () => {
    const candidates = Array.from({ length: 6 }, (_, i) => makeCandidate({ assetId: `a${i}`, clusterId: `c${i}`, uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 40, stdDevKw: 8, availabilityProb: 0.9 }) }))
    const { gap } = measureSubsetSelectionGap(candidates, makeTarget(120))
    expect(gap).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// Result structure
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: result structure', () => {
  it('totalCommittedKw = sum of selected.committedKw', () => {
    const candidates = Array.from({ length: 5 }, (_, i) => makeCandidate({ assetId: `a${i}`, clusterId: `c${i}` }))
    const result = optimizePortfolio(candidates, makeTarget(100))
    const sum = result.selected.reduce((s, a) => s + a.committedKw, 0)
    expect(Math.abs(result.totalCommittedKw - sum)).toBeLessThan(0.01)
  })

  it('clusterCount = number of distinct clusters in selection', () => {
    const candidates = [makeCandidate({ assetId: 'a', clusterId: 'x' }), makeCandidate({ assetId: 'b', clusterId: 'x' }), makeCandidate({ assetId: 'c', clusterId: 'y' })]
    const result = optimizePortfolio(candidates, makeTarget(100, REALISTIC))
    const distinctClusters = new Set(result.selected.map((s) => s.clusterId)).size
    expect(result.clusterCount).toBe(distinctClusters)
  })

  it('result carries the algorithm name', () => {
    const result = optimizePortfolio([makeCandidate({ assetId: 'a' })], makeTarget(10))
    expect(result.algorithm).toBe('greedy_lexicographic_marginal_safe_capacity')
  })
})

// ---------------------------------------------------------------------------
// 100-candidate sanity
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: 100-candidate sanity', () => {
  it('100 candidates across 10 clusters: selects a feasible portfolio', () => {
    const candidates: CandidateAsset[] = []
    for (let cluster = 0; cluster < 10; cluster++) {
      for (let i = 0; i < 10; i++) {
        candidates.push(makeCandidate({
          assetId: `der-${cluster}-${i}`,
          clusterId: `region-${cluster}`,
          availableCapacityKw: 50,
          uncertainty: makeProfile({ assetId: `der-${cluster}-${i}`, clusterId: `region-${cluster}`, expectedPerformanceKw: 50, stdDevKw: 3, availabilityProb: 0.97 }),
        }))
      }
    }

    const result = optimizePortfolio(candidates, makeTarget(2000, REALISTIC))
    expect(result.selected.length).toBeGreaterThan(0)
    expect(result.selected.length).toBeLessThan(100)
    expect(result.clusterCount).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// buildCandidate helper
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: buildCandidate helper', () => {
  it('preserves the uncertainty profile without mutation', () => {
    const profile = makeProfile({ assetId: 'a', clusterId: 'x', expectedPerformanceKw: 80, stdDevKw: 10 })
    const candidate = buildCandidate({ assetId: 'a', clusterId: 'x', availableCapacityKw: 50, uncertainty: profile })
    expect(candidate.uncertainty.expectedPerformanceKw).toBe(80) // not capped
    expect(candidate.uncertainty.stdDevKw).toBe(10)
    expect(candidate.availableCapacityKw).toBe(50)
  })
})
