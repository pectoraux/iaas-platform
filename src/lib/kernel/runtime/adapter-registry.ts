// =============================================================================
// Kernel: Adapter Registry (Phase 7 — hardened)
// =============================================================================
// The AdapterRegistry maps (assetType, adapterType) to InfrastructureAdapter
// implementations. It is the single point of resolution: given an asset's
// type and (optionally) a specific adapter type, the registry returns the
// adapter that can execute physical work on that asset.
//
// PHASE 7 HARDENING:
//   1. Atomic registration — validate-then-commit, no partial mutation.
//   2. Explicit adapter identity — every adapter has a unique adapterType.
//   3. Deterministic selection — resolve by assetType + adapterType.
//      Unknown → throws. Ambiguous → throws. No silent fallback.
//   4. Capability-aware metadata — answer "which adapters can execute
//      capability X on asset type Y?"
//   5. Immutable state inspection — diagnostics without exposing the mutable map.
//
// KEY INVARIANTS:
//   - Registration is all-or-nothing. If any (assetType, adapterType) binding
//     in a single register() call conflicts, the entire call is rejected and
//     the registry is unchanged.
//   - Every adapter has a unique adapterType. Two adapters with the same
//     adapterType cannot be registered.
//   - An asset type CAN have multiple adapters (e.g., battery → simulated_der,
//     tesla_powerwall, enphase_battery). Resolution is deterministic when
//     adapterType is specified; ambiguous when only assetType is specified
//     and multiple adapters are registered for it.
//
// DEPENDENCY DIRECTION:
//   Vertical (VPP) → InfrastructureRuntime → AdapterRegistry → InfrastructureAdapter
//
// The vertical NEVER imports or instantiates a concrete adapter. It goes
// through the runtime, which resolves the adapter via the registry.
// =============================================================================

import type { InfrastructureAdapter } from '../adapters/infrastructure-adapter'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Describes an adapter registration. The registry stores adapters keyed by
 * their unique adapterType, with a set of supported asset types and
 * capabilities for deterministic selection.
 */
export interface AdapterDescriptor {
  /** The adapter instance. */
  readonly adapter: InfrastructureAdapter
  /** Asset types this adapter can handle (e.g., ['battery', 'solar_inverter']). */
  readonly supportedAssetTypes: string[]
  /** Capabilities this adapter can execute (e.g., ['energy_discharge', 'frequency_response']). */
  readonly supportedCapabilities: string[]
}

/**
 * Selection criteria for resolving an adapter.
 *
 * - assetType: REQUIRED. The type of asset to execute on.
 * - adapterType: OPTIONAL. If specified, resolves the exact adapter.
 *   If omitted, resolves the single adapter registered for the asset type.
 *   If multiple adapters are registered and adapterType is omitted,
 *   resolution is AMBIGUOUS and throws.
 * - capabilityType: OPTIONAL. If specified, the resolved adapter must
 *   support this capability. Used for capability-aware selection.
 */
export interface AdapterSelection {
  assetType: string
  adapterType?: string
  capabilityType?: string
}

/**
 * Immutable diagnostic snapshot of a registered adapter.
 * Does NOT expose the adapter instance — only metadata.
 */
export interface AdapterInfo {
  adapterType: string
  supportedAssetTypes: readonly string[]
  supportedCapabilities: readonly string[]
  /** Phase 12B Slice 5: whether this adapter can cancel/fence a running execution. */
  readonly supportsCancellation: boolean
}

// ---------------------------------------------------------------------------
// AdapterRegistry
// ---------------------------------------------------------------------------

export class AdapterRegistry {
  /**
   * Internal map: adapterType → AdapterDescriptor.
   * Keyed by adapterType (unique identity), NOT by asset type.
   * An asset type can map to multiple adapters.
   */
  private readonly adaptersByType = new Map<string, AdapterDescriptor>()

  /**
   * Internal index: assetType → Set of adapterTypes that support it.
   * Derived from adaptersByType. Kept in sync for fast lookup.
   */
  private readonly assetTypeIndex = new Map<string, Set<string>>()

  // -------------------------------------------------------------------------
  // P7.1 — Shared descriptor validation (used by register + registerBatch)
  // -------------------------------------------------------------------------

