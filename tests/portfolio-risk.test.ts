/**
 * VPP-2D-1: Portfolio Risk Engine tests.
 *
 * Tests the pure computation engine: per-DER uncertainty → correlation →
 * portfolio VaR → safe committed capacity.
 *
 * Mathematical properties verified:
 *   - Per-DER contribution (E[X_i], Var(X_i)) with availability mixture
 *   - Uncorrelated portfolio: Var = Σ Var(X_i)
 *   - Correlated portfolio: Var is higher → safe capacity is lower
 *   - Availability effect: lower p → lower E[S], higher Var → lower safe capacity
 *   - Confidence level: higher c → higher z → lower safe capacity
 *   - Diversification: large N uncorrelated → σ/E ratio → 0
 *   - Perfect correlation: no diversification
 *   - Zero-correlation vs full-correlation extremes
 *   - Requested vs safe: platform under-promises when safe < requested
 *   - Large portfolio (100 DERs) sanity
 *
 * Run: bun test tests/portfolio-risk.test.ts --timeout 30000
 */
import { describe, it, expect } from 'bun:test'
import {
  computeDerContribution,
  buildCorrelationMatrix,
  computePortfolioRisk,
  computePortfolioRiskWithMatrix,
  computeSafeCapacity,
  inverseNormalCDF,
  deriveUncertaintyFromEvaluation,
  type DerUncertaintyProfile,
  type CorrelationModel,
} from '../src/lib/services/portfolio-risk.service'

// Helper: create a DER profile with sensible defaults.
function makeProfile(overrides: Partial<DerUncertaintyProfile> & { assetId: string }): DerUncertaintyProfile {
  return {
    clusterId: 'default',
    expectedPerformanceKwh: 10,
    stdDevKwh: 2,
    availabilityProb: 1.0,
    ...overrides,
  }
}

const NO_CORRELATION: CorrelationModel = { withinCluster: 0, crossCluster: 0 }
const FULL_CORRELATION: CorrelationModel = { withinCluster: 1, crossCluster: 1 }
const REALISTIC: CorrelationModel = { withinCluster: 0.6, crossCluster: 0.1 }

describe('Portfolio Risk: inverseNormalCDF', () => {
  it('returns known z-scores for common confidence levels', () => {
    // Standard values: z_0.95 ≈ 1.645, z_0.99 ≈ 2.326, z_0.999 ≈ 3.090
    expect(inverseNormalCDF(0.95)).toBeCloseTo(1.6449, 3)
    expect(inverseNormalCDF(0.99)).toBeCloseTo(2.3263, 3)
    expect(inverseNormalCDF(0.999)).toBeCloseTo(3.0902, 2)
  })

  it('returns 0 for p=0.5 (median)', () => {
    expect(inverseNormalCDF(0.5)).toBeCloseTo(0, 6)
  })

  it('throws for p outside (0, 1)', () => {
    expect(() => inverseNormalCDF(0)).toThrow()
    expect(() => inverseNormalCDF(1)).toThrow()
    expect(() => inverseNormalCDF(-0.1)).toThrow()
    expect(() => inverseNormalCDF(1.1)).toThrow()
  })
})

