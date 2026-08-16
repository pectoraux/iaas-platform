// =============================================================================
// Next.js Instrumentation — Application Startup Hook (Phase 6.2)
// =============================================================================
// This file is automatically loaded by Next.js once when the server starts
// (in production). It is the APPLICATION ENTRY POINT that initializes the
// composition root before any request handler or worker runs.
//
// See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
//
// This is where the AdapterRegistry gets populated. The VPP service and the
// InfrastructureRuntime do NOT import the bootstrap — they receive a
// pre-populated registry from the application startup.
// =============================================================================

/**
 * Called once by Next.js when the server starts.
 *
 * Registers all concrete adapters with the generic AdapterRegistry. After
 * this returns, the registry is fully populated and any code path that calls
 * resolveAdapter() will resolve correctly.
 */
export async function register(): Promise<void> {
  // Dynamic import to avoid loading the bootstrap in edge/worker contexts
  // that don't need it. The import is a side-effect + explicit init call.
  const { initializeBootstrap } = await import('@/lib/bootstrap')
  initializeBootstrap()
}
