// =============================================================================
// DER History Simulator — generates synthetic load histories with KNOWN ground truth.
//
// This is the foundation of VPP-2: instead of using real telemetry (which we
// don't have), we generate synthetic histories where we KNOW what the asset
// would have done without dispatch. This lets us measure baseline accuracy
// against true counterfactuals.
//
// The simulator generates:
//   1. Historical load profiles (what the battery did on past days)
//   2. A "true counterfactual" for the dispatch day (what it WOULD have done)
//   3. An "actual with dispatch" profile (what it DID do during dispatch)
//
// The baseline strategies then predict the counterfactual from history.
// We compare: predicted_counterfactual vs true_counterfactual
//             → baseline bias, MAE, over/underpayment
// =============================================================================

import { Prisma } from '@prisma/client'

export interface LoadProfilePoint {
  timestamp: string // ISO
  powerKw: number   // signed: positive = charging/drawing from grid, negative = discharging
  energyKwh: number // cumulative energy in this interval
}

export interface DayProfile {
  date: string         // YYYY-MM-DD
  dayOfWeek: number    // 0=Sunday ... 6=Saturday
  isWeekend: boolean
  temperatureC: number // ambient temperature (affects battery efficiency)
  points: LoadProfilePoint[] // 96 points (15-min intervals for 24h)
  totalEnergyKwh: number
  peakPowerKw: number
}

export interface DispatchDayGroundTruth {
  date: string
  dispatchStartIndex: number  // 15-min interval index (0-95)
  dispatchEndIndex: number
  // The TRUE counterfactual: what the battery would have done without dispatch.
  trueCounterfactualKwh: number
  // What the battery actually did during the dispatch window WITH dispatch.
  actualWithDispatchKwh: number
  // The TRUE incremental performance (actual - counterfactual).
  trueIncrementalKwh: number
  // The full day profile (with dispatch applied).
  dayProfile: DayProfile
  // The counterfactual profile (without dispatch).
  counterfactualProfile: DayProfile
}

export interface SyntheticHistory {
  days: DayProfile[]
  dispatchDay: DispatchDayGroundTruth
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

export class DERHistorySimulator {
  private rng: () => number

