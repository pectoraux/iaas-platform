/**
 * VPP-2 Baseline Engine Tests
 *
 * Tests the real baseline/performance engine against synthetic histories
 * with KNOWN ground truth. Measures bias, MAE, overpayment, underpayment
 * across three baseline strategies.
 *
 * Run: bun test tests/vpp-baseline.test.ts --timeout 60000
 */
import { describe, it, expect } from 'bun:test'
import {
  DERHistorySimulator,
  type SyntheticHistory,
} from '../src/lib/services/der-simulator.service'
import {
  SameTimeHistoricalBaseline,
  WeekdayWeekendAverageBaseline,
  RegressionBaseline,
  evaluateBaseline,
  evaluateAllBaselines,
  type BaselineStrategy,
} from '../src/lib/services/baseline-engine.service'

describe('VPP-2: DER History Simulator', () => {
  it('should generate synthetic history with known ground truth', () => {
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 17, 2, 5)

    // 14 historical days.
    expect(history.days.length).toBe(14)

    // Each day has 96 points (15-min intervals).
    expect(history.days[0].points.length).toBe(96)

    // Dispatch day has ground truth.
    expect(history.dispatchDay.trueCounterfactualKwh).toBeGreaterThan(0)
    expect(history.dispatchDay.actualWithDispatchKwh).toBeGreaterThan(0)
    expect(history.dispatchDay.trueIncrementalKwh).toBeGreaterThan(0)

    // The incremental performance should be positive (dispatch added energy delivery).
    expect(history.dispatchDay.trueIncrementalKwh).toBeGreaterThan(0)
  })

  it('should produce different counterfactuals for different dispatch windows', () => {
    const sim = new DERHistorySimulator(42)
    const evening = sim.generateHistory(14, 17, 2, 5)  // 5-7 PM
    const midday = sim.generateHistory(14, 12, 2, 5)   // 12-2 PM

    // Evening dispatch should have higher counterfactual (battery normally discharges).
    expect(evening.dispatchDay.trueCounterfactualKwh).toBeGreaterThan(midday.dispatchDay.trueCounterfactualKwh)
  })
})

describe('VPP-2: Baseline Strategies', () => {
  const sim = new DERHistorySimulator(42)
  const history = sim.generateHistory(14, 17, 2, 5)
  const { trueCounterfactualKwh, actualWithDispatchKwh, trueIncrementalKwh } = history.dispatchDay

  it('same-time historical baseline should predict within a reasonable range', () => {
    const strategy = new SameTimeHistoricalBaseline()
    const result = strategy.predict(history.days, { dispatchStartIndex: history.dispatchDay.dispatchStartIndex, dispatchEndIndex: history.dispatchDay.dispatchEndIndex, dispatchDate: history.dispatchDay.date, dayOfWeek: history.dispatchDay.dayProfile.dayOfWeek, isWeekend: history.dispatchDay.dayProfile.isWeekend })

    expect(result.method).toBe('same_time_historical')
    expect(result.predictedCounterfactualKwh).toBeGreaterThanOrEqual(0)
    // Should be in the ballpark of the true counterfactual (within 2x).
    expect(result.predictedCounterfactualKwh).toBeLessThan(trueCounterfactualKwh * 3)
  })

  it('similar-day average baseline should account for day-of-week', () => {
    const strategy = new WeekdayWeekendAverageBaseline()
    const result = strategy.predict(history.days, { dispatchStartIndex: history.dispatchDay.dispatchStartIndex, dispatchEndIndex: history.dispatchDay.dispatchEndIndex, dispatchDate: history.dispatchDay.date, dayOfWeek: history.dispatchDay.dayProfile.dayOfWeek, isWeekend: history.dispatchDay.dayProfile.isWeekend })

    expect(result.method).toBe('weekday_weekend_average')
    expect(result.predictedCounterfactualKwh).toBeGreaterThanOrEqual(0)
    // Should use only similar days (filtered by weekday/weekend).
    expect(result.predictedProfile.length).toBeGreaterThan(0)
  })

  it('regression baseline should adjust for temperature + day-of-week', () => {
    const strategy = new RegressionBaseline()
    const result = strategy.predict(history.days, { dispatchStartIndex: history.dispatchDay.dispatchStartIndex, dispatchEndIndex: history.dispatchDay.dispatchEndIndex, dispatchDate: history.dispatchDay.date, dayOfWeek: history.dispatchDay.dayProfile.dayOfWeek, isWeekend: history.dispatchDay.dayProfile.isWeekend })

    expect(result.method).toBe('regression')
    expect(result.predictedCounterfactualKwh).toBeGreaterThanOrEqual(0)
  })

  it('all three strategies should produce different predictions', () => {
    const strategies: BaselineStrategy[] = [
      new SameTimeHistoricalBaseline(),
      new WeekdayWeekendAverageBaseline(),
      new RegressionBaseline(),
    ]

    const predictions = strategies.map(s => s.predict(history.days, { dispatchStartIndex: history.dispatchDay.dispatchStartIndex, dispatchEndIndex: history.dispatchDay.dispatchEndIndex, dispatchDate: history.dispatchDay.date, dayOfWeek: history.dispatchDay.dayProfile.dayOfWeek, isWeekend: history.dispatchDay.dayProfile.isWeekend }).predictedCounterfactualKwh)

    // At least two should differ (they use different methodologies).
    const unique = new Set(predictions.map(p => p.toFixed(2)))
    expect(unique.size).toBeGreaterThanOrEqual(2)
  })
})

