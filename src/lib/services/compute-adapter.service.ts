// =============================================================================
// Compute Adapter — compute-specific physical device abstraction.
//
// Phase 8: This adapter implements the generic InfrastructureAdapter interface
// from the kernel. The AdapterRegistry resolves it for compute assets. The
// compute vertical does NOT import or instantiate this adapter directly — it
// goes through the InfrastructureRuntime, which resolves the adapter via the
// registry.
//
// The adapter does NOT bypass the generic pipeline — it produces telemetry
// that flows through generic Event → Verification → Attestation → Contribution.
//
// This is the PROOF that the architecture is a Network Operating System:
// the SAME InfrastructureRuntime, AdapterRegistry, Execution, Contribution,
// Reward, and Settlement pipeline that serves energy-vpp serves compute —
// with zero kernel modifications.
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
// Simulated Compute Adapter — implements the generic InfrastructureAdapter
// ---------------------------------------------------------------------------

/**
 * Simulated compute adapter for testing. Generates telemetry with ~95%
 * utilization efficiency. No real hardware communication — just deterministic
 * values.
 *
 * Phase 8: Implements the generic InfrastructureAdapter interface. The
 * AdapterRegistry resolves this adapter for compute assets (compute_node,
 * gpu_cluster).
 *
 * This adapter is the proof point: it uses the SAME interface as
 * SimulatedDERAdapter, registers into the SAME AdapterRegistry, and is
 * resolved by the SAME InfrastructureRuntime — with zero kernel changes.
 */
export class SimulatedComputeAdapter implements InfrastructureAdapter {
  readonly adapterType = 'simulated_compute'

  /**
   * Execute a compute job and return normalized telemetry.
   * This is the generic InfrastructureAdapter.execute() implementation.
   *
   * The adapter simulates:
   *   - GPU/CPU utilization at ~95% of assigned capacity
   *   - Memory usage proportional to the job
   *   - Telemetry payload matching the capability schema
   */
  async execute(command: ExecuteCommand): Promise<ExecuteResult> {
    const assignedHours = new Prisma.Decimal(command.assignedQuantity)
    const utilizationEfficiency = new Prisma.Decimal('0.95')

    const actualHours = assignedHours.times(utilizationEfficiency)

    // Generate telemetry payload matching the capability schema.
    let payload: Record<string, unknown>
    if (command.capabilityType === 'gpu_compute') {
      const gpuCount = (command.parameters?.gpuCount as number) ?? 1
      payload = {
        gpu_count: gpuCount,
        gpu_utilization_pct: 95,
        memory_gb: gpuCount * 16, // 16 GB per GPU
        duration_seconds: command.durationSeconds,
      }
    } else if (command.capabilityType === 'cpu_compute') {
      const cpuCores = (command.parameters?.cpuCores as number) ?? 4
      payload = {
        cpu_cores: cpuCores,
        cpu_utilization_pct: 95,
        memory_gb: cpuCores * 4, // 4 GB per core
        duration_seconds: command.durationSeconds,
      }
    } else {
      // Generic fallback.
      payload = {
        output_value: parseFloat(actualHours.toString()),
        duration_seconds: command.durationSeconds,
      }
    }

    return {
      assetId: command.assetId,
      actualQuantity: actualHours.toString(),
      actualUnit: command.assignedUnit,
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
        { type: 'gpu_compute', unit: 'GPU-hours', maxCapacity: '100' },
        { type: 'cpu_compute', unit: 'CPU-hours', maxCapacity: '1000' },
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
