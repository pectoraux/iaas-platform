/**
 * VPP-2D-2B: Portfolio Optimizer tests (marginal-safe-capacity, partial allocation).
 *
 * Tests the hardened optimizer:
 *   - Explicit lexicographic objective
 *   - Marginal safe capacity scoring (not arbitrary weights)
 *   - Partial allocation (committedKw can be < availableCapacityKw)
 *   - Immutable uncertainty profiles (buildCandidate doesn't mutate)
 *   - Candidate validation
 *   - Optimality-gap measurement (greedy vs exhaustive for small N)
 *
 * Run: bun test tests/portfolio-optimizer.test.ts --timeout 60000
 */
import { describe, it, expect } from 'bun:test'
import {
  optimizePortfolio,
  exhaustiveOptimize,
  measureOptimalityGap,
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
    expect(() => validateCandidates([
      makeCandidate({ assetId: 'a' }),
      makeCandidate({ assetId: 'a' }),
    ])).toThrow(ValidationError)
  })

  it('rejects negative availableCapacityKw', () => {
    expect(() => validateCandidates([
      makeCandidate({ assetId: 'a', availableCapacityKw: -5 }),
    ])).toThrow(ValidationError)
  })

  it('rejects availabilityProb outside [0, 1]', () => {
    expect(() => validateCandidates([
      makeCandidate({ assetId: 'a', uncertainty: makeProfile({ assetId: 'a', availabilityProb: 1.5 }) }),
    ])).toThrow(ValidationError)
    expect(() => validateCandidates([
      makeCandidate({ assetId: 'b', uncertainty: makeProfile({ assetId: 'b', availabilityProb: -0.1 }) }),
    ])).toThrow(ValidationError)
  })

  it('rejects negative stdDevKw', () => {
    expect(() => validateCandidates([
      makeCandidate({ assetId: 'a', uncertainty: makeProfile({ assetId: 'a', stdDevKw: -1 }) }),
    ])).toThrow(ValidationError)
  })

  it('rejects empty clusterId', () => {
    expect(() => validateCandidates([
      makeCandidate({ assetId: 'a', clusterId: '' }),
    ])).toThrow(ValidationError)
  })

  it('rejects non-finite values', () => {
    expect(() => validateCandidates([
      makeCandidate({ assetId: 'a', availableCapacityKw: NaN }),
    ])).toThrow(ValidationError)
    expect(() => validateCandidates([
      makeCandidate({ assetId: 'b', availableCapacityKw: Infinity }),
    ])).toThrow(ValidationError)
  })

  it('rejects negative costPerKw', () => {
    expect(() => validateCandidates([
      makeCandidate({ assetId: 'a', costPerKw: -0.1 }),
    ])).toThrow(ValidationError)
  })
})

// ---------------------------------------------------------------------------
// Basic selection
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: basic selection', () => {
  it('selects enough assets to meet the target', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 1, availabilityProb: 1.0 }),
      }),
    )

    const result = optimizePortfolio(candidates, makeTarget(200))

    expect(result.fullyServed).toBe(true)
    expect(result.committedKw).toBeGreaterThanOrEqual(200)
    expect(result.shortfallKw).toBe(0)
    expect(result.selected.length).toBeGreaterThan(0)
    expect(result.algorithm).toBe('greedy_marginal_safe_capacity')
  })

  it('reflects the confidence level in the risk result', () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 100, stdDevKw: 10, availabilityProb: 0.95 }),
      }),
    )

    const result = optimizePortfolio(candidates, makeTarget(300, NO_CORRELATION, 0.99))

    expect(result.risk.confidenceLevel).toBe(0.99)
    expect(result.risk.distributionModel).toBe('normal_approximation')
  })
})