  constructor(seed = 42) {
    // Simple seeded PRNG (mulberry32).
    let s = seed
    this.rng = () => {
      s |= 0
      s = (s + 0x6D2B79F5) | 0
      let t = Math.imul(s ^ (s >>> 15), 1 | s)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  /**
   * Generate a synthetic history of a residential battery.
   *
   * Model:
   *   - Charges from solar during the day (10:00-15:00)
   *   - Discharges during evening peak (18:00-21:00)
   *   - Weekend patterns are different (more midday usage)
   *   - Temperature affects efficiency
   *   - Random noise on each interval
   *
   * @param numDays Number of historical days to generate (before dispatch day)
   * @param dispatchHour Hour of dispatch (e.g. 17 for 5 PM)
   * @param dispatchDurationHours Duration of dispatch in hours
   * @param dispatchPowerKw Power requested during dispatch
   */
  generateHistory(
    numDays: number,
    dispatchHour: number = 17,
    dispatchDurationHours: number = 2,
    dispatchPowerKw: number = 5,
  ): SyntheticHistory {
    const days: DayProfile[] = []
    const today = new Date()

    // Generate historical days (before dispatch day).
    for (let i = numDays; i >= 1; i--) {
      const date = new Date(today)
      date.setDate(date.getDate() - i)
      days.push(this.generateDayProfile(date, false, 0, 0, 0))
    }

    // Generate the dispatch day with known counterfactual.
    const dispatchDate = new Date(today)
    const dispatchStartIndex = dispatchHour * 4 // 15-min intervals
    const dispatchEndIndex = Math.min(95, dispatchStartIndex + dispatchDurationHours * 4)

    // First, generate the counterfactual (what would have happened without dispatch).
    const counterfactualProfile = this.generateDayProfile(dispatchDate, false, 0, 0, 0)

    // Then, generate the actual profile WITH dispatch overlaid.
    const actualProfile = this.generateDayProfile(dispatchDate, true, dispatchStartIndex, dispatchEndIndex, dispatchPowerKw)

    // Calculate ground truth values.
    const trueCounterfactualKwh = this.sumEnergyInWindow(
      counterfactualProfile.points, dispatchStartIndex, dispatchEndIndex,
    )
    const actualWithDispatchKwh = this.sumEnergyInWindow(
      actualProfile.points, dispatchStartIndex, dispatchEndIndex,
    )
    const trueIncrementalKwh = actualWithDispatchKwh - trueCounterfactualKwh

    return {
      days,
      dispatchDay: {
        date: dispatchDate.toISOString().split('T')[0],
        dispatchStartIndex,
        dispatchEndIndex,
        trueCounterfactualKwh,
        actualWithDispatchKwh,
        trueIncrementalKwh,
        dayProfile: actualProfile,
        counterfactualProfile,
      },
    }
  }

  private generateDayProfile(
    date: Date,
    isDispatchDay: boolean,
    dispatchStart: number,
    dispatchEnd: number,
    dispatchPowerKw: number,
  ): DayProfile {
    const dayOfWeek = date.getDay()
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
    const temperatureC = 15 + this.rng() * 20 // 15-35°C
    const efficiency = Math.max(0.85, 1.0 - (temperatureC - 20) * 0.005) // ~95-100% at 20°C

    const points: LoadProfilePoint[] = []
    let totalEnergy = 0
    let peakPower = 0

    for (let i = 0; i < 96; i++) {
      const hour = i / 4
      let powerKw = 0

      // Solar charging: 10:00-15:00 (indices 40-60)
      if (hour >= 10 && hour < 15) {
        const solarIntensity = Math.sin(((hour - 10) / 5) * Math.PI) // bell curve
        powerKw = (3 + this.rng() * 2) * solarIntensity * efficiency
      }
      // Evening discharge: 18:00-21:00 (indices 72-84)
      else if (hour >= 18 && hour < 21) {
        const eveningPeak = Math.sin(((hour - 18) / 3) * Math.PI)
        powerKw = -(2.5 + this.rng() * 1.5) * eveningPeak * efficiency
      }
      // Overnight: minimal
      else if (hour >= 0 && hour < 6) {
        powerKw = 0.2 + this.rng() * 0.3
      }
      // Morning: moderate
      else if (hour >= 6 && hour < 10) {
        powerKw = 0.5 + this.rng() * 0.8
      }
      // Afternoon: moderate
      else if (hour >= 15 && hour < 18) {
        powerKw = 0.8 + this.rng() * 0.5
      }
      // Late evening: low
      else {
        powerKw = 0.3 + this.rng() * 0.4
      }

      // Weekend adjustment: more midday usage, less evening peak.
      if (isWeekend) {
        if (hour >= 10 && hour < 16) powerKw *= 1.3
        if (hour >= 18 && hour < 21) powerKw *= 0.7
      }

      // Apply dispatch override.
      if (isDispatchDay && i >= dispatchStart && i < dispatchEnd) {
        powerKw = -dispatchPowerKw * efficiency // discharge at dispatch power
      }

      // Add noise.
      powerKw += (this.rng() - 0.5) * 0.5

      const energyKwh = Math.abs(powerKw) * 0.25 // 15-min interval
      totalEnergy += energyKwh
      peakPower = Math.max(peakPower, Math.abs(powerKw))

      const timestamp = new Date(date)
      timestamp.setHours(Math.floor(hour), (i % 4) * 15, 0, 0)

      points.push({
        timestamp: timestamp.toISOString(),
        powerKw: parseFloat(powerKw.toFixed(4)),
        energyKwh: parseFloat(energyKwh.toFixed(4)),
      })
    }

    return {
      date: date.toISOString().split('T')[0],
      dayOfWeek,
      isWeekend,
      temperatureC: parseFloat(temperatureC.toFixed(1)),
      points,
      totalEnergyKwh: parseFloat(totalEnergy.toFixed(4)),
      peakPowerKw: parseFloat(peakPower.toFixed(4)),
    }
  }

  private sumEnergyInWindow(points: LoadProfilePoint[], start: number, end: number): number {
    let sum = 0
    for (let i = start; i < end && i < points.length; i++) {
      // Only count discharge (negative power = energy delivered to grid).
      if (points[i].powerKw < 0) {
        sum += points[i].energyKwh
      }
    }
    return parseFloat(sum.toFixed(4))
  }
}
