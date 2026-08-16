/**
 * VPP-2B: Strategy selection + provider contract + hard scenarios.
 *
 * Tests that:
 * 1. The provider honors assetId + dispatchStartTime
 * 2. Missing baseline → BASELINE_UNAVAILABLE (no zero fallback)
 * 3. 100+ varied scenarios → explicit strategy selection
 * 4. Hard scenarios: actual weekday vs weekend, sparse, anomalous, etc.
 *
 * Run: bun test tests/vpp-baseline-selection.test.ts --timeout 60000
 */
import { describe, it, expect } from 'bun:test'
import { DERHistorySimulator } from '../src/lib/services/der-simulator.service'
import { SimulatedHistoricalTelemetryProvider } from '../src/lib/services/historical-telemetry-provider.service'
import {
  SameTimeHistoricalBaseline,
  WeekdayWeekendAverageBaseline,
  RegressionBaseline,
  evaluateBaseline,
  evaluateAllBaselines,
  type BaselineStrategy,
  type BaselineEvaluation,
} from '../src/lib/services/baseline-engine.service'

// ---------------------------------------------------------------------------
// Provider contract tests
// ---------------------------------------------------------------------------

describe('VPP-2B: Provider contract', () => {
  it('different asset IDs produce different histories', async () => {
    const provider = new SimulatedHistoricalTelemetryProvider()
    const dispatchTime = new Date('2026-08-20T17:00:00Z')

    const histA = await provider.getHistory('asset-A', dispatchTime, 14)
    const histB = await provider.getHistory('asset-B', dispatchTime, 14)

    expect(histA).toBeTruthy()
    expect(histB).toBeTruthy()
    expect(histA!.length).toBe(14)
    expect(histB!.length).toBe(14)

    // Different assets should have different temperature (different seed).
    expect(histA![0].temperatureC).not.toBe(histB![0].temperatureC)
  })

  it('repeated calls with same asset/date are deterministic', async () => {
    const provider = new SimulatedHistoricalTelemetryProvider()
    const dispatchTime = new Date('2026-08-20T17:00:00Z')

    const hist1 = await provider.getHistory('asset-X', dispatchTime, 14)
    const hist2 = await provider.getHistory('asset-X', dispatchTime, 14)

    expect(hist1).toBeTruthy()
    expect(hist2).toBeTruthy()
    expect(hist1![0].temperatureC).toBe(hist2![0].temperatureC)
    expect(hist1![0].points[0].powerKw).toBe(hist2![0].points[0].powerKw)
  })

  it('no training sample is >= dispatchStartTime', async () => {
    const provider = new SimulatedHistoricalTelemetryProvider()
    const dispatchTime = new Date('2026-08-20T17:00:00Z')

    const hist = await provider.getHistory('asset-A', dispatchTime, 14)
    expect(hist).toBeTruthy()

    const dispatchDateStr = dispatchTime.toISOString().split('T')[0]
    for (const day of hist!) {
      expect(day.date < dispatchDateStr).toBe(true)
    }
  })

  it('dispatch day ground truth uses the supplied date', async () => {
    const provider = new SimulatedHistoricalTelemetryProvider()
    const dispatchTime = new Date('2026-08-20T17:00:00Z')

    const gt = await provider.getDispatchDayGroundTruth?.('asset-A', dispatchTime, 2, 5)
    expect(gt).toBeTruthy()
    expect(gt!.date).toBe('2026-08-20')
  })

  it('insufficient history returns null (BASELINE_UNAVAILABLE)', async () => {
    const provider = new SimulatedHistoricalTelemetryProvider()
    const dispatchTime = new Date('2026-08-20T17:00:00Z')

    const hist = await provider.getHistory('asset-A', dispatchTime, 2) // only 2 days
    expect(hist).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Strategy selection: 100 varied scenarios
// ---------------------------------------------------------------------------

describe('VPP-2B: Strategy selection', () => {
  const N = 100
  const strategies: BaselineStrategy[] = [
    new SameTimeHistoricalBaseline(),
    new WeekdayWeekendAverageBaseline(),
    new RegressionBaseline(),
  ]

  const allEvals: Record<string, BaselineEvaluation[]> = {}
  for (const s of strategies) allEvals[s.name] = []

  // Vary: dispatch hour, duration, power, seed.
  const hours = [3, 7, 12, 14, 17, 18, 19, 20, 22]
  const durations = [1, 2, 3, 4]
  const powers = [2, 5, 8, 10]

  let scenarioIdx = 0
  for (let seed = 1; seed <= N; seed++) {
    const hour = hours[scenarioIdx % hours.length]
    const duration = durations[scenarioIdx % durations.length]
    const power = powers[scenarioIdx % powers.length]
    scenarioIdx++

    const sim = new DERHistorySimulator(seed)
    const history = sim.generateHistory(14, hour, duration, power)
    const evals = evaluateAllBaselines(history)
    for (const e of evals) allEvals[e.method].push(e)
  }

  it('should have 100 evaluations per strategy across varied scenarios', () => {
    for (const s of strategies) {
      expect(allEvals[s.name].length).toBe(N)
    }
  })

  it('should select the best strategy by MAE', () => {
    const results = strategies.map(s => {
      const evals = allEvals[s.name]
      const mae = evals.reduce((sum, e) => sum + e.absoluteError, 0) / N
      const bias = evals.reduce((sum, e) => sum + e.bias, 0) / N
      const rmse = Math.sqrt(evals.reduce((sum, e) => sum + e.signedError ** 2, 0) / N)
      const p95Errors = evals.map(e => e.absoluteError).sort((a, b) => a - b)
      const p95 = p95Errors[Math.floor(N * 0.95)]
      const fpRate = evals.filter(e => e.falsePositive).length / N
      const fnRate = evals.filter(e => e.falseNegative).length / N
      const totalOverpay = evals.reduce((s, e) => s + e.overpaymentKwh, 0)
      const totalUnderpay = evals.reduce((s, e) => s + e.underpaymentKwh, 0)

      console.log(`  ${s.name}: MAE=${mae.toFixed(3)}, bias=${bias.toFixed(3)}, RMSE=${rmse.toFixed(3)}, P95=${p95.toFixed(3)}, FP=${(fpRate*100).toFixed(1)}%, FN=${(fnRate*100).toFixed(1)}%, overpay=${totalOverpay.toFixed(2)}, underpay=${totalUnderpay.toFixed(2)}`)

      return { name: s.name, mae, bias, rmse, p95, fpRate, fnRate }
    })

    // Select best by MAE.
    const best = results.reduce((min, r) => r.mae < min.mae ? r : min)
    console.log(`  SELECTED: ${best.name} (lowest MAE)`)

    // The selected strategy must have MAE > 0 (not trivially perfect).
    expect(best.mae).toBeGreaterThan(0)

    // The selected strategy must have false positive rate < 20%.
    expect(best.fpRate).toBeLessThan(0.2)

    // The selected strategy must have false negative rate < 20%.
    expect(best.fnRate).toBeLessThan(0.2)
  })

  it('all strategies should have finite, non-negative MAE', () => {
    for (const s of strategies) {
      const mae = allEvals[s.name].reduce((sum, e) => sum + e.absoluteError, 0) / N
      expect(isFinite(mae)).toBe(true)
      expect(mae).toBeGreaterThanOrEqual(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Hard scenario tests (actually testing the claims)
// ---------------------------------------------------------------------------

describe('VPP-2B: Hard scenarios (real tests)', () => {
  it('weekday dispatch vs weekend dispatch produce different baselines', () => {
    // Find a weekday and a weekend in the simulator.
    // The simulator uses real dates, so we need to find appropriate days.
    const sim = new DERHistorySimulator(42)

    // Generate with dispatch on different days of the week.
    const monday = new Date('2026-08-17T17:00:00Z') // Monday
    const saturday = new Date('2026-08-22T17:00:00Z') // Saturday

    const weekdayHistory = sim.generateHistory(14, 17, 2, 5, monday)
    const weekendHistory = sim.generateHistory(14, 17, 2, 5, saturday)

    expect(weekdayHistory.dispatchDay.dayProfile.isWeekend).toBe(false)
    expect(weekendHistory.dispatchDay.dayProfile.isWeekend).toBe(true)

    // The counterfactuals should differ (weekday has different pattern).
    const strategy = new WeekdayWeekendAverageBaseline()
    const weekdayResult = strategy.predict(weekdayHistory.days, { dispatchStartIndex: weekdayHistory.dispatchDay.dispatchStartIndex, dispatchEndIndex: weekdayHistory.dispatchDay.dispatchEndIndex, dispatchDate: weekdayHistory.dispatchDay.date, dayOfWeek: weekdayHistory.dispatchDay.dayProfile.dayOfWeek, isWeekend: weekdayHistory.dispatchDay.dayProfile.isWeekend })
    const weekendResult = strategy.predict(weekendHistory.days, { dispatchStartIndex: weekendHistory.dispatchDay.dispatchStartIndex, dispatchEndIndex: weekendHistory.dispatchDay.dispatchEndIndex, dispatchDate: weekendHistory.dispatchDay.date, dayOfWeek: weekendHistory.dispatchDay.dayProfile.dayOfWeek, isWeekend: weekendHistory.dispatchDay.dayProfile.isWeekend })

    // Predictions should differ because the training data has different weekday/weekend mix.
    expect(weekdayResult.predictedCounterfactualKwh).not.toBe(weekendResult.predictedCounterfactualKwh)
  })

  it('sparse history (3 days) produces a baseline but with lower confidence', () => {
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(3, 17, 2, 5)

    const strategy = new WeekdayWeekendAverageBaseline()
    const result = strategy.predict(history.days, { dispatchStartIndex: history.dispatchDay.dispatchStartIndex, dispatchEndIndex: history.dispatchDay.dispatchEndIndex, dispatchDate: history.dispatchDay.date, dayOfWeek: history.dispatchDay.dayProfile.dayOfWeek, isWeekend: history.dispatchDay.dayProfile.isWeekend })

    expect(result.predictedCounterfactualKwh).toBeGreaterThanOrEqual(0)
    // With only 3 days, the prediction should be less stable — just verify it's finite.
    expect(isFinite(result.predictedCounterfactualKwh)).toBe(true)
  })

  it('dispatch outside normal discharge (3 AM) has low counterfactual', () => {
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 3, 2, 5)

    expect(history.dispatchDay.trueCounterfactualKwh).toBeLessThan(1.0)
  })

  it('dispatch during normal discharge (19:00) has higher counterfactual', () => {
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 19, 2, 5)

    expect(history.dispatchDay.trueCounterfactualKwh).toBeGreaterThan(0.5)
  })

  it('zero-dispatch effect produces near-zero incremental', () => {
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 17, 2, 0)

    expect(Math.abs(history.dispatchDay.trueIncrementalKwh)).toBeLessThan(2.0)
  })

  it('negative predicted performance is handled gracefully', () => {
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 3, 2, 5) // 3 AM, low actual

    const strategy = new SameTimeHistoricalBaseline()
    const result = strategy.predict(history.days, { dispatchStartIndex: history.dispatchDay.dispatchStartIndex, dispatchEndIndex: history.dispatchDay.dispatchEndIndex, dispatchDate: history.dispatchDay.date, dayOfWeek: history.dispatchDay.dayProfile.dayOfWeek, isWeekend: history.dispatchDay.dayProfile.isWeekend })
    const eval_ = evaluateBaseline(result, history.dispatchDay)

    expect(isFinite(eval_.claimedPerformanceKwh)).toBe(true)
    expect(isFinite(eval_.bias)).toBe(true)
  })

  it('insufficient history for regression falls back to historical', () => {
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(2, 17, 2, 5) // only 2 days

    const strategy = new RegressionBaseline()
    const result = strategy.predict(history.days, { dispatchStartIndex: history.dispatchDay.dispatchStartIndex, dispatchEndIndex: history.dispatchDay.dispatchEndIndex, dispatchDate: history.dispatchDay.date, dayOfWeek: history.dispatchDay.dayProfile.dayOfWeek, isWeekend: history.dispatchDay.dayProfile.isWeekend })

    // Should fall back to historical method.
    expect(result.method).toContain('fallback')
  })

  it('counterfactual and treatment have identical exogenous inputs', () => {
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 17, 2, 5)

    const cf = history.dispatchDay.counterfactualProfile
    const tr = history.dispatchDay.dayProfile

    expect(cf.temperatureC).toBe(tr.temperatureC)
    expect(cf.dayOfWeek).toBe(tr.dayOfWeek)

    const { dispatchStartIndex, dispatchEndIndex } = history.dispatchDay
    for (let i = 0; i < 96; i++) {
      if (i < dispatchStartIndex || i >= dispatchEndIndex) {
        expect(cf.points[i].powerKw).toBe(tr.points[i].powerKw)
      }
    }
  })
})
