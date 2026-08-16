// =============================================================================
// Kernel: Runtime Module (Phase 5, hardened Phase 7.3)
// =============================================================================
// This module exports the runtime contract types and the RuntimeRegistry
// singleton. It does NOT auto-register runtimes — that is the application
// bootstrap's job (src/lib/bootstrap/).
//
// Phase 7.3 — NO AUTO-REGISTRATION:
//   Previously, this module auto-registered InfrastructureRuntime,
//   ProtocolRuntime, and HybridRuntime on import. But InfrastructureRuntime
//   now requires an AdapterRegistry in its constructor (dependency injection),
//   and the kernel cannot import the bootstrap (which constructs the registry).
//   So runtime registration moved to the bootstrap layer.
//
//   The application (via instrumentation.ts → initializeBootstrap) constructs
//   the AdapterRegistry, constructs InfrastructureRuntime(registry), and
//   registers all three runtimes with the RuntimeRegistry. Tests that need
//   the global registry call initializeBootstrap() in beforeAll().
//
// Verticals import `resolveRuntime` from this module to resolve a
// NetworkVersion's runtimeKind to a concrete NetworkRuntime. They never
// touch the registry directly.
// =============================================================================

import { runtimeRegistry } from './registry'
import type { NetworkRuntime, RuntimeKind } from './types'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a runtime kind to its concrete NetworkRuntime implementation.
 *
 * Phase 7.3: This does NOT auto-register. The application bootstrap must
 * have called initializeBootstrap() (which registers runtimes) before any
 * code calls this. If no runtime is registered, it throws.
 *
 * THROWS if the kind is not registered — there is no silent fallback.
 */
export function resolveRuntime(kind: RuntimeKind): NetworkRuntime {
  return runtimeRegistry.resolve(kind)
}

// Re-export the registry for bootstrap + testing.
export { runtimeRegistry }
export type { NetworkRuntime, RuntimeKind, RuntimeExecuteInput, RuntimeExecuteResult } from './types'
export { RUNTIME_KINDS, validateRuntimeKind, isRuntimeKind } from './types'
export { resolveAdapter, adapterRegistry } from './adapter-registry'