// ---------------------------------------------------------------------------
// Insufficient capacity
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: insufficient capacity', () => {
  it('reports shortfall when the pool cannot meet the target', () => {
    const candidates = [
      makeCandidate({ assetId: 'a', availableCapacityKw: 50 }),
      makeCandidate({ assetId: 'b', availableCapacityKw: 50 }),
    ]

    const result = optimizePortfolio(candidates, makeTarget(500))

    expect(result.fullyServed).toBe(false)
    expect(result.shortfallKw).toBeGreaterThan(0)
    expect(result.selected.length).toBe(2)
  })

  it('reports full shortfall when pool is empty', () => {
    const result = optimizePortfolio([], makeTarget(100))

    expect(result.fullyServed).toBe(false)
    expect(result.shortfallKw).toBe(100)
    expect(result.selected.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Partial allocation
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: partial allocation', () => {
  it('can commit less than the full available capacity on the last asset', () => {
    // 10 assets of 100 kW each, very low variance. Request 250 kW.
    // The optimizer should select 3 assets but only partially allocate the 3rd.
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
    // At least one asset should have committedKw < availableCapacityKw.
    const partial = result.selected.filter((s) => s.committedKw < 100)
    expect(partial.length).toBeGreaterThan(0)
    // Total committed should be close to 250, not 300+.
    expect(result.totalCommittedKw).toBeLessThan(300)
  })

  it('totalCommittedKw is close to the requested amount when partial allocation works', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        clusterId: `c${i}`,
        availableCapacityKw: 100,
        uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 100, stdDevKw: 0.5, availabilityProb: 1.0 }),
      }),
    )

    const result = optimizePortfolio(candidates, makeTarget(350))

    // With partial allocation, total committed should be near 350, not 400.
    expect(result.totalCommittedKw).toBeGreaterThanOrEqual(350)
    expect(result.totalCommittedKw).toBeLessThan(400)
  })
})

// ---------------------------------------------------------------------------
// Correlation diversification
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: correlation diversification', () => {
  it('prefers spreading across clusters when correlation is high within-cluster', () => {
    const oneCluster = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        clusterId: 'single',
        uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 5, availabilityProb: 0.97 }),
      }),
    )
    const manyClusters = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        clusterId: `c${i}`,
        uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 5, availabilityProb: 0.97 }),
      }),
    )

    const target = makeTarget(400, REALISTIC)
    const result1 = optimizePortfolio(oneCluster, target)
    const result2 = optimizePortfolio(manyClusters, target)

    expect(result2.committedKw).toBeGreaterThanOrEqual(result1.committedKw)
    expect(result2.clusterCount).toBeGreaterThanOrEqual(result1.clusterCount)
  })
})

