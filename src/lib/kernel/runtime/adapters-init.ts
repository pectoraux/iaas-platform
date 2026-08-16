// =============================================================================
// Kernel: Adapter Registry Initialization (Phase 6)
// =============================================================================
// This module registers all canonical adapters with the AdapterRegistry
// singleton. It is imported once at application startup.
//
// The registry is initialized with adapters for each known asset type:
//   - Energy assets (battery, solar_inverter, ev_charger, smart_meter)
//     → SimulatedDERAdapter
//   - (Future) Compute assets (compute_node, gpu_cluster) → ComputeAdapter
//   - (Future) Storage assets (storage_node) → StorageAdapter
//
// The InfrastructureRuntime imports `resolveAdapter` from this module to
// resolve an adapter for a given asset type. Verticals never touch the
// registry directly.
// =============================================================================

import { adapterRegistry } from './adapter-registry'
import type { InfrastructureAdapter } from '../adapters/infrastructure-adapter'
import { SimulatedDERAdapter } from '../../services/der-adapter.service'

// ---------------------------------------------------------------------------
// Register canonical adapters (once)
// ---------------------------------------------------------------------------

let initialized = false

function ensureRegistered(): void {
  if (initialized) return
  // Register the simulated DER adapter for all energy asset types.
  // This is the only adapter today; Phase 8 will add a compute adapter.
  const derAdapter: InfrastructureAdapter = new SimulatedDERAdapter()

  adapterRegistry.registerForAssetTypes(
    ['battery', 'solar_inverter', 'ev_charger', 'smart_meter'],
    derAdapter,
  )
  initialized = true
}

// Auto-register on module load.
ensureRegistered()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve an adapter for a given asset type.
 *
 * This is the ONLY function the InfrastructureRuntime calls to get an adapter.
 * It ensures the registry is initialized, then resolves.
 *
 * THROWS if the asset type is not registered — no silent fallback.
 */
export function resolveAdapter(assetType: string): InfrastructureAdapter {
  ensureRegistered()
  return adapterRegistry.resolve(assetType)
}

// Re-export the registry for testing/diagnostics.
export { adapterRegistry }
