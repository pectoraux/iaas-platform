// =============================================================================
// Bootstrap: Concrete Adapter Registration (Phase 6.2)
// =============================================================================
// This module registers all concrete adapter implementations with the generic
// AdapterRegistry. It is the ONLY place in the codebase that imports concrete
// adapter implementations.
//
// DEPENDENCY DIRECTION:
//   kernel (AdapterRegistry, InfrastructureAdapter interface)
//     ↑
//   bootstrap/adapters.ts (THIS — registers concrete adapters)
//     ↑
//   bootstrap/index.ts (calls registerAdapters() at application startup)
//     ↑
//   instrumentation.ts / tests
//
// The kernel/runtime layer NEVER imports this file or any concrete adapter.
// The InfrastructureRuntime calls resolveAdapter() from the generic registry;
// it does not know which concrete adapter is registered.
//
// VPP does NOT import this file. The application (via bootstrap/index.ts)
// owns registration, not the vertical service.
// =============================================================================

import { adapterRegistry } from '@/lib/kernel/runtime/adapter-registry'
import { SimulatedDERAdapter } from '@/lib/services/der-adapter.service'

/**
 * Register all concrete adapters with the generic AdapterRegistry.
 *
 * Called by bootstrap/index.ts (initializeBootstrap) at application startup.
 * NOT called by vertical services — they receive a pre-populated registry.
 *
 * Idempotent — safe to call multiple times (the registry throws on duplicate
 * registration, but bootstrap/index.ts guards with an `initialized` flag).
 */
export function registerAdapters(): void {
  // Register the simulated DER adapter for all energy asset types.
  // Phase 8 will add a compute adapter here (for compute_node, gpu_cluster).
  adapterRegistry.registerForAssetTypes(
    ['battery', 'solar_inverter', 'ev_charger', 'smart_meter'],
    new SimulatedDERAdapter(),
  )
}
