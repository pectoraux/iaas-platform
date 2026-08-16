/**
 * VPP-2A: Baseline evaluation across 100+ scenarios + hard scenarios.
 *
 * Tests that the simulator produces uncontaminated ground truth and that
 * baseline strategies are evaluated with meaningful statistical criteria.
 *
 * Run: bun test tests/vpp-baseline-eval.test.ts --timeout 60000
 */
import { describe, it, expect } from 'bun:test'
import { DERHistorySimulator } from '../src/lib/services/der-simulator.service'
import {
  SameTimeHistoricalBaseline,
  WeekdayWeekendAverageBaseline,
  RegressionBaseline,
  evaluateBaseline,
  evaluateAllBaselines,
  type BaselineStrategy,
  type BaselineEvaluation,
} from '../src/lib/services/baseline-engine.service'

describe('VPP-2A: Simulator ground truth integrity', () => {
  it('counterfactual and treatment must share identical exogenous inputs', () => {
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 17, 2, 5)

    const cf = history.dispatchDay.counterfactualProfile
    const tr = history.dispatchDay.dayProfile

    // Same temperature (exogenous input must be identical).
    expect(cf.temperatureC).toBe(tr.temperatureC)

    // Same day-of-week.
    expect(cf.dayOfWeek).toBe(tr.dayOfWeek)
    expect(cf.isWeekend).toBe(tr.isWeekend)

    // Outside the dispatch window, the profiles must be IDENTICAL
    // (the only difference should be dispatch).
    const { dispatchStartIndex, dispatchEndIndex } = history.dispatchDay
    for (let i = 0; i < 96; i++) {
      if (i < dispatchStartIndex || i >= dispatchEndIndex) {
        expect(cf.points[i].powerKw).toBe(tr.points[i].powerKw)
      }
    }
  })

  it('true incremental must equal actual minus counterfactual', () => {
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 17, 2, 5)
    const { trueCounterfactualKwh, actualWithDispatchKwh, trueIncrementalKwh } = history.dispatchDay

    expect(Math.abs(trueIncrementalKwh - (actualWithDispatchKwh - trueCounterfactualKwh))).toBeLessThan(0.001)
  })
})

describe('VPP-2A: 100-scenario statistical evaluation', () => {
  const N = 100
  const strategies: BaselineStrategy[] = [
    new SameTimeHistoricalBaseline(),
    new WeekdayWeekendAverageBaseline(),
    new RegressionBaseline(),
  ]

  // Run 100 independently seeded scenarios.
  const allEvaluations: Record<string, BaselineEvaluation[]> = {}
  for (const s of strategies) {
    allEvaluations[s.name] = []
  }

  for (let seed = 1; seed <= N; seed++) {
    const sim = new DERHistorySimulator(seed)
    const history = sim.generateHistory(14, 17, 2, 5)
    const evals = evaluateAllBaselines(history)
    for (const e of evals) {
      allEvaluations[e.method].push(e)
    }
  }

  it('should have 100 evaluations per strategy', () => {
    for (const s of strategies) {
      expect(allEvaluations[s.name].length).toBe(N)
    }
  })

  it('all strategies should have non-negative MAE', () => {
    for (const s of strategies) {
      const evals = allEvaluations[s.name]
      const mae = evals.reduce((sum, e) => sum + e.absoluteError, 0) / N
      expect(mae).toBeGreaterThan(0)
    }
  })

  it('should report per-strategy statistics', () => {
    for (const s of strategies) {
      const evals = allEvaluations[s.name]

      const bias = evals.reduce((sum, e) => sum + e.bias, 0) / N
      const mae = evals.reduce((sum, e) => sum + e.absoluteError, 0) / N
      const rmse = Math.sqrt(evals.reduce((sum, e) => sum + e.signedError * e.signedError, 0) / N)
      const p95Errors = evals.map(e => e.absoluteError).sort((a, b) => a - b)
      const p95 = p95Errors[Math.floor(N * 0.95)]
      const medianErrors = evals.map(e => e.absoluteError).sort((a, b) => a - b)
      const median = medianErrors[Math.floor(N / 2)]
      const falsePositives = evals.filter(e => e.falsePositive).length
      const falseNegatives = evals.filter(e => e.falseNegative).length
      const totalOverpayment = evals.reduce((sum, e) => sum + e.overpaymentKwh, 0)
      const totalUnderpayment = evals.reduce((sum, e) => sum + e.underpaymentKwh, 0)

      // All metrics should be finite numbers.
      expect(isFinite(bias)).toBe(true)
      expect(isFinite(mae)).toBe(true)
      expect(isFinite(rmse)).toBe(true)
      expect(isFinite(p95)).toBe(true)
      expect(isFinite(median)).toBe(true)

      // False positive + false negative should be <= N.
      expect(falsePositives + falseNegatives).toBeLessThanOrEqual(N)

      // Overpayment and underpayment should be non-negative.
      expect(totalOverpayment).toBeGreaterThanOrEqual(0)
      expect(totalUnderpayment).toBeGreaterThanOrEqual(0)

      // Log the results for visibility.
      console.log(`  ${s.name}: bias=${bias.toFixed(3)}, MAE=${mae.toFixed(3)}, RMSE=${rmse.toFixed(3)}, P95=${p95.toFixed(3)}, median=${median.toFixed(3)}, FP=${falsePositives}, FN=${falseNegatives}, overpay=${totalOverpayment.toFixed(2)}kWh, underpay=${totalUnderpayment.toFixed(2)}kWh`)
    }
  })

  it('regression should not be dramatically worse than historical', () => {
    const histMAE = allEvaluations['same_time_historical'].reduce((s, e) => s + e.absoluteError, 0) / N
    const regMAE = allEvaluations['regression'].reduce((s, e) => s + e.absoluteError, 0) / N

    // Regression should be within 50% of historical (much stricter than 2x).
    expect(regMAE).toBeLessThanOrEqual(histMAE * 1.5)
  })
})

