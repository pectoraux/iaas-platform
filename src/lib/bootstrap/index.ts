// =============================================================================
// Bootstrap: Application Composition Root (Phase 6.3, hardened Phase 7.3)
// =============================================================================
// This is the APPLICATION-LEVEL composition root. It provides an explicit
// `initializeBootstrap()` function that:
//   1. Registers all concrete adapters with the generic AdapterRegistry.
//   2. Constructs InfrastructureRuntime(adapterRegistry) — dependency injection.
//   3. Registers InfrastructureRuntime, ProtocolRuntime, HybridRuntime with
//      the RuntimeRegistry.
//
// DEPENDENCY DIRECTION:
//   kernel (AdapterRegistry, RuntimeRegistry, InfrastructureAdapter interface)
//     ↑
//   bootstrap/index.ts (THIS — exports initializeBootstrap)
//     ↑
//   instrumentation.ts (Next.js server startup) / tests
//
// The VPP service does NOT import this module. The VPP service is completely
// unaware that an adapter registry or runtime registry needs initialization.
// The application (not the vertical) owns composition.
//
// Phase 6.3 — NO IMPLICIT SIDE EFFECTS:
//   Importing this module does NOT register anything. Registration only
//   happens when `initializeBootstrap()` is explicitly called.
//
// Phase 7.3 — DEPENDENCY INJECTION:
//   InfrastructureRuntime is constructed with the AdapterRegistry instance,
//   not imported as a global. This makes the runtime testable with an
//   isolated registry.
//
// Explicit initialization graph:
//
//   Application startup (instrumentation.ts → register())
//       ↓
//   bootstrap/index.ts (initializeBootstrap — explicit call)
//       ↓
//   adapters.ts (registerAdapters → AdapterRegistry populated)
//       ↓
//   InfrastructureRuntime(adapterRegistry) constructed
//       ↓
//   RuntimeRegistry (InfrastructureRuntime + ProtocolRuntime + HybridRuntime)
//       ↓
//   VPP service (uses resolveRuntime → InfrastructureRuntime)
// =============================================================================

import { registerAdapters } from './adapters'
import { adapterRegistry } from '@/lib/kernel/runtime/adapter-registry'
import { runtimeRegistry } from '@/lib/kernel/runtime/registry'
import { InfrastructureRuntime } from '@/lib/kernel/runtime/infrastructure-runtime'
import { ProtocolRuntime } from '@/lib/kernel/runtime/protocol-runtime'
import { HybridRuntime } from '@/lib/kernel/runtime/hybrid-runtime'

let initialized = false

/**
 * Initialize the application bootstrap.
 *
 * Idempotent — safe to call multiple times.
 *
 * 1. Registers concrete adapters (SimulatedDERAdapter) with AdapterRegistry.
 * 2. Constructs InfrastructureRuntime(adapterRegistry) — dependency injection.
 * 3. Registers InfrastructureRuntime, ProtocolRuntime, HybridRuntime with
 *    RuntimeRegistry.
 *
 * Called by:
 *   - src/instrumentation.ts (Next.js server startup, production)
 *   - tests (directly, as their own composition root)
 *
 * NOT called by:
 *   - vertical services (VPP, future compute/storage verticals)
 *   - the kernel/runtime layer
 *   - merely importing this module (Phase 6.3: no implicit side effects)
 */
export function initializeBootstrap(): void {
  if (initialized) return

  // 1. Register concrete adapters.
  registerAdapters()

  // 2. Construct InfrastructureRuntime with the populated adapter registry.
  //    Phase 7.3: dependency injection — the runtime receives the registry
  //    instance rather than importing the global singleton.
  const infrastructureRuntime = new InfrastructureRuntime(adapterRegistry)

  // 3. Register all three runtimes with the RuntimeRegistry.
  runtimeRegistry.register(infrastructureRuntime)
  runtimeRegistry.register(new ProtocolRuntime())
  runtimeRegistry.register(new HybridRuntime())

  initialized = true
}

// Phase 6.3: NO module-scope call to initializeBootstrap().
// Importing this module is a pure import — it does not mutate global state.
// The caller MUST explicitly call initializeBootstrap().
