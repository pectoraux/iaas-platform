// =============================================================================
// ActiveExecutionRegistry — IAAS-DOM-ARCH-5 / WORK-021 (AR-021-17 fix)
//                         + WORK-022 (V5 §2.5 deactivation semantics)
// =============================================================================
// The AUTHORITATIVE in-process registry of active sandbox executions. It closes
// the AR-021-17 gap: an extension revoked in the ExtensionRegistry catalog must
// never leave an already-running sandbox execution alive.
//
// Frozen V5 §2.5 contract:
//   "revoked: terminal state; future execution denied and active context
//    terminated."
//   "deactivated: active execution context terminated/deactivated."
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
// WORK-022 — the SAME authoritative control path serves DEACTIVATION:
//
//   ExtensionRegistry.transitionLifecycle(→ deactivated)
//       │  durable DB update, then SYNCHRONOUS termination hook
//       ↓
//   ActiveExecutionRegistry.deactivateActiveExecutionsForExtension(...)
//       │   (marks the REVERSIBLE deactivation ledger + terminates every
//       │    active SandboxExecutionHandle of this extension)
//       ↓
//   SandboxExecutionHandle.revoke()  →  termination
//
//   ExtensionRegistry.transitionLifecycle(deactivated → activated)
//       │  durable DB update, then SYNCHRONOUS re-activation hook
//       ↓
//   ActiveExecutionRegistry.reactivateExtension(...)
//       → clears the deactivation ledger mark (execution permitted again)
//
// Deactivation is REVERSIBLE and therefore uses a ledger of its own, DISTINCT
// from the terminal revoked-execution ledger: the revoked ledger refuses
// registrations forever (revocation is terminal), while the deactivation
// ledger refuses registrations only until the durable re-activation clears
// it. The terminal revoked-execution ledger is used ONLY by `revoked`.
//
// Before this registry the Runtime held the execution handle in a LOCAL
// variable: `registry revoke → handle.revoke()` did not exist as a control
// path, so an extension could be revoked in the catalog while an
// already-running sandbox continued until its own timeout/resource limit.
//
// RACE SAFETY — the AR-021-17 guarantee (revocation):
//   "a revoke occurring before, during, or immediately after execution
//    registration must never leave an active sandbox alive after the registry
//    is durably revoked."
//
// RACE SAFETY — the WORK-022 symmetric guarantee (deactivation):
//   a deactivation occurring before, during, or immediately after execution
//   registration must never leave an active sandbox running for an extension
//   that is durably deactivated. The deactivation ledger refuses registrations
//   exactly like the revoked ledger — except re-activation CLEARS it (the
//   deactivation is reversible; the revocation is not).
//
// Node.js executes synchronous functions atomically with respect to each other
// (single-threaded event loop; no await inside any registry operation). The
// three interleavings are therefore closed WITHOUT locks:
//
//   1. Revoke/deactivate BEFORE registration:
//      revokeActiveExecutionsForExtension() marks the extension in the
//      revoked-execution ledger; every subsequent beginSandboxExecution() for
//      that (tenantId, extensionType, extensionVersion) is REFUSED. No sandbox
//      is ever spawned (V5 §2.5 "future execution denied").
//      deactivateActiveExecutionsForExtension() marks the extension in the
//      REVERSIBLE deactivation ledger; subsequent registrations are refused
//      with 'extension_deactivated' until re-activation clears the mark.
//
//   2. Revoke/deactivate DURING registration (between begin and attach):
//      The entry already exists in the registry when the hook runs, so the
//      hook marks it `terminateRequested`. When the handle is attached
//      (attachSandboxHandle), the registry revokes it IMMEDIATELY — the
//      termination is initiated in the same synchronous block as the spawn.
//      (In the current Runtime the begin → executeWithHandle → attach sequence
//      is itself synchronous, so this window is zero-length there; the defense
//      exists for any SandboxHost implementation that defers spawning.)
//
//   3. Revoke/deactivate AFTER registration (execution running):
//      The hook finds the entry with its attached handle and calls
//      handle.revoke() directly → SIGTERM (+ SIGKILL escalation owned by the
//      sandbox host) → SandboxTerminatedError('revoked') → failed provenance.
//      (The handle-revocation cause 'revoked' is the V5 §2.5 termination
//      abstraction's recorded cause for ANY SandboxExecutionHandle.revoke()
//      call — deactivation terminates through the SAME architectural
//      abstraction and therefore records the SAME explicit cause. No new
//      termination-cause vocabulary is introduced — WORK-022 leaves the
//      provenance schema semantics untouched.)
//
// The hook is invoked by ExtensionRegistry synchronously AFTER the durable
// database update that records the lifecycle transition, so any registration
// that raced with the update either (a) is already in the registry —
// terminated now — or (b) runs after the ledger mark — refused at registration.
// There is no interleaving in which a sandbox survives a durable revoke or a
// durable deactivation.
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
      /** 'extension_revoked' — terminal ledger (V5 §2.5 revoked); refused forever.
       *  'extension_deactivated' — reversible ledger (V5 §2.5 deactivated);
       *    refused until durable re-activation clears the mark (WORK-022). */
      refusalReason: 'extension_revoked' | 'extension_deactivated'
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

