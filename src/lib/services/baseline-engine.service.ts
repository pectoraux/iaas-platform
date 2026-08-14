// =============================================================================
// Baseline Engine — VPP-2: counterfactual load prediction.
//
// The baseline engine predicts what a DER asset WOULD have done without
// dispatch. The difference between actual and baseline = verified incremental
// performance (the economically payable quantity).
//
// Three baseline strategies are implemented:
//   1. SameTimeHistoricalBaseline — uses the same time window from past days
//   2. WeekdayWeekendAverageBaseline — averages similar days (same day-of-week)
//   3. RegressionBaseline — linear regression on temperature + day-of-week
//
// Each strategy is evaluated against known ground truth from the simulator
// to measure: bias, MAE, overpayment, underpayment.
//
// CRITICAL: this replaces the placeholder "baseline = 0" from VPP-1.
// The baseline engine is VPP-SPECIFIC (sits above the generic platform).
// It produces a derived contribution quantity via the existing generic
// Contribution mechanism (derivedQuantity + derivedUnit).
// =============================================================================

import type { DayProfile, LoadProfilePoint, DispatchDayGroundTruth } from './der-simulator.service'

export interface BaselineResult {
  method: string
  predictedCounterfactualKwh: number
  // Per-interval prediction (for detailed analysis).
  predictedProfile: LoadProfilePoint[]
}

export interface BaselineEvaluation {
  method: string
  trueCounterfactualKwh: number
  predictedCounterfactualKwh: number
  // Error metrics.
  bias: number              // predicted - true (positive = over-predict counterfactual → underpayment)
  absoluteError: number     // |predicted - true|
  signedError: number       // predicted - true
  // Economic consequences.
  claimedPerformanceKwh: number // actual - predicted (what the VPP claims as incremental)
  truePerformanceKwh: number   // actual - true (the real incremental)
  overpaymentKwh: number       // claimed - true (positive = operator overpaid)
  underpaymentKwh: number      // true - claimed (positive = operator underpaid)
  overpaymentPct: number       // overpayment / true * 100
  underpaymentPct: number
  // Classification.
  falsePositive: boolean    // claimed performance > 0 when true performance <= 0
  falseNegative: boolean    // claimed performance <= 0 when true performance > 0
}

// ---------------------------------------------------------------------------
// Baseline Strategy Interface
// ---------------------------------------------------------------------------

export interface BaselineStrategy {
  readonly name: string
  /**
   * Predict the counterfactual load for the dispatch window.
   * @param history Past day profiles (excluding dispatch day)
   * @param dispatchDay Ground truth for the dispatch day (contains window info)
   * @returns Baseline prediction (predicted counterfactual kWh + profile)
   */
  predict(history: DayProfile[], dispatchDay: DispatchDayGroundTruth): BaselineResult
}

// ---------------------------------------------------------------------------
// Strategy 1: Same-Time Historical Baseline
// ---------------------------------------------------------------------------

/**
 * Uses the same time window from each historical day.
 * Simple average of energy delivered during the dispatch window across all
 * historical days.
 *
 * This is the simplest baseline. It ignores day-of-week and weather.
 * It tends to have high bias when weekends differ from weekdays.
 */
export class SameTimeHistoricalBaseline implements BaselineStrategy {
  readonly name = 'same_time_historical'