describe('Portfolio Risk: per-DER contribution', () => {
  it('E[X_i] = p · μ (availability scales expected performance)', () => {
    const c = computeDerContribution(makeProfile({
      assetId: 'a', expectedPerformanceKwh: 100, stdDevKwh: 5, availabilityProb: 0.9,
    }))
    expect(c.expectedKwh).toBeCloseTo(90, 6) // 0.9 * 100
  })

  it('Var(X_i) = p·σ² + p·(1-p)·μ² (law of total variance)', () => {
    const c = computeDerContribution(makeProfile({
      assetId: 'a', expectedPerformanceKwh: 100, stdDevKwh: 5, availabilityProb: 0.9,
    }))
    // 0.9 * 25 + 0.9 * 0.1 * 10000 = 22.5 + 900 = 922.5
    expect(c.varianceKwh2).toBeCloseTo(922.5, 4)
    expect(c.stdDevKwh).toBeCloseTo(Math.sqrt(922.5), 4)
  })

  it('p=1.0: Var = σ² (no availability mixture term)', () => {
    const c = computeDerContribution(makeProfile({
      assetId: 'a', expectedPerformanceKwh: 100, stdDevKwh: 5, availabilityProb: 1.0,
    }))
    expect(c.expectedKwh).toBe(100)
    expect(c.varianceKwh2).toBe(25) // 1.0 * 25 + 0 = 25
  })

  it('p=0.5: availability dominates variance when μ >> σ', () => {
    const c = computeDerContribution(makeProfile({
      assetId: 'a', expectedPerformanceKwh: 100, stdDevKwh: 5, availabilityProb: 0.5,
    }))
    // E = 50, Var = 0.5*25 + 0.5*0.5*10000 = 12.5 + 2500 = 2512.5
    expect(c.expectedKwh).toBe(50)
    expect(c.varianceKwh2).toBeCloseTo(2512.5, 2)
    // The availability term (2500) dominates the performance term (12.5).
    expect(c.varianceKwh2).toBeGreaterThan(2500)
  })
})

describe('Portfolio Risk: correlation matrix', () => {
  it('same cluster → withinCluster correlation', () => {
    const profiles = [
      makeProfile({ assetId: 'a', clusterId: 'north' }),
      makeProfile({ assetId: 'b', clusterId: 'north' }),
    ]
    const m = buildCorrelationMatrix(profiles, REALISTIC)
    expect(m[0][1]).toBe(0.6)
    expect(m[1][0]).toBe(0.6)
  })

  it('different clusters → crossCluster correlation', () => {
    const profiles = [
      makeProfile({ assetId: 'a', clusterId: 'north' }),
      makeProfile({ assetId: 'b', clusterId: 'south' }),
    ]
    const m = buildCorrelationMatrix(profiles, REALISTIC)
    expect(m[0][1]).toBe(0.1)
  })

  it('diagonal is always 1.0', () => {
    const profiles = [
      makeProfile({ assetId: 'a', clusterId: 'x' }),
      makeProfile({ assetId: 'b', clusterId: 'y' }),
      makeProfile({ assetId: 'c', clusterId: 'x' }),
    ]
    const m = buildCorrelationMatrix(profiles, REALISTIC)
    expect(m[0][0]).toBe(1.0)
    expect(m[1][1]).toBe(1.0)
    expect(m[2][2]).toBe(1.0)
  })

  it('matrix is symmetric', () => {
    const profiles = [
      makeProfile({ assetId: 'a', clusterId: 'x' }),
      makeProfile({ assetId: 'b', clusterId: 'y' }),
      makeProfile({ assetId: 'c', clusterId: 'x' }),
    ]
    const m = buildCorrelationMatrix(profiles, REALISTIC)
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(m[i][j]).toBe(m[j][i])
      }
    }
  })
})