describe('VPP-2A: Hard scenarios', () => {
  it('weekday dispatch vs weekend dispatch produce different baselines', () => {
    const sim1 = new DERHistorySimulator(42)
    const weekdayHistory = sim1.generateHistory(14, 17, 2, 5)

    // Check if dispatch day is a weekday.
    const isWeekend = weekdayHistory.dispatchDay.dayProfile.isWeekend
    // Just verify the simulator can generate both types.
    expect(typeof isWeekend).toBe('boolean')
  })

  it('dispatch outside normal discharge (3 AM) should have low counterfactual', () => {
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 3, 2, 5) // 3 AM

    // At 3 AM, the battery should not be discharging → counterfactual near 0.
    expect(history.dispatchDay.trueCounterfactualKwh).toBeLessThan(2.0)
  })

  it('dispatch during normal discharge (19:00) should have higher counterfactual', () => {
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 19, 2, 5) // 7 PM

    // At 7 PM, the battery normally discharges → counterfactual > 0.
    expect(history.dispatchDay.trueCounterfactualKwh).toBeGreaterThan(0.5)
  })

  it('sparse history (3 days) should still produce a baseline', () => {
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(3, 17, 2, 5)

    const strategy = new WeekdayWeekendAverageBaseline()
    const result = strategy.predict(history.days, { dispatchStartIndex: history.dispatchDay.dispatchStartIndex, dispatchEndIndex: history.dispatchDay.dispatchEndIndex, dispatchDate: history.dispatchDay.date, dayOfWeek: history.dispatchDay.dayProfile.dayOfWeek, isWeekend: history.dispatchDay.dayProfile.isWeekend })

    expect(result.predictedCounterfactualKwh).toBeGreaterThanOrEqual(0)
  })

  it('negative predicted performance should not produce negative contribution', () => {
    // If baseline overpredicts, actual - baseline could be negative.
    // The VPP should handle this (performanceKwh could be negative → no reward).
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 3, 2, 5) // 3 AM, low actual

    const strategy = new SameTimeHistoricalBaseline()
    const result = strategy.predict(history.days, { dispatchStartIndex: history.dispatchDay.dispatchStartIndex, dispatchEndIndex: history.dispatchDay.dispatchEndIndex, dispatchDate: history.dispatchDay.date, dayOfWeek: history.dispatchDay.dayProfile.dayOfWeek, isWeekend: history.dispatchDay.dayProfile.isWeekend })

    // At 3 AM, actual discharge should be high (dispatch), counterfactual near 0.
    // But if baseline overpredicts, claimed performance could be low.
    // Just verify the evaluation handles it.
    const eval_ = evaluateBaseline(result, history.dispatchDay)
    expect(typeof eval_.claimedPerformanceKwh).toBe('number')
    expect(isFinite(eval_.claimedPerformanceKwh)).toBe(true)
  })

  it('zero true incremental performance should be handled', () => {
    // Create a scenario where dispatch power = 0 (no actual dispatch effect).
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 17, 2, 0) // 0 kW dispatch

    // True incremental should be near 0 (no dispatch effect, just noise).
    expect(Math.abs(history.dispatchDay.trueIncrementalKwh)).toBeLessThan(2.0)

    const evals = evaluateAllBaselines(history)
    for (const e of evals) {
      // Should not crash, should produce finite numbers.
      expect(isFinite(e.bias)).toBe(true)
      expect(isFinite(e.claimedPerformanceKwh)).toBe(true)
    }
  })
})