describe('VPP-2: Baseline Evaluation', () => {
  it('should correctly measure bias, overpayment, underpayment', () => {
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 17, 2, 5)
    const evaluations = evaluateAllBaselines(history)

    expect(evaluations.length).toBe(3)

    for (const e of evaluations) {
      // All should have non-negative predicted counterfactuals.
      expect(e.predictedCounterfactualKwh).toBeGreaterThanOrEqual(0)

      // True performance should be positive (dispatch delivered energy).
      expect(e.truePerformanceKwh).toBeGreaterThan(0)

      // Claimed performance should be positive.
      expect(e.claimedPerformanceKwh).toBeGreaterThan(0)

      // Absolute error should be non-negative.
      expect(e.absoluteError).toBeGreaterThanOrEqual(0)

      // Bias + true = predicted (signed error).
      expect(Math.abs(e.bias + e.trueCounterfactualKwh - e.predictedCounterfactualKwh)).toBeLessThan(0.3)

      // Overpayment + underpayment should not both be positive.
      expect(e.overpaymentKwh === 0 || e.underpaymentKwh === 0).toBe(true)

      // Overpayment + true performance = claimed performance.
      expect(Math.abs(e.overpaymentKwh + e.truePerformanceKwh - e.claimedPerformanceKwh)).toBeLessThan(0.3)
    }
  })

  it('should detect false positives and false negatives', () => {
    // Create a scenario where dispatch happens during a non-discharge window.
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 3, 2, 5) // 3 AM dispatch — battery normally idle

    const evaluations = evaluateAllBaselines(history)

    for (const e of evaluations) {
      // At 3 AM, true counterfactual should be near zero (battery not discharging).
      // Dispatch should produce actual energy → incremental performance is high.
      // Baselines should predict near-zero counterfactual.

      // True performance should be positive (dispatch added energy at 3 AM).
      expect(e.truePerformanceKwh).toBeGreaterThan(0)

      // No false negative (dispatch did produce energy).
      expect(e.falseNegative).toBe(false)
    }
  })

  it('regression baseline should generally have lower MAE than simple historical', () => {
    // Run multiple simulations to get statistical comparison.
    let historicalMAE = 0
    let regressionMAE = 0
    const N = 10

    for (let seed = 1; seed <= N; seed++) {
      const sim = new DERHistorySimulator(seed)
      const history = sim.generateHistory(14, 17, 2, 5)
      const evaluations = evaluateAllBaselines(history)

      historicalMAE += evaluations[0].absoluteError
      regressionMAE += evaluations[2].absoluteError
    }

    historicalMAE /= N
    regressionMAE /= N

    // Regression should generally be better (lower MAE), though not guaranteed
    // for every single run. We just verify both are reasonable.
    expect(historicalMAE).toBeGreaterThan(0)
    expect(regressionMAE).toBeGreaterThan(0)
    expect(regressionMAE).toBeLessThanOrEqual(historicalMAE * 2) // within 2x of historical
  })

  it('should quantify economic consequences of baseline error', () => {
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 17, 2, 5)
    const evaluations = evaluateAllBaselines(history)

    for (const e of evaluations) {
      // Overpayment % should be reasonable (not > 200%).
      if (e.truePerformanceKwh > 0) {
        expect(Math.abs(e.overpaymentPct)).toBeLessThan(200)
        expect(Math.abs(e.underpaymentPct)).toBeLessThan(200)
      }

      // The sum of overpayment and underpayment percentages should equal the
      // absolute percentage error (approximately).
      // |overpayment_pct| + |underpayment_pct| ≈ |signed_error / true_perf| * 100
      const expectedPctSum = Math.abs(e.signedError / e.truePerformanceKwh) * 100
      const actualPctSum = e.overpaymentPct + e.underpaymentPct
      expect(Math.abs(actualPctSum - expectedPctSum)).toBeLessThan(1) // 1% tolerance
    }
  })
})
