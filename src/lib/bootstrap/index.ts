// =============================================================================
// Bootstrap: Application Composition Root (Phase 6.2)
// =============================================================================
// This is the APPLICATION-LEVEL composition root. It is called once at
// application startup (via src/instrumentation.ts in production, or imported
// directly by tests). It registers all concrete adapters with the generic
// AdapterRegistry.
//
// DEPENDENCY DIRECTION:
//   kernel (AdapterRegistry, InfrastructureAdapter interface)
//     ↑
//   bootstrap/index.ts (THIS — calls registerAdapters())
//     ↑
//   instrumentation.ts (Next.js server startup) / tests
//
// The VPP service does NOT import this module. The VPP service is completely
// unaware that an adapter registry needs initialization. The application
// (not the vertical) owns composition.
//
// This is the explicit initialization graph:
//
//   Application startup (instrumentation.ts)
//       ↓
//   bootstrap/index.ts (initializeBootstrap)
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
 */
export function initializeBootstrap(): void {
  if (initialized) return
  registerAdapters()
  initialized = true
}

// Auto-initialize on module load. This ensures that any code path that
// imports this module (directly or via instrumentation) gets a populated
// registry. Tests and instrumentation.ts can also call initializeBootstrap()
// explicitly to express intent.
initializeBootstrap()