describe('Portfolio Risk: uncorrelated portfolio', () => {
  it('Var(S) = Σ Var(X_i) when ρ = 0', () => {
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKwh: 10, stdDevKwh: 2, availabilityProb: 1 }),
      makeProfile({ assetId: 'b', expectedPerformanceKwh: 10, stdDevKwh: 2, availabilityProb: 1 }),
    ]
    const risk = computePortfolioRisk(profiles, NO_CORRELATION)
    // E[S] = 20, Var = 4+4 = 8, σ = √8
    expect(risk.expectedKwh).toBe(20)
    expect(risk.varianceKwh2).toBeCloseTo(8, 6)
    expect(risk.stdDevKwh).toBeCloseTo(Math.sqrt(8), 6)
  })

  it('safe capacity = E[S] - z·σ at 99% confidence', () => {
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKwh: 10, stdDevKwh: 2, availabilityProb: 1 }),
      makeProfile({ assetId: 'b', expectedPerformanceKwh: 10, stdDevKwh: 2, availabilityProb: 1 }),
    ]
    const result = computeSafeCapacity(profiles, NO_CORRELATION, 100, 0.99)
    // E[S] = 20, σ = √8 ≈ 2.828, z_99 ≈ 2.326
    // safe = 20 - 2.326 * 2.828 ≈ 20 - 6.578 ≈ 13.42
    expect(result.expectedKwh).toBe(20)
    expect(result.zScore).toBeCloseTo(2.3263, 3)
    expect(result.committedKw).toBeCloseTo(20 - 2.3263 * Math.sqrt(8), 2)
    // Buyer requested 100 but safe capacity is ~13.4 → under-promises.
    expect(result.fullyServed).toBe(false)
    expect(result.shortfallKw).toBeCloseTo(100 - result.committedKw, 2)
  })
})

describe('Portfolio Risk: correlated portfolio', () => {
  it('correlated portfolio has HIGHER variance than uncorrelated', () => {
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKwh: 10, stdDevKwh: 2, availabilityProb: 1 }),
      makeProfile({ assetId: 'b', expectedPerformanceKwh: 10, stdDevKwh: 2, availabilityProb: 1 }),
    ]
    const uncorrelated = computePortfolioRisk(profiles, NO_CORRELATION)
    const correlated = computePortfolioRisk(profiles, FULL_CORRELATION)

    // Same expected value (correlation doesn't affect the mean).
    expect(correlated.expectedKwh).toBe(uncorrelated.expectedKwh)
    // Correlated variance is higher.
    expect(correlated.varianceKwh2).toBeGreaterThan(uncorrelated.varianceKwh2)
  })

  it('fully correlated: σ_S = Σ σ_i (no diversification)', () => {
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKwh: 10, stdDevKwh: 2, availabilityProb: 1 }),
      makeProfile({ assetId: 'b', expectedPerformanceKwh: 10, stdDevKwh: 2, availabilityProb: 1 }),
    ]
    const risk = computePortfolioRisk(profiles, FULL_CORRELATION)
    // Var = 4 + 4 + 2*1*√(4*4) = 8 + 2*4 = 16, σ = 4 = 2+2
    expect(risk.varianceKwh2).toBeCloseTo(16, 6)
    expect(risk.stdDevKwh).toBeCloseTo(4, 6) // = σ_1 + σ_2
  })

  it('correlated portfolio has LOWER safe capacity than uncorrelated', () => {
    const profiles = [
      makeProfile({ assetId: 'a', clusterId: 'north', expectedPerformanceKwh: 10, stdDevKwh: 2 }),
      makeProfile({ assetId: 'b', clusterId: 'north', expectedPerformanceKwh: 10, stdDevKwh: 2 }),
    ]
    const uncorrelated = computeSafeCapacity(profiles, NO_CORRELATION, 100, 0.99)
    const correlated = computeSafeCapacity(profiles, { withinCluster: 0.6, crossCluster: 0.1 }, 100, 0.99)

    expect(correlated.committedKw).toBeLessThan(uncorrelated.committedKw)
  })

  it('cross-cluster correlation is between uncorrelated and fully correlated', () => {
    // 2 DERs in different clusters with moderate cross-cluster correlation.
    const profiles = [
      makeProfile({ assetId: 'a', clusterId: 'north', expectedPerformanceKwh: 10, stdDevKwh: 2 }),
      makeProfile({ assetId: 'b', clusterId: 'south', expectedPerformanceKwh: 10, stdDevKwh: 2 }),
    ]
    const uncorrelated = computePortfolioRisk(profiles, NO_CORRELATION)
    const moderate = computePortfolioRisk(profiles, { withinCluster: 1.0, crossCluster: 0.3 })
    const full = computePortfolioRisk(profiles, FULL_CORRELATION)

    expect(moderate.varianceKwh2).toBeGreaterThan(uncorrelated.varianceKwh2)
    expect(moderate.varianceKwh2).toBeLessThan(full.varianceKwh2)
  })
})

