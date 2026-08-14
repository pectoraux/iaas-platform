// =============================================================================
// DER History Simulator — generates synthetic load histories with KNOWN ground truth.
//
// VPP-2 FIX: The simulator now generates ONE latent base day per date,
// then derives both the counterfactual (no dispatch) and treatment (dispatch)
// profiles from the SAME base. This ensures the only intentional difference
// between counterfactual and actual is the dispatch effect itself.
//
// Previous bug: two separate generateDayProfile() calls produced different
// temperatures and noise, contaminating trueIncrementalKwh.
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

// A latent base day contains the deterministic + stochastic inputs that
// define a day's behavior, BEFORE dispatch is applied.
interface LatentBaseDay {
  date: Date
  dayOfWeek: number
  isWeekend: boolean
  temperatureC: number
  // The base load profile WITHOUT dispatch (the counterfactual).
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
   * Generate a synthetic history of a residential battery.
   *
   * FIX: Each day is generated as a LatentBaseDay (fixed temperature + noise),
   * then the counterfactual profile IS the base day, and the treatment profile
   * is the same base day with dispatch overlaid. The only difference is dispatch.
   */
  generateHistory(
    numDays: number,
    dispatchHour: number = 17,
    dispatchDurationHours: number = 2,
    dispatchPowerKw: number = 5,
  ): SyntheticHistory {
    const days: DayProfile[] = []
    const today = new Date()

    // Generate historical days (each as a latent base day → profile).
    for (let i = numDays; i >= 1; i--) {
      const date = new Date(today)
      date.setDate(date.getDate() - i)
      const baseDay = this.generateLatentBaseDay(date)
      days.push(this.latentToProfile(baseDay))
    }

    // Generate the dispatch day as ONE latent base day.
    const dispatchDate = new Date(today)
    const dispatchBaseDay = this.generateLatentBaseDay(dispatchDate)

    const dispatchStartIndex = dispatchHour * 4
    const dispatchEndIndex = Math.min(95, dispatchStartIndex + dispatchDurationHours * 4)

    // Counterfactual profile = base day with NO dispatch (just the latent base).
    const counterfactualProfile = this.latentToProfile(dispatchBaseDay)

    // Treatment profile = SAME base day + dispatch overlay.
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
    const treatmentBaseDay: LatentBaseDay = {
      ...dispatchBaseDay,
      basePoints: treatmentPoints,
    }
    const treatmentProfile = this.latentToProfile(treatmentBaseDay)

    // Calculate ground truth (the ONLY difference is dispatch).
    const trueCounterfactualKwh = this.sumDischargeEnergy(
      counterfactualProfile.points, dispatchStartIndex, dispatchEndIndex,
    )
    const actualWithDispatchKwh = this.sumDischargeEnergy(
      treatmentProfile.points, dispatchStartIndex, dispatchEndIndex,
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
        dayProfile: treatmentProfile,
        counterfactualProfile,
      },
    }
  }

  /**
   * Generate a latent base day: fixed temperature, fixed noise sequence,
   * and the load profile that results from the underlying behavioral model
   * (solar charging, evening discharge, etc.) WITHOUT any dispatch.
   */
  private generateLatentBaseDay(date: Date): LatentBaseDay {
    const dayOfWeek = date.getDay()
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
    const temperatureC = 15 + this.rng() * 20
    const efficiency = Math.max(0.85, 1.0 - (temperatureC - 20) * 0.005)

    // Pre-generate the noise sequence for this day (FIX: same noise for both
    // counterfactual and treatment — the only difference is dispatch).
    const noise: number[] = []
    for (let i = 0; i < 96; i++) {
      noise.push((this.rng() - 0.5) * 0.5)
    }

    const basePoints: LoadProfilePoint[] = []
    for (let i = 0; i < 96; i++) {
      const hour = i / 4
      let powerKw = this.getBaseLoad(hour, isWeekend, efficiency)

      // Apply the pre-generated noise (same for counterfactual and treatment).
      powerKw += noise[i]

      const energyKwh = Math.abs(powerKw) * 0.25

      const timestamp = new Date(date)
      timestamp.setHours(Math.floor(hour), (i % 4) * 15, 0, 0)

      basePoints.push({
        timestamp: timestamp.toISOString(),
        powerKw: parseFloat(powerKw.toFixed(4)),
        energyKwh: parseFloat(energyKwh.toFixed(4)),
      })
    }

    return { date, dayOfWeek, isWeekend, temperatureC, basePoints }
  }

  /**
   * The underlying behavioral model: what the battery does based on time of day,
   * day type, and efficiency. This is the SAME for counterfactual and treatment
   * (dispatch is applied separately as an overlay).
   */
  private getBaseLoad(hour: number, isWeekend: boolean, efficiency: number): number {
    let powerKw: number

    if (hour >= 10 && hour < 15) {
      const solarIntensity = Math.sin(((hour - 10) / 5) * Math.PI)
      powerKw = (3 + 0.5) * solarIntensity * efficiency // deterministic component
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

  /**
   * Convert a latent base day to a full DayProfile (with totals).
   */
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

  /**
   * Sum discharge energy (negative power = energy delivered to grid) in a window.
   */
  private sumDischargeEnergy(points: LoadProfilePoint[], start: number, end: number): number {
    let sum = 0
    for (let i = start; i < end && i < points.length; i++) {
      if (points[i].powerKw < 0) {
        sum += points[i].energyKwh
      }
    }
    return parseFloat(sum.toFixed(4))
  }
}
