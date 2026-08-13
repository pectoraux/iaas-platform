// =============================================================================
// DER Adapter Interface — VPP-specific device abstraction.
//
// The VPP orchestration calls this interface. The simulated adapter generates
// normalized telemetry. Future real adapters (Tesla, Enphase, SolarEdge,
// ChargePoint) implement the same interface.
//
// The adapter does NOT bypass the generic pipeline — it produces telemetry
// that flows through generic Event → Verification → Attestation → Contribution.
// =============================================================================

export interface DERTelemetry {
  payload: Record<string, unknown>
  // The capability this telemetry is for (must match the asset's assignment).
  capabilityType: string
}

export interface DERDischargeResult {
  telemetry: DERTelemetry
  // The actual energy delivered (kWh) — used for baseline calculation.
  actualKwh: string
  actualKw: string
  // State of charge after discharge (for batteries).
  stateOfChargePct?: number
}

export interface DERAdapter {
  readonly adapterType: string // 'simulated' | 'tesla' | 'enphase' | ...

  /**
   * Execute a discharge command and return normalized telemetry.
   * The adapter is responsible for:
   *   1. Communicating with the physical device (or simulating it)
   *   2. Generating normalized telemetry matching the capability schema
   *   3. Returning the actual energy/power values for baseline calculation
   */
  executeDischarge(input: {
    assignedKw: string
    assignedKwh: string
    capabilityType: string
    durationSeconds: number
  }): Promise<DERDischargeResult>
}

// ---------------------------------------------------------------------------
// Simulated DER Adapter
// ---------------------------------------------------------------------------

/**
 * Simulated adapter for testing. Generates telemetry with ~98% efficiency.
 * No real hardware communication — just deterministic values.
 */
export class SimulatedDERAdapter implements DERAdapter {
  readonly adapterType = 'simulated'

  async executeDischarge(input: {
    assignedKw: string
    assignedKwh: string
    capabilityType: string
    durationSeconds: number
  }): Promise<DERDischargeResult> {
    const assignedKwh = new Prisma.Decimal(input.assignedKwh)
    const assignedKw = new Prisma.Decimal(input.assignedKw)
    const efficiency = new Prisma.Decimal('0.98')

    const actualKwh = assignedKwh.times(efficiency)
    const actualKw = assignedKw.times(efficiency)
    const stateOfChargePct = 65 // simulated post-discharge SoC

    // Generate telemetry payload matching the capability schema.
    let payload: Record<string, unknown>
    if (input.capabilityType === 'energy_discharge') {
      payload = {
        power_kw: parseFloat(actualKw.toString()),
        available_energy_kwh: parseFloat(actualKwh.toString()),
        state_of_charge_pct: stateOfChargePct,
      }
    } else if (input.capabilityType === 'frequency_response') {
      payload = {
        frequency_hz: 49.8,
        response_kw: parseFloat(actualKw.toString()),
        duration_seconds: input.durationSeconds,
      }
    } else if (input.capabilityType === 'energy_capacity') {
      payload = {
        capacity_kwh: parseFloat(assignedKwh.toString()),
        available_kwh: parseFloat(actualKwh.toString()),
        reserved_kwh: 0,
      }
    } else {
      // Generic fallback — use the first numeric values.
      payload = {
        output_value: parseFloat(actualKwh.toString()),
        duration_seconds: input.durationSeconds,
      }
    }

    return {
      telemetry: {
        payload,
        capabilityType: input.capabilityType,
      },
      actualKwh: actualKwh.toString(),
      actualKw: actualKw.toString(),
      stateOfChargePct,
    }
  }
}

import { Prisma } from '@prisma/client'
