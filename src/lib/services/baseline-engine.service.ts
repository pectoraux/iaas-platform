// =============================================================================
// Baseline Engine — VPP-2: counterfactual load prediction.
//
// VPP-2C FIXES:
// 1. Split BaselineContext (production input) from GroundTruthMetadata (eval only)
// 2. Strategy selection with quantitative acceptance criteria
// 3. Persisted BaselinePolicy (versioned, associated with NetworkVersion)
// 4. No negative performance payments: max(0, actual - baseline)
// =============================================================================

import type { DayProfile, LoadProfilePoint, DispatchDayGroundTruth } from './der-simulator.service'

export interface BaselineResult {
  method: string
  predictedCounterfactualKwh: number
  predictedProfile: LoadProfilePoint[]
}

export interface BaselineEvaluation {
  method: string
  trueCounterfactualKwh: number
  predictedCounterfactualKwh: number
  bias: number
  absoluteError: number
  signedError: number
  claimedPerformanceKwh: number
  truePerformanceKwh: number
  overpaymentKwh: number
  underpaymentKwh: number
  overpaymentPct: number
  underpaymentPct: number
  falsePositive: boolean
  falseNegative: boolean
}

// ---------------------------------------------------------------------------
// BaselineContext — PRODUCTION input for baseline prediction.
// Contains ONLY observable context: dispatch window, day-of-week, date.
// NEVER contains ground truth (trueCounterfactual, trueIncremental, etc.).
// ---------------------------------------------------------------------------

export interface BaselineContext {
  dispatchStartIndex: number
  dispatchEndIndex: number
  dispatchDate: string
  dayOfWeek: number
  isWeekend: boolean
  // Optional observable covariates (temperature, etc.)
  temperatureC?: number
}

// ---------------------------------------------------------------------------
// BaselinePolicy — persisted, versioned strategy selection.
// Associated with NetworkVersion configuration.
// ---------------------------------------------------------------------------

export interface BaselineAcceptanceCriteria {
  maxMae: number
  maxAbsBias: number
  maxP95Error: number
  maxFalsePositiveRate: number
  maxFalseNegativeRate: number
  maxOverpaymentPct: number
  maxUnderpaymentPct: number
}

export interface BaselinePolicy {
  selectedStrategy: string
  evaluationId: string
  evaluatedAt: string
  criteria: BaselineAcceptanceCriteria
  metrics: {
    mae: number
    bias: number
    p95Error: number
    falsePositiveRate: number
    falseNegativeRate: number
    overpaymentPct: number
    underpaymentPct: number
  }
  status: 'accepted' | 'rejected' | 'no_acceptable_strategy'
}

export const DEFAULT_ACCEPTANCE_CRITERIA: BaselineAcceptanceCriteria = {
  maxMae: 3.0,           // kWh — max acceptable MAE
  maxAbsBias: 1.5,       // kWh — max acceptable absolute bias
  maxP95Error: 5.0,      // kWh — max acceptable P95 absolute error
  maxFalsePositiveRate: 0.15,  // 15%
  maxFalseNegativeRate: 0.15,  // 15%
  maxOverpaymentPct: 30,       // 30%
  maxUnderpaymentPct: 30,      // 30%
}

// ---------------------------------------------------------------------------
// Baseline Strategy Interface — now takes BaselineContext (not ground truth)
// ---------------------------------------------------------------------------

export interface BaselineStrategy {
  readonly name: string
  predict(history: DayProfile[], context: BaselineContext): BaselineResult
}

// ---------------------------------------------------------------------------
// Strategy 1: Same-Time Historical Baseline
// ---------------------------------------------------------------------------

export class SameTimeHistoricalBaseline implements BaselineStrategy {
  readonly name = 'same_time_historical'

