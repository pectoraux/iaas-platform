/**
 * VPP-2D-4: Portfolio Commitment tests.
 *
 * Tests the portfolio fulfillment evaluation — the core math that
 * aggregates individual assignment results into a portfolio-level
 * obligation assessment.
 *
 * The pure computePortfolioFulfillment() function is tested directly
 * (no DB required). The DB-dependent create/evaluate functions are
 * tested via integration tests that require PostgreSQL (run in CI/Vercel).
 *
 * Properties verified:
 *   - Basic fulfillment: delivered ≥ committed × tolerance → fulfilled
 *   - Partial fulfillment: 0 < delivered < tolerance → partial
 *   - Failed: 0 delivered → failed
 *   - Overdelivery: delivered > committed → fulfilled (100%+)
 *   - Per-asset clipping: underperforming assets contribute 0, not negative
 *   - Tolerance band: configurable threshold (90% default, 100% strict)
 *   - kW/kWh conversion: deliveredKw = deliveredKwh / durationHours
 *   - Aggregate reconciliation: Σ actual, Σ baseline, Σ performance
 *
 * Run: bun test tests/portfolio-commitment.test.ts --timeout 30000
 */
import { describe, it, expect } from 'bun:test'
import { computePortfolioFulfillment } from '../src/lib/services/portfolio-commitment.service'

// Helpers

function asset(assetId: string, actual: number, baseline: number): {
  assetId: string
  actualKwh: number
  baselineKwh: number
  performanceKwh: number
} {
  // performanceKwh = max(0, actual - baseline) — per-asset clipping
  return {
    assetId,
    actualKwh: actual,
    baselineKwh: baseline,
    performanceKwh: Math.max(0, actual - baseline),
  }
}

// ---------------------------------------------------------------------------
// Basic fulfillment
// ---------------------------------------------------------------------------

describe('Portfolio Commitment: basic fulfillment', () => {
  it('delivered ≥ committed × tolerance → fulfilled', () => {
    // 4 assets, each delivering 100 kWh performance over 2 hours = 50 kW each.
    // Total delivered = 400 kWh / 2h = 200 kW.
    // Committed = 200 kW. Fulfillment = 100%.
    const perAsset = [
      asset('a', 120, 20),  // performance = 100
      asset('b', 110, 10),  // performance = 100
      asset('c', 130, 30),  // performance = 100
      asset('d', 125, 25),  // performance = 100
    ]

    const result = computePortfolioFulfillment(perAsset, 200, 2, 90)

    expect(result.deliveredKwh).toBe(400)
    expect(result.deliveredKw).toBe(200)
    expect(result.fulfillmentPct).toBeCloseTo(100, 1)
    expect(result.status).toBe('fulfilled')
  })

  it('delivered exactly at tolerance threshold → fulfilled', () => {
    // Committed = 200 kW, tolerance = 90%.
    // Delivered = 180 kW → fulfillment = 90% → fulfilled (≥ threshold).
    const perAsset = [
      asset('a', 100, 10),  // performance = 90
      asset('b', 100, 10),  // performance = 90
    ]
    // Total performance = 180 kWh, duration = 1h → 180 kW.

    const result = computePortfolioFulfillment(perAsset, 200, 1, 90)

    expect(result.deliveredKw).toBe(180)
    expect(result.fulfillmentPct).toBeCloseTo(90, 1)
    expect(result.status).toBe('fulfilled')
  })
})

// ---------------------------------------------------------------------------
// Partial fulfillment
// ---------------------------------------------------------------------------

describe('Portfolio Commitment: partial fulfillment', () => {
  it('delivered below tolerance but > 0 → partial', () => {
    // Committed = 200 kW, tolerance = 90%.
    // Delivered = 150 kW → fulfillment = 75% → partial.
    const perAsset = [
      asset('a', 100, 25),  // performance = 75
      asset('b', 100, 25),  // performance = 75
    ]
    // Total = 150 kWh / 1h = 150 kW.

    const result = computePortfolioFulfillment(perAsset, 200, 1, 90)

    expect(result.deliveredKw).toBe(150)
    expect(result.fulfillmentPct).toBeCloseTo(75, 1)
    expect(result.status).toBe('partial')
  })

  it('delivered slightly below tolerance → partial', () => {
    // Committed = 100 kW, tolerance = 90%.
    // Delivered = 89 kW → fulfillment = 89% → partial (just under 90%).
    const perAsset = [asset('a', 89, 0)]  // performance = 89

    const result = computePortfolioFulfillment(perAsset, 100, 1, 90)

    expect(result.fulfillmentPct).toBeCloseTo(89, 1)
    expect(result.status).toBe('partial')
  })
})

// ---------------------------------------------------------------------------
// Failed
// ---------------------------------------------------------------------------

