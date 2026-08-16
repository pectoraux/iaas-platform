// =============================================================================
// Kernel: Adapter Registry (Phase 6)
// =============================================================================
// The AdapterRegistry maps asset types to InfrastructureAdapter implementations.
// It is the single point of resolution: given an asset's type (e.g., 'battery',
// 'compute_node'), the registry returns the adapter that can execute physical
// work on that asset.
//
// KEY INVARIANT:
//   Every asset type resolves to exactly one adapter. If no adapter is
//   registered for the asset type, resolution throws — there is no silent
//   fallback. This ensures an asset with an unregistered type cannot execute
//   at all, rather than silently using the wrong adapter.
//
// The registry is a singleton, initialized at module load with the canonical
// adapters. Verticals never register adapters — adapters are kernel-level,
// registered once.
//
// DEPENDENCY DIRECTION:
//   Vertical (VPP) → InfrastructureRuntime → AdapterRegistry → InfrastructureAdapter
//
// The vertical NEVER imports or instantiates a concrete adapter. It goes
// through the runtime, which resolves the adapter via the registry.
// =============================================================================

import type { InfrastructureAdapter } from '../adapters/infrastructure-adapter'

// ---------------------------------------------------------------------------
// AdapterRegistry
// ---------------------------------------------------------------------------

export class AdapterRegistry {
  private readonly adapters = new Map<string, InfrastructureAdapter>()

  /**
   * Register an adapter for one or more asset types.
   * Called once at module initialization for each canonical adapter.
   * Throws if an adapter is already registered for an asset type.
   */
  registerForAssetTypes(assetTypes: string[], adapter: InfrastructureAdapter): void {
    for (const assetType of assetTypes) {
      if (this.adapters.has(assetType)) {
        throw new Error(
          `Adapter already registered for asset type '${assetType}'. ` +
            `An asset type can only have one adapter.`,
        )
      }
      this.adapters.set(assetType, adapter)
    }
  }

  /**
   * Resolve an adapter for a given asset type.
   *
   * THROWS if no adapter is registered for the asset type. There is NO
   * silent fallback — an asset with an unregistered type cannot execute.
   */
  resolve(assetType: string): InfrastructureAdapter {
    const adapter = this.adapters.get(assetType)
    if (!adapter) {
      throw new Error(
        `No adapter registered for asset type '${assetType}'. ` +
          `Registered types: ${Array.from(this.adapters.keys()).join(', ')}. ` +
          `An asset with this type cannot execute.`,
      )
    }
    return adapter
  }

  /**
   * Check if an adapter is registered for the given asset type.
   */
  has(assetType: string): boolean {
    return this.adapters.has(assetType)
  }

  /**
   * List all registered asset types. For diagnostics/testing.
   */
  registeredAssetTypes(): string[] {
    return Array.from(this.adapters.keys())
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

/**
 * The global AdapterRegistry singleton. Initialized once with the canonical
 * adapters. The InfrastructureRuntime imports this to resolve adapters.
 */
export const adapterRegistry = new AdapterRegistry()
