/**
 * VPP-2D-2: Portfolio Optimizer tests.
 *
 * Tests the generic portfolio optimizer: given a pool of candidate assets
 * (each with uncertainty, availability, cluster, available capacity, optional
 * cost), select a subset that satisfies a capacity request at a target
 * confidence level while minimizing risk and cost.
 *
 * Properties verified:
 *   - Basic selection: optimizer selects enough assets to meet the target
 *   - Safe capacity: committed ≥ target when pool is sufficient
 *   - Insufficient capacity: shortfall reported when pool can't meet target
 *   - Correlation diversification: optimizer prefers spreading across clusters
 *   - Availability: lower-availability assets require more total capacity
 *   - Opportunity cost: lower-opportunity-cost assets preferred
 *   - Pruning: redundant assets removed after greedy selection
 *   - Empty/edge cases: empty pool, zero request, no viable candidates
 *   - Large portfolio (100 candidates) sanity
 *
 * Run: bun test tests/portfolio-optimizer.test.ts --timeout 30000
 */
import { describe, it, expect } from 'bun:test'
import {
  optimizePortfolio,
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
// Tests
// ---------------------------------------------------------------------------

describe('Portfolio Optimizer: basic selection', () => {
  it('selects enough assets to meet the target', () => {
    // 10 assets, each 50 kW, low variance → safe capacity should easily meet 200 kW.
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        expectedPerformanceKw: 50,
        availableCapacityKw: 50,
        uncertainty: makeProfile({
          assetId: `a${i}`,
          expectedPerformanceKw: 50,
          stdDevKw: 1,
          availabilityProb: 1.0,
        }),
      }),
    )

    const result = optimizePortfolio(candidates, makeTarget(200))

    expect(result.fullyServed).toBe(true)
    expect(result.committedKw >= 200 || result.selected.length === 10).toBe(true)
    expect(result.shortfallKw).toBe(0)
    expect(result.selected.length).toBeGreaterThan(0)
  })

  it('commits capacity at the requested confidence level', () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 100, stdDevKw: 10, availabilityProb: 0.95 }),
      }),
    )

    const result = optimizePortfolio(candidates, makeTarget(300, NO_CORRELATION, 0.99))

    // The risk engine's safe capacity at 99% should be reflected.
    expect(result.risk.confidenceLevel).toBe(0.99)
    expect(result.risk.distributionModel).toBe('normal_approximation')
  })
})

describe('Portfolio Optimizer: insufficient capacity', () => {
  it('reports shortfall when the pool cannot meet the target', () => {
    // 2 assets of 50 kW each → max 100 kW. Request 500 kW.
    const candidates = [
      makeCandidate({ assetId: 'a', availableCapacityKw: 50 }),
      makeCandidate({ assetId: 'b', availableCapacityKw: 50 }),
    ]

    const result = optimizePortfolio(candidates, makeTarget(500))

    expect(result.fullyServed).toBe(false)
    expect(result.shortfallKw).toBeGreaterThan(0)
    expect(result.selected.length).toBe(2) // selected all available
  })

  it('reports full shortfall when pool is empty', () => {
    const result = optimizePortfolio([], makeTarget(100))

    expect(result.fullyServed).toBe(false)
    expect(result.shortfallKw).toBe(100)
    expect(result.selected.length).toBe(0)
    expect(result.totalCommittedKw).toBe(0)
  })
})

