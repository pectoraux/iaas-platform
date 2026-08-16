// =============================================================================
// DER History Simulator — generates synthetic load histories with KNOWN ground truth.
//
// FIX: The simulator now accepts an explicit dispatch date and derives
// per-asset deterministic seeds from the assetId + date, so different
// assets get uncorrelated histories.
//
// Each day is generated as a LatentBaseDay (fixed temperature + noise),
// then counterfactual = base day, treatment = same base + dispatch overlay.
// =============================================================================

export interface LoadProfilePoint {
  timestamp: string
  powerKw: number
  energyKwh: number
}

export interface DayProfile {
  date: string
  dayOfWeek: number
  isWeekend: boolean
  temperatureC: number
  points: LoadProfilePoint[]
  totalEnergyKwh: number
  peakPowerKw: number
}

interface LatentBaseDay {
  date: Date
  dayOfWeek: number
  isWeekend: boolean
  temperatureC: number
  basePoints: LoadProfilePoint[]
}

export interface DispatchDayGroundTruth {
  date: string
  dispatchStartIndex: number
  dispatchEndIndex: number
  trueCounterfactualKwh: number
  actualWithDispatchKwh: number
  trueIncrementalKwh: number
  dayProfile: DayProfile
  counterfactualProfile: DayProfile
}

export interface SyntheticHistory {
  days: DayProfile[]
  dispatchDay: DispatchDayGroundTruth
}

export class DERHistorySimulator {
  private rng: () => number

  constructor(seed = 42) {
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
   * Derive a deterministic seed from assetId + date.
   * Different assets get different (but reproducible) histories.
   */
  static deriveSeed(assetId: string, date: Date): number {
    const dateStr = date.toISOString().split('T')[0]
    let hash = 0
    const str = `${assetId}:${dateStr}`
    for (let i = 0; i < str.length; i++) {
      hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0
    }
    return Math.abs(hash) || 1
  }

  /**
   * Generate history where the dispatch day is the supplied dispatchDate
   * (not new Date()). Historical days precede dispatchDate.
   */
  generateHistory(
    numDays: number,
    dispatchHour: number,
    dispatchDurationHours: number,
    dispatchPowerKw: number,
    dispatchDate?: Date, // explicit dispatch date (defaults to today for backward compat)
  ): SyntheticHistory {
    const today = dispatchDate ?? new Date()
    const days: DayProfile[] = []

    // Historical days precede the dispatch date.
    for (let i = numDays; i >= 1; i--) {
      const date = new Date(today)
      date.setDate(date.getDate() - i)
      const baseDay = this.generateLatentBaseDay(date)
      days.push(this.latentToProfile(baseDay))
    }

    // Dispatch day = the supplied date.
    const dispatchBaseDay = this.generateLatentBaseDay(today)
    const dispatchStartIndex = dispatchHour * 4
    const dispatchEndIndex = Math.min(95, dispatchStartIndex + dispatchDurationHours * 4)

    const counterfactualProfile = this.latentToProfile(dispatchBaseDay)

    const treatmentPoints = dispatchBaseDay.basePoints.map((p, i) => {
      if (i >= dispatchStartIndex && i < dispatchEndIndex) {
        const efficiency = Math.max(0.85, 1.0 - (dispatchBaseDay.temperatureC - 20) * 0.005)
        const dispatchPower = -dispatchPowerKw * efficiency
        return {
          ...p,
          powerKw: dispatchPower,
          energyKwh: Math.abs(dispatchPower) * 0.25,
        }
      }
      return p
    })
    const treatmentProfile = this.latentToProfile({ ...dispatchBaseDay, basePoints: treatmentPoints })

    const trueCounterfactualKwh = this.sumDischargeEnergy(counterfactualProfile.points, dispatchStartIndex, dispatchEndIndex)
    const actualWithDispatchKwh = this.sumDischargeEnergy(treatmentProfile.points, dispatchStartIndex, dispatchEndIndex)
    const trueIncrementalKwh = actualWithDispatchKwh - trueCounterfactualKwh

    return {
      days,
      dispatchDay: {
        date: today.toISOString().split('T')[0],
        dispatchStartIndex,
        dispatchEndIndex,
        trueCounterfactualKwh,
        actualWithDispatchKwh,
        trueIncrementalKwh,
        dayProfile: treatmentProfile,
        counterfactualProfile,
      },
    }
  }

  private generateLatentBaseDay(date: Date): LatentBaseDay {
    const dayOfWeek = date.getDay()
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
    const temperatureC = 15 + this.rng() * 20
    const efficiency = Math.max(0.85, 1.0 - (temperatureC - 20) * 0.005)

    const noise: number[] = []
    for (let i = 0; i < 96; i++) {
      noise.push((this.rng() - 0.5) * 0.5)
    }

    const basePoints: LoadProfilePoint[] = []
    for (let i = 0; i < 96; i++) {
      const hour = i / 4
      let powerKw = this.getBaseLoad(hour, isWeekend, efficiency)
      powerKw += noise[i]
      const energyKwh = Math.abs(powerKw) * 0.25
      const timestamp = new Date(date)
      timestamp.setHours(Math.floor(hour), (i % 4) * 15, 0, 0)
      basePoints.push({ timestamp: timestamp.toISOString(), powerKw: parseFloat(powerKw.toFixed(4)), energyKwh: parseFloat(energyKwh.toFixed(4)) })
    }

    return { date, dayOfWeek, isWeekend, temperatureC, basePoints }
  }

  private getBaseLoad(hour: number, isWeekend: boolean, efficiency: number): number {
    let powerKw: number
    if (hour >= 10 && hour < 15) {
      const solarIntensity = Math.sin(((hour - 10) / 5) * Math.PI)
      powerKw = (3 + 0.5) * solarIntensity * efficiency
    } else if (hour >= 18 && hour < 21) {
      const eveningPeak = Math.sin(((hour - 18) / 3) * Math.PI)
      powerKw = -(2.5 + 0.3) * eveningPeak * efficiency
    } else if (hour >= 0 && hour < 6) {
      powerKw = 0.2
    } else if (hour >= 6 && hour < 10) {
      powerKw = 0.5
    } else if (hour >= 15 && hour < 18) {
      powerKw = 0.8
    } else {
      powerKw = 0.3
    }
    if (isWeekend) {
      if (hour >= 10 && hour < 16) powerKw *= 1.3
      if (hour >= 18 && hour < 21) powerKw *= 0.7
    }
    return powerKw
  }

  private latentToProfile(base: LatentBaseDay): DayProfile {
    let totalEnergy = 0
    let peakPower = 0
    for (const p of base.basePoints) {
      totalEnergy += p.energyKwh
      peakPower = Math.max(peakPower, Math.abs(p.powerKw))
    }
    return {
      date: base.date.toISOString().split('T')[0],
      dayOfWeek: base.dayOfWeek,
      isWeekend: base.isWeekend,
      temperatureC: parseFloat(base.temperatureC.toFixed(1)),
      points: base.basePoints,
      totalEnergyKwh: parseFloat(totalEnergy.toFixed(4)),
      peakPowerKw: parseFloat(peakPower.toFixed(4)),
    }
  }

  private sumDischargeEnergy(points: LoadProfilePoint[], start: number, end: number): number {
    let sum = 0
    for (let i = start; i < end && i < points.length; i++) {
      if (points[i].powerKw < 0) sum += points[i].energyKwh
    }
    return parseFloat(sum.toFixed(4))
  }
}