  predict(history: DayProfile[], dispatchDay: DispatchDayGroundTruth): BaselineResult {
    const { dispatchStartIndex, dispatchEndIndex } = dispatchDay
    const windowEnergies: number[] = []

    for (const day of history) {
      let energy = 0
      for (let i = dispatchStartIndex; i < dispatchEndIndex && i < day.points.length; i++) {
        if (day.points[i].powerKw < 0) { // discharge
          energy += day.points[i].energyKwh
        }
      }
      windowEnergies.push(energy)
    }

    const predicted = windowEnergies.length > 0
      ? windowEnergies.reduce((a, b) => a + b, 0) / windowEnergies.length
      : 0

    // Build predicted profile (average of historical days).
    const predictedProfile: LoadProfilePoint[] = []
    for (let i = dispatchStartIndex; i < dispatchEndIndex; i++) {
      let sumPower = 0
      let count = 0
      for (const day of history) {
        if (i < day.points.length) {
          sumPower += day.points[i].powerKw
          count++
        }
      }
      const avgPower = count > 0 ? sumPower / count : 0
      predictedProfile.push({
        timestamp: dispatchDay.dayProfile.points[i]?.timestamp ?? new Date().toISOString(),
        powerKw: parseFloat(avgPower.toFixed(4)),
        energyKwh: parseFloat((Math.abs(avgPower) * 0.25).toFixed(4)),
      })
    }

    return {
      method: this.name,
      predictedCounterfactualKwh: parseFloat(predicted.toFixed(4)),
      predictedProfile,
    }
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: Similar-Day Average Baseline
// ---------------------------------------------------------------------------

/**
 * Averages only days with the same day-of-week as the dispatch day.
 * This accounts for the fact that weekday and weekend patterns differ.
 *
 * Typically has lower bias than same-time historical for mixed day types.
 */
export class WeekdayWeekendAverageBaseline implements BasaselineStrategy {
  readonly name = 'weekday_weekend_average'

  predict(history: DayProfile[], dispatchDay: DispatchDayGroundTruth): BaselineResult {
    const { dispatchStartIndex, dispatchEndIndex } = dispatchDay
    const dispatchDayOfWeek = dispatchDay.dayProfile.dayOfWeek

    // Filter to similar days (same weekday/weekend category).
    const isWeekend = dispatchDayOfWeek === 0 || dispatchDayOfWeek === 6
    const similarDays = history.filter(d => d.isWeekend === isWeekend)

    const windowEnergies: number[] = []
    for (const day of similarDays) {
      let energy = 0
      for (let i = dispatchStartIndex; i < dispatchEndIndex && i < day.points.length; i++) {
        if (day.points[i].powerKw < 0) {
          energy += day.points[i].energyKwh
        }
      }
      windowEnergies.push(energy)
    }

    const predicted = windowEnergies.length > 0
      ? windowEnergies.reduce((a, b) => a + b, 0) / windowEnergies.length
      : 0

    const predictedProfile: LoadProfilePoint[] = []
    for (let i = dispatchStartIndex; i < dispatchEndIndex; i++) {
      let sumPower = 0
      let count = 0
      for (const day of similarDays) {
        if (i < day.points.length) {
          sumPower += day.points[i].powerKw
          count++
        }
      }
      const avgPower = count > 0 ? sumPower / count : 0
      predictedProfile.push({
        timestamp: dispatchDay.dayProfile.points[i]?.timestamp ?? new Date().toISOString(),
        powerKw: parseFloat(avgPower.toFixed(4)),
        energyKwh: parseFloat((Math.abs(avgPower) * 0.25).toFixed(4)),
      })
    }

    return {
      method: this.name,
      predictedCounterfactualKwh: parseFloat(predicted.toFixed(4)),
      predictedProfile,
    }
  }
}

// ---------------------------------------------------------------------------
// Strategy 3: Regression Baseline (temperature + day-of-week adjusted)
// ---------------------------------------------------------------------------

/**
 * Simple linear regression: energy_in_window = a * temperature + b * isWeekend + c
 *
 * Fits the model on historical days, then predicts for the dispatch day.
 * This is the most sophisticated baseline — it adjusts for weather and schedule.
 *
 * In practice, real VPPs use more complex models (weather forecasts, load
 * forecasts, neural networks). This is a minimal but principled regression.
 */
export class RegressionBaseline implements BaselineStrategy {
  readonly name = 'regression'

  predict(history: DayProfile[], dispatchDay: DispatchDayGroundTruth): BaselineResult {
    const { dispatchStartIndex, dispatchEndIndex } = dispatchDay

    // Build training data: (temperature, isWeekend, energy) for each historical day.
    const trainingData: Array<{ temp: number; isWeekend: number; energy: number }> = []
    for (const day of history) {
      let energy = 0
      for (let i = dispatchStartIndex; i < dispatchEndIndex && i < day.points.length; i++) {
        if (day.points[i].powerKw < 0) {
          energy += day.points[i].energyKwh
        }
      }
      trainingData.push({
        temp: day.temperatureC,
        isWeekend: day.isWeekend ? 1 : 0,
        energy,
      })
    }

    if (trainingData.length < 3) {
      // Not enough data for regression — fall back to simple average.
      const fallback = new SameTimeHistoricalBaseline()
      const result = fallback.predict(history, dispatchDay)
      return { ...result, method: this.name + '_fallback' }
    }

    // Fit: energy = a * temp + b * isWeekend + c (ordinary least squares).
    const { a, b, c } = this.fitOLS(trainingData)

    // Predict for dispatch day.
    const dispatchTemp = dispatchDay.dayProfile.temperatureC
    const dispatchIsWeekend = dispatchDay.dayProfile.isWeekend ? 1 : 0
    const predicted = a * dispatchTemp + b * dispatchIsWeekend + c

    // Build predicted profile (scale historical average by predicted/mean ratio).
    const meanEnergy = trainingData.reduce((s, d) => s + d.energy, 0) / trainingData.length
    const scale = meanEnergy > 0 ? predicted / meanEnergy : 1

    const predictedProfile: LoadProfilePoint[] = []
    for (let i = dispatchStartIndex; i < dispatchEndIndex; i++) {
      let sumPower = 0
      let count = 0
      for (const day of history) {
        if (i < day.points.length) {
          sumPower += day.points[i].powerKw
          count++
        }
      }
      const avgPower = count > 0 ? (sumPower / count) * scale : 0
      predictedProfile.push({
        timestamp: dispatchDay.dayProfile.points[i]?.timestamp ?? new Date().toISOString(),
        powerKw: parseFloat(avgPower.toFixed(4)),
        energyKwh: parseFloat((Math.abs(avgPower) * 0.25).toFixed(4)),
      })
    }

    return {
      method: this.name,
      predictedCounterfactualKwh: parseFloat(Math.max(0, predicted).toFixed(4)),
      predictedProfile,
    }
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

    // Solve: energy = a * temp + b * isWeekend + c
    // Normal equations: X'X * [a,b,c]' = X'y
    // X'X = [[sumTT, sumTW, sumT], [sumTW, sumWW, sumW], [sumT, sumW, n]]
    // X'y = [sumTE, sumWE, sumE]
    const XTX = [[sumTT, sumTW, sumT], [sumTW, sumWW, sumW], [sumT, sumW, n]]
    const XTy = [sumTE, sumWE, sumE]

    const det = this.det3(XTX)
    if (Math.abs(det) < 1e-10) {
      const mean = sumE / n
      return { a: 0, b: 0, c: mean }
    }

    // Cramer's rule: replace column i with XTy.
    const a = this.det3(this.replaceCol(XTX, 0, XTy)) / det
    const b = this.det3(this.replaceCol(XTX, 1, XTy)) / det
    const c = this.det3(this.replaceCol(XTX, 2, XTy)) / det

    return { a, b, c }
  }

  private replaceCol(matrix: number[][], col: number, vec: number[]): number[][] {
    return matrix.map((row, i) => row.map((val, j) => j === col ? vec[i] : val))
  }

  private det3(m: number[][]): number {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
         - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
         + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  }
}

// ---------------------------------------------------------------------------
// Evaluation Harness
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
  const bias = signedError // positive bias = over-predicting counterfactual → underpaying
  const absoluteError = Math.abs(signedError)

  // Overpayment: operator claims MORE than they actually delivered.
  const overpaymentKwh = Math.max(0, claimedPerf - truePerf)
  // Underpayment: operator delivered MORE than they were paid for.
  const underpaymentKwh = Math.max(0, truePerf - claimedPerf)

  return {
    method: baseline.method,
    trueCounterfactualKwh: trueCf,
    predictedCounterfactualKwh: predictedCf,
    bias: parseFloat(bias.toFixed(4)),
    absoluteError: parseFloat(absoluteError.toFixed(4)),
    signedError: parseFloat(signedError.toFixed(4)),
    claimedPerformanceKwh: parseFloat(claimedPerf.toFixed(4)),
    truePerformanceKwh: parseFloat(truePerf.toFixed(4)),
    overpaymentKwh: parseFloat(overpaymentKwh.toFixed(4)),
    underpaymentKwh: parseFloat(underpaymentKwh.toFixed(4)),
    overpaymentPct: truePerf > 0 ? parseFloat((overpaymentKwh / truePerf * 100).toFixed(2)) : 0,
    underpaymentPct: truePerf > 0 ? parseFloat((underpaymentKwh / truePerf * 100).toFixed(2)) : 0,
    falsePositive: claimedPerf > 0 && truePerf <= 0,
    falseNegative: claimedPerf <= 0 && truePerf > 0,
  }
}

export function evaluateAllBaselines(
  history: { days: DayProfile[]; dispatchDay: DispatchDayGroundTruth },
): BaselineEvaluation[] {
  const strategies: BaselineStrategy[] = [
    new SameTimeHistoricalBaseline(),
    new WeekdayWeekendAverageBaseline(),
    new RegressionBaseline(),
  ]

  return strategies.map(s => {
    const result = s.predict(history.days, history.dispatchDay)
    return evaluateBaseline(result, history.dispatchDay)
  })
}
