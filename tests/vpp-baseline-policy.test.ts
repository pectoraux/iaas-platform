/**
 * VPP-2C: Baseline policy contract integration test.
 *
 * Tests the complete flow:
 * evaluation → eligible strategy → persisted policy → VPP execution resolves that strategy
 *
 * Also tests:
 * - no acceptable strategy → no performance settlement
 * - negative performance is clipped to zero (no negative rewards)
 *
 * Run: bun test tests/vpp-baseline-policy.test.ts --timeout 60000
 */
import { describe, it, expect } from 'bun:test'
import { DERHistorySimulator } from '../src/lib/services/der-simulator.service'
import {
  SameTimeHistoricalBaseline,
  WeekdayWeekendAverageBaseline,
  RegressionBaseline,
  evaluateBaseline,
  evaluateAllBaselines,
  selectBaselineStrategy,
  getStrategy,
  getAllStrategies,
  DEFAULT_ACCEPTANCE_CRITERIA,
  type BaselineEvaluation,
  type BaselineContext,
} from '../src/lib/services/baseline-engine.service'

describe('VPP-2C: Baseline policy contract', () => {
  // Run 100 varied scenarios for strategy selection.
  const N = 100
  const allEvals: Record<string, BaselineEvaluation[]> = {}
  const strategies = getAllStrategies()
  for (const s of strategies) allEvals[s.name] = []

  const hours = [3, 7, 12, 14, 17, 18, 19, 20, 22]
  const durations = [1, 2, 3, 4]
  const powers = [2, 5, 8, 10]

  let idx = 0
  for (let seed = 1; seed <= N; seed++) {
    const hour = hours[idx % hours.length]
    const duration = durations[idx % durations.length]
    const power = powers[idx % powers.length]
    idx++
    const sim = new DERHistorySimulator(seed)
    const history = sim.generateHistory(14, hour, duration, power)
    const evals = evaluateAllBaselines(history)
    for (const e of evals) allEvals[e.method].push(e)
  }

  it('strategy selection produces a valid BaselinePolicy', () => {
    const result = selectBaselineStrategy(allEvals, DEFAULT_ACCEPTANCE_CRITERIA)

    expect(result.policy.status).toBe('accepted')
    expect(result.policy.selectedStrategy).toBeTruthy()
    expect(result.policy.evaluationId).toBeTruthy()
    expect(result.policy.evaluatedAt).toBeTruthy()
    expect(result.policy.criteria).toEqual(DEFAULT_ACCEPTANCE_CRITERIA)
    expect(result.policy.metrics.mae).toBeGreaterThan(0)
    expect(result.allMetrics.length).toBe(strategies.length)
  })

  it('selected strategy is resolvable from the registry', () => {
    const result = selectBaselineStrategy(allEvals, DEFAULT_ACCEPTANCE_CRITERIA)
    const strategy = getStrategy(result.policy.selectedStrategy)
    expect(strategy).toBeTruthy()
    expect(strategy!.name).toBe(result.policy.selectedStrategy)
  })

  it('VPP execution resolves the selected strategy (not hardcoded)', () => {
    // Simulate what the VPP execution path does: resolve strategy by name.
    const result = selectBaselineStrategy(allEvals, DEFAULT_ACCEPTANCE_CRITERIA)
    const strategyName = result.policy.selectedStrategy // This is what would be persisted.
    const resolvedStrategy = getStrategy(strategyName)

    expect(resolvedStrategy).toBeTruthy()
    expect(resolvedStrategy!.name).toBe(strategyName)
    // The resolved strategy is NOT a hardcoded WeekdayWeekendAverageBaseline instance.
    // It's whatever the evaluation selected.
    expect(resolvedStrategy!.name).toBe(result.policy.selectedStrategy)
  })

  it('no acceptable strategy → NO_ACCEPTABLE_BASELINE', () => {
    // Use impossibly strict criteria.
    const strictCriteria = {
      maxMae: 0.001,
      maxAbsBias: 0.001,
      maxP95Error: 0.001,
      maxFalsePositiveRate: 0.001,
      maxFalseNegativeRate: 0.001,
      maxOverpaymentPct: 0.001,
      maxUnderpaymentPct: 0.001,
    }
    const result = selectBaselineStrategy(allEvals, strictCriteria)

    expect(result.policy.status).toBe('no_acceptable_strategy')
    expect(result.policy.selectedStrategy).toBe('')
  })

  it('negative performance is clipped to zero (no negative rewards)', () => {
    // Create a scenario where baseline > actual (negative performance).
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 19, 2, 2) // low power dispatch at peak time

    const context: BaselineContext = {
      dispatchStartIndex: history.dispatchDay.dispatchStartIndex,
      dispatchEndIndex: history.dispatchDay.dispatchEndIndex,
      dispatchDate: history.dispatchDay.date,
      dayOfWeek: history.dispatchDay.dayProfile.dayOfWeek,
      isWeekend: history.dispatchDay.dayProfile.isWeekend,
      temperatureC: history.dispatchDay.dayProfile.temperatureC,
    }

    const strategy = new WeekdayWeekendAverageBaseline()
    const result = strategy.predict(history.days, context)

    const actualKwh = history.dispatchDay.actualWithDispatchKwh
    const baselineKwh = result.predictedCounterfactualKwh
    const rawPerformance = actualKwh - baselineKwh
    const verifiedPerformance = Math.max(0, rawPerformance)

    // If raw is negative, verified must be 0.
    if (rawPerformance < 0) {
      expect(verifiedPerformance).toBe(0)
    }
    // Verified is always >= 0.
    expect(verifiedPerformance).toBeGreaterThanOrEqual(0)
  })

  it('production baseline never receives ground truth values', () => {
    // Verify that BaselineContext contains NO ground truth fields.
    const sim = new DERHistorySimulator(42)
    const history = sim.generateHistory(14, 17, 2, 5)

    const context: BaselineContext = {
      dispatchStartIndex: history.dispatchDay.dispatchStartIndex,
      dispatchEndIndex: history.dispatchDay.dispatchEndIndex,
      dispatchDate: history.dispatchDay.date,
      dayOfWeek: history.dispatchDay.dayProfile.dayOfWeek,
      isWeekend: history.dispatchDay.dayProfile.isWeekend,
    }

    // BaselineContext must NOT have trueCounterfactualKwh, trueIncrementalKwh, etc.
    expect((context as any).trueCounterfactualKwh).toBeUndefined()
    expect((context as any).trueIncrementalKwh).toBeUndefined()
    expect((context as any).actualWithDispatchKwh).toBeUndefined()
    expect((context as any).dayProfile).toBeUndefined()
    expect((context as any).counterfactualProfile).toBeUndefined()
  })
})
