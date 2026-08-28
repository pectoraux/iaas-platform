// =============================================================================
// ActiveExecutionRegistry — IAAS-DOM-ARCH-5 / WORK-021 (AR-021-17 fix)
// =============================================================================
// The AUTHORITATIVE in-process registry of active sandbox executions. It closes
// the AR-021-17 gap: an extension revoked in the ExtensionRegistry catalog must
// never leave an already-running sandbox execution alive.
//
// Frozen V5 §2.5 contract:
//   "revoked: terminal state; future execution denied and active context
//    terminated."
//
// AUTHORITATIVE CONTROL PATH (the AR-021-17 required correction):
//
//   ExtensionRuntime.executeExtension (sandbox path)
//       │  begin → executeWithHandle → attach   (one synchronous block)
//       ↓
//   ActiveExecutionRegistry:  executionId → SandboxExecutionHandle
//       ↑ attach / end (completion)
//   ExtensionRegistry.revokeExtension(...) / transitionLifecycle(→ revoked)
//       │  durable DB update, then SYNCHRONOUS termination hook
//       ↓
//   ActiveExecutionRegistry.revokeActiveExecutionsForExtension(...)
//       ↓
//   SandboxExecutionHandle.revoke()  →  subprocess termination
//
// Before this registry the Runtime held the execution handle in a LOCAL
// variable: `registry revoke → handle.revoke()` did not exist as a control
// path, so an extension could be revoked in the catalog while an
// already-running sandbox continued until its own timeout/resource limit.
//
// RACE SAFETY — the AR-021-17 guarantee:
//   "a revoke occurring before, during, or immediately after execution
//    registration must never leave an active sandbox alive after the registry
//    is durably revoked."
//
// Node.js executes synchronous functions atomically with respect to each other
// (single-threaded event loop; no await inside any registry operation). The
// three interleavings are therefore closed WITHOUT locks:
//
//   1. Revoke BEFORE registration:
//      revokeActiveExecutionsForExtension() marks the extension in the
//      revoked-execution ledger; every subsequent beginSandboxExecution() for
//      that (tenantId, extensionType, extensionVersion) is REFUSED. No sandbox
//      is ever spawned (V5 §2.5 "future execution denied").
//
//   2. Revoke DURING registration (between begin and attach):
//      The entry already exists in the registry when the hook runs, so the
//      hook marks it `terminateRequested`. When the handle is attached
//      (attachSandboxHandle), the registry revokes it IMMEDIATELY — the
//      termination is initiated in the same synchronous block as the spawn.
//      (In the current Runtime the begin → executeWithHandle → attach sequence
//      is itself synchronous, so this window is zero-length there; the defense
//      exists for any SandboxHost implementation that defers spawning.)
//
//   3. Revoke AFTER registration (execution running):
//      The hook finds the entry with its attached handle and calls
//      handle.revoke() directly → SIGTERM (+ SIGKILL escalation owned by the
//      sandbox host) → SandboxTerminatedError('revoked') → failed provenance.
//
// The hook is invoked by ExtensionRegistry synchronously AFTER the durable
// database update that records revocation, so any registration that raced with
// the update either (a) is already in the registry — terminated now — or
// (b) runs after the ledger mark — refused at registration. There is no
// interleaving in which a sandbox survives a durable revoke.
//
// Architectural boundaries (frozen by IAAS-DOM-ARCH-5 / WORK-021):
//   - Service-layer, NOT kernel (this module is in src/lib/services/).
//   - Does NOT own catalog/lifecycle state (that is ExtensionRegistry).
//   - Does NOT execute extensions (that is ExtensionRuntime).
//   - Does NOT implement sandbox technology (that is SandboxHost).
//   - Owns ONLY the lifecycle of active execution handles: registration,
//     attachment, termination bookkeeping, and completion.
//   - Termination is DELEGATED through SandboxExecutionHandle.revoke() — the
//     V5 §2.5 architectural termination abstraction is preserved (no
//     runtime-specific API is frozen here).
//
// Scope note (honest limitation): this registry is in-process. Extension
// revocation is durable across process restarts (PostgreSQL), and new
// executions are denied by the ExtensionRuntime lifecycle gate reading the
// durable state; executions running in OTHER processes are terminated by those
// processes' own registries when the revocation command reaches them. Within
// THIS process the guarantee above is airtight.
// =============================================================================

import { randomUUID } from 'node:crypto'
import type { SandboxExecutionHandle } from '@/lib/services/sandbox-host.service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Identity of the extension whose sandbox execution is being registered. */
export interface ActiveExecutionDescriptor {
  tenantId: string
  extensionType: string
  extensionVersion: string
  /** The execution idempotency key supplied by the caller (observability). */
  idempotencyKey: string
}

/** Immutable view of a registered active execution (introspection/audit). */
export interface ActiveExecutionRecord extends ActiveExecutionDescriptor {
  executionId: string
  /** ISO timestamp of registration (before the sandbox was spawned). */
  beganAt: string
  /**
   * 'starting'  — registered, sandbox not yet spawned/attached;
   * 'active'    — handle attached, sandbox execution in flight;
   * 'terminating' — termination requested (via the authoritative hook or a
   *                 direct per-execution revoke); completion pending.
   */
  state: 'starting' | 'active' | 'terminating'
}

