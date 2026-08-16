// =============================================================================
// DER Adapter — VPP-specific physical device abstraction.
//
// Phase 6: This adapter implements the generic InfrastructureAdapter interface
// from the kernel. The AdapterRegistry resolves it for energy assets. VPP
// does NOT import or instantiate this adapter directly — it goes through the
// InfrastructureRuntime, which resolves the adapter via the registry.
//
// The adapter does NOT bypass the generic pipeline — it produces telemetry
// that flows through generic Event → Verification → Attestation → Contribution.
// =============================================================================

import { Prisma } from '@prisma/client'
import type {
  InfrastructureAdapter,
  ExecuteCommand,
  ExecuteResult,
  AssetCapabilities,
  TelemetryReading,
  HealthStatus,
} from '@/lib/kernel/adapters/infrastructure-adapter'

// ---------------------------------------------------------------------------
// VPP-specific result types (for backward compat with existing code)
// ---------------------------------------------------------------------------

export interface DERTelemetry {
  payload: Record<string, unknown>
  capabilityType: string
}

export interface DERDischargeResult {
  telemetry: DERTelemetry
  actualKwh: string
  actualKw: string
  stateOfChargePct?: number
}

// ---------------------------------------------------------------------------
// Simulated DER Adapter — implements the generic InfrastructureAdapter
// ---------------------------------------------------------------------------

/**
 * Simulated adapter for testing. Generates telemetry with ~98% efficiency.
 * No real hardware communication — just deterministic values.
 *
 * Phase 6: Implements the generic InfrastructureAdapter interface. The
 * AdapterRegistry resolves this adapter for energy assets (battery,
 * solar_inverter, ev_charger, smart_meter).
 */
export class SimulatedDERAdapter implements InfrastructureAdapter {
  readonly adapterType = 'simulated_der'

  /**
   * Execute a discharge command and return normalized telemetry.
   * This is the generic InfrastructureAdapter.execute() implementation.
   */
  async execute(command: ExecuteCommand): Promise<ExecuteResult> {
    const assignedKwh = new Prisma.Decimal(command.assignedQuantity)
    const assignedKw = new Prisma.Decimal(command.parameters?.assignedKw as string ?? command.assignedQuantity)
    const efficiency = new Prisma.Decimal('0.98')

    const actualKwh = assignedKwh.times(efficiency)
    const actualKw = assignedKw.times(efficiency)
    const stateOfChargePct = 65 // simulated post-discharge SoC

    // Generate telemetry payload matching the capability schema.
    let payload: Record<string, unknown>
    if (command.capabilityType === 'energy_discharge') {
      payload = {
        power_kw: parseFloat(actualKw.toString()),
        available_energy_kwh: parseFloat(actualKwh.toString()),
        state_of_charge_pct: stateOfChargePct,
      }
    } else if (command.capabilityType === 'frequency_response') {
      payload = {
        frequency_hz: 49.8,
        response_kw: parseFloat(actualKw.toString()),
        duration_seconds: command.durationSeconds,
      }
    } else if (command.capabilityType === 'energy_capacity') {
      payload = {
        capacity_kwh: parseFloat(assignedKwh.toString()),
        available_kwh: parseFloat(actualKwh.toString()),
        reserved_kwh: 0,
      }
    } else {
      // Generic fallback.
      payload = {
        output_value: parseFloat(actualKwh.toString()),
        duration_seconds: command.durationSeconds,
      }
    }

    return {
      assetId: command.assetId,
      actualQuantity: actualKwh.toString(),
      actualUnit: 'kWh',
      telemetry: {
        payload,
      },
      success: true,
    }
  }

  async discover(): Promise<AssetCapabilities[]> {
    // Simulated — no real discovery.
    return []
  }

  async getCapabilities(assetId: string): Promise<AssetCapabilities> {
    return {
      assetId,
      capabilities: [
        { type: 'energy_discharge', unit: 'kWh', maxCapacity: '100' },
      ],
      health: 'healthy',
    }
  }

  async readTelemetry(assetId: string, capabilityType: string): Promise<TelemetryReading> {
    return {
      assetId,
      timestamp: new Date(),
      capabilityType,
      payload: {},
    }
  }

  async health(assetId: string): Promise<HealthStatus> {
    return {
      assetId,
      status: 'healthy',
    }
  }
}
