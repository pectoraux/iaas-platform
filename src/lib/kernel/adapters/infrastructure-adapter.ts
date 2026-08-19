// =============================================================================
// Kernel: Generic Infrastructure Adapter Interface
// =============================================================================
// The top-level abstraction for physical infrastructure integration.
// VPP's DERAdapter is a specialization of this interface.
//
// The adapter contract:
//   - discover(): find available assets on the physical network
//   - getCapabilities(): what can this asset do?
//   - readTelemetry(): read current state / measurements
//   - execute(): command the asset to perform work
//   - health(): check asset health / availability
//
// Verticals implement this:
//   EnergyInfrastructureAdapter (VPP) → DERAdapter
//   StorageInfrastructureAdapter → StorageNodeAdapter
//   ComputeInfrastructureAdapter → GPUClusterAdapter
//   WirelessInfrastructureAdapter → AccessPointAdapter
//
// The key architectural rule:
//   Core kernel → Adapter contract → vendor/physical implementation
//
// The adapter NEVER touches the economic kernel directly. It produces
// telemetry data that enters the generic Event → Verification → Attestation
// → Contribution pipeline.
// =============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The capabilities an infrastructure asset can provide.
 */
export interface AssetCapabilities {
  assetId: string
  /** What this asset can do (e.g., 'energy_discharge', 'storage_capacity', 'compute_gpu'). */
  capabilities: Array<{
    type: string
    unit: string  // kWh | TB | GPU | Gbps | ...
    /** Maximum capacity in the capability's unit. */
    maxCapacity: string  // decimal as string
  }>
  /** Current health status. */
  health: 'healthy' | 'degraded' | 'offline'
  /** Optional metadata (firmware version, location, etc.). */
  metadata?: Record<string, unknown>
}

/**
 * A telemetry reading from an infrastructure asset.
 */
export interface TelemetryReading {
  assetId: string
  timestamp: Date
  /** The capability being measured (e.g., 'energy_discharge'). */
  capabilityType: string
  /** Measured values (e.g., { power_kw: 50, available_energy_kwh: 100 }). */
  payload: Record<string, unknown>
}

/**
 * An execution command sent to an infrastructure asset.
 */
export interface ExecuteCommand {
  assetId: string
  /** The capability to execute (e.g., 'energy_discharge'). */
  capabilityType: string
  /** Assigned quantity (e.g., '50' kW). */
  assignedQuantity: string
  assignedUnit: string
  /** Duration in seconds. */
  durationSeconds: number
  /** Optional parameters (e.g., discharge profile, ramp rate). */
  parameters?: Record<string, unknown>
  /**
   * Phase 12B Slice 5: an optional AbortSignal. If the adapter honors it,
   * the runtime can cancel a running execution by calling abort()
   * on the AbortController that produced this signal. Adapters that do NOT
   * support cancellation (supportsCancellation=false in their descriptor)
   * will ignore this field.
   */
  abortSignal?: AbortSignal
}

/**
 * The result of an execution command.
 */
export interface ExecuteResult {
  assetId: string
  /** Actual output quantity (e.g., '48.5' kWh). */
  actualQuantity: string
  actualUnit: string
  /** Telemetry payload from the execution. */
  telemetry: {
    payload: Record<string, unknown>
  }
  /** Whether the execution succeeded. */
  success: boolean
  /** Error message if failed. */
  error?: string
}

/**
 * Health check result.
 */
export interface HealthStatus {
  assetId: string
  status: 'healthy' | 'degraded' | 'offline'
  /** Optional diagnostic information. */
  diagnostics?: Record<string, unknown>
}

/**
 * Phase 12B Slice 5: a command to cancel/fence a running execution.
 *
 * Sent to an adapter when the runtime determines a lease is lost and the
 * physical operation must be stopped. The adapter should attempt to cancel
 * the in-flight execution on the physical resource.
 *
 * If the adapter CANNOT cancel (supportsCancellation=false), the runtime
 * does NOT send this command — instead it marks the lease
 * 'unsafe_to_retry' and requires human/ops intervention.
 */
export interface CancelCommand {
  assetId: string
  /** The capability that was being executed. */
  capabilityType: string
  /** The lease ID that authorized the execution (for logging/correlation). */
  leaseId: string
  /** The reason for cancellation (e.g., 'lease expired', 'process crash'). */
  reason: string
}

/**
 * Phase 12B Slice 5: the result of a cancel/fence attempt.
 */
export interface CancelResult {
  assetId: string
  /** Whether the cancellation was confirmed. If false, the physical operation
   * may still be running — the lease must be marked 'unsafe_to_retry'. */
  confirmed: boolean
  /** Optional diagnostic info. */
  diagnostics?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Generic infrastructure adapter interface.
 *
 * Verticals implement this to integrate physical infrastructure:
 *   - EnergyInfrastructureAdapter (VPP) → TeslaAdapter, EnphaseAdapter, etc.
 *   - StorageInfrastructureAdapter → StorageNodeAdapter
 *   - ComputeInfrastructureAdapter → GPUClusterAdapter
 *   - WirelessInfrastructureAdapter → AccessPointAdapter
 *
 * The adapter NEVER touches the economic kernel. It produces telemetry
 * that enters the generic Event pipeline.
 */
export interface InfrastructureAdapter {
  /** Adapter type identifier (e.g., 'tesla_powerwall', 'enphase_battery'). */
  readonly adapterType: string

  /**
   * Phase 12B Slice 5: whether this adapter supports cancellation/fencing of
   * a running execution. If false, the runtime will NOT call cancel() and
   * will mark lost leases as 'unsafe_to_retry' (physical execution may still
   * be running; retry is NOT authorized without human/ops intervention).
   *
   * Simulated adapters return false (they execute synchronously and have no
   * real physical operation to cancel). Real adapters that can cancel
   * (e.g., a Tesla API with a stop-charging endpoint) should return true and
   * implement cancel().
   */
  readonly supportsCancellation?: boolean

  /**
   * Discover available assets on the physical network.
   * Used for auto-registration (future).
   */
  discover(): Promise<AssetCapabilities[]>

  /**
   * Get capabilities for a specific asset.
   */
  getCapabilities(assetId: string): Promise<AssetCapabilities>

  /**
   * Read current telemetry from an asset.
   */
  readTelemetry(assetId: string, capabilityType: string): Promise<TelemetryReading>

  /**
   * Execute a command on an asset.
   * Returns the actual output + telemetry payload.
   *
   * Phase 12B Slice 5: if the adapter supports cancellation (supportsCancellation=true),
   * the runtime will pass an AbortSignal in command.abortSignal. The adapter
   * should periodically check signal.aborted and stop the physical operation.
   */
  execute(command: ExecuteCommand): Promise<ExecuteResult>

  /**
   * Check asset health.
   */
  health(assetId: string): Promise<HealthStatus>

  /**
   * Phase 12B Slice 5: cancel/fence a running execution.
   *
   * Called by the runtime when a lease is lost (expired) and the adapter
   * supports cancellation. The adapter should attempt to stop the in-flight
   * physical operation on the resource.
   *
   * If the adapter returns confirmed=false, the physical operation may still
   * be running — the lease must be marked 'unsafe_to_retry'.
   *
   * If the adapter does NOT support cancellation (supportsCancellation=false),
   * this method will NOT be called. The runtime marks the lease
   * 'unsafe_to_retry' directly.
   */
  cancel?(command: CancelCommand): Promise<CancelResult>
}
