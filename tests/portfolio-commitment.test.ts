/**
 * VPP-2D-4: Portfolio Commitment tests (integrated + corrected).
 *
 * Tests the hardened portfolio commitment service:
 *   - Separated performance measures (operator contribution vs buyer fulfillment)
 *   - Completion gating (pending until all assignments terminal)
 *   - Fulfillment basis (per_asset_clipped vs aggregate_counterfactual)
 *   - Measurement method (average_power vs energy)
 *   - Per-asset clipping vs aggregate counterfactual (the key distinction)
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
  return {
    assetId,
    actualKwh: actual,
    baselineKwh: baseline,
    performanceKwh: Math.max(0, actual - baseline),
  }
}

// ---------------------------------------------------------------------------
// Separated performance measures (the key 2D-4 correction)
// ---------------------------------------------------------------------------

describe('Portfolio Commitment: separated performance measures', () => {
  it('records operatorContributionKwh = Σ max(0, actual_i - baseline_i)', () => {
    const perAsset = [
      asset('a', 120, 20),  // performance = 100
      asset('b', 80, 100),  // performance = 0 (underperformed)
      asset('c', 150, 50),  // performance = 100
    ]

    const result = computePortfolioFulfillment(perAsset, 200, 1, {
      fulfillmentBasis: 'per_asset_clipped',
    })

    // Operator contribution = 100 + 0 + 100 = 200.
    expect(result.operatorContributionKwh).toBe(200)
  })

  it('records rawSignedPortfolioPerformanceKwh = Σ actual - Σ baseline', () => {
    const perAsset = [
      asset('a', 120, 20),  // signed = +100
      asset('b', 80, 100),  // signed = -20
      asset('c', 150, 50),  // signed = +100
    ]

    const result = computePortfolioFulfillment(perAsset, 200, 1, {
      fulfillmentBasis: 'per_asset_clipped',
    })

    // Raw signed = (120+80+150) - (20+100+50) = 350 - 170 = 180.
    expect(result.rawSignedPortfolioPerformanceKwh).toBe(180)
  })

  it('rawSigned can be negative when portfolio underperforms aggregate baseline', () => {
    const perAsset = [
      asset('a', 50, 100),  // signed = -50
      asset('b', 60, 100),  // signed = -40 (wait, 60-100 = -40)
    ]
    // Σ actual = 110, Σ baseline = 200, raw signed = -90.

    const result = computePortfolioFulfillment(perAsset, 200, 1, {
      fulfillmentBasis: 'per_asset_clipped',
    })

    expect(result.rawSignedPortfolioPerformanceKwh).toBe(-90)
    // Operator contribution = 0 + 0 = 0 (both clipped).
    expect(result.operatorContributionKwh).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Fulfillment basis: per_asset_clipped vs aggregate_counterfactual
// ---------------------------------------------------------------------------

describe('Portfolio Commitment: fulfillment basis', () => {
  it('per_asset_clipped: underperforming asset contributes 0, not negative', () => {
    // Asset A: actual=100, baseline=150 → performance = 0 (clipped)
    // Asset B: actual=200, baseline=50 → performance = 150
    // per_asset_clipped: buyerDelivered = 0 + 150 = 150
    const perAsset = [
      asset('a', 100, 150),
      asset('b', 200, 50),
    ]

    const result = computePortfolioFulfillment(perAsset, 100, 1, {
      fulfillmentBasis: 'per_asset_clipped',
    })

    expect(result.buyerDeliveredKwh).toBe(150)
    expect(result.operatorContributionKwh).toBe(150)
  })

  it('aggregate_counterfactual: overperformance offsets underperformance', () => {
    // Same assets as above.
    // aggregate_counterfactual: buyerDelivered = max(0, Σactual - Σbaseline)
    //   = max(0, (100+200) - (150+50)) = max(0, 300-200) = 100
    const perAsset = [
      asset('a', 100, 150),
      asset('b', 200, 50),
    ]

    const result = computePortfolioFulfillment(perAsset, 100, 1, {
      fulfillmentBasis: 'aggregate_counterfactual',
    })

    expect(result.buyerDeliveredKwh).toBe(100) // NOT 150
    // rawSigned = 300 - 200 = 100, max(0, 100) = 100.
    expect(result.rawSignedPortfolioPerformanceKwh).toBe(100)
  })

  it('per_asset_clipped ≠ aggregate_counterfactual when assets have mixed performance', () => {
    // This is the key test proving the two bases give different results.
    const perAsset = [
      asset('a', 100, 150),  // underperforms → 0 clipped, -50 signed
      asset('b', 200, 50),   // overperforms → 150 clipped, +150 signed
    ]

    const clipped = computePortfolioFulfillment(perAsset, 100, 1, {
      fulfillmentBasis: 'per_asset_clipped',
    })
    const aggregate = computePortfolioFulfillment(perAsset, 100, 1, {
      fulfillmentBasis: 'aggregate_counterfactual',
    })

    // Clipped: 0 + 150 = 150.
    // Aggregate: max(0, (100+200) - (150+50)) = max(0, 100) = 100.
    expect(clipped.buyerDeliveredKwh).toBe(150)
    expect(aggregate.buyerDeliveredKwh).toBe(100)
    expect(clipped.buyerDeliveredKwh).not.toBe(aggregate.buyerDeliveredKwh)
  })

  it('default fulfillmentBasis is per_asset_clipped', () => {
    const perAsset = [asset('a', 100, 20)]
    const result = computePortfolioFulfillment(perAsset, 100, 1)
    expect(result.fulfillmentBasis).toBe('per_asset_clipped')
  })
})

// ---------------------------------------------------------------------------
// Measurement method
// ---------------------------------------------------------------------------

describe('Portfolio Commitment: measurement method', () => {
  it('average_power: deliveredKw = deliveredKwh / durationHours', () => {
    const perAsset = [asset('a', 200, 0)]  // performance = 200 kWh

    const result = computePortfolioFulfillment(perAsset, 100, 2, {
      measurementMethod: 'average_power',
    })

    expect(result.buyerDeliveredKwh).toBe(200)
    expect(result.buyerDeliveredKw).toBe(100) // 200 / 2h = 100 kW
  })

  it('energy: fulfillment = deliveredKwh / requestedKwh (NOT / committedKw)', () => {
    // 200 kWh delivered, 1000 kWh requested → 20% fulfillment.
    // committedKw = 500 (display-only for energy method).
    const perAsset = [asset('a', 200, 0)]  // performance = 200 kWh

    const result = computePortfolioFulfillment(perAsset, 500, 2, {
      measurementMethod: 'energy',
      requestedKwh: 1000,
    })

    expect(result.buyerDeliveredKwh).toBe(200)
    expect(result.fulfillmentPct).toBeCloseTo(20, 1) // 200 / 1000 = 20%, NOT 200/500 = 40%
    expect(result.status).toBe('failed') // 20% < 90% tolerance
  })

  it('energy: 1000 kWh delivered / 1000 kWh requested = 100% fulfillment', () => {
    const perAsset = [asset('a', 1000, 0)]  // performance = 1000 kWh

    const result = computePortfolioFulfillment(perAsset, 500, 2, {
      measurementMethod: 'energy',
      requestedKwh: 1000,
    })

    expect(result.fulfillmentPct).toBeCloseTo(100, 1)
    expect(result.status).toBe('fulfilled')
  })

  it('energy: deliveredKw is still computed (display-only) = deliveredKwh / duration', () => {
    const perAsset = [asset('a', 200, 0)]  // 200 kWh over 2h = 100 kW

    const result = computePortfolioFulfillment(perAsset, 100, 2, {
      measurementMethod: 'energy',
      requestedKwh: 200,
    })

    // deliveredKw is display-only for energy method — still computed as
    // deliveredKwh / durationHours for informational purposes.
    expect(result.buyerDeliveredKw).toBe(100) // 200 / 2h = 100 kW
    // But fulfillment uses the energy denominator, not kW.
    expect(result.fulfillmentPct).toBeCloseTo(100, 1) // 200 / 200 = 100%
  })

  it('interval_power is explicitly rejected (not silently treated as average_power)', () => {
    const perAsset = [asset('a', 100, 0)]

    expect(() =>
      computePortfolioFulfillment(perAsset, 100, 1, {
        measurementMethod: 'interval_power',
      }),
    ).toThrow(/not yet supported/)
  })

  it('default measurementMethod is average_power', () => {
    const perAsset = [asset('a', 100, 0)]
    const result = computePortfolioFulfillment(perAsset, 100, 1)
    expect(result.measurementMethod).toBe('average_power')
  })

  it('average_power: longer duration → lower deliveredKw', () => {
    const perAsset = [asset('a', 100, 0)]  // 100 kWh

    const r1h = computePortfolioFulfillment(perAsset, 100, 1, { measurementMethod: 'average_power' })
    const r4h = computePortfolioFulfillment(perAsset, 100, 4, { measurementMethod: 'average_power' })

    expect(r1h.buyerDeliveredKw).toBe(100)
    expect(r4h.buyerDeliveredKw).toBe(25)
  })

  it('average_power: fulfillment = deliveredKw / committedKw', () => {
    // 1000 kWh over 2h = 500 kW. Committed 500 kW → 100%.
    const perAsset = [asset('a', 1000, 0)]

    const result = computePortfolioFulfillment(perAsset, 500, 2, {
      measurementMethod: 'average_power',
    })

    expect(result.buyerDeliveredKw).toBe(500)
    expect(result.fulfillmentPct).toBeCloseTo(100, 1)
    expect(result.status).toBe('fulfilled')
  })
})

// ---------------------------------------------------------------------------
// Basic fulfillment + tolerance (with new options interface)
// ---------------------------------------------------------------------------

describe('Portfolio Commitment: basic fulfillment', () => {
  it('delivered ≥ committed × tolerance → fulfilled', () => {
    const perAsset = [
      asset('a', 120, 20),
      asset('b', 110, 10),
      asset('c', 130, 30),
      asset('d', 125, 25),
    ]

    const result = computePortfolioFulfillment(perAsset, 200, 2, { toleranceThresholdPct: 90 })

    expect(result.buyerDeliveredKwh).toBe(400)
    expect(result.buyerDeliveredKw).toBe(200)
    expect(result.fulfillmentPct).toBeCloseTo(100, 1)
    expect(result.status).toBe('fulfilled')
  })

  it('partial: below tolerance but > 0', () => {
    const perAsset = [asset('a', 75, 0)]
    const result = computePortfolioFulfillment(perAsset, 100, 1, { toleranceThresholdPct: 90 })
    expect(result.fulfillmentPct).toBeCloseTo(75, 1)
    expect(result.status).toBe('partial')
  })

  it('failed: zero delivered', () => {
    const perAsset = [asset('a', 50, 100)]  // performance = 0
    const result = computePortfolioFulfillment(perAsset, 100, 1, { toleranceThresholdPct: 90 })
    expect(result.buyerDeliveredKwh).toBe(0)
    expect(result.status).toBe('failed')
  })

  it('overdelivery → fulfilled at 100%+', () => {
    const perAsset = [asset('a', 200, 0)]
    const result = computePortfolioFulfillment(perAsset, 100, 1)
    expect(result.fulfillmentPct).toBeCloseTo(200, 1)
    expect(result.status).toBe('fulfilled')
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
    const result = computePortfolioFulfillment(perAsset, 200, 1)
    expect(result.totalActualKwh).toBe(450)
  })

  it('totalBaselineKwh = Σ baselineKwh_i', () => {
    const perAsset = [
      asset('a', 100, 20),
      asset('b', 150, 30),
      asset('c', 200, 50),
    ]
    const result = computePortfolioFulfillment(perAsset, 200, 1)
    expect(result.totalBaselineKwh).toBe(100)
  })

  it('rawSignedPortfolioPerformanceKwh = totalActual - totalBaseline', () => {
    const perAsset = [
      asset('a', 100, 20),
      asset('b', 150, 30),
      asset('c', 200, 50),
    ]
    const result = computePortfolioFulfillment(perAsset, 200, 1)
    expect(result.rawSignedPortfolioPerformanceKwh).toBe(350) // 450 - 100
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Portfolio Commitment: edge cases', () => {
  it('committedKw = 0 → fulfillmentPct = 0, status = failed', () => {
    const perAsset = [asset('a', 100, 0)]
    const result = computePortfolioFulfillment(perAsset, 0, 1)
    expect(result.fulfillmentPct).toBe(0)
    expect(result.status).toBe('failed')
  })

  it('empty portfolio → failed', () => {
    const result = computePortfolioFulfillment([], 100, 1)
    expect(result.buyerDeliveredKwh).toBe(0)
    expect(result.status).toBe('failed')
  })

  it('zero duration is handled safely', () => {
    const perAsset = [asset('a', 100, 0)]
    const result = computePortfolioFulfillment(perAsset, 100, 0)
    expect(Number.isFinite(result.buyerDeliveredKw)).toBe(true)
  })

  it('all assets underperform → raw signed negative, buyer delivered 0', () => {
    const perAsset = [
      asset('a', 50, 100),  // signed = -50
      asset('b', 60, 100),  // signed = -40
    ]
    const result = computePortfolioFulfillment(perAsset, 100, 1, {
      fulfillmentBasis: 'aggregate_counterfactual',
    })
    expect(result.rawSignedPortfolioPerformanceKwh).toBe(-90)
    expect(result.buyerDeliveredKwh).toBe(0) // max(0, -90) = 0
    expect(result.status).toBe('failed')
  })
})