/** Result of the authoritative deactivation hook (WORK-022). */
export interface DeactivateActiveExecutionsResult {
  /**
   * Every execution of the extension terminated by the deactivation (handle
   * attached → handle.revoke() called) or marked for termination at attach.
   * None of these executions survives the durable deactivation.
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

/**
 * WORK-022 — the deactivation ledger: (tenantId, extensionType,
 * extensionVersion) triples whose extension is CURRENTLY durably deactivated.
 * Guards registration against the deactivate/registration race with the SAME
 * synchronous-mark pattern as the revoked ledger — but is REVERSIBLE: the
 * durable deactivated → activated transition clears the mark (via
 * reactivateExtension), after which registrations are permitted again.
 *
 * This ledger is DISTINCT from the terminal revoked-execution ledger: the
 * terminal ledger is used ONLY by `revoked` (W022-AC02). Deactivation NEVER
 * writes it.
 */
const deactivatedExtensionLedger = new Set<string>()

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
  // Terminal ledger FIRST: a revoked extension is refused forever, regardless
  // of any deactivation mark (revoked is terminal; deactivated is reversible).
  if (revokedExtensionLedger.has(key)) {
    return {
      ok: false,
      refusalReason: 'extension_revoked',
      reason:
        `extension ${descriptor.extensionType}@${descriptor.extensionVersion} is durably revoked ` +
        '(active-execution registry ledger; V5 §2.5 — future execution denied and active context terminated)',
    }
  }
  // WORK-022 — reversible deactivation ledger: refuse registrations for a
  // durably deactivated extension until re-activation clears the mark. This
  // closes the deactivate/registration race symmetrically to AR-021-17: an
  // execution whose catalog read predated the durable deactivation cannot
  // spawn a sandbox that outlives it.
  if (deactivatedExtensionLedger.has(key)) {
    return {
      ok: false,
      refusalReason: 'extension_deactivated',
      reason:
        `extension ${descriptor.extensionType}@${descriptor.extensionVersion} is durably deactivated ` +
        '(active-execution registry deactivation ledger; V5 §2.5 — active execution context terminated; ' +
        'reversible via the deactivated → activated lifecycle transition)',
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
// The authoritative extension-level DEACTIVATION hook (called by
// ExtensionRegistry.transitionLifecycle → deactivated) — WORK-022, V5 §2.5
// ---------------------------------------------------------------------------

/**
 * WORK-022 — the deactivation termination hook. Marks the extension in the
 * REVERSIBLE deactivation ledger (registrations refused until re-activation)
 * and terminates EVERY active sandbox execution of that extension —
 * synchronously, so no sandbox execution outlives the durable deactivation.
 *
 * MUST be called by ExtensionRegistry AFTER the durable database update that
 * records the deactivated lifecycle state, with NO await in between (the
 * durable deactivation and this hook must be observationally atomic with
 * respect to new registrations).
 *
 * NEVER touches the terminal revoked-execution ledger — that ledger is used
 * ONLY by `revoked` (W022-AC02). Termination goes through the SAME
 * architectural abstraction as revocation: SandboxExecutionHandle.revoke().
 */
export function deactivateActiveExecutionsForExtension(
  tenantId: string,
  extensionType: string,
  extensionVersion: string,
): DeactivateActiveExecutionsResult {
  // 1. Deactivation-ledger mark FIRST — atomically with the map scan below
  //    (synchronous block). Any registration that runs after this point is
  //    refused until re-activation.
  deactivatedExtensionLedger.add(extensionKey(tenantId, extensionType, extensionVersion))

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

/**
 * WORK-022 — the re-activation hook. Clears the extension's deactivation-ledger
 * mark so registrations are permitted again.
 *
 * MUST be called by ExtensionRegistry AFTER the durable database update that
 * records the deactivated → activated transition, with NO await in between —
 * the durable re-activation and this hook must be observationally atomic with
 * respect to new registrations (the mirror image of the deactivation hook).
 *
 * Idempotent: clearing an unmarked extension is a no-op. NEVER clears the
 * terminal revoked-execution ledger (revocation is irreversible).
 */
export function reactivateExtension(
  tenantId: string,
  extensionType: string,
  extensionVersion: string,
): void {
  deactivatedExtensionLedger.delete(extensionKey(tenantId, extensionType, extensionVersion))
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

/** Whether the extension is currently marked deactivated (reversible) in this
 *  process's deactivation ledger (WORK-022). */
export function isExtensionMarkedDeactivated(
  tenantId: string,
  extensionType: string,
  extensionVersion: string,
): boolean {
  return deactivatedExtensionLedger.has(extensionKey(tenantId, extensionType, extensionVersion))
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
 * Test helper: reset the registry (executions + both ledgers). Production
 * code must NEVER call this — the ledgers are safety mechanisms whose
 * integrity must not be reset while the process lives.
 */
export function __resetActiveExecutionRegistryForTesting(): void {
  executions.clear()
  revokedExtensionLedger.clear()
  deactivatedExtensionLedger.clear()
}
