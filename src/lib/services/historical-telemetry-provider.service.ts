// =============================================================================
// Historical Telemetry Provider — abstraction for loading asset telemetry history.
//
// FIX: The provider now honors assetId and dispatchStartTime:
// - Different assets get different (but deterministic) histories via per-asset seeds
// - The dispatch date is the supplied dispatchStartTime (not new Date())
// - Training data is strictly before dispatchStartTime
// - Repeated calls with same asset/date are deterministic
//
// If required historical data is unavailable, returns null (BASELINE_UNAVAILABLE).
// =============================================================================

import type { DayProfile, DispatchDayGroundTruth } from './der-simulator.service'
import { DERHistorySimulator } from './der-simulator.service'

export interface HistoricalTelemetryProvider {
  /**
   * Get historical day profiles for an asset, strictly before the dispatch event.
   * Returns null if insufficient historical data is available.
   */
  getHistory(
    assetId: string,
    dispatchStartTime: Date,
    numDays: number,
  ): Promise<DayProfile[] | null>

  /**
   * Get the dispatch day's ground truth (for evaluation/auditability).
   * Returns null if unavailable.
   */
  getDispatchDayGroundTruth?(
    assetId: string,
    dispatchStartTime: Date,
    dispatchDurationHours: number,
    dispatchPowerKw: number,
  ): Promise<DispatchDayGroundTruth | null>
}

// ---------------------------------------------------------------------------
// Simulated provider — per-asset deterministic histories.
// ---------------------------------------------------------------------------

export class SimulatedHistoricalTelemetryProvider implements HistoricalTelemetryProvider {
  async getHistory(
    assetId: string,
    dispatchStartTime: Date,
    numDays: number,
  ): Promise<DayProfile[] | null> {
    if (numDays < 3) return null // minimum history requirement

    // Derive a per-asset seed so different assets get uncorrelated histories.
    const seed = DERHistorySimulator.deriveSeed(assetId, dispatchStartTime)
    const simulator = new DERHistorySimulator(seed)

    const dispatchHour = dispatchStartTime.getHours()
    const history = simulator.generateHistory(
      numDays,
      dispatchHour,
      2, // duration hours (not used for history, only for dispatch day)
      5, // power (not used for history)
      dispatchStartTime, // explicit dispatch date
    )

    // Verify no training sample is >= dispatchStartTime.
    const dispatchDateStr = dispatchStartTime.toISOString().split('T')[0]
    const validDays = history.days.filter(d => d.date < dispatchDateStr)

    if (validDays.length < 3) return null

    return validDays
  }

  async getDispatchDayGroundTruth(
    assetId: string,
    dispatchStartTime: Date,
    dispatchDurationHours: number,
    dispatchPowerKw: number,
  ): Promise<DispatchDayGroundTruth | null> {
    const seed = DERHistorySimulator.deriveSeed(assetId, dispatchStartTime)
    const simulator = new DERHistorySimulator(seed)

    const dispatchHour = dispatchStartTime.getHours()
    const history = simulator.generateHistory(
      14,
      dispatchHour,
      dispatchDurationHours,
      dispatchPowerKw,
      dispatchStartTime, // explicit dispatch date
    )

    return history.dispatchDay
  }
}
