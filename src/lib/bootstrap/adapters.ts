// =============================================================================
// Bootstrap: Adapter Registry Composition Root (Phase 6.1)
// =============================================================================
// This is the COMPOSITION ROOT for concrete adapter registration. It is the
// ONLY place in the codebase that imports concrete adapter implementations
// and registers them with the generic AdapterRegistry.
//
// DEPENDENCY DIRECTION:
//   kernel (AdapterRegistry, InfrastructureAdapter interface)
//     ↑
//   bootstrap (this file — registers concrete adapters)
//     ↑
//   vertical adapters (SimulatedDERAdapter, future ComputeAdapter, etc.)
//
// The kernel/runtime layer NEVER imports this file or any concrete adapter.
// The InfrastructureRuntime calls resolveAdapter() from the generic registry;
// it does not know which concrete adapter is registered.
//
// This file is imported as a side-effect by the vertical services (VPP) to
// ensure adapters are registered before any dispatch execution. The vertical
// imports the bootstrap, NOT the concrete adapter.
// =============================================================================

import { adapterRegistry } from '@/lib/kernel/runtime/adapter-registry'
import { SimulatedDERAdapter } from '@/lib/services/der-adapter.service'

// ---------------------------------------------------------------------------
// Register concrete adapters (once)
// ---------------------------------------------------------------------------

let initialized = false

function ensureRegistered(): void {
  if (initialized) return

  // Register the simulated DER adapter for all energy asset types.
  // Phase 8 will add a compute adapter here (for compute_node, gpu_cluster).
  adapterRegistry.registerForAssetTypes(
    ['battery', 'solar_inverter', 'ev_charger', 'smart_meter'],
    new SimulatedDERAdapter(),
  )

  initialized = true
}

// Auto-register on module load.
ensureRegistered()

// Export nothing — this is a side-effect module. The act of importing it
// ensures the concrete adapters are registered with the generic registry.
export {}