describe('Portfolio Risk: availability effect', () => {
  it('lower availability reduces expected performance', () => {
    const highAvail = computePortfolioRisk([
      makeProfile({ assetId: 'a', expectedPerformanceKwh: 100, availabilityProb: 0.99 }),
      makeProfile({ assetId: 'b', expectedPerformanceKwh: 100, availabilityProb: 0.99 }),
    ], NO_CORRELATION)
    const lowAvail = computePortfolioRisk([
      makeProfile({ assetId: 'a', expectedPerformanceKwh: 100, availabilityProb: 0.8 }),
      makeProfile({ assetId: 'b', expectedPerformanceKwh: 100, availabilityProb: 0.8 }),
    ], NO_CORRELATION)

    expect(lowAvail.expectedKwh).toBeLessThan(highAvail.expectedKwh)
    // 0.8*200 = 160 vs 0.99*200 = 198
    expect(lowAvail.expectedKwh).toBeCloseTo(160, 6)
    expect(highAvail.expectedKwh).toBeCloseTo(198, 6)
  })

  it('lower availability increases variance (mixture term)', () => {
    const highAvail = computePortfolioRisk([
      makeProfile({ assetId: 'a', expectedPerformanceKwh: 100, stdDevKwh: 5, availabilityProb: 0.99 }),
    ], NO_CORRELATION)
    const lowAvail = computePortfolioRisk([
      makeProfile({ assetId: 'a', expectedPerformanceKwh: 100, stdDevKwh: 5, availabilityProb: 0.8 }),
    ], NO_CORRELATION)

    // p=0.99: Var = 0.99*25 + 0.99*0.01*10000 = 24.75 + 99 = 123.75
    // p=0.8:  Var = 0.8*25 + 0.8*0.2*10000 = 20 + 1600 = 1620
    expect(lowAvail.varianceKwh2).toBeGreaterThan(highAvail.varianceKwh2)
    expect(lowAvail.varianceKwh2).toBeCloseTo(1620, 1)
  })

  it('lower availability → lower safe capacity (double penalty)', () => {
    const highAvail = computeSafeCapacity([
      makeProfile({ assetId: 'a', expectedPerformanceKwh: 100, stdDevKwh: 5, availabilityProb: 0.99 }),
      makeProfile({ assetId: 'b', expectedPerformanceKwh: 100, stdDevKwh: 5, availabilityProb: 0.99 }),
    ], NO_CORRELATION, 500, 0.99)
    const lowAvail = computeSafeCapacity([
      makeProfile({ assetId: 'a', expectedPerformanceKwh: 100, stdDevKwh: 5, availabilityProb: 0.8 }),
      makeProfile({ assetId: 'b', expectedPerformanceKwh: 100, stdDevKwh: 5, availabilityProb: 0.8 }),
    ], NO_CORRELATION, 500, 0.99)

    // Lower availability → lower E[S] AND higher σ → much lower safe capacity.
    expect(lowAvail.committedKw).toBeLessThan(highAvail.committedKw)
  })
})

describe('Portfolio Risk: confidence level trade-off', () => {
  it('higher confidence → lower safe capacity (more conservative)', () => {
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKwh: 100, stdDevKwh: 10, availabilityProb: 0.95 }),
      makeProfile({ assetId: 'b', expectedPerformanceKwh: 100, stdDevKwh: 10, availabilityProb: 0.95 }),
    ]
    const c95 = computeSafeCapacity(profiles, NO_CORRELATION, 500, 0.95)
    const c99 = computeSafeCapacity(profiles, NO_CORRELATION, 500, 0.99)
    const c999 = computeSafeCapacity(profiles, NO_CORRELATION, 500, 0.999)

    // Higher confidence → higher z → lower safe capacity.
    expect(c99.committedKw).toBeLessThan(c95.committedKw)
    expect(c999.committedKw).toBeLessThan(c99.committedKw)
  })

  it('throws for confidence outside (0, 1)', () => {
    const profiles = [makeProfile({ assetId: 'a' })]
    expect(() => computeSafeCapacity(profiles, NO_CORRELATION, 100, 0)).toThrow()
    expect(() => computeSafeCapacity(profiles, NO_CORRELATION, 100, 1)).toThrow()
  })
})