describe('Portfolio Commitment: failed', () => {
  it('zero delivered → failed', () => {
    // All assets underperformed their baseline → performance = 0 for all.
    const perAsset = [
      asset('a', 50, 100),  // performance = max(0, 50-100) = 0
      asset('b', 60, 100),  // performance = 0
    ]

    const result = computePortfolioFulfillment(perAsset, 200, 1, 90)

    expect(result.deliveredKwh).toBe(0)
    expect(result.deliveredKw).toBe(0)
    expect(result.fulfillmentPct).toBe(0)
    expect(result.status).toBe('failed')
  })

  it('empty portfolio → failed', () => {
    const result = computePortfolioFulfillment([], 100, 1, 90)

    expect(result.deliveredKw).toBe(0)
    expect(result.fulfillmentPct).toBe(0)
    expect(result.status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// Overdelivery
// ---------------------------------------------------------------------------

describe('Portfolio Commitment: overdelivery', () => {
  it('delivered > committed → fulfilled (100%+)', () => {
    // Committed = 100 kW. Delivered = 150 kW → fulfillment = 150%.
    const perAsset = [
      asset('a', 150, 0),  // performance = 150
    ]

    const result = computePortfolioFulfillment(perAsset, 100, 1, 90)

    expect(result.deliveredKw).toBe(150)
    expect(result.fulfillmentPct).toBeCloseTo(150, 1)
    expect(result.status).toBe('fulfilled')
  })

  it('overdelivery does not cap fulfillment at 100%', () => {
    const perAsset = [asset('a', 200, 0)]  // performance = 200

    const result = computePortfolioFulfillment(perAsset, 100, 1, 90)

    expect(result.fulfillmentPct).toBeCloseTo(200, 1)
    expect(result.status).toBe('fulfilled')
  })
})

// ---------------------------------------------------------------------------
// Per-asset clipping (the key aggregation rule)
// ---------------------------------------------------------------------------

describe('Portfolio Commitment: per-asset clipping', () => {
  it('underperforming asset contributes 0, not negative', () => {
    // Asset A: actual=100, baseline=120 → performance = max(0, -20) = 0
    // Asset B: actual=100, baseline=20 → performance = 80
    // Total performance = 80 kWh (NOT 80 + (-20) = 60).
    const perAsset = [
      asset('a', 100, 120),  // underperforms baseline → performance = 0
      asset('b', 100, 20),   // performance = 80
    ]

    const result = computePortfolioFulfillment(perAsset, 100, 1, 90)

    // deliveredKwh = 0 + 80 = 80 (the underperforming asset contributes 0,
    // not -20).
    expect(result.deliveredKwh).toBe(80)
    expect(result.deliveredKw).toBe(80)
  })

  it('Σ performance ≠ max(0, Σ actual - Σ baseline) — clipping is per-asset', () => {
    // This is the key mathematical property: per-asset clipping matters.
    //
    // Asset A: actual=100, baseline=150 → performance = 0 (clipped)
    // Asset B: actual=200, baseline=50 → performance = 150
    //
    // Per-asset clipping: delivered = 0 + 150 = 150 kWh
    // Naive (wrong): max(0, (100+200) - (150+50)) = max(0, 300-200) = 100 kWh
    //
    // The per-asset approach gives 150 (correct — asset B's overperformance
    // is not offset by asset A's underperformance). The naive approach
    // gives 100 (wrong — it lets A's shortfall reduce B's contribution).
    const perAsset = [
      asset('a', 100, 150),  // performance = 0
      asset('b', 200, 50),   // performance = 150
    ]

    const result = computePortfolioFulfillment(perAsset, 100, 1, 90)

    expect(result.deliveredKwh).toBe(150) // NOT 100
    expect(result.totalActualKwh).toBe(300)
    expect(result.totalBaselineKwh).toBe(200)
    // deliveredKwh (150) ≠ max(0, totalActual - totalBaseline) = max(0, 100) = 100
    expect(result.deliveredKwh).not.toBe(100)
  })
})

// ---------------------------------------------------------------------------
// Tolerance band
// ---------------------------------------------------------------------------

describe('Portfolio Commitment: tolerance band', () => {
  it('default tolerance is 90%', () => {
    const perAsset = [asset('a', 90, 0)]  // performance = 90

    // committedKw=100, delivered=90 → 90% → fulfilled at default tolerance.
    const result = computePortfolioFulfillment(perAsset, 100, 1)
    expect(result.toleranceThresholdPct).toBe(90)
    expect(result.fulfillmentPct).toBeCloseTo(90, 1)
    expect(result.status).toBe('fulfilled')
  })

  it('strict tolerance (100%) requires full delivery', () => {
    const perAsset = [asset('a', 90, 0)]  // performance = 90

    // 90% fulfillment with 100% tolerance → partial.
    const result = computePortfolioFulfillment(perAsset, 100, 1, 100)
    expect(result.status).toBe('partial')
  })

  it('lenient tolerance (50%) accepts half delivery', () => {
    const perAsset = [asset('a', 50, 0)]  // performance = 50

    // 50% fulfillment with 50% tolerance → fulfilled.
    const result = computePortfolioFulfillment(perAsset, 100, 1, 50)
    expect(result.status).toBe('fulfilled')
  })

  it('tolerance applies to committedKw, not requestedKw', () => {
    // Buyer requested 500 kW. Optimizer committed 400 kW (safe capacity).
    // Delivered 360 kW → 90% of committed → fulfilled at 90% tolerance.
    const perAsset = [asset('a', 360, 0)]  // performance = 360

    const result = computePortfolioFulfillment(perAsset, 400, 1, 90)
    expect(result.fulfillmentPct).toBeCloseTo(90, 1)
    expect(result.status).toBe('fulfilled')
  })
})

// ---------------------------------------------------------------------------
// kW / kWh conversion
// ---------------------------------------------------------------------------

describe('Portfolio Commitment: kW/kWh conversion', () => {
  it('deliveredKw = deliveredKwh / durationHours', () => {
    // 4 assets, each 100 kWh performance over 2 hours = 50 kW each.
    // Total = 400 kWh / 2h = 200 kW.
    const perAsset = [
      asset('a', 120, 20),
      asset('b', 110, 10),
      asset('c', 130, 30),
      asset('d', 125, 25),
    ]

    const result = computePortfolioFulfillment(perAsset, 200, 2, 90)
    expect(result.deliveredKwh).toBe(400)
    expect(result.deliveredKw).toBe(200)
  })

  it('longer duration → lower deliveredKw for same energy', () => {
    const perAsset = [asset('a', 100, 0)]  // 100 kWh

    const r1h = computePortfolioFulfillment(perAsset, 100, 1, 90)
    const r4h = computePortfolioFulfillment(perAsset, 100, 4, 90)

    expect(r1h.deliveredKw).toBe(100) // 100 kWh / 1h = 100 kW
    expect(r4h.deliveredKw).toBe(25)  // 100 kWh / 4h = 25 kW
  })

  it('zero duration is handled safely (no division by zero)', () => {
    const perAsset = [asset('a', 100, 0)]
    const result = computePortfolioFulfillment(perAsset, 100, 0, 90)
    expect(result.deliveredKw).toBeGreaterThan(0) // doesn't crash or return NaN
    expect(Number.isFinite(result.deliveredKw)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Aggregate reconciliation
// ---------------------------------------------------------------------------

describe('Portfolio Commitment: aggregate reconciliation', () => {
  it('totalActualKwh = Σ actualKwh_i', () => {
    const perAsset = [
      asset('a', 100, 20),
      asset('b', 150, 30),
      asset('c', 200, 50),
    ]

    const result = computePortfolioFulfillment(perAsset, 200, 1, 90)
    expect(result.totalActualKwh).toBe(450) // 100+150+200
  })

  it('totalBaselineKwh = Σ baselineKwh_i', () => {
    const perAsset = [
      asset('a', 100, 20),
      asset('b', 150, 30),
      asset('c', 200, 50),
    ]

    const result = computePortfolioFulfillment(perAsset, 200, 1, 90)
    expect(result.totalBaselineKwh).toBe(100) // 20+30+50
  })

  it('deliveredKwh = Σ performanceKwh_i (per-asset clipped)', () => {
    const perAsset = [
      asset('a', 100, 20),  // performance = 80
      asset('b', 150, 30),  // performance = 120
      asset('c', 200, 50),  // performance = 150
    ]

    const result = computePortfolioFulfillment(perAsset, 200, 1, 90)
    expect(result.deliveredKwh).toBe(350) // 80+120+150
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Portfolio Commitment: edge cases', () => {
  it('committedKw = 0 → fulfillmentPct = 0, status = failed', () => {
    const perAsset = [asset('a', 100, 0)]
    const result = computePortfolioFulfillment(perAsset, 0, 1, 90)
    expect(result.fulfillmentPct).toBe(0)
    expect(result.status).toBe('failed')
  })

  it('all assets have zero performance → failed', () => {
    const perAsset = [
      asset('a', 50, 50),  // performance = 0
      asset('b', 60, 60),  // performance = 0
    ]
    const result = computePortfolioFulfillment(perAsset, 100, 1, 90)
    expect(result.deliveredKwh).toBe(0)
    expect(result.status).toBe('failed')
  })

  it('mixed completed and underperforming assets', () => {
    // 4 assets. 2 deliver well, 1 underperforms (contributes 0), 1 delivers partially.
    const perAsset = [
      asset('a', 120, 20),  // performance = 100
      asset('b', 130, 30),  // performance = 100
      asset('c', 50, 100),  // performance = 0 (underperformed)
      asset('d', 80, 30),   // performance = 50
    ]
    // Total performance = 100 + 100 + 0 + 50 = 250 kWh / 1h = 250 kW.

    const result = computePortfolioFulfillment(perAsset, 300, 1, 90)
    expect(result.deliveredKwh).toBe(250)
    expect(result.deliveredKw).toBe(250)
    expect(result.fulfillmentPct).toBeCloseTo(83.33, 1)
    expect(result.status).toBe('partial') // 83.33% < 90%
  })
})
