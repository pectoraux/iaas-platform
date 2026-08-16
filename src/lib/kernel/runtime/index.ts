// =============================================================================
// Kernel: Runtime Registry Initialization (Phase 5)
// =============================================================================
// This module registers all canonical runtimes with the RuntimeRegistry
// singleton. It is imported once at application startup (via the VPP service
// or any other vertical that needs to resolve a runtime).
//
// The registry is initialized with three runtimes:
//   - InfrastructureRuntime (fully implemented — the current execution model)
//   - ProtocolRuntime (stub — Phase 9)
//   - HybridRuntime (stub — Phase 10)
//
// Verticals import `resolveRuntime` from this module to resolve a
// NetworkVersion's runtimeKind to a concrete NetworkRuntime. They never
// touch the registry directly.
// =============================================================================

import { runtimeRegistry } from './registry'
import { InfrastructureRuntime } from './infrastructure-runtime'
import { ProtocolRuntime } from './protocol-runtime'
import { HybridRuntime } from './hybrid-runtime'
import type { NetworkRuntime, RuntimeKind } from './types'

// ---------------------------------------------------------------------------
// Register canonical runtimes (once)
// ---------------------------------------------------------------------------

let initialized = false

function ensureRegistered(): void {
  if (initialized) return
  runtimeRegistry.register(new InfrastructureRuntime())
  runtimeRegistry.register(new ProtocolRuntime())
  runtimeRegistry.register(new HybridRuntime())
  initialized = true
}

// Auto-register on module load. This is idempotent (the registry throws on
// double-registration, but this module is only loaded once).
ensureRegistered()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a runtime kind to its concrete NetworkRuntime implementation.
 *
 * This is the ONLY function verticals should call to get a runtime. It
 * ensures the registry is initialized, then resolves.
 *
 * THROWS if the kind is not registered — there is no silent fallback.
 */
export function resolveRuntime(kind: RuntimeKind): NetworkRuntime {
  ensureRegistered()
  return runtimeRegistry.resolve(kind)
}

// Re-export the registry for testing/diagnostics.
export { runtimeRegistry }
export type { NetworkRuntime, RuntimeKind, RuntimeExecuteInput, RuntimeExecuteResult } from './types'
export { RUNTIME_KINDS, validateRuntimeKind, isRuntimeKind } from './types'
export { resolveAdapter, adapterRegistry } from './adapters-init'
