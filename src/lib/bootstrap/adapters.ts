// =============================================================================
// Bootstrap: Concrete Adapter Registration (Phase 7)
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
//
// Phase 7: Registration now uses AdapterDescriptor (adapter + supported asset
// types + supported capabilities) instead of just asset types. This enables
// deterministic selection by (assetType, adapterType) and capability-aware
// queries.
// =============================================================================

import { adapterRegistry, type AdapterDescriptor } from '@/lib/kernel/runtime/adapter-registry'
import { SimulatedDERAdapter } from '@/lib/services/der-adapter.service'
import { SimulatedComputeAdapter } from '@/lib/services/compute-adapter.service'

/**
 * Register all concrete adapters with the generic AdapterRegistry.
 *
 * Called by bootstrap/index.ts (initializeBootstrap) at application startup.
 * NOT called by vertical services — they receive a pre-populated registry.
 *
 * Idempotent — safe to call multiple times (bootstrap/index.ts guards with
 * an `initialized` flag; the registry itself throws on duplicate adapterType).
 *
 * Phase 7: Uses AdapterDescriptor with capabilities.
 * Phase 8: Added the compute adapter alongside the DER adapter. Both register
 * atomically via registerBatch — if either conflicts, neither is committed.
 */
export function registerAdapters(): void {
  const derDescriptor: AdapterDescriptor = {
    adapter: new SimulatedDERAdapter(),
    supportedAssetTypes: ['battery', 'solar_inverter', 'ev_charger', 'smart_meter'],
    supportedCapabilities: ['energy_discharge', 'frequency_response', 'energy_capacity'],
  }

  const computeDescriptor: AdapterDescriptor = {
    adapter: new SimulatedComputeAdapter(),
    supportedAssetTypes: ['compute_node', 'gpu_cluster'],
    supportedCapabilities: ['gpu_compute', 'cpu_compute'],
  }

  // Phase 7: registerBatch is atomic — if this fails, no adapters are committed.
  // Phase 8: Both energy + compute adapters register together. The kernel
  // (InfrastructureRuntime, AdapterRegistry) does NOT know about compute —
  // it just resolves adapters by asset type.
  adapterRegistry.registerBatch([derDescriptor, computeDescriptor])
}
