// =============================================================================
// Bootstrap: Application Composition Root (Phase 6.3)
// =============================================================================
// This is the APPLICATION-LEVEL composition root. It provides an explicit
// `initializeBootstrap()` function that registers all concrete adapters with
// the generic AdapterRegistry.
//
// DEPENDENCY DIRECTION:
//   kernel (AdapterRegistry, InfrastructureAdapter interface)
//     ↑
//   bootstrap/index.ts (THIS — exports initializeBootstrap)
//     ↑
//   instrumentation.ts (Next.js server startup) / tests
//
// The VPP service does NOT import this module. The VPP service is completely
// unaware that an adapter registry needs initialization. The application
// (not the vertical) owns composition.
//
// Phase 6.3 — NO IMPLICIT SIDE EFFECTS:
//   Importing this module does NOT register adapters. The registration only
//   happens when `initializeBootstrap()` is explicitly called. This eliminates
//   the last hidden initialization coupling: a worker, CLI, migration, or test
//   helper that merely imports the bootstrap to access a helper will NOT
//   mutate the global adapter registry.
//
//   The ONLY production caller is src/instrumentation.ts (Next.js server
//   startup). Tests call it explicitly as their own composition root.
//
// Explicit initialization graph:
//
//   Application startup (instrumentation.ts → register())
//       ↓
//   bootstrap/index.ts (initializeBootstrap — explicit call)
//       ↓
//   adapters.ts (registerAdapters)
//       ↓
//   AdapterRegistry (now populated)
//       ↓
//   InfrastructureRuntime / VPP service (use the populated registry)
// =============================================================================

import { registerAdapters } from './adapters'

let initialized = false

/**
 * Initialize the application bootstrap.
 *
 * Idempotent — safe to call multiple times. Registers all concrete adapters
 * with the generic AdapterRegistry.
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
  registerAdapters()
  initialized = true
}

// Phase 6.3: NO module-scope call to initializeBootstrap().
// Importing this module is a pure import — it does not mutate global state.
// The caller MUST explicitly call initializeBootstrap().

