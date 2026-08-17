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

  // Phase 11B: Crash recovery + C3 index setup.
  // - ensureC3UniqueIndex: creates the partial unique index on
  //   ReconciliationAttempt(evidenceId) WHERE status='PENDING'. This is
  //   race-proof under PostgreSQL (Defect 5 fix). No-op for in-memory.
  // - recoverPending: resolves any PENDING attempts left over from a previous
  //   process crash (spec §6.3). Safe no-op when none exist.
  const { runtimeRegistry } = await import('@/lib/kernel/runtime')
  const { HybridRuntime } = await import('@/lib/kernel/runtime/hybrid-runtime')
  const hybridRuntime = runtimeRegistry.resolve('hybrid')
  if (hybridRuntime instanceof HybridRuntime) {
    // Defect 5 fix: ensure the partial unique index exists before recovery.
    // For Postgres this runs CREATE UNIQUE INDEX IF NOT EXISTS (race-proof C3).
    // For in-memory this is a no-op.
    await hybridRuntime.reconciliationStore.ensureC3UniqueIndex()
    // Spec §6.3: resolve any PENDING attempts left over from a previous crash.
    await hybridRuntime.recoverPending()
  }
}