describe('Portfolio Risk: diversification', () => {
  it('uncorrelated: σ/E ratio decreases as N grows', () => {
    // Add more DERs with the same profile. For uncorrelated DERs:
    //   E grows as N, σ grows as √N, so σ/E → 0.
    const makeN = (n: number): DerUncertaintyProfile[] =>
      Array.from({ length: n }, (_, i) => makeProfile({
        assetId: `der-${i}`, expectedPerformanceKwh: 10, stdDevKwh: 2, availabilityProb: 1,
      }))

    const r2 = computePortfolioRisk(makeN(2), NO_CORRELATION)
    const r10 = computePortfolioRisk(makeN(10), NO_CORRELATION)
    const r100 = computePortfolioRisk(makeN(100), NO_CORRELATION)

    const ratio2 = r2.stdDevKwh / r2.expectedKwh
    const ratio10 = r10.stdDevKwh / r10.expectedKwh
    const ratio100 = r100.stdDevKwh / r100.expectedKwh

    expect(ratio10).toBeLessThan(ratio2)
    expect(ratio100).toBeLessThan(ratio10)
    // For 100 uncorrelated DERs, the ratio should be quite small.
    expect(ratio100).toBeLessThan(0.05)
  })

  it('fully correlated: σ/E ratio stays constant as N grows (no diversification)', () => {
    const makeN = (n: number): DerUncertaintyProfile[] =>
      Array.from({ length: n }, (_, i) => makeProfile({
        assetId: `der-${i}`, expectedPerformanceKwh: 10, stdDevKwh: 2, availabilityProb: 1,
      }))

    const r2 = computePortfolioRisk(makeN(2), FULL_CORRELATION)
    const r10 = computePortfolioRisk(makeN(10), FULL_CORRELATION)
    const r100 = computePortfolioRisk(makeN(100), FULL_CORRELATION)

    const ratio2 = r2.stdDevKwh / r2.expectedKwh
    const ratio10 = r10.stdDevKwh / r10.expectedKwh
    const ratio100 = r100.stdDevKwh / r100.expectedKwh

    // All identical — no diversification under full correlation.
    expect(ratio10).toBeCloseTo(ratio2, 6)
    expect(ratio100).toBeCloseTo(ratio2, 6)
  })

  it('realistic correlation: diversification benefit is between 0 and full', () => {
    // With realistic correlation (within=0.6, cross=0.1), same-cluster DERs
    // get partial diversification but not as much as uncorrelated.
    const makeN = (n: number): DerUncertaintyProfile[] =>
      Array.from({ length: n }, (_, i) => makeProfile({
        assetId: `der-${i}`, clusterId: 'same', expectedPerformanceKwh: 10, stdDevKwh: 2, availabilityProb: 1,
      }))

    const uncorr = computePortfolioRisk(makeN(100), NO_CORRELATION)
    const realistic = computePortfolioRisk(makeN(100), REALISTIC)
    const full = computePortfolioRisk(makeN(100), FULL_CORRELATION)

    // σ ordering: uncorrelated < realistic < fully correlated
    expect(uncorr.stdDevKwh).toBeLessThan(realistic.stdDevKwh)
    expect(realistic.stdDevKwh).toBeLessThan(full.stdDevKwh)
  })
})

