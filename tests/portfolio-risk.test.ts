/**
 * VPP-2D-1: Portfolio Risk Engine tests (POWER-based, normal approximation).
 *
 * Tests the pure computation engine: per-DER uncertainty (kW) → correlation →
 * portfolio VaR → safe committed capacity (kW).
 *
 * VPP-2D-1 corrections addressed:
 *   - DIMENSIONAL: all quantities in kW (power), not kWh (energy)
 *   - distributionModel field exposed ('normal_approximation')
 *   - Correlation matrix validation (shape, diagonal, symmetry, range, PSD)
 *
 * Mathematical properties verified:
 *   - Per-DER contribution (E[X_i], Var(X_i)) with availability mixture
 *   - Uncorrelated portfolio: Var = Σ Var(X_i)
 *   - Correlated portfolio: Var is higher → safe capacity is lower
 *   - Availability effect: lower p → lower E[S], higher Var → lower safe capacity
 *   - Confidence level: higher c → higher z → lower safe capacity
 *   - Diversification: large N uncorrelated → σ/E ratio → 0
 *   - Perfect correlation: no diversification
 *   - Requested vs safe: platform under-promises when safe < requested
 *   - Large portfolio (100 DERs) sanity
 *   - Correlation matrix validation: non-PSD rejected, invalid shape/range rejected
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
  validateCorrelationMatrix,
  deriveUncertaintyFromEvaluation,
  type DerUncertaintyProfile,
  type CorrelationModel,
} from '../src/lib/services/portfolio-risk.service'
import { ValidationError } from '@/lib/domain/errors'

// Helper: create a DER profile with sensible defaults (all in kW).
function makeProfile(overrides: Partial<DerUncertaintyProfile> & { assetId: string }): DerUncertaintyProfile {
  return {
    clusterId: 'default',
    expectedPerformanceKw: 10,
    stdDevKw: 2,
    availabilityProb: 1.0,
    ...overrides,
  }
}

const NO_CORRELATION: CorrelationModel = { withinCluster: 0, crossCluster: 0 }
const FULL_CORRELATION: CorrelationModel = { withinCluster: 1, crossCluster: 1 }
const REALISTIC: CorrelationModel = { withinCluster: 0.6, crossCluster: 0.1 }

describe('Portfolio Risk: inverseNormalCDF', () => {
  it('returns known z-scores for common confidence levels', () => {
    expect(inverseNormalCDF(0.95)).toBeCloseTo(1.6449, 3)
    expect(inverseNormalCDF(0.99)).toBeCloseTo(2.3263, 3)
    expect(inverseNormalCDF(0.999)).toBeCloseTo(3.0902, 2)
  })

  it('returns 0 for p=0.5 (median)', () => {
    expect(inverseNormalCDF(0.5)).toBeCloseTo(0, 6)
  })

  it('throws for p outside (0, 1)', () => {
    expect(() => inverseNormalCDF(0)).toThrow(ValidationError)
    expect(() => inverseNormalCDF(1)).toThrow(ValidationError)
    expect(() => inverseNormalCDF(-0.1)).toThrow(ValidationError)
    expect(() => inverseNormalCDF(1.1)).toThrow(ValidationError)
  })
})

describe('Portfolio Risk: per-DER contribution (kW)', () => {
  it('E[X_i] = p · μ (availability scales expected power)', () => {
    const c = computeDerContribution(makeProfile({
      assetId: 'a', expectedPerformanceKw: 100, stdDevKw: 5, availabilityProb: 0.9,
    }))
    expect(c.expectedKw).toBeCloseTo(90, 6) // 0.9 * 100
  })

  it('Var(X_i) = p·σ² + p·(1-p)·μ² (law of total variance)', () => {
    const c = computeDerContribution(makeProfile({
      assetId: 'a', expectedPerformanceKw: 100, stdDevKw: 5, availabilityProb: 0.9,
    }))
    // 0.9 * 25 + 0.9 * 0.1 * 10000 = 22.5 + 900 = 922.5
    expect(c.varianceKw2).toBeCloseTo(922.5, 4)
    expect(c.stdDevKw).toBeCloseTo(Math.sqrt(922.5), 4)
  })

  it('p=1.0: Var = σ² (no availability mixture term)', () => {
    const c = computeDerContribution(makeProfile({
      assetId: 'a', expectedPerformanceKw: 100, stdDevKw: 5, availabilityProb: 1.0,
    }))
    expect(c.expectedKw).toBe(100)
    expect(c.varianceKw2).toBe(25)
  })

  it('p=0.5: availability dominates variance when μ >> σ', () => {
    const c = computeDerContribution(makeProfile({
      assetId: 'a', expectedPerformanceKw: 100, stdDevKw: 5, availabilityProb: 0.5,
    }))
    expect(c.expectedKw).toBe(50)
    expect(c.varianceKw2).toBeCloseTo(2512.5, 2)
    expect(c.varianceKw2).toBeGreaterThan(2500)
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

describe('Portfolio Risk: correlation matrix validation', () => {
  it('accepts a valid correlation matrix', () => {
    const m = [[1.0, 0.5], [0.5, 1.0]]
    expect(() => validateCorrelationMatrix(m, 2)).not.toThrow()
  })

  it('accepts the identity matrix (uncorrelated)', () => {
    const m = [[1.0, 0, 0], [0, 1.0, 0], [0, 0, 1.0]]
    expect(() => validateCorrelationMatrix(m, 3)).not.toThrow()
  })

  it('rejects wrong size', () => {
    const m = [[1.0, 0.5]]
    expect(() => validateCorrelationMatrix(m, 2)).toThrow(ValidationError)
  })

  it('rejects non-square matrix', () => {
    const m = [[1.0, 0.5, 0.3], [0.5, 1.0]]
    expect(() => validateCorrelationMatrix(m, 2)).toThrow(ValidationError)
  })

  it('rejects diagonal != 1.0', () => {
    const m = [[0.9, 0.5], [0.5, 1.0]]
    expect(() => validateCorrelationMatrix(m, 2)).toThrow(ValidationError)
  })

  it('rejects asymmetric matrix', () => {
    const m = [[1.0, 0.5], [0.3, 1.0]]
    expect(() => validateCorrelationMatrix(m, 2)).toThrow(ValidationError)
  })

  it('rejects entry out of [-1, 1]', () => {
    const m = [[1.0, 1.5], [1.5, 1.0]]
    expect(() => validateCorrelationMatrix(m, 2)).toThrow(ValidationError)
  })

  it('rejects entry < -1', () => {
    const m = [[1.0, -1.5], [-1.5, 1.0]]
    expect(() => validateCorrelationMatrix(m, 2)).toThrow(ValidationError)
  })

  it('rejects a non-PSD matrix (negative eigenvalue)', () => {
    // This matrix is symmetric, unit diagonal, in-range — but NOT PSD.
    //   [[1.0, 0.9, 0.9],
    //    [0.9, 1.0, 0.1],
    //    [0.9, 0.1, 1.0]]
    // Eigenvalues: ~2.0, ~0.9, ~-0.1 → one negative → not PSD.
    // A risk engine must reject this, not silently clamp negative variance.
    const m = [
      [1.0, 0.9, 0.9],
      [0.9, 1.0, 0.1],
      [0.9, 0.1, 1.0],
    ]
    expect(() => validateCorrelationMatrix(m, 3)).toThrow(ValidationError)
    expect(() => validateCorrelationMatrix(m, 3)).toThrow(/positive semidefinite/i)
  })

  it('computePortfolioRiskWithMatrix rejects non-PSD matrix', () => {
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKw: 10, stdDevKw: 2 }),
      makeProfile({ assetId: 'b', expectedPerformanceKw: 10, stdDevKw: 2 }),
      makeProfile({ assetId: 'c', expectedPerformanceKw: 10, stdDevKw: 2 }),
    ]
    const nonPsd = [
      [1.0, 0.9, 0.9],
      [0.9, 1.0, 0.1],
      [0.9, 0.1, 1.0],
    ]
    expect(() => computePortfolioRiskWithMatrix(profiles, nonPsd)).toThrow(ValidationError)
  })

  // -------------------------------------------------------------------------
  // PSD validator regression tests (eigenvalue-based, replaces buggy Cholesky).
  // The previous Cholesky implementation accepted certain non-PSD matrices
  // because it silently set zero-pivot entries to zero without checking the
  // residual row/column. These tests lock in the corrected eigenvalue-based
  // check.
  // -------------------------------------------------------------------------

  it('REGRESSION: rejects [[1,1,0],[1,1,1],[0,1,1]] (the matrix the old Cholesky accepted)', () => {
    // This matrix is symmetric, unit-diagonal, in-range — but NOT PSD.
    // Eigenvalues: 1, 1+√2 ≈ 2.414, 1-√2 ≈ -0.414 → one materially
    // negative → not PSD.
    //
    // The old Cholesky implementation accepted this because after the first
    // pivot elimination, the [1][1] pivot became ~0, and the code silently
    // set the [2][1] entry to 0 without checking that its residual was also
    // zero (it wasn't). The eigenvalue-based check correctly rejects it.
    const m = [
      [1.0, 1.0, 0.0],
      [1.0, 1.0, 1.0],
      [0.0, 1.0, 1.0],
    ]
    expect(() => validateCorrelationMatrix(m, 3)).toThrow(ValidationError)
    expect(() => validateCorrelationMatrix(m, 3)).toThrow(/positive semidefinite/i)
  })

  it('accepts a valid positive-definite matrix', () => {
    // [[1, 0.5, 0.3], [0.5, 1, 0.4], [0.3, 0.4, 1]]
    // All eigenvalues positive (PD).
    const m = [
      [1.0, 0.5, 0.3],
      [0.5, 1.0, 0.4],
      [0.3, 0.4, 1.0],
    ]
    expect(() => validateCorrelationMatrix(m, 3)).not.toThrow()
  })

  it('accepts a valid singular PSD matrix (perfectly correlated pair)', () => {
    // [[1, 1, 0], [1, 1, 0], [0, 0, 1]]
    // Eigenvalues: 2, 0, 1 → smallest is 0 (semidefinite, not definite).
    // This is a valid correlation matrix where assets 0 and 1 are perfectly
    // correlated. It's singular but PSD — must be accepted.
    const m = [
      [1.0, 1.0, 0.0],
      [1.0, 1.0, 0.0],
      [0.0, 0.0, 1.0],
    ]
    expect(() => validateCorrelationMatrix(m, 3)).not.toThrow()
  })

  it('accepts the identity matrix (uncorrelated, PD)', () => {
    const m = [
      [1.0, 0.0, 0.0],
      [0.0, 1.0, 0.0],
      [0.0, 0.0, 1.0],
    ]
    expect(() => validateCorrelationMatrix(m, 3)).not.toThrow()
  })

  it('rejects a matrix with a slightly negative eigenvalue', () => {
    // [[1, 0.8, 0.8], [0.8, 1, 0.2], [0.8, 0.2, 1]]
    // Eigenvalues: ~2.0, ~0.96, ~-0.16 → materially negative → not PSD.
    const m = [
      [1.0, 0.8, 0.8],
      [0.8, 1.0, 0.2],
      [0.8, 0.2, 1.0],
    ]
    expect(() => validateCorrelationMatrix(m, 3)).toThrow(ValidationError)
  })

  it('rejects a 4x4 non-PSD matrix (symmetric, unit diagonal, in-range)', () => {
    // A 4x4 matrix that is symmetric, unit-diagonal, in-range, but not PSD.
    // Constructed to have a negative eigenvalue.
    //   [[1.0, 0.9, 0.9, 0.9],
    //    [0.9, 1.0, 0.1, 0.1],
    //    [0.9, 0.1, 1.0, 0.1],
    //    [0.9, 0.1, 0.1, 1.0]]
    const m = [
      [1.0, 0.9, 0.9, 0.9],
      [0.9, 1.0, 0.1, 0.1],
      [0.9, 0.1, 1.0, 0.1],
      [0.9, 0.1, 0.1, 1.0],
    ]
    expect(() => validateCorrelationMatrix(m, 4)).toThrow(ValidationError)
  })

  it('accepts a large valid PSD matrix (100x100 block-correlation)', () => {
    // Build a 100x100 block-correlation matrix (same cluster, ρ=0.5).
    // This is always PSD (it's a valid correlation structure).
    const n = 100
    const m: number[][] = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) =>
        i === j ? 1.0 : 0.5,
      ),
    )
    expect(() => validateCorrelationMatrix(m, n)).not.toThrow()
  })
})

describe('Portfolio Risk: uncorrelated portfolio', () => {
  it('Var(S) = Σ Var(X_i) when ρ = 0', () => {
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKw: 10, stdDevKw: 2, availabilityProb: 1 }),
      makeProfile({ assetId: 'b', expectedPerformanceKw: 10, stdDevKw: 2, availabilityProb: 1 }),
    ]
    const risk = computePortfolioRisk(profiles, NO_CORRELATION)
    expect(risk.expectedKw).toBe(20)
    expect(risk.varianceKw2).toBeCloseTo(8, 6)
    expect(risk.stdDevKw).toBeCloseTo(Math.sqrt(8), 6)
  })

  it('safe capacity = E[S] - z·σ at 99% confidence (normal approximation)', () => {
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKw: 10, stdDevKw: 2, availabilityProb: 1 }),
      makeProfile({ assetId: 'b', expectedPerformanceKw: 10, stdDevKw: 2, availabilityProb: 1 }),
    ]
    const result = computeSafeCapacity(profiles, NO_CORRELATION, 100, 0.99)
    expect(result.expectedKw).toBe(20)
    expect(result.zScore).toBeCloseTo(2.3263, 3)
    expect(result.committedKw).toBeCloseTo(20 - 2.3263 * Math.sqrt(8), 2)
    expect(result.fullyServed).toBe(false)
    expect(result.shortfallKw).toBeCloseTo(100 - result.committedKw, 2)
    expect(result.distributionModel).toBe('normal_approximation')
    expect(result.normalApproximationSafeCapacity).toBeCloseTo(result.committedKw, 6)
  })
})

describe('Portfolio Risk: correlated portfolio', () => {
  it('correlated portfolio has HIGHER variance than uncorrelated', () => {
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKw: 10, stdDevKw: 2, availabilityProb: 1 }),
      makeProfile({ assetId: 'b', expectedPerformanceKw: 10, stdDevKw: 2, availabilityProb: 1 }),
    ]
    const uncorrelated = computePortfolioRisk(profiles, NO_CORRELATION)
    const correlated = computePortfolioRisk(profiles, FULL_CORRELATION)

    expect(correlated.expectedKw).toBe(uncorrelated.expectedKw)
    expect(correlated.varianceKw2).toBeGreaterThan(uncorrelated.varianceKw2)
  })

  it('fully correlated: σ_S = Σ σ_i (no diversification)', () => {
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKw: 10, stdDevKw: 2, availabilityProb: 1 }),
      makeProfile({ assetId: 'b', expectedPerformanceKw: 10, stdDevKw: 2, availabilityProb: 1 }),
    ]
    const risk = computePortfolioRisk(profiles, FULL_CORRELATION)
    expect(risk.varianceKw2).toBeCloseTo(16, 6)
    expect(risk.stdDevKw).toBeCloseTo(4, 6) // = σ_1 + σ_2
  })

  it('correlated portfolio has LOWER safe capacity than uncorrelated', () => {
    const profiles = [
      makeProfile({ assetId: 'a', clusterId: 'north', expectedPerformanceKw: 10, stdDevKw: 2 }),
      makeProfile({ assetId: 'b', clusterId: 'north', expectedPerformanceKw: 10, stdDevKw: 2 }),
    ]
    const uncorrelated = computeSafeCapacity(profiles, NO_CORRELATION, 100, 0.99)
    const correlated = computeSafeCapacity(profiles, { withinCluster: 0.6, crossCluster: 0.1 }, 100, 0.99)
    expect(correlated.committedKw).toBeLessThan(uncorrelated.committedKw)
  })

  it('cross-cluster correlation is between uncorrelated and fully correlated', () => {
    const profiles = [
      makeProfile({ assetId: 'a', clusterId: 'north', expectedPerformanceKw: 10, stdDevKw: 2 }),
      makeProfile({ assetId: 'b', clusterId: 'south', expectedPerformanceKw: 10, stdDevKw: 2 }),
    ]
    const uncorrelated = computePortfolioRisk(profiles, NO_CORRELATION)
    const moderate = computePortfolioRisk(profiles, { withinCluster: 1.0, crossCluster: 0.3 })
    const full = computePortfolioRisk(profiles, FULL_CORRELATION)
    expect(moderate.varianceKw2).toBeGreaterThan(uncorrelated.varianceKw2)
    expect(moderate.varianceKw2).toBeLessThan(full.varianceKw2)
  })
})

describe('Portfolio Risk: availability effect', () => {
  it('lower availability reduces expected performance', () => {
    const highAvail = computePortfolioRisk([
      makeProfile({ assetId: 'a', expectedPerformanceKw: 100, availabilityProb: 0.99 }),
      makeProfile({ assetId: 'b', expectedPerformanceKw: 100, availabilityProb: 0.99 }),
    ], NO_CORRELATION)
    const lowAvail = computePortfolioRisk([
      makeProfile({ assetId: 'a', expectedPerformanceKw: 100, availabilityProb: 0.8 }),
      makeProfile({ assetId: 'b', expectedPerformanceKw: 100, availabilityProb: 0.8 }),
    ], NO_CORRELATION)
    expect(lowAvail.expectedKw).toBeLessThan(highAvail.expectedKw)
    expect(lowAvail.expectedKw).toBeCloseTo(160, 6)
    expect(highAvail.expectedKw).toBeCloseTo(198, 6)
  })

  it('lower availability increases variance (mixture term)', () => {
    const highAvail = computePortfolioRisk([
      makeProfile({ assetId: 'a', expectedPerformanceKw: 100, stdDevKw: 5, availabilityProb: 0.99 }),
    ], NO_CORRELATION)
    const lowAvail = computePortfolioRisk([
      makeProfile({ assetId: 'a', expectedPerformanceKw: 100, stdDevKw: 5, availabilityProb: 0.8 }),
    ], NO_CORRELATION)
    expect(lowAvail.varianceKw2).toBeGreaterThan(highAvail.varianceKw2)
  })

  it('lower availability → lower safe capacity (double penalty)', () => {
    const highAvail = computeSafeCapacity([
      makeProfile({ assetId: 'a', expectedPerformanceKw: 100, stdDevKw: 5, availabilityProb: 0.99 }),
      makeProfile({ assetId: 'b', expectedPerformanceKw: 100, stdDevKw: 5, availabilityProb: 0.99 }),
    ], NO_CORRELATION, 500, 0.99)
    const lowAvail = computeSafeCapacity([
      makeProfile({ assetId: 'a', expectedPerformanceKw: 100, stdDevKw: 5, availabilityProb: 0.8 }),
      makeProfile({ assetId: 'b', expectedPerformanceKw: 100, stdDevKw: 5, availabilityProb: 0.8 }),
    ], NO_CORRELATION, 500, 0.99)
    expect(lowAvail.committedKw).toBeLessThan(highAvail.committedKw)
  })
})

describe('Portfolio Risk: confidence level trade-off', () => {
  it('higher confidence → lower safe capacity (more conservative)', () => {
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKw: 100, stdDevKw: 10, availabilityProb: 0.95 }),
      makeProfile({ assetId: 'b', expectedPerformanceKw: 100, stdDevKw: 10, availabilityProb: 0.95 }),
    ]
    const c95 = computeSafeCapacity(profiles, NO_CORRELATION, 500, 0.95)
    const c99 = computeSafeCapacity(profiles, NO_CORRELATION, 500, 0.99)
    const c999 = computeSafeCapacity(profiles, NO_CORRELATION, 500, 0.999)
    expect(c99.committedKw).toBeLessThan(c95.committedKw)
    expect(c999.committedKw).toBeLessThan(c99.committedKw)
    // All carry the distribution model label.
    expect(c95.distributionModel).toBe('normal_approximation')
    expect(c99.distributionModel).toBe('normal_approximation')
    expect(c999.distributionModel).toBe('normal_approximation')
  })

  it('throws for confidence outside (0, 1)', () => {
    const profiles = [makeProfile({ assetId: 'a' })]
    expect(() => computeSafeCapacity(profiles, NO_CORRELATION, 100, 0)).toThrow(ValidationError)
    expect(() => computeSafeCapacity(profiles, NO_CORRELATION, 100, 1)).toThrow(ValidationError)
  })

  it('throws for negative requestedKw', () => {
    const profiles = [makeProfile({ assetId: 'a' })]
    expect(() => computeSafeCapacity(profiles, NO_CORRELATION, -1, 0.99)).toThrow(ValidationError)
  })
})

describe('Portfolio Risk: diversification', () => {
  it('uncorrelated: σ/E ratio decreases as N grows', () => {
    const makeN = (n: number): DerUncertaintyProfile[] =>
      Array.from({ length: n }, (_, i) => makeProfile({
        assetId: `der-${i}`, expectedPerformanceKw: 10, stdDevKw: 2, availabilityProb: 1,
      }))

    const r2 = computePortfolioRisk(makeN(2), NO_CORRELATION)
    const r10 = computePortfolioRisk(makeN(10), NO_CORRELATION)
    const r100 = computePortfolioRisk(makeN(100), NO_CORRELATION)

    const ratio2 = r2.stdDevKw / r2.expectedKw
    const ratio10 = r10.stdDevKw / r10.expectedKw
    const ratio100 = r100.stdDevKw / r100.expectedKw

    expect(ratio10).toBeLessThan(ratio2)
    expect(ratio100).toBeLessThan(ratio10)
    expect(ratio100).toBeLessThan(0.05)
  })

  it('fully correlated: σ/E ratio stays constant as N grows (no diversification)', () => {
    const makeN = (n: number): DerUncertaintyProfile[] =>
      Array.from({ length: n }, (_, i) => makeProfile({
        assetId: `der-${i}`, expectedPerformanceKw: 10, stdDevKw: 2, availabilityProb: 1,
      }))

    const r2 = computePortfolioRisk(makeN(2), FULL_CORRELATION)
    const r10 = computePortfolioRisk(makeN(10), FULL_CORRELATION)
    const r100 = computePortfolioRisk(makeN(100), FULL_CORRELATION)

    const ratio2 = r2.stdDevKw / r2.expectedKw
    const ratio10 = r10.stdDevKw / r10.expectedKw
    const ratio100 = r100.stdDevKw / r100.expectedKw

    expect(ratio10).toBeCloseTo(ratio2, 6)
    expect(ratio100).toBeCloseTo(ratio2, 6)
  })

  it('realistic correlation: diversification benefit is between 0 and full', () => {
    const makeN = (n: number): DerUncertaintyProfile[] =>
      Array.from({ length: n }, (_, i) => makeProfile({
        assetId: `der-${i}`, clusterId: 'same', expectedPerformanceKw: 10, stdDevKw: 2, availabilityProb: 1,
      }))

    const uncorr = computePortfolioRisk(makeN(100), NO_CORRELATION)
    const realistic = computePortfolioRisk(makeN(100), REALISTIC)
    const full = computePortfolioRisk(makeN(100), FULL_CORRELATION)

    expect(uncorr.stdDevKw).toBeLessThan(realistic.stdDevKw)
    expect(realistic.stdDevKw).toBeLessThan(full.stdDevKw)
  })
})

describe('Portfolio Risk: safe capacity boundaries', () => {
  it('requested < safe → committed = requested (no over-promise)', () => {
    const profiles = Array.from({ length: 10 }, (_, i) => makeProfile({
      assetId: `der-${i}`, expectedPerformanceKw: 100, stdDevKw: 0.1, availabilityProb: 1,
    }))
    const result = computeSafeCapacity(profiles, NO_CORRELATION, 50, 0.99)
    expect(result.committedKw).toBe(50)
    expect(result.fullyServed).toBe(true)
    expect(result.shortfallKw).toBe(0)
    // normalApproximationSafeCapacity is the uncapped value.
    expect(result.normalApproximationSafeCapacity).toBeGreaterThan(50)
  })

  it('safe < requested → committed = safe (under-promise)', () => {
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKw: 10, stdDevKw: 5, availabilityProb: 0.9 }),
      makeProfile({ assetId: 'b', expectedPerformanceKw: 10, stdDevKw: 5, availabilityProb: 0.9 }),
    ]
    const result = computeSafeCapacity(profiles, NO_CORRELATION, 100, 0.99)
    expect(result.committedKw).toBeLessThan(100)
    expect(result.fullyServed).toBe(false)
    expect(result.shortfallKw).toBeGreaterThan(0)
  })

  it('safe capacity is floored at 0 (never negative)', () => {
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKw: 10, stdDevKw: 20, availabilityProb: 0.3 }),
    ]
    const result = computeSafeCapacity(profiles, NO_CORRELATION, 100, 0.999)
    expect(result.committedKw).toBeGreaterThanOrEqual(0)
    expect(result.committedKw).toBe(0)
    expect(result.normalApproximationSafeCapacity).toBe(0)
  })

  it('empty portfolio → safe capacity = 0', () => {
    const result = computeSafeCapacity([], NO_CORRELATION, 100, 0.99)
    expect(result.expectedKw).toBe(0)
    expect(result.stdDevKw).toBe(0)
    expect(result.committedKw).toBe(0)
    expect(result.fullyServed).toBe(false)
    expect(result.distributionModel).toBe('normal_approximation')
  })
})

describe('Portfolio Risk: 100-DER portfolio sanity (kW)', () => {
  it('100 DERs across 5 clusters: realistic safe capacity', () => {
    // 100 DERs, 5 geographic clusters of 20 each.
    // Each DER: 50 kW reserved capacity.
    const profiles: DerUncertaintyProfile[] = []
    for (let cluster = 0; cluster < 5; cluster++) {
      for (let i = 0; i < 20; i++) {
        profiles.push({
          assetId: `der-${cluster}-${i}`,
          clusterId: `region-${cluster}`,
          expectedPerformanceKw: 50,
          stdDevKw: 3,
          availabilityProb: 0.97,
        })
      }
    }

    const result = computeSafeCapacity(profiles, REALISTIC, 4000, 0.99)

    // E[S] = 100 * 50 * 0.97 = 4850 kW
    expect(result.expectedKw).toBeCloseTo(4850, 0)
    expect(result.derCount).toBe(100)

    // With realistic correlation, safe capacity should be meaningfully below
    // E[S] but still substantial (diversification helps even with correlation).
    expect(result.committedKw).toBeGreaterThan(0)
    expect(result.committedKw).toBeLessThan(result.expectedKw)

    // The platform can safely promise a large chunk of the 4000 kW request
    // at 99% confidence — but NOT all of it (correlation + availability
    // create real risk).
    expect(result.committedKw).toBeGreaterThan(2500)
  })

  it('clustering matters: spreading DERs across more clusters improves safe capacity', () => {
    const oneCluster = Array.from({ length: 100 }, (_, i) => makeProfile({
      assetId: `der-${i}`, clusterId: 'single',
      expectedPerformanceKw: 50, stdDevKw: 3, availabilityProb: 0.97,
    }))
    const manyClusters = Array.from({ length: 100 }, (_, i) => makeProfile({
      assetId: `der-${i}`, clusterId: `region-${i % 10}`,
      expectedPerformanceKw: 50, stdDevKw: 3, availabilityProb: 0.97,
    }))

    const result1 = computeSafeCapacity(oneCluster, REALISTIC, 10000, 0.99)
    const result2 = computeSafeCapacity(manyClusters, REALISTIC, 10000, 0.99)
    expect(result2.committedKw).toBeGreaterThan(result1.committedKw)
  })
})

describe('Portfolio Risk: deriveUncertaintyFromEvaluation (kWh → kW)', () => {
  it('μ (kW) = reservedKw (expected power = reserved capacity)', () => {
    const p = deriveUncertaintyFromEvaluation({
      assetId: 'a', clusterId: 'north',
      reservedKw: 50, durationHours: 2,
      evaluationMetrics: { mae: 2, p95Error: 5 },
    })
    expect(p.expectedPerformanceKw).toBe(50) // reserved power, NOT reserved*duration
  })

  it('σ (kW) = max(MAE, P95/1.96) / durationHours (kWh → kW conversion)', () => {
    const p = deriveUncertaintyFromEvaluation({
      assetId: 'a', clusterId: 'north',
      reservedKw: 50, durationHours: 2,
      evaluationMetrics: { mae: 2, p95Error: 5 },
    })
    // max(2, 5/1.96) = 2.55 kWh, / 2 hours = 1.275 kW
    const expectedSigmaKwh = Math.max(2, 5 / 1.96)
    expect(p.stdDevKw).toBeCloseTo(expectedSigmaKwh / 2, 4)
  })

  it('σ = MAE/duration when MAE > P95/1.96', () => {
    const p = deriveUncertaintyFromEvaluation({
      assetId: 'a', clusterId: 'north',
      reservedKw: 50, durationHours: 4,
      evaluationMetrics: { mae: 10, p95Error: 5 },
    })
    // max(10, 2.55) = 10 kWh, / 4 hours = 2.5 kW
    expect(p.stdDevKw).toBeCloseTo(10 / 4, 4)
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

  it('throws for non-positive durationHours', () => {
    expect(() => deriveUncertaintyFromEvaluation({
      assetId: 'a', clusterId: 'north',
      reservedKw: 50, durationHours: 0,
      evaluationMetrics: { mae: 2, p95Error: 5 },
    })).toThrow(ValidationError)
  })

  it('longer duration → lower σ in kW (same energy error spread over more hours)', () => {
    const p2h = deriveUncertaintyFromEvaluation({
      assetId: 'a', clusterId: 'north',
      reservedKw: 50, durationHours: 2,
      evaluationMetrics: { mae: 4, p95Error: 10 },
    })
    const p4h = deriveUncertaintyFromEvaluation({
      assetId: 'a', clusterId: 'north',
      reservedKw: 50, durationHours: 4,
      evaluationMetrics: { mae: 4, p95Error: 10 },
    })
    // Same kWh error, but 4h dispatch → half the kW std dev.
    expect(p4h.stdDevKw).toBeCloseTo(p2h.stdDevKw / 2, 4)
  })
})

describe('Portfolio Risk: general correlation matrix', () => {
  it('computePortfolioRiskWithMatrix accepts a custom valid matrix', () => {
    const profiles = [
      makeProfile({ assetId: 'a', expectedPerformanceKw: 10, stdDevKw: 2, availabilityProb: 1 }),
      makeProfile({ assetId: 'b', expectedPerformanceKw: 10, stdDevKw: 2, availabilityProb: 1 }),
    ]
    const matrix = [[1.0, 0.3], [0.3, 1.0]]
    const risk = computePortfolioRiskWithMatrix(profiles, matrix)
    // Var = 4 + 4 + 2*0.3*√(4*4) = 8 + 2.4 = 10.4
    expect(risk.varianceKw2).toBeCloseTo(10.4, 6)
    expect(risk.expectedKw).toBe(20)
  })
})