/** Result of a race-safe registration attempt. */
export type BeginSandboxExecutionResult =
  | { ok: true; executionId: string }
  | {
      ok: false
      refusalReason: 'extension_revoked'
      reason: string
    }

/** Result of attaching a handle to a registered execution. */
export type AttachSandboxHandleResult =
  | 'attached'
  | 'attached-and-revoked'
  | 'unknown-execution'

/** Result of the authoritative termination hook. */
export interface RevokeActiveExecutionsResult {
  /**
   * Every execution of the extension that was terminated immediately (handle
   * attached → handle.revoke() called) or marked for termination at attach
   * (registered but not yet attached). None of these executions survives the
   * durable revocation.
   */
  executionIds: string[]
}

// ---------------------------------------------------------------------------
// Registry state (module-level singleton state)
// ---------------------------------------------------------------------------

interface RegistryEntry {
  descriptor: ActiveExecutionDescriptor
  handle: SandboxExecutionHandle | null
  terminateRequested: boolean
  beganAt: Date
}

const executions = new Map<string, RegistryEntry>()

/**
 * The revoked-execution ledger: (tenantId, extensionType, extensionVersion)
 * triples whose extension reached the durable `revoked` lifecycle state during
 * this process's lifetime. Guards registration against the revoke/registration
 * race: once marked, beginSandboxExecution refuses the extension forever
 * (revocation is terminal — there is no un-revoke transition).
 */
const revokedExtensionLedger = new Set<string>()

function extensionKey(tenantId: string, extensionType: string, extensionVersion: string): string {
  return `${tenantId}|${extensionType}|${extensionVersion}`
}

// ---------------------------------------------------------------------------
// Registration (called by ExtensionRuntime BEFORE the sandbox is spawned)
// ---------------------------------------------------------------------------

/**
 * Register an active sandbox execution BEFORE the sandbox is spawned.
 *
 * Atomic (synchronous) two-step: (1) refuse if the extension is in the
 * revoked-execution ledger (a durable revoke raced with this registration);
 * (2) insert the entry in state 'starting' (no handle yet).
 *
 * The caller MUST pair every successful begin with endSandboxExecution()
 * (in a finally block) and MUST call attachSandboxHandle() as soon as the
 * SandboxHost returns the execution handle — in the same synchronous block as
 * the spawn whenever possible.
 */
export function beginSandboxExecution(
  descriptor: ActiveExecutionDescriptor,
): BeginSandboxExecutionResult {
  const key = extensionKey(descriptor.tenantId, descriptor.extensionType, descriptor.extensionVersion)
  if (revokedExtensionLedger.has(key)) {
    return {
      ok: false,
      refusalReason: 'extension_revoked',
      reason:
        `extension ${descriptor.extensionType}@${descriptor.extensionVersion} is durably revoked ` +
        '(active-execution registry ledger; V5 §2.5 — future execution denied and active context terminated)',
    }
  }
  const executionId = `sandbox-exec-${randomUUID()}`
  executions.set(executionId, {
    descriptor: { ...descriptor },
    handle: null,
    terminateRequested: false,
    beganAt: new Date(),
  })
  return { ok: true, executionId }
}

// ---------------------------------------------------------------------------
// Handle attachment (called by ExtensionRuntime right after the spawn)
// ---------------------------------------------------------------------------

/**
 * Attach the SandboxExecutionHandle returned by SandboxHost.executeWithHandle()
 * to its registered execution.
 *
 * If the authoritative termination hook fired between registration and this
 * attachment (the revoke-during-registration window), the handle is revoked
 * IMMEDIATELY — the termination is initiated in the same synchronous block as
 * the spawn, so the sandbox cannot make progress while revoked.
 *
 * Returns:
 *   'attached'              — normal attachment;
 *   'attached-and-revoked'  — a revoke was requested during registration, the
 *                             handle has been revoked at attach;
 *   'unknown-execution'     — the execution already ended (attach after end).
 */
export function attachSandboxHandle(
  executionId: string,
  handle: SandboxExecutionHandle,
): AttachSandboxHandleResult {
  const entry = executions.get(executionId)
  if (!entry) return 'unknown-execution'
  entry.handle = handle
  if (entry.terminateRequested) {
    // A durable revoke already reached this execution while it was starting.
    // Terminate it NOW — this is the race-closure for the registration window.
    handle.revoke()
    return 'attached-and-revoked'
  }
  return 'attached'
}

// ---------------------------------------------------------------------------
// Completion (called by ExtensionRuntime in a finally block)
// ---------------------------------------------------------------------------

/**
 * Remove a finished execution from the registry. Called when the execution's
 * result settles (success, failure, or termination). After this call the
 * execution is no longer revocable (there is nothing left to terminate).
 */
export function endSandboxExecution(executionId: string): void {
  executions.delete(executionId)
}