// ---------------------------------------------------------------------------
// Opportunity cost
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: opportunity cost', () => {
  it('prefers lower-opportunity-cost assets when risk is similar', () => {
    const expensive = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({
        assetId: `exp-${i}`,
        clusterId: `e${i}`,
        opportunityCostPerKw: 10,
        uncertainty: makeProfile({ assetId: `exp-${i}`, expectedPerformanceKw: 50, stdDevKw: 2, availabilityProb: 0.99 }),
      }),
    )
    const cheap = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({
        assetId: `cheap-${i}`,
        clusterId: `c${i}`,
        opportunityCostPerKw: 1,
        uncertainty: makeProfile({ assetId: `cheap-${i}`, expectedPerformanceKw: 50, stdDevKw: 2, availabilityProb: 0.99 }),
      }),
    )

    const result = optimizePortfolio([...expensive, ...cheap], makeTarget(200))

    const selectedIds = result.selected.map((s) => s.assetId)
    const allCheap = selectedIds.every((id) => id.startsWith('cheap-'))
    expect(allCheap).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Immutable uncertainty profiles
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: immutable uncertainty profiles', () => {
  it('buildCandidate does not mutate the caller uncertainty profile', () => {
    const original = makeProfile({ assetId: 'a', clusterId: 'x', expectedPerformanceKw: 80 })
    const originalCopy = { ...original }

    const candidate = buildCandidate({
      assetId: 'a',
      clusterId: 'x',
      availableCapacityKw: 50, // less than expectedPerformanceKw=80
      uncertainty: original,
    })

    // The candidate's uncertainty should be a COPY, not a reference.
    expect(candidate.uncertainty).not.toBe(original)
    // The original should be unmutated.
    expect(original).toEqual(originalCopy)
    // The candidate should preserve the original expectedPerformanceKw
    // (NOT silently capped to 50).
    expect(candidate.uncertainty.expectedPerformanceKw).toBe(80)
  })

  it('optimizer preserves the uncertainty profile even when expected > available', () => {
    const candidates = [
      makeCandidate({
        assetId: 'a',
        availableCapacityKw: 30,
        uncertainty: makeProfile({ assetId: 'a', expectedPerformanceKw: 80, stdDevKw: 10 }),
      }),
      makeCandidate({
        assetId: 'b',
        availableCapacityKw: 30,
        uncertainty: makeProfile({ assetId: 'b', expectedPerformanceKw: 80, stdDevKw: 10 }),
      }),
    ]

    const result = optimizePortfolio(candidates, makeTarget(50))

    // The result should have selected assets, and the committedKw should
    // respect availableCapacityKw (≤ 30), not the expected (80).
    for (const s of result.selected) {
      expect(s.committedKw).toBeLessThanOrEqual(30)
    }
  })
})

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: pruning', () => {
  it('removes redundant assets that overshoot the target', () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        clusterId: `c${i}`,
        uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 1, availabilityProb: 1.0 }),
      }),
    )

    const result = optimizePortfolio(candidates, makeTarget(100))

    expect(result.fullyServed).toBe(true)
    expect(result.selected.length).toBeLessThan(20)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: edge cases', () => {
  it('zero request → empty selection, fully served', () => {
    const candidates = [makeCandidate({ assetId: 'a' })]
    const result = optimizePortfolio(candidates, makeTarget(0))

    expect(result.fullyServed).toBe(true)
    expect(result.selected.length).toBe(0)
  })

  it('candidates with zero available capacity are skipped', () => {
    const candidates = [
      makeCandidate({ assetId: 'a', availableCapacityKw: 0 }),
      makeCandidate({ assetId: 'b', availableCapacityKw: 50 }),
    ]
    const result = optimizePortfolio(candidates, makeTarget(40))

    expect(result.selected.some((s) => s.assetId === 'a')).toBe(false)
    expect(result.selected.some((s) => s.assetId === 'b')).toBe(true)
  })

  it('throws for negative requestedKw', () => {
    expect(() => optimizePortfolio([], makeTarget(-1))).toThrow(ValidationError)
  })

  it('throws for confidence outside (0, 1)', () => {
    expect(() => optimizePortfolio([], { requestedKw: 100, confidenceLevel: 0, correlationModel: NO_CORRELATION })).toThrow(ValidationError)
    expect(() => optimizePortfolio([], { requestedKw: 100, confidenceLevel: 1, correlationModel: NO_CORRELATION })).toThrow(ValidationError)
  })
})