describe('Portfolio Optimizer: correlation diversification', () => {
  it('prefers spreading across clusters when correlation is high within-cluster', () => {
    // 10 assets in ONE cluster vs 10 assets spread across 10 clusters.
    // Both have the same per-asset stats. The diversified pool should
    // achieve higher safe capacity (lower portfolio variance).
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

    // The diversified pool should commit more (or need fewer assets) because
    // cross-cluster correlation is lower → lower portfolio variance →
    // higher safe capacity.
    expect(result2.committedKw).toBeGreaterThanOrEqual(result1.committedKw)

    // The diversified pool should use more clusters.
    expect(result2.clusterCount).toBeGreaterThanOrEqual(result1.clusterCount)
  })

  it('selects from multiple clusters even when one cluster has more capacity', () => {
    // Cluster A has 5 assets, cluster B has 2. Optimizer should still pick
    // from both to diversify (not just the bigger cluster).
    const candidates = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeCandidate({ assetId: `a${i}`, clusterId: 'A' }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeCandidate({ assetId: `b${i}`, clusterId: 'B' }),
      ),
    ]

    const result = optimizePortfolio(candidates, makeTarget(200, REALISTIC))

    // Should have selected from more than one cluster (diversification).
    expect(result.clusterCount).toBeGreaterThan(1)
  })
})

describe('Portfolio Optimizer: availability effect', () => {
  it('lower-availability assets require more total selection to meet target', () => {
    const highAvail = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 5, availabilityProb: 0.99 }),
      }),
    )
    const lowAvail = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 5, availabilityProb: 0.70 }),
      }),
    )

    const target = makeTarget(200, NO_CORRELATION)
    const resultHigh = optimizePortfolio(highAvail, target)
    const resultLow = optimizePortfolio(lowAvail, target)

    // Lower availability → need more assets (or achieve lower safe capacity).
    // Either resultLow.selected.length > resultHigh.selected.length,
    // or resultLow.committedKw < resultHigh.committedKw.
    const lowNeedsMore = resultLow.selected.length >= resultHigh.selected.length
    const lowCommitsLess = resultLow.committedKw <= resultHigh.committedKw
    expect(lowNeedsMore || lowCommitsLess).toBe(true)
  })
})

describe('Portfolio Optimizer: opportunity cost', () => {
  it('prefers lower-opportunity-cost assets when risk is similar', () => {
    // 10 expensive assets (oppCost=10) + 10 cheap assets (oppCost=1).
    // Both have identical risk profiles. Optimizer should prefer cheap.
    const expensive = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({
        assetId: `exp-${i}`,
        clusterId: `exp-${i}`,
        opportunityCostPerKw: 10,
        uncertainty: makeProfile({ assetId: `exp-${i}`, expectedPerformanceKw: 50, stdDevKw: 2, availabilityProb: 0.99 }),
      }),
    )
    const cheap = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({
        assetId: `cheap-${i}`,
        clusterId: `cheap-${i}`,
        opportunityCostPerKw: 1,
        uncertainty: makeProfile({ assetId: `cheap-${i}`, expectedPerformanceKw: 50, stdDevKw: 2, availabilityProb: 0.99 }),
      }),
    )

    const result = optimizePortfolio([...expensive, ...cheap], makeTarget(200))

    // All selected assets should be from the cheap pool.
    const selectedIds = result.selected.map((s) => s.assetId)
    const allCheap = selectedIds.every((id) => id.startsWith('cheap-'))
    expect(allCheap).toBe(true)

    // Total opportunity cost should be low.
    expect(result.totalOpportunityCost).toBeDefined()
    expect(result.totalOpportunityCost!).toBeLessThan(200 * 10) // less than if all expensive
  })

  it('prefers lower-cost assets when risk is similar', () => {
    const expensive = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({
        assetId: `exp-${i}`,
        clusterId: `c${i}`,
        costPerKw: 0.20,
        uncertainty: makeProfile({ assetId: `exp-${i}`, expectedPerformanceKw: 50, stdDevKw: 2, availabilityProb: 0.99 }),
      }),
    )
    const cheap = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({
        assetId: `cheap-${i}`,
        clusterId: `d${i}`,
        costPerKw: 0.05,
        uncertainty: makeProfile({ assetId: `cheap-${i}`, expectedPerformanceKw: 50, stdDevKw: 2, availabilityProb: 0.99 }),
      }),
    )

    const result = optimizePortfolio([...expensive, ...cheap], makeTarget(200))

    const selectedIds = result.selected.map((s) => s.assetId)
    const allCheap = selectedIds.every((id) => id.startsWith('cheap-'))
    expect(allCheap).toBe(true)
    expect(result.totalCost).toBeDefined()
  })
})

