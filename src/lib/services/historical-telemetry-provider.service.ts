// =============================================================================
// Historical Telemetry Provider — abstraction for loading asset telemetry history.
//
// This is the seam between the VPP baseline engine and the actual data source.
// In production, this would query TimescaleDB or the event history table.
// For the MVP, the SimulatedHistoricalTelemetryProvider generates synthetic
// data using the DERHistorySimulator.
//
// CRITICAL: the provider returns ONLY data strictly before the dispatch event.
// Dispatch-day actual data is never included in baseline training data.
// =============================================================================

import type { DayProfile, DispatchDayGroundTruth } from './der-simulator.service'
import { DERHistorySimulator } from './der-simulator.service'

export interface HistoricalTelemetryProvider {
  /**
   * Get historical day profiles for an asset, strictly before the dispatch event.
   * This data is used for baseline TRAINING only — never includes dispatch-day actuals.
   *
   * @param assetId The asset to get history for
   * @param dispatchStartTime The start of the dispatch event (cutoff for training data)
   * @param numDays Number of historical days to retrieve
   * @returns Array of DayProfile objects, each strictly before dispatchStartTime
   */
  getHistory(
    assetId: string,
    dispatchStartTime: Date,
    numDays: number,
  ): Promise<DayProfile[]>

  /**
   * Get the dispatch day's ground truth (for evaluation purposes).
   * In production, this would be the verified telemetry from the dispatch day.
   * For the simulator, it returns the known ground truth.
   *
   * @param assetId The asset
   * @param dispatchStartTime Start of dispatch
   * @param dispatchDurationHours Duration
   * @param dispatchPowerKw Power
   */
  getDispatchDayGroundTruth?(
    assetId: string,
    dispatchStartTime: Date,
    dispatchDurationHours: number,
    dispatchPowerKw: number,
  ): Promise<DispatchDayGroundTruth | null>
}

// ---------------------------------------------------------------------------
// Simulated provider — uses DERHistorySimulator with a fixed seed per asset.
// ---------------------------------------------------------------------------

export class SimulatedHistoricalTelemetryProvider implements HistoricalTelemetryProvider {
  private simulator: DERHistorySimulator

  constructor(seed = 42) {
    this.simulator = new DERHistorySimulator(seed)
  }

  async getHistory(
    _assetId: string,
    _dispatchStartTime: Date,
    numDays: number,
  ): Promise<DayProfile[]> {
    // Generate a full history (including dispatch day), then return only
    // the historical days (excluding the dispatch day).
    const history = this.simulator.generateHistory(numDays, 17, 2, 5)
    return history.days // days[] excludes the dispatch day
  }

  async getDispatchDayGroundTruth(
    _assetId: string,
    dispatchStartTime: Date,
    dispatchDurationHours: number,
    dispatchPowerKw: number,
  ): Promise<DispatchDayGroundTruth | null> {
    const dispatchHour = dispatchStartTime.getHours()
    const history = this.simulator.generateHistory(
      14, // numDays (must match what getHistory would use)
      dispatchHour,
      dispatchDurationHours,
      dispatchPowerKw,
    )
    return history.dispatchDay
  }
}