  /**
   * Validate a single descriptor completely. This is the SHARED validation
   * path used by both `register()` and `registerBatch()`.
   *
   * Checks:
   *   - adapterType is non-empty
   *   - supportedAssetTypes is non-empty
   *   - every supportedAssetType string is non-empty
   *
   * Does NOT check adapterType uniqueness against the registry or the batch —
   * those checks are context-specific (single register vs batch) and are
   * performed by the callers.
   *
   * @throws if any field-level validation fails.
   */
  private validateDescriptor(descriptor: AdapterDescriptor): void {
    const { adapter, supportedAssetTypes } = descriptor
    const adapterType = adapter.adapterType

    if (!adapterType) {
      throw new Error('Cannot register adapter: adapterType is empty.')
    }
    if (supportedAssetTypes.length === 0) {
      throw new Error(
        `Cannot register adapter '${adapterType}': supportedAssetTypes is empty. ` +
          `An adapter must support at least one asset type.`,
      )
    }
    for (const at of supportedAssetTypes) {
      if (!at) {
        throw new Error(
          `Cannot register adapter '${adapterType}': supportedAssetTypes contains an empty string.`,
        )
      }
    }
  }

  /**
   * Commit a descriptor to the registry. This is the SHARED commit path.
   * It assumes validation has ALREADY been performed — it does NOT validate.
   * Called by both `register()` and `registerBatch()` after their respective
   * validation phases pass.
   */
  private commitDescriptor(descriptor: AdapterDescriptor): void {
    const { adapter, supportedAssetTypes, supportedCapabilities } = descriptor
    const adapterType = adapter.adapterType

    // Store the descriptor.
    this.adaptersByType.set(adapterType, {
      adapter,
      supportedAssetTypes: [...supportedAssetTypes],
      supportedCapabilities: [...supportedCapabilities],
    })

    // Update the asset type index.
    for (const at of supportedAssetTypes) {
      let set = this.assetTypeIndex.get(at)
      if (!set) {
        set = new Set()
        this.assetTypeIndex.set(at, set)
      }
      set.add(adapterType)
    }
  }

  // -------------------------------------------------------------------------
  // P7.1 — Atomic single registration
  // -------------------------------------------------------------------------

  /**
   * Register an adapter with its supported asset types and capabilities.
   *
   * ATOMIC (P7.1): Validates the ENTIRE descriptor before committing. If any
   * validation fails, the registry is unchanged.
   *
   * IDENTITY (P7.2): The adapter's adapterType must be unique. If an adapter
   * with the same adapterType is already registered, the call throws.
   *
   * @throws if adapterType is empty.
   * @throws if supportedAssetTypes is empty or contains empty strings.
   * @throws if the adapterType is already registered.
   */
  register(descriptor: AdapterDescriptor): void {
    // --- VALIDATE PHASE (no mutation) ---
    this.validateDescriptor(descriptor)
    const adapterType = descriptor.adapter.adapterType
    if (this.adaptersByType.has(adapterType)) {
      throw new Error(
        `Cannot register adapter '${adapterType}': an adapter with this adapterType ` +
          `is already registered. Adapter identities are unique.`,
      )
    }

    // --- COMMIT PHASE (all validations passed) ---
    this.commitDescriptor(descriptor)
  }

  // -------------------------------------------------------------------------
  // P7.1 — Atomic batch registration
  // -------------------------------------------------------------------------