describe('Portfolio Optimizer: pruning', () => {
  it('removes redundant assets that overshoot the target', () => {
    // 20 assets, each 50 kW, low variance. Request 100 kW.
    // Greedy might select 3-4; pruning should reduce to the minimum needed.
    const candidates = Array.from({ length: 20 }, (_, i) =>
      makeCandidate({
        assetId: `a${i}`,
        clusterId: `c${i}`, // each in its own cluster (no correlation)
        uncertainty: makeProfile({ assetId: `a${i}`, expectedPerformanceKw: 50, stdDevKw: 1, availabilityProb: 1.0 }),
      }),
    )

    const result = optimizePortfolio(candidates, makeTarget(100))

    expect(result.fullyServed).toBe(true)
    // Should NOT have selected all 20 — pruning should keep it minimal.
    expect(result.selected.length).toBeLessThan(20)
    expect(result.selected.length).toBeGreaterThanOrEqual(2)
  })
})

describe('Portfolio Optimizer: edge cases', () => {
  it('zero request → empty selection, fully served', () => {
    const candidates = [makeCandidate({ assetId: 'a' })]
    const result = optimizePortfolio(candidates, makeTarget(0))

    expect(result.fullyServed).toBe(true)
    expect(result.selected.length).toBe(0)
    expect(result.totalCommittedKw).toBe(0)
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

describe('Portfolio Optim: 100-candidate sanity', () => {
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

    // Should select a subset that meets or approaches the target.
    expect(result.selected.length).toBeGreaterThan(0)
    expect(result.selected.length).toBeLessThan(100) // not all
    expect(result.clusterCount).toBeGreaterThan(1) // diversified
    expect(result.candidateCount).toBe(100)

    // With realistic correlation, 2000 kW should be achievable from 100 DERs.
    if (result.fullyServed) {
      expect(result.committedKw).toBeGreaterThanOrEqual(2000)
    }
  })
})

describe('Portfolio Optimizer: buildCandidate helper', () => {
  it('caps expectedPerformanceKw at availableCapacityKw', () => {
    const candidate = buildCandidate({
      assetId: 'a',
      clusterId: 'north',
      availableCapacityKw: 30,
      uncertainty: makeProfile({ assetId: 'a', clusterId: 'north', expectedPerformanceKw: 50 }),
    })
    expect(candidate.uncertainty.expectedPerformanceKw).toBe(30) // capped
    expect(candidate.availableCapacityKw).toBe(30)
  })

  it('does not increase expectedPerformanceKw above the profile value', () => {
    const candidate = buildCandidate({
      assetId: 'a',
      clusterId: 'north',
      availableCapacityKw: 100, // more than the profile's 50
      uncertainty: makeProfile({ assetId: 'a', clusterId: 'north', expectedPerformanceKw: 50 }),
    })
    expect(candidate.uncertainty.expectedPerformanceKw).toBe(50) // not increased
  })

  it('preserves cost and opportunity cost', () => {
    const candidate = buildCandidate({
      assetId: 'a',
      clusterId: 'north',
      availableCapacityKw: 50,
      uncertainty: makeProfile({ assetId: 'a', clusterId: 'north' }),
      costPerKw: 0.10,
      opportunityCostPerKw: 5,
    })
    expect(candidate.costPerKw).toBe(0.10)
    expect(candidate.opportunityCostPerKw).toBe(5)
  })
})

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
      expect(s.expectedKw).toBeCloseTo(s.committedKw * (s.assetId === 'a' ? 0.9 : 0.8), 4)
    }
  })

  it('totalCommittedKw = sum of selected.committedKw', () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({ assetId: `a${i}`, clusterId: `c${i}` }),
    )
    const result = optimizePortfolio(candidates, makeTarget(100))

    const sum = result.selected.reduce((s, a) => s + a.committedKw, 0)
    expect(result.totalCommittedKw).toBeCloseTo(sum, 6)
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
})