// ---------------------------------------------------------------------------
// Per-execution revocation
// ---------------------------------------------------------------------------

/**
 * Revoke a single active execution by executionId (administrative kill-switch
 * for one execution — does NOT mark the extension revoked; extension-level
 * revocation is revokeActiveExecutionsForExtension).
 *
 * Returns true if the execution was registered (and is now terminated or
 * marked for termination at attach); false if it was not registered (already
 * finished or never begun).
 */
export function revokeActiveExecution(executionId: string): boolean {
  const entry = executions.get(executionId)
  if (!entry) return false
  terminateEntry(entry)
  return true
}

// ---------------------------------------------------------------------------
// The authoritative extension-level termination hook (called by
// ExtensionRegistry.revokeExtension / transitionLifecycle → revoked)
// ---------------------------------------------------------------------------

/**
 * The AR-021-17 termination hook. Marks the extension in the revoked-execution
 * ledger (future registrations refused) and terminates EVERY active sandbox
 * execution of that extension — synchronously, so no sandbox survives the
 * durable revocation.
 *
 * MUST be called by ExtensionRegistry AFTER the durable database update that
 * records the revoked lifecycle state, with NO await in between (the durable
 * revocation and this hook must be observationally atomic with respect to new
 * registrations).
 */
export function revokeActiveExecutionsForExtension(
  tenantId: string,
  extensionType: string,
  extensionVersion: string,
): RevokeActiveExecutionsResult {
  // 1. Ledger mark FIRST — atomically with the map scan below (synchronous
  //    block). Any registration that runs after this point is refused.
  revokedExtensionLedger.add(extensionKey(tenantId, extensionType, extensionVersion))

  // 2. Terminate every registered execution of this extension.
  const executionIds: string[] = []
  for (const [executionId, entry] of executions) {
    const d = entry.descriptor
    if (
      d.tenantId === tenantId
      && d.extensionType === extensionType
      && d.extensionVersion === extensionVersion
    ) {
      terminateEntry(entry)
      executionIds.push(executionId)
    }
  }
  return { executionIds }
}

/** Terminate one registry entry: revoke an attached handle, or mark a
 *  still-starting execution so attachSandboxHandle() revokes it at attach. */
function terminateEntry(entry: RegistryEntry): void {
  entry.terminateRequested = true
  if (entry.handle && !entry.handle.isRevoked()) {
    // handle.revoke() is idempotent at the host; the isRevoked() guard makes
    // repeated termination hooks (e.g. revokeExtension after a lifecycle
    // transition already revoked) a true no-op.
    entry.handle.revoke()
  }
  // No handle yet → the revoke is recorded (terminateRequested); the attach
  // call revokes the handle the moment the sandbox host returns it.
}

// ---------------------------------------------------------------------------
// Introspection (tests + operational observability)
// ---------------------------------------------------------------------------

/** Look up one active execution by id (undefined when not registered). */
export function getActiveExecution(executionId: string): ActiveExecutionRecord | undefined {
  const entry = executions.get(executionId)
  return entry ? toRecord(executionId, entry) : undefined
}

/** List registered executions, optionally filtered by extension identity. */
export function listActiveExecutions(
  filter?: { tenantId?: string; extensionType?: string; extensionVersion?: string },
): ActiveExecutionRecord[] {
  const out: ActiveExecutionRecord[] = []
  for (const [executionId, entry] of executions) {
    const d = entry.descriptor
    if (filter?.tenantId !== undefined && d.tenantId !== filter.tenantId) continue
    if (filter?.extensionType !== undefined && d.extensionType !== filter.extensionType) continue
    if (filter?.extensionVersion !== undefined && d.extensionVersion !== filter.extensionVersion) continue
    out.push(toRecord(executionId, entry))
  }
  return out
}

/** Whether the extension is marked durably revoked in this process's ledger. */
export function isExtensionMarkedRevoked(
  tenantId: string,
  extensionType: string,
  extensionVersion: string,
): boolean {
  return revokedExtensionLedger.has(extensionKey(tenantId, extensionType, extensionVersion))
}

function toRecord(executionId: string, entry: RegistryEntry): ActiveExecutionRecord {
  return {
    executionId,
    tenantId: entry.descriptor.tenantId,
    extensionType: entry.descriptor.extensionType,
    extensionVersion: entry.descriptor.extensionVersion,
    idempotencyKey: entry.descriptor.idempotencyKey,
    beganAt: entry.beganAt.toISOString(),
    state: entry.terminateRequested ? 'terminating' : entry.handle ? 'active' : 'starting',
  }
}

// ---------------------------------------------------------------------------
// Test helper — reset registry state for test isolation ONLY
// ---------------------------------------------------------------------------

/**
 * Test helper: reset the registry (executions + revoked ledger). Production
 * code must NEVER call this — the revoked ledger is a safety mechanism whose
 * integrity must not be reset while the process lives.
 */
export function __resetActiveExecutionRegistryForTesting(): void {
  executions.clear()
  revokedExtensionLedger.clear()
}