  /**
   * Register multiple adapters atomically. If ANY descriptor in the batch
   * fails validation, the ENTIRE batch is rejected and the registry is
   * unchanged. No partial mutation.
   *
   * This is important for bootstrap: registering all adapters for a vertical
   * is all-or-nothing. If the compute adapter conflicts, the energy adapters
   * are not partially committed.
   *
   * Phase 7.1 fix: The batch validates ALL descriptors completely (field
   * validation + uniqueness within batch + uniqueness against registry)
   * BEFORE committing ANY of them. The commit phase uses commitDescriptor()
   * directly — it does NOT call register(), so there is no possibility of a
   * mid-batch throw after partial commitment.
   */
  registerBatch(descriptors: AdapterDescriptor[]): void {
    // --- VALIDATE PHASE (no mutation) ---
    // 1. Field-validate every descriptor (adapterType non-empty, supportedAssetTypes
    //    non-empty, no empty asset type strings).
    for (const desc of descriptors) {
      this.validateDescriptor(desc)
    }

    // 2. Check for internal duplicates within the batch.
    const seenInBatch = new Set<string>()
    for (const desc of descriptors) {
      const at = desc.adapter.adapterType
      if (seenInBatch.has(at)) {
        throw new Error(
          `Cannot register batch: adapterType '${at}' appears more than once in the batch.`,
        )
      }
      seenInBatch.add(at)
    }

    // 3. Check for conflicts with the existing registry.
    for (const desc of descriptors) {
      const at = desc.adapter.adapterType
      if (this.adaptersByType.has(at)) {
        throw new Error(
          `Cannot register batch: adapterType '${at}' is already registered.`,
        )
      }
    }

    // --- COMMIT PHASE (all validations passed) ---
    // Commit directly via commitDescriptor() — NOT via register(). This
    // guarantees no mid-batch throw: all validation is done, so commitDescriptor
    // cannot throw. The registry is mutated only after every descriptor is
    // validated.
    for (const desc of descriptors) {
      this.commitDescriptor(desc)
    }
  }

  // -------------------------------------------------------------------------
  // P7.3 — Deterministic selection
  // -------------------------------------------------------------------------

  /**
   * Resolve an adapter for a given selection.
   *
   * DETERMINISTIC (P7.3):
   *   - If adapterType is specified: resolves the exact adapter. Throws if
   *     not registered or if it doesn't support the assetType.
   *   - If adapterType is omitted: resolves the single adapter registered
   *     for the assetType. If MULTIPLE adapters are registered for the
   *     assetType, resolution is AMBIGUOUS and throws.
   *   - If capabilityType is specified: the resolved adapter must support
   *     it, or resolution throws.
   *
   * THROWS on:
   *   - unknown asset type (no adapters registered)
   *   - unknown adapter type
   *   - ambiguous resolution (multiple adapters, no adapterType specified)
   *   - capability not supported
   *
   * There is NO silent fallback.
   */
  resolve(selection: AdapterSelection): InfrastructureAdapter {
    const { assetType, adapterType, capabilityType } = selection

    // Find candidate adapterTypes for this assetType.
    const candidates = this.assetTypeIndex.get(assetType)
    if (!candidates || candidates.size === 0) {
      throw new Error(
        `No adapter registered for asset type '${assetType}'. ` +
          `Registered asset types: ${Array.from(this.assetTypeIndex.keys()).join(', ')}.`,
      )
    }

    let resolvedAdapterType: string

    if (adapterType) {
      // Explicit adapter selection — must be registered AND support the assetType.
      if (!candidates.has(adapterType)) {
        throw new Error(
          `Adapter '${adapterType}' does not support asset type '${assetType}'. ` +
            `Adapters for '${assetType}': ${Array.from(candidates).join(', ')}.`,
        )
      }
      resolvedAdapterType = adapterType
    } else {
      // Implicit selection — require exactly one candidate.
      if (candidates.size > 1) {
        throw new Error(
          `Ambiguous adapter resolution for asset type '${assetType}': ` +
            `multiple adapters registered (${Array.from(candidates).join(', ')}). ` +
            `Specify adapterType to disambiguate.`,
        )
      }
      resolvedAdapterType = candidates.values().next().value!
    }

    const descriptor = this.adaptersByType.get(resolvedAdapterType)!
    const adapter = descriptor.adapter

    // Capability check (if specified).
    if (capabilityType) {
      if (!descriptor.supportedCapabilities.includes(capabilityType)) {
        throw new Error(
          `Adapter '${resolvedAdapterType}' does not support capability '${capabilityType}'. ` +
            `Supported capabilities: ${descriptor.supportedCapabilities.join(', ')}.`,
        )
      }
    }

    return adapter
  }

