// =============================================================================
// Kernel: Runtime Registry (Phase 5)
// =============================================================================
// The RuntimeRegistry maps a RuntimeKind to a concrete NetworkRuntime
// implementation. It is the single point of resolution: given a
// NetworkVersion's runtimeKind, the registry returns the runtime that
// executes work for that version.
//
// KEY INVARIANT:
//   Every active NetworkVersion resolves to exactly one runtime.
//   If the runtimeKind is not registered, resolution throws — there is
//   no silent fallback. This ensures a version with an unknown runtimeKind
//   cannot execute at all, rather than silently using the wrong runtime.
//
// The registry is a singleton, initialized at module load with the three
// canonical runtimes (infrastructure, protocol, hybrid). Verticals never
// register runtimes — runtimes are kernel-level, registered once.
// =============================================================================

import type { NetworkRuntime, RuntimeKind } from './types'

// ---------------------------------------------------------------------------
// RuntimeRegistry
// ---------------------------------------------------------------------------

export class RuntimeRegistry {
  private readonly runtimes = new Map<RuntimeKind, NetworkRuntime>()

  /**
   * Register a runtime implementation for a kind.
   * Called once at module initialization for each canonical runtime.
   * Throws if a runtime is already registered for this kind (defends
   * against accidental double-registration).
   */
  register(runtime: NetworkRuntime): void {
    if (this.runtimes.has(runtime.kind)) {
      throw new Error(
        `Runtime already registered for kind '${runtime.kind}'. ` +
          `A runtime kind can only be registered once.`,
      )
    }
    this.runtimes.set(runtime.kind, runtime)
  }

  /**
   * Resolve a runtime kind to its concrete implementation.
   *
   * THROWS if no runtime is registered for the given kind. There is NO
   * silent fallback — a version with an unregistered runtimeKind cannot
   * execute. This is the key invariant: every active NetworkVersion
   * resolves to exactly one runtime, or it doesn't execute at all.
   */
  resolve(kind: RuntimeKind): NetworkRuntime {
    const runtime = this.runtimes.get(kind)
    if (!runtime) {
      throw new Error(
        `No runtime registered for kind '${kind}'. ` +
          `Registered kinds: ${Array.from(this.runtimes.keys()).join(', ')}. ` +
          `A NetworkVersion with this runtimeKind cannot execute.`,
      )
    }
    return runtime
  }

  /**
   * Check if a runtime is registered for the given kind.
   * Used by validation logic (not by execution paths — those use resolve()).
   */
  has(kind: RuntimeKind): boolean {
    return this.runtimes.has(kind)
  }

  /**
   * List all registered runtime kinds. For diagnostics/testing.
   */
  registeredKinds(): RuntimeKind[] {
    return Array.from(this.runtimes.keys())
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

/**
 * The global RuntimeRegistry singleton. Initialized once with the three
 * canonical runtimes. Verticals import this to resolve runtimes; the kernel
 * registers runtimes here at module load.
 */
export const runtimeRegistry = new RuntimeRegistry()