describe('Portfolio Risk: safe capacity boundaries', () => {
  it('requested < safe → committed = requested (no over-promise)', () => {
    // 10 DERs, each 100 kWh expected, very low variance → safe capacity >> 50.
    const profiles = Array.from({ length: 10 }, (_, i) => makeProfile({
      assetId: `der-${i}`, expectedPerformanceKwh: 100, stdDevKwh: 0.1, availabilityProb: 1,
    }))
    const result = computeSafeCapacity(profiles, NO_CORRELATION, 50, 0.99)

    // E[S] = 1000, σ ≈ 0.316 → safe ≈ 1000 - 2.326*0.316 ≈ 999.3
    // Requested 50 < 999 → committed = 50.
    expect(result.committedKw).toBe(50)
    expect(result.fullyServed).toBe(true)
    expect(result.shortfallKw).toBe(0)
  })

  it('safe < requested → committed = safe (under-promise)', () => {
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKwh: 10, stdDevKwh: 5, availabilityProb: 0.9 }),
      makeProfile({ assetId: 'b', expectedPerformanceKwh: 10, stdDevKwh: 5, availabilityProb: 0.9 }),
    ]
    const result = computeSafeCapacity(profiles, NO_CORRELATION, 100, 0.99)

    // E[S] = 18, but high variance → safe capacity is much lower than 100.
    expect(result.committedKw).toBeLessThan(100)
    expect(result.fullyServed).toBe(false)
    expect(result.shortfallKw).toBeGreaterThan(0)
  })

  it('safe capacity is floored at 0 (never negative)', () => {
    // Extreme case: very low availability + high variance + high confidence.
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKwh: 10, stdDevKwh: 20, availabilityProb: 0.3 }),
    ]
    const result = computeSafeCapacity(profiles, NO_CORRELATION, 100, 0.999)

    // E[S] = 3, σ is large → E - z*σ is deeply negative → floored at 0.
    expect(result.committedKw).toBeGreaterThanOrEqual(0)
    expect(result.committedKw).toBe(0)
  })

  it('empty portfolio → safe capacity = 0', () => {
    const result = computeSafeCapacity([], NO_CORRELATION, 100, 0.99)
    expect(result.expectedKwh).toBe(0)
    expect(result.stdDevKwh).toBe(0)
    expect(result.committedKw).toBe(0)
    expect(result.fullyServed).toBe(false)
  })
})

describe('Portfolio Risk: 100-DER portfolio sanity', () => {
  it('100 DERs across 5 clusters: realistic safe capacity', () => {
    // 100 DERs, 5 geographic clusters of 20 each.
    // Each DER: 50 kW reserved, 2-hour dispatch, σ from MAE=2, P95=5.
    const profiles: DerUncertaintyProfile[] = []
    for (let cluster = 0; cluster < 5; cluster++) {
      for (let i = 0; i < 20; i++) {
        profiles.push({
          assetId: `der-${cluster}-${i}`,
          clusterId: `region-${cluster}`,
          expectedPerformanceKwh: 100, // 50 kW * 2 hours
          stdDevKwh: 3, // max(MAE=2, P95/1.96=2.55) ≈ 2.55, round to 3
          availabilityProb: 0.97,
        })
      }
    }

    const result = computeSafeCapacity(profiles, REALISTIC, 8000, 0.99)

    // E[S] = 100 * 100 * 0.97 = 9700 kWh
    expect(result.expectedKwh).toBeCloseTo(9700, 0)
    expect(result.derCount).toBe(100)

    // With realistic correlation, safe capacity should be meaningfully below
    // E[S] but still substantial (diversification helps even with correlation).
    expect(result.committedKw).toBeGreaterThan(0)
    expect(result.committedKw).toBeLessThan(result.expectedKwh)

    // The platform can safely promise a large chunk of the 8000 kW request
    // at 99% confidence — but NOT all of it (correlation + availability
    // create real risk).
    // (The exact value depends on the correlation model; this asserts the
    //  order of magnitude is reasonable.)
    expect(result.committedKw).toBeGreaterThan(5000)
  })

  it('clustering matters: spreading DERs across more clusters improves safe capacity', () => {
    // 100 DERs, all in ONE cluster (high common-mode risk).
    const oneCluster = Array.from({ length: 100 }, (_, i) => makeProfile({
      assetId: `der-${i}`, clusterId: 'single',
      expectedPerformanceKwh: 100, stdDevKwh: 3, availabilityProb: 0.97,
    }))

    // 100 DERs, spread across 10 clusters of 10 (lower common-mode risk).
    const manyClusters = Array.from({ length: 100 }, (_, i) => makeProfile({
      assetId: `der-${i}`, clusterId: `region-${i % 10}`,
      expectedPerformanceKwh: 100, stdDevKwh: 3, availabilityProb: 0.97,
    }))

    const result1 = computeSafeCapacity(oneCluster, REALISTIC, 20000, 0.99)
    const result2 = computeSafeCapacity(manyClusters, REALISTIC, 20000, 0.99)

    // Spreading across more clusters → lower effective correlation →
    // higher safe capacity.
    expect(result2.committedKw).toBeGreaterThan(result1.committedKw)
  })
})