// ---------------------------------------------------------------------------
// Optimality gap (greedy vs exhaustive)
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: optimality gap', () => {
  it('exhaustive optimizer returns a valid result for small N', () => {
    const candidates = Array.from({ length: 6 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        clusterId: `c${i}`,
        uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 5, availabilityProb: 0.95 }),
      }),
    )

    const optimal = exhaustiveOptimize(candidates, makeTarget(150))
    expect(optimal.algorithm).toBe('exhaustive')
    expect(optimal.selected.length).toBeGreaterThan(0)
    expect(optimal.committedKw).toBeGreaterThanOrEqual(0)
  })

  it('greedy result is close to optimal for simple cases', () => {
    // 8 candidates, all in different clusters, low variance.
    const candidates = Array.from({ length: 8 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        clusterId: `c${i}`,
        uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 3, availabilityProb: 0.97 }),
      }),
    )

    const { heuristic, optimal, gap } = measureOptimalityGap(candidates, makeTarget(200))

    expect(heuristic.algorithm).toBe('greedy_marginal_safe_capacity')
    expect(optimal.algorithm).toBe('exhaustive')
    // The gap should be small (< 10%) for this simple uncorrelated case.
    expect(gap).toBeLessThan(0.10)
  })

  it('greedy gap is reasonable under realistic correlation', () => {
    // 10 candidates across 3 clusters, realistic correlation.
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        clusterId: `c${i % 3}`,
        uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 5, availabilityProb: 0.95 }),
      }),
    )

    const { gap } = measureOptimalityGap(candidates, makeTarget(250, REALISTIC))

    // Under correlation, the gap may be larger but should still be bounded.
    expect(gap).toBeLessThan(0.20)
  })

  it('exhaustive optimizer rejects N > 15', () => {
    const candidates = Array.from({ length: 16 }, (_, i) =>
      makeCandidate({ assetId: `a${i}`, clusterId: `c${i}` }),
    )
    expect(() => exhaustiveOptimize(candidates, makeTarget(100))).toThrow()
  })

  it('measureOptimalityGap returns non-negative gap', () => {
    const candidates = Array.from({ length: 6 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        clusterId: `c${i}`,
        uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 40, stdDevKw: 8, availabilityProb: 0.9 }),
      }),
    )

    const { gap } = measureOptimalityGap(candidates, makeTarget(120))
    expect(gap).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// Result structure
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: result structure', () => {
  it('returns per-asset committedKw and expectedKw', () => {
    const candidates = [
      makeCandidate({
        assetId: 'a',
        uncertainty: makeProfile({ assetId: 'a', expectedPerformanceKw: 50, availabilityProb: 0.9 }),
      }),
      makeCandidate({
        assetId: 'b',
        uncertainty: makeProfile({ assetId: 'b', expectedPerformanceKw: 50, availabilityProb: 0.8 }),
      }),
    ]

    const result = optimizePortfolio(candidates, makeTarget(50))

    for (const s of result.selected) {
      expect(s.committedKw).toBeGreaterThan(0)
    }
  })

  it('totalCommittedKw = sum of selected.committedKw', () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({ assetId: `a${i}`, clusterId: `c${i}` }),
    )
    const result = optimizePortfolio(candidates, makeTarget(100))

    const sum = result.selected.reduce((s, a) => s + a.committedKw, 0)
    expect(Math.abs(result.totalCommittedKw - sum)).toBeLessThan(0.01)
  })

  it('clusterCount = number of distinct clusters in selection', () => {
    const candidates = [
      makeCandidate({ assetId: 'a', clusterId: 'x' }),
      makeCandidate({ assetId: 'b', clusterId: 'x' }),
      makeCandidate({ assetId: 'c', clusterId: 'y' }),
    ]
    const result = optimizePortfolio(candidates, makeTarget(100, REALISTIC))

    const distinctClusters = new Set(result.selected.map((s) => s.clusterId)).size
    expect(result.clusterCount).toBe(distinctClusters)
  })

  it('result carries the algorithm name', () => {
    const result = optimizePortfolio([makeCandidate({ assetId: 'a' })], makeTarget(10))
    expect(result.algorithm).toBe('greedy_marginal_safe_capacity')
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
        candidates.push(
          makeCandidate({
            assetId: `der-${cluster}-${i}`,
            clusterId: `region-${cluster}`,
            availableCapacityKw: 50,
            uncertainty: makeProfile({
              assetId: `der-${cluster}-${i}`,
              clusterId: `region-${cluster}`,
              expectedPerformanceKw: 50,
              stdDevKw: 3,
              availabilityProb: 0.97,
            }),
          }),
        )
      }
    }

    const result = optimizePortfolio(candidates, makeTarget(2000, REALISTIC))

    expect(result.selected.length).toBeGreaterThan(0)
    expect(result.selected.length).toBeLessThan(100)
    expect(result.clusterCount).toBeGreaterThan(1)
    expect(result.candidateCount).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// buildCandidate helper
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: buildCandidate helper', () => {
  it('preserves the uncertainty profile without mutation', () => {
    const profile = makeProfile({ assetId: 'a', clusterId: 'x', expectedPerformanceKw: 80, stdDevKw: 10 })
    const candidate = buildCandidate({
      assetId: 'a',
      clusterId: 'x',
      availableCapacityKw: 50,
      uncertainty: profile,
    })
    // The candidate should preserve the original expectedPerformanceKw.
    expect(candidate.uncertainty.expectedPerformanceKw).toBe(80)
    expect(candidate.uncertainty.stdDevKw).toBe(10)
    expect(candidate.availableCapacityKw).toBe(50)
  })

  it('preserves cost and opportunity cost', () => {
    const candidate = buildCandidate({
      assetId: 'a',
      clusterId: 'x',
      availableCapacityKw: 50,
      uncertainty: makeProfile({ assetId: 'a', clusterId: 'x' }),
      costPerKw: 0.10,
      opportunityCostPerKw: 5,
    })
    expect(candidate.costPerKw).toBe(0.10)
    expect(candidate.opportunityCostPerKw).toBe(5)
  })
})