  /**
   * Phase 12B Slice 5: resolve the full AdapterDescriptor (not just the
   * adapter instance) for a selection. The orchestrator uses this to query
   * whether the resolved adapter supports cancellation/fencing.
   */
  resolveDescriptor(selection: AdapterSelection): AdapterDescriptor {
    const { assetType, adapterType, capabilityType } = selection
    const candidates = this.assetTypeIndex.get(assetType)
    if (!candidates || candidates.size === 0) {
      throw new Error(
        `No adapter registered for asset type '${assetType}'.`,
      )
    }
    let resolvedAdapterType: string
    if (adapterType) {
      if (!candidates.has(adapterType)) {
        throw new Error(
          `Adapter '${adapterType}' does not support asset type '${assetType}'.`,
        )
      }
      resolvedAdapterType = adapterType
    } else {
      if (candidates.size > 1) {
        throw new Error(
          `Ambiguous adapter resolution for asset type '${assetType}'.`,
        )
      }
      resolvedAdapterType = candidates.values().next().value!
    }
    const descriptor = this.adaptersByType.get(resolvedAdapterType)!
    if (capabilityType && !descriptor.supportedCapabilities.includes(capabilityType)) {
      throw new Error(
        `Adapter '${resolvedAdapterType}' does not support capability '${capabilityType}'.`,
      )
    }
    return descriptor
  }

  // -------------------------------------------------------------------------
  // P7.4 — Capability-aware queries
  // -------------------------------------------------------------------------

  /**
   * Find all adapters that can execute a given capability on a given asset type.
   *
   * Returns adapterTypes (not instances) — for diagnostics and planning.
   * Returns an empty array if none match.
   */
  findAdaptersForCapability(assetType: string, capabilityType: string): string[] {
    const candidates = this.assetTypeIndex.get(assetType)
    if (!candidates) return []

    const result: string[] = []
    for (const adapterType of candidates) {
      const desc = this.adaptersByType.get(adapterType)!
      if (desc.supportedCapabilities.includes(capabilityType)) {
        result.push(adapterType)
      }
    }
    return result
  }

  // -------------------------------------------------------------------------
  // P7.5 — Immutable state inspection
  // -------------------------------------------------------------------------

  /**
   * Check if an adapter is registered for the given asset type.
   */
  has(assetType: string): boolean {
    const candidates = this.assetTypeIndex.get(assetType)
    return !!candidates && candidates.size > 0
  }

  /**
   * Check if a specific adapterType is registered.
   */
  hasAdapter(adapterType: string): boolean {
    return this.adaptersByType.has(adapterType)
  }

  /**
   * List all registered asset types (immutable copy).
   */
  registeredAssetTypes(): string[] {
    return Array.from(this.assetTypeIndex.keys())
  }

  /**
   * List all registered adapter types (immutable copy).
   */
  registeredAdapterTypes(): string[] {
    return Array.from(this.adaptersByType.keys())
  }

  /**
   * Get immutable diagnostic info for all registered adapters.
   * Does NOT expose adapter instances — only metadata.
   */
  listAdapters(): AdapterInfo[] {
    const result: AdapterInfo[] = []
    for (const [adapterType, desc] of this.adaptersByType) {
      result.push({
        adapterType,
        supportedAssetTypes: Object.freeze([...desc.supportedAssetTypes]),
        supportedCapabilities: Object.freeze([...desc.supportedCapabilities]),
        supportsCancellation: desc.adapter.supportsCancellation ?? false,
      })
    }
    return result
  }

  /**
   * Get the adapterTypes registered for a specific asset type.
   * Returns an empty array if the asset type is unknown.
   */
  adaptersForAssetType(assetType: string): string[] {
    const candidates = this.assetTypeIndex.get(assetType)
    return candidates ? Array.from(candidates) : []
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

/**
 * The global AdapterRegistry singleton. Concrete adapters are registered
 * into this singleton by the application bootstrap layer (NOT by the kernel).
 *
 * The kernel/runtime layer NEVER imports concrete adapter implementations.
 * The composition root (src/lib/bootstrap/) owns registration.
 */
export const adapterRegistry = new AdapterRegistry()

// ---------------------------------------------------------------------------
// Resolution helper (backward-compatible with Phase 6 callers)
// ---------------------------------------------------------------------------

/**
 * Resolve an adapter for a given asset type.
 *
 * This is a thin wrapper around adapterRegistry.resolve(). It resolves the
 * single adapter for the asset type — if multiple are registered, it throws
 * (ambiguous). Callers that need deterministic selection should call
 * adapterRegistry.resolve({ assetType, adapterType }) directly.
 *
 * THROWS if no adapter is registered or if resolution is ambiguous.
 */
export function resolveAdapter(assetType: string): InfrastructureAdapter {
  return adapterRegistry.resolve({ assetType })
}