  predict(history: DayProfile[], context: BaselineContext): BaselineResult {
    const { dispatchStartIndex, dispatchEndIndex } = context
    const windowEnergies: number[] = []

    for (const day of history) {
      let energy = 0
      for (let i = dispatchStartIndex; i < dispatchEndIndex && i < day.points.length; i++) {
        if (day.points[i].powerKw < 0) energy += day.points[i].energyKwh
      }
      windowEnergies.push(energy)
    }

    const predicted = windowEnergies.length > 0
      ? windowEnergies.reduce((a, b) => a + b, 0) / windowEnergies.length
      : 0

    const predictedProfile: LoadProfilePoint[] = []
    for (let i = dispatchStartIndex; i < dispatchEndIndex; i++) {
      let sumPower = 0, count = 0
      for (const day of history) {
        if (i < day.points.length) { sumPower += day.points[i].powerKw; count++ }
      }
      const avgPower = count > 0 ? sumPower / count : 0
      predictedProfile.push({
        timestamp: new Date(context.dispatchDate + 'T00:00:00Z').toISOString(),
        powerKw: parseFloat(avgPower.toFixed(4)),
        energyKwh: parseFloat((Math.abs(avgPower) * 0.25).toFixed(4)),
      })
    }

    return { method: this.name, predictedCounterfactualKwh: parseFloat(predicted.toFixed(4)), predictedProfile }
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: Weekday/Weekend Average Baseline
// ---------------------------------------------------------------------------

export class WeekdayWeekendAverageBaseline implements BaselineStrategy {
  readonly name = 'weekday_weekend_average'

  predict(history: DayProfile[], context: BaselineContext): BaselineResult {
    const { dispatchStartIndex, dispatchEndIndex, isWeekend } = context
    const similarDays = history.filter(d => d.isWeekend === isWeekend)

    const windowEnergies: number[] = []
    for (const day of similarDays) {
      let energy = 0
      for (let i = dispatchStartIndex; i < dispatchEndIndex && i < day.points.length; i++) {
        if (day.points[i].powerKw < 0) energy += day.points[i].energyKwh
      }
      windowEnergies.push(energy)
    }

    const predicted = windowEnergies.length > 0
      ? windowEnergies.reduce((a, b) => a + b, 0) / windowEnergies.length
      : 0

    const predictedProfile: LoadProfilePoint[] = []
    for (let i = dispatchStartIndex; i < dispatchEndIndex; i++) {
      let sumPower = 0, count = 0
      for (const day of similarDays) {
        if (i < day.points.length) { sumPower += day.points[i].powerKw; count++ }
      }
      const avgPower = count > 0 ? sumPower / count : 0
      predictedProfile.push({
        timestamp: new Date(context.dispatchDate + 'T00:00:00Z').toISOString(),
        powerKw: parseFloat(avgPower.toFixed(4)),
        energyKwh: parseFloat((Math.abs(avgPower) * 0.25).toFixed(4)),
      })
    }

    return { method: this.name, predictedCounterfactualKwh: parseFloat(predicted.toFixed(4)), predictedProfile }
  }
}

// ---------------------------------------------------------------------------
// Strategy 3: Regression Baseline
// ---------------------------------------------------------------------------

export class RegressionBaseline implements BaselineStrategy {
  readonly name = 'regression'

  predict(history: DayProfile[], context: BaselineContext): BaselineResult {
    const { dispatchStartIndex, dispatchEndIndex } = context

    const trainingData: Array<{ temp: number; isWeekend: number; energy: number }> = []
    for (const day of history) {
      let energy = 0
      for (let i = dispatchStartIndex; i < dispatchEndIndex && i < day.points.length; i++) {
        if (day.points[i].powerKw < 0) energy += day.points[i].energyKwh
      }
      trainingData.push({ temp: day.temperatureC, isWeekend: day.isWeekend ? 1 : 0, energy })
    }

    if (trainingData.length < 3) {
      const fallback = new SameTimeHistoricalBaseline()
      const result = fallback.predict(history, context)
      return { ...result, method: this.name + '_fallback' }
    }

    const { a, b, c } = this.fitOLS(trainingData)
    const dispatchTemp = context.temperatureC ?? 20
    const dispatchIsWeekend = context.isWeekend ? 1 : 0
    const predicted = a * dispatchTemp + b * dispatchIsWeekend + c

    const meanEnergy = trainingData.reduce((s, d) => s + d.energy, 0) / trainingData.length
    const scale = meanEnergy > 0 ? predicted / meanEnergy : 1

    const predictedProfile: LoadProfilePoint[] = []
    for (let i = dispatchStartIndex; i < dispatchEndIndex; i++) {
      let sumPower = 0, count = 0
      for (const day of history) {
        if (i < day.points.length) { sumPower += day.points[i].powerKw; count++ }
      }
      const avgPower = count > 0 ? (sumPower / count) * scale : 0
      predictedProfile.push({
        timestamp: new Date(context.dispatchDate + 'T00:00:00Z').toISOString(),
        powerKw: parseFloat(avgPower.toFixed(4)),
        energyKwh: parseFloat((Math.abs(avgPower) * 0.25).toFixed(4)),
      })
    }

    return { method: this.name, predictedCounterfactualKwh: parseFloat(Math.max(0, predicted).toFixed(4)), predictedProfile }
  }

  private fitOLS(data: Array<{ temp: number; isWeekend: number; energy: number }>): { a: number; b: number; c: number } {
    const n = data.length
    const sumT = data.reduce((s, d) => s + d.temp, 0)
    const sumW = data.reduce((s, d) => s + d.isWeekend, 0)
    const sumE = data.reduce((s, d) => s + d.energy, 0)
    const sumTT = data.reduce((s, d) => s + d.temp * d.temp, 0)
    const sumWW = data.reduce((s, d) => s + d.isWeekend * d.isWeekend, 0)
    const sumTW = data.reduce((s, d) => s + d.temp * d.isWeekend, 0)
    const sumTE = data.reduce((s, d) => s + d.temp * d.energy, 0)
    const sumWE = data.reduce((s, d) => s + d.isWeekend * d.energy, 0)

    const XTX = [[sumTT, sumTW, sumT], [sumTW, sumWW, sumW], [sumT, sumW, n]]
    const XTy = [sumTE, sumWE, sumE]
    const det = this.det3(XTX)
    if (Math.abs(det) < 1e-10) return { a: 0, b: 0, c: sumE / n }

    return {
      a: this.det3(this.replaceCol(XTX, 0, XTy)) / det,
      b: this.det3(this.replaceCol(XTX, 1, XTy)) / det,
      c: this.det3(this.replaceCol(XTX, 2, XTy)) / det,
    }
  }

  private replaceCol(m: number[][], col: number, v: number[]): number[][] {
    return m.map((row, i) => row.map((val, j) => j === col ? v[i] : val))
  }

  private det3(m: number[][]): number {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
         - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
         + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  }
}

// ---------------------------------------------------------------------------
// Strategy Registry — resolve strategy by name from persisted policy
// ---------------------------------------------------------------------------

const STRATEGY_REGISTRY: Record<string, BaselineStrategy> = {
  'same_time_historical': new SameTimeHistoricalBaseline(),
  'weekday_weekend_average': new WeekdayWeekendAverageBaseline(),
  'regression': new RegressionBaseline(),
}

export function getStrategy(name: string): BaselineStrategy | null {
  return STRATEGY_REGISTRY[name] ?? null
}

export function getAllStrategies(): BaselineStrategy[] {
  return Object.values(STRATEGY_REGISTRY)
}

// ---------------------------------------------------------------------------
// Evaluation Harness (uses ground truth — for evaluation ONLY, not production)
// ---------------------------------------------------------------------------

export function evaluateBaseline(
  baseline: BaselineResult,
  groundTruth: DispatchDayGroundTruth,
): BaselineEvaluation {
  const trueCf = groundTruth.trueCounterfactualKwh
  const predictedCf = baseline.predictedCounterfactualKwh
  const actual = groundTruth.actualWithDispatchKwh
  const truePerf = actual - trueCf
  const claimedPerf = actual - predictedCf
  const signedError = predictedCf - trueCf

  return {
    method: baseline.method,
    trueCounterfactualKwh: trueCf,
    predictedCounterfactualKwh: predictedCf,
    bias: parseFloat(signedError.toFixed(4)),
    absoluteError: parseFloat(Math.abs(signedError).toFixed(4)),
    signedError: parseFloat(signedError.toFixed(4)),
    claimedPerformanceKwh: parseFloat(claimedPerf.toFixed(4)),
    truePerformanceKwh: parseFloat(truePerf.toFixed(4)),
    overpaymentKwh: parseFloat(Math.max(0, claimedPerf - truePerf).toFixed(4)),
    underpaymentKwh: parseFloat(Math.max(0, truePerf - claimedPerf).toFixed(4)),
    overpaymentPct: truePerf > 0 ? parseFloat((Math.max(0, claimedPerf - truePerf) / truePerf * 100).toFixed(2)) : 0,
    underpaymentPct: truePerf > 0 ? parseFloat((Math.max(0, truePerf - claimedPerf) / truePerf * 100).toFixed(2)) : 0,
    falsePositive: claimedPerf > 0 && truePerf <= 0,
    falseNegative: claimedPerf <= 0 && truePerf > 0,
  }
}

// ---------------------------------------------------------------------------
// Strategy Selection — evaluates all strategies and selects the best eligible one
// ---------------------------------------------------------------------------

export interface StrategySelectionResult {
  policy: BaselinePolicy
  allMetrics: Array<{ method: string; mae: number; bias: number; p95: number; fpRate: number; fnRate: number; overpayPct: number; underpayPct: number }>
}

export function selectBaselineStrategy(
  evaluations: Record<string, BaselineEvaluation[]>,
  criteria: BaselineAcceptanceCriteria = DEFAULT_ACCEPTANCE_CRITERIA,
): StrategySelectionResult {
  const N = evaluations[Object.keys(evaluations)[0]]?.length ?? 0
  const allMetrics: StrategySelectionResult['allMetrics'] = []
  const eligible: Array<{ name: string; mae: number; metrics: any }> = []

  for (const [method, evals] of Object.entries(evaluations)) {
    const mae = evals.reduce((s, e) => s + e.absoluteError, 0) / N
    const bias = evals.reduce((s, e) => s + e.bias, 0) / N
    const p95Errors = evals.map(e => e.absoluteError).sort((a, b) => a - b)
    const p95 = p95Errors[Math.floor(N * 0.95)] ?? 0
    const fpRate = evals.filter(e => e.falsePositive).length / N
    const fnRate = evals.filter(e => e.falseNegative).length / N
    const overpayPct = evals.filter(e => e.truePerformanceKwh > 0).reduce((s, e) => s + e.overpaymentPct, 0) / N
    const underpayPct = evals.filter(e => e.truePerformanceKwh > 0).reduce((s, e) => s + e.underpaymentPct, 0) / N

    const metrics = { mae, bias, p95, fpRate, fnRate, overpayPct, underpayPct }
    allMetrics.push({ method, ...metrics })

    // Check eligibility.
    if (
      mae <= criteria.maxMae &&
      Math.abs(bias) <= criteria.maxAbsBias &&
      p95 <= criteria.maxP95Error &&
      fpRate <= criteria.maxFalsePositiveRate &&
      fnRate <= criteria.maxFalseNegativeRate &&
      overpayPct <= criteria.maxOverpaymentPct &&
      underpayPct <= criteria.maxUnderpaymentPct
    ) {
      eligible.push({ name: method, mae, metrics })
    }
  }

  // Select lowest MAE among eligible.
  if (eligible.length === 0) {
    return {
      policy: {
        selectedStrategy: '',
        evaluationId: `eval-${Date.now()}`,
        evaluatedAt: new Date().toISOString(),
        criteria,
        metrics: { mae: 0, bias: 0, p95Error: 0, falsePositiveRate: 0, falseNegativeRate: 0, overpaymentPct: 0, underpaymentPct: 0 },
        status: 'no_acceptable_strategy',
      },
      allMetrics,
    }
  }

  const best = eligible.reduce((min, r) => r.mae < min.mae ? r : min)
  return {
    policy: {
      selectedStrategy: best.name,
      evaluationId: `eval-${Date.now()}`,
      evaluatedAt: new Date().toISOString(),
      criteria,
      metrics: best.metrics,
      status: 'accepted',
    },
    allMetrics,
  }
}

// ---------------------------------------------------------------------------
// evaluateAllBaselines — convenience: run all strategies on one history
// (uses ground truth for evaluation — NOT for production baseline)
// ---------------------------------------------------------------------------

export function evaluateAllBaselines(
  history: { days: DayProfile[]; dispatchDay: DispatchDayGroundTruth },
): BaselineEvaluation[] {
  const strategies = getAllStrategies()
  const context: BaselineContext = {
    dispatchStartIndex: history.dispatchDay.dispatchStartIndex,
    dispatchEndIndex: history.dispatchDay.dispatchEndIndex,
    dispatchDate: history.dispatchDay.date,
    dayOfWeek: history.dispatchDay.dayProfile.dayOfWeek,
    isWeekend: history.dispatchDay.dayProfile.isWeekend,
    temperatureC: history.dispatchDay.dayProfile.temperatureC,
  }
  return strategies.map(s => {
    const result = s.predict(history.days, context)
    return evaluateBaseline(result, history.dispatchDay)
  })
}