describe('Portfolio Risk: deriveUncertaintyFromEvaluation', () => {
  it('μ = reservedKw * durationHours', () => {
    const p = deriveUncertaintyFromEvaluation({
      assetId: 'a', clusterId: 'north',
      reservedKw: 50, durationHours: 2,
      evaluationMetrics: { mae: 2, p95Error: 5 },
    })
    expect(p.expectedPerformanceKwh).toBe(100) // 50 * 2
  })

  it('σ = max(MAE, P95/1.96)', () => {
    const p = deriveUncertaintyFromEvaluation({
      assetId: 'a', clusterId: 'north',
      reservedKw: 50, durationHours: 2,
      evaluationMetrics: { mae: 2, p95Error: 5 },
    })
    // max(2, 5/1.96) = max(2, 2.55) = 2.55
    expect(p.stdDevKwh).toBeCloseTo(5 / 1.96, 4)
  })

  it('σ = MAE when MAE > P95/1.96', () => {
    const p = deriveUncertaintyFromEvaluation({
      assetId: 'a', clusterId: 'north',
      reservedKw: 50, durationHours: 2,
      evaluationMetrics: { mae: 5, p95Error: 5 },
    })
    // max(5, 2.55) = 5
    expect(p.stdDevKwh).toBe(5)
  })

  it('default availability = 0.98', () => {
    const p = deriveUncertaintyFromEvaluation({
      assetId: 'a', clusterId: 'north',
      reservedKw: 50, durationHours: 2,
      evaluationMetrics: { mae: 2, p95Error: 5 },
    })
    expect(p.availabilityProb).toBe(0.98)
  })

  it('explicit availability overrides default', () => {
    const p = deriveUncertaintyFromEvaluation({
      assetId: 'a', clusterId: 'north',
      reservedKw: 50, durationHours: 2,
      evaluationMetrics: { mae: 2, p95Error: 5 },
      availabilityProb: 0.95,
    })
    expect(p.availabilityProb).toBe(0.95)
  })
})

describe('Portfolio Risk: general correlation matrix', () => {
  it('computePortfolioRiskWithMatrix accepts a custom matrix', () => {
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKwh: 10, stdDevKwh: 2, availabilityProb: 1 }),
      makeProfile({ assetId: 'b', expectedPerformanceKwh: 10, stdDevKwh: 2, availabilityProb: 1 }),
    ]
    // Custom matrix: ρ = 0.3
    const matrix = [[1.0, 0.3], [0.3, 1.0]]
    const risk = computePortfolioRiskWithMatrix(profiles, matrix)

    // Var = 4 + 4 + 2*0.3*√(4*4) = 8 + 2.4 = 10.4
    expect(risk.varianceKwh2).toBeCloseTo(10.4, 6)
    expect(risk.expectedKwh).toBe(20)
  })
})
