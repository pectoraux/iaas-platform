/// <reference types="bun-types" />
// =============================================================================
// WORK-022 — Sandbox Lifecycle Completion: unit + architecture tests
// =============================================================================
// Verifies the W022-AC01..AC10 slice WITHOUT a database and WITHOUT external
// sandbox tooling:
//
//   - ActiveExecutionRegistry deactivation semantics (W022-AC01/AC02/AC05):
//     the REVERSIBLE deactivation ledger + deactivation termination hook,
//     distinct from the terminal revoked-execution ledger (WORK-021).
//   - Static wiring checks: the deactivation hook fires synchronously AFTER
//     the durable lifecycle update; install-time validation happens BEFORE
//     the durable update (a denied install leaves the entry untouched);
//     WORK-021 revocation wiring is unchanged (Required Verification).
//   - Anti-dependency checks (W022-AC07): no vertical, EconomicPipeline,
//     Route/Transport, RuntimeRegistry, kernel, or catalog-ownership
//     dependency is introduced; the registry does not execute extensions and
//     the runtime does not own lifecycle.
//   - V5 immutability (W022-AC10): IAAS-DOM-ARCH-5 remains FROZEN and its §2.5
//     lifecycle contract is unchanged.
//
// Golden end-to-end chains against real PostgreSQL + real wasmtime live in
// tests/work-022-sandbox-lifecycle-pg.test.ts (CI: postgres-integration-tests).
// =============================================================================

import { describe, expect, test, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  beginSandboxExecution,
  attachSandboxHandle,
  endSandboxExecution,
  revokeActiveExecutionsForExtension,
  deactivateActiveExecutionsForExtension,
  reactivateExtension,
  isExtensionMarkedRevoked,
  isExtensionMarkedDeactivated,
  listActiveExecutions,
  __resetActiveExecutionRegistryForTesting,
} from '../src/lib/services/active-execution-registry.service'
import {
  SandboxTerminatedError,
  DenyByDefaultSandboxHost,
  type SandboxHost,
  type SandboxExecutionHandle,
  type SandboxExecutionResult,
  type SandboxCeiling,
} from '../src/lib/services/sandbox-host.service'

const REPO_ROOT = process.cwd()

function readSrc(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

const TENANT_A = 'tenant-a'
const TENANT_B = 'tenant-b'
const EXT_X = 'w022-ext-x'
const EXT_Y = 'w022-ext-y'
const VERSION = '1.0.0'

beforeEach(() => {
  __resetActiveExecutionRegistryForTesting()
})

// ---------------------------------------------------------------------------
// Fake handles (deterministic; mirror the real host's termination semantics:
// revoke() → SandboxTerminatedError 'revoked')
// ---------------------------------------------------------------------------

class HangingHandle implements SandboxExecutionHandle {
  revokeCalls = 0
  private revoked = false
  readonly result: Promise<SandboxExecutionResult>
  private rejectResult!: (err: Error) => void

  constructor() {
    this.result = new Promise<SandboxExecutionResult>((_resolve, reject) => {
      this.rejectResult = reject
    })
    // Termination rejections must never surface as unhandled rejections in
    // tests that assert only the revocation side effects (same pattern as
    // the WORK-021 PG suite's immediately-attached outcome handlers).
    this.result.catch(() => {})
  }

  revoke(): void {
    if (this.revoked) return // idempotent, mirroring WasmtimeSandboxHost
    this.revoked = true
    this.revokeCalls++
    this.rejectResult(new SandboxTerminatedError(
      'Sandbox execution terminated: revoked via explicit host revocation (fake hanging host)',
      'revoked',
    ))
  }

  isRevoked(): boolean {
    return this.revoked
  }
}

function descriptor(tenantId: string, extensionType: string) {
  return { tenantId, extensionType, extensionVersion: VERSION, idempotencyKey: `k-${Math.random()}` }
}

/** Register + attach a hanging handle; returns the handle for assertions. */
function registerActive(tenantId: string, extensionType: string): HangingHandle {
  const begin = beginSandboxExecution(descriptor(tenantId, extensionType))
  if (!begin.ok) throw new Error(`unexpected registration refusal: ${begin.reason}`)
  const handle = new HangingHandle()
  attachSandboxHandle(begin.executionId, handle)
  return handle
}

// ---------------------------------------------------------------------------
// W022-AC01 — the deactivation hook terminates active executions through the
// authoritative control path (SandboxExecutionHandle.revoke())
// ---------------------------------------------------------------------------

describe('WORK-022 — deactivation terminates active executions (W022-AC01)', () => {
  test('deactivateActiveExecutionsForExtension revokes every attached handle of the extension', () => {
    const h1 = registerActive(TENANT_A, EXT_X)
    const h2 = registerActive(TENANT_A, EXT_X)

    const result = deactivateActiveExecutionsForExtension(TENANT_A, EXT_X, VERSION)

    expect(result.executionIds).toHaveLength(2)
    expect(h1.revokeCalls).toBe(1)
    expect(h2.revokeCalls).toBe(1)
    // Both executions are now in the terminating state.
    const remaining = listActiveExecutions({ tenantId: TENANT_A, extensionType: EXT_X })
    expect(remaining.every(e => e.state === 'terminating')).toBe(true)
  })

  test('termination goes through the §2.5 abstraction: the handle rejects with SandboxTerminatedError (revoked)', async () => {
    const handle = registerActive(TENANT_A, EXT_X)
    const outcome = handle.result.then(
      () => { throw new Error('expected termination') },
      e => e,
    )
    deactivateActiveExecutionsForExtension(TENANT_A, EXT_X, VERSION)
    const err = await outcome
    expect(err).toBeInstanceOf(SandboxTerminatedError)
    expect((err as SandboxTerminatedError).terminationReason).toBe('revoked')
  })

  test('deactivation during the registration window revokes at attach (race closure)', () => {
    // The execution registered but the handle is NOT yet attached when the
    // deactivation hook runs — the mark must terminate it at attach time.
    const begin = beginSandboxExecution(descriptor(TENANT_A, EXT_X))
    if (!begin.ok) throw new Error('unexpected refusal')

    deactivateActiveExecutionsForExtension(TENANT_A, EXT_X, VERSION)

    const handle = new HangingHandle()
    const attachResult = attachSandboxHandle(begin.executionId, handle)
    expect(attachResult).toBe('attached-and-revoked')
    expect(handle.revokeCalls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// W022-AC02 — deactivation is REVERSIBLE and NEVER uses the terminal
// revoked-execution ledger
// ---------------------------------------------------------------------------

describe('WORK-022 — deactivation is reversible and never touches the revoked ledger (W022-AC02)', () => {
  test('deactivation does NOT mark the extension revoked (distinct ledgers)', () => {
    deactivateActiveExecutionsForExtension(TENANT_A, EXT_X, VERSION)
    expect(isExtensionMarkedDeactivated(TENANT_A, EXT_X, VERSION)).toBe(true)
    expect(isExtensionMarkedRevoked(TENANT_A, EXT_X, VERSION)).toBe(false)
  })

  test('registration is refused while deactivated — with the deactivation refusal, not the revocation refusal', () => {
    deactivateActiveExecutionsForExtension(TENANT_A, EXT_X, VERSION)
    const begin = beginSandboxExecution(descriptor(TENANT_A, EXT_X))
    expect(begin.ok).toBe(false)
    if (!begin.ok) {
      expect(begin.refusalReason).toBe('extension_deactivated')
      expect(begin.reason).toContain('deactivated')
    }
  })

  test('re-activation clears the deactivation mark — registration is permitted again', () => {
    deactivateActiveExecutionsForExtension(TENANT_A, EXT_X, VERSION)
    reactivateExtension(TENANT_A, EXT_X, VERSION)
    expect(isExtensionMarkedDeactivated(TENANT_A, EXT_X, VERSION)).toBe(false)
    const begin = beginSandboxExecution(descriptor(TENANT_A, EXT_X))
    expect(begin.ok).toBe(true)
  })

  test('reactivateExtension is idempotent (clearing an unmarked extension is a no-op)', () => {
    reactivateExtension(TENANT_A, EXT_X, VERSION)
    expect(isExtensionMarkedDeactivated(TENANT_A, EXT_X, VERSION)).toBe(false)
  })

  test('reactivateExtension NEVER clears the terminal revoked ledger', () => {
    revokeActiveExecutionsForExtension(TENANT_A, EXT_X, VERSION)
    reactivateExtension(TENANT_A, EXT_X, VERSION)
    expect(isExtensionMarkedRevoked(TENANT_A, EXT_X, VERSION)).toBe(true)
    const begin = beginSandboxExecution(descriptor(TENANT_A, EXT_X))
    expect(begin.ok).toBe(false)
    if (!begin.ok) expect(begin.refusalReason).toBe('extension_revoked')
  })

  test('revocation still dominates a prior deactivation (terminal ledger first)', () => {
    deactivateActiveExecutionsForExtension(TENANT_A, EXT_X, VERSION)
    revokeActiveExecutionsForExtension(TENANT_A, EXT_X, VERSION)
    const begin = beginSandboxExecution(descriptor(TENANT_A, EXT_X))
    expect(begin.ok).toBe(false)
    if (!begin.ok) expect(begin.refusalReason).toBe('extension_revoked')
  })

  test('a stale deactivation mark cannot outlive the terminal state: revocation clears it', () => {
    deactivateActiveExecutionsForExtension(TENANT_A, EXT_X, VERSION)
    // The registry's revoked path: terminal-ledger mark FIRST, then the
    // deactivation-mark cleanup (the extension is terminal, not deactivated).
    revokeActiveExecutionsForExtension(TENANT_A, EXT_X, VERSION)
    reactivateExtension(TENANT_A, EXT_X, VERSION)
    expect(isExtensionMarkedDeactivated(TENANT_A, EXT_X, VERSION)).toBe(false)
    expect(isExtensionMarkedRevoked(TENANT_A, EXT_X, VERSION)).toBe(true)
    // The terminal ledger still refuses registrations forever.
    const begin = beginSandboxExecution(descriptor(TENANT_A, EXT_X))
    expect(begin.ok).toBe(false)
    if (!begin.ok) expect(begin.refusalReason).toBe('extension_revoked')
  })
})

// ---------------------------------------------------------------------------
// W022-AC05 — deactivation is tenant-scoped and extension-scoped
// ---------------------------------------------------------------------------

describe('WORK-022 — deactivation scoping (W022-AC05)', () => {
  test('deactivating tenant A never terminates tenant B executions', () => {
    const handleA = registerActive(TENANT_A, EXT_X)
    const handleB = registerActive(TENANT_B, EXT_X)

    const result = deactivateActiveExecutionsForExtension(TENANT_A, EXT_X, VERSION)

    expect(result.executionIds).toHaveLength(1)
    expect(handleA.revokeCalls).toBe(1)
    expect(handleB.revokeCalls).toBe(0)
    // Tenant B's execution is still active.
    const bActive = listActiveExecutions({ tenantId: TENANT_B, extensionType: EXT_X })
    expect(bActive).toHaveLength(1)
    expect(bActive[0]?.state).toBe('active')
  })

  test('deactivating one extension never terminates another extension executions', () => {
    const handleX = registerActive(TENANT_A, EXT_X)
    const handleY = registerActive(TENANT_A, EXT_Y)

    const result = deactivateActiveExecutionsForExtension(TENANT_A, EXT_X, VERSION)

    expect(result.executionIds).toHaveLength(1)
    expect(handleX.revokeCalls).toBe(1)
    expect(handleY.revokeCalls).toBe(0)
    expect(isExtensionMarkedDeactivated(TENANT_A, EXT_Y, VERSION)).toBe(false)
  })

  test('the deactivation mark is scoped: tenant B same extension type remains registrable', () => {
    deactivateActiveExecutionsForExtension(TENANT_A, EXT_X, VERSION)
    const beginB = beginSandboxExecution(descriptor(TENANT_B, EXT_X))
    expect(beginB.ok).toBe(true)
    const beginOtherVersion = beginSandboxExecution({
      tenantId: TENANT_A,
      extensionType: EXT_X,
      extensionVersion: '2.0.0',
      idempotencyKey: 'k',
    })
    expect(beginOtherVersion.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Static wiring — hook ordering (Required Verification: "hook synchronous
// after the durable deactivation update"; W022-AC01)
// ---------------------------------------------------------------------------

// Strip line + block comments so source-order checks test CODE, not prose.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1')
}

describe('WORK-022 — static wiring: hooks and validation ordering', () => {
  const REGISTRY_SRC = readSrc('src/lib/services/extension-registry.service.ts')
  const REGISTRY_CODE = stripComments(REGISTRY_SRC)

  test('the deactivation hook fires AFTER the durable lifecycle update (source order)', () => {
    const updateIdx = REGISTRY_CODE.indexOf('data: { lifecycleState: targetState }')
    const hookIdx = REGISTRY_CODE.indexOf('deactivateActiveExecutionsForExtension(tenantId, extensionType, extensionVersion)')
    expect(updateIdx).toBeGreaterThan(-1)
    expect(hookIdx).toBeGreaterThan(-1)
    // The hook call site must come AFTER the durable update call site — with
    // only synchronous statements in between (no await between durability and
    // termination: the hook call itself is not awaited).
    expect(hookIdx).toBeGreaterThan(updateIdx)
    const between = REGISTRY_CODE.slice(updateIdx, hookIdx)
    expect(between).not.toMatch(/\bawait\b/)
  })

  test('install-time validation happens BEFORE the durable lifecycle update (source order)', () => {
    const validateIdx = REGISTRY_CODE.indexOf('await validateModuleForInstall(')
    const updateIdx = REGISTRY_CODE.indexOf('data: { lifecycleState: targetState }')
    expect(validateIdx).toBeGreaterThan(-1)
    expect(validateIdx).toBeLessThan(updateIdx)
  })

  test('the re-activation hook clears the deactivation mark after the durable update (source order)', () => {
    const updateIdx = REGISTRY_CODE.indexOf('data: { lifecycleState: targetState }')
    // The FIRST reactivateExtension call site sits in revokeExtension (mark
    // cleanup on the terminal path); the transitionLifecycle call site is the
    // one that must follow the durable update here.
    const reactivateIdx = REGISTRY_CODE.indexOf('reactivateExtension(tenantId, extensionType, extensionVersion)', updateIdx)
    expect(reactivateIdx).toBeGreaterThan(-1)
    expect(reactivateIdx).toBeGreaterThan(updateIdx)
    const between = REGISTRY_CODE.slice(updateIdx, reactivateIdx)
    expect(between).not.toMatch(/\bawait\b/)
  })

  test('WORK-021 revocation wiring is unchanged: both durable paths still fire the revoked hook', () => {
    expect(REGISTRY_SRC).toContain('revokeActiveExecutionsForExtension(tenantId, extensionType, extensionVersion)')
    // Both call sites: revokeExtension AND transitionLifecycle(→ revoked).
    const first = REGISTRY_SRC.indexOf('revokeActiveExecutionsForExtension(tenantId, extensionType, extensionVersion)')
    const second = REGISTRY_SRC.indexOf('revokeActiveExecutionsForExtension(tenantId, extensionType, extensionVersion)', first + 1)
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(-1)
  })

  test('the runtime maps the deactivation race-refusal to the existing denial vocabulary', () => {
    const RUNTIME_SRC = readSrc('src/lib/services/extension-runtime.service.ts')
    expect(RUNTIME_SRC).toContain("'extension_deactivated'")
    expect(RUNTIME_SRC).toContain("kind: 'lifecycle_not_activated'")
  })
})

// ---------------------------------------------------------------------------
// W022-AC07 — anti-dependency: no new authority or ownership
// ---------------------------------------------------------------------------

describe('WORK-022 — anti-dependency checks (W022-AC07)', () => {
  const REGISTRY_SRC = readSrc('src/lib/services/extension-registry.service.ts')
  const AER_SRC = readSrc('src/lib/services/active-execution-registry.service.ts')
  const RUNTIME_SRC = readSrc('src/lib/services/extension-runtime.service.ts')
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('the registry imports the sandbox host ONLY as an erased type + a lazy dynamic import (no static coupling)', () => {
    // The static import must be type-only (erased at runtime); the runtime
    // dependency is the same lazy dynamic-import pattern the Runtime uses.
    expect(REGISTRY_SRC).toMatch(/^import type \{ SandboxHost \} from '@\/lib\/services\/sandbox-host\.service'/m)
    const staticValueImport = /^import \{(?! type)[^}]*\} from '@\/lib\/services\/sandbox-host\.service'/m
    expect(staticValueImport.test(REGISTRY_SRC)).toBe(false)
    expect(REGISTRY_SRC).toContain("await import('@/lib/services/sandbox-host.service')")
  })

  test('the registry does NOT spawn processes or execute extensions (lifecycle authority only)', () => {
    expect(REGISTRY_SRC).not.toContain('child_process')
    expect(REGISTRY_SRC).not.toContain('spawn(')
    expect(REGISTRY_SRC).not.toMatch(/export\s+(async\s+)?function\s+execute\b/)
  })

  test('the registry imports NO vertical/EconomicPipeline/Route/Transport/RuntimeRegistry/kernel dependency', () => {
    const verticalPattern = /(?:vpp|compute|storage|wireless|manufacturing)\.service/
    expect(verticalPattern.test(REGISTRY_SRC)).toBe(false)
    expect(REGISTRY_SRC).not.toContain('economic-pipeline')
    const dataPlanePattern = /(?:routing|transport|delivery-confirmation)\.service/
    expect(dataPlanePattern.test(REGISTRY_SRC)).toBe(false)
    expect(REGISTRY_SRC).not.toMatch(/from\s+['"]@\/lib\/kernel\//m)
    expect(REGISTRY_SRC).not.toMatch(/^import.*@\/lib\/kernel/m)
  })

  test('the runtime does NOT own lifecycle (no transition/revoke exports added)', () => {
    expect(RUNTIME_SRC).not.toMatch(/export\s+(async\s+)?function\s+transitionLifecycle\b/)
    expect(RUNTIME_SRC).not.toMatch(/export\s+(async\s+)?function\s+revokeExtension\b/)
    expect(RUNTIME_SRC).not.toMatch(/export\s+(async\s+)?function\s+registerExtension\b/)
  })

  test('the sandbox host imports NO ExtensionRegistry (no catalog ownership; one-way dependency)', () => {
    expect(SANDBOX_SRC).not.toContain('extension-registry.service')
    expect(SANDBOX_SRC).not.toMatch(/export\s+(async\s+)?function\s+transitionLifecycle\b/)
  })

  test('the ActiveExecutionRegistry owns ONLY execution-handle lifecycle (no catalog state)', () => {
    expect(AER_SRC).not.toContain('extension-registry.service')
    expect(AER_SRC).not.toContain('extension-runtime.service')
    expect(AER_SRC).not.toContain("from '@/lib/db'")
    // The deactivation ledger is DISTINCT from the revoked ledger (two sets).
    expect(AER_SRC).toContain('revokedExtensionLedger')
    expect(AER_SRC).toContain('deactivatedExtensionLedger')
    // The revoked hook NEVER writes the deactivation ledger and vice versa.
    const revokeHook = AER_SRC.slice(
      AER_SRC.indexOf('export function revokeActiveExecutionsForExtension'),
      AER_SRC.indexOf('export function deactivateActiveExecutionsForExtension'),
    )
    expect(revokeHook).not.toContain('deactivatedExtensionLedger.add')
    const deactivateHook = AER_SRC.slice(
      AER_SRC.indexOf('export function deactivateActiveExecutionsForExtension'),
      AER_SRC.indexOf('export function reactivateExtension'),
    )
    expect(deactivateHook).not.toContain('revokedExtensionLedger.add')
  })
})

// ---------------------------------------------------------------------------
// Deny-by-default validation (V5 §2.7 — unavailable sandbox never validates)
// ---------------------------------------------------------------------------

describe('WORK-022 — validate-only deny-by-default (V5 §2.7)', () => {
  test('DenyByDefaultSandboxHost.validateOnly throws SandboxUnavailableError', () => {
    const host = new DenyByDefaultSandboxHost()
    expect(host.isAvailable()).toBe(false)
    expect(() => host.validateOnly(Buffer.alloc(8), [])).toThrow(/deny-by-default/)
  })

  test('a SandboxHost without the validate-only path is treated as unable to validate (optional contract)', () => {
    // The interface method is optional; callers (the registry) deny-by-default
    // when it is absent — proven end-to-end in the PG suite. Here: the
    // optional-method contract shape itself.
    const host: SandboxHost = {
      isAvailable: () => true,
      execute: async () => { throw new Error('unused') },
      executeWithHandle: () => { throw new Error('unused') },
    }
    expect((host as { validateOnly?: unknown }).validateOnly).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// W022-AC10 — V5 remains FROZEN and unmodified
// ---------------------------------------------------------------------------

describe('WORK-022 — V5 immutability (W022-AC10)', () => {
  const V5 = readSrc('spec/domain-architecture-v5.md')
  const LOCK = readSrc('spec/architecture-lock.md')

  test('IAAS-DOM-ARCH-5 remains FROZEN', () => {
    expect(V5).toMatch(/Status:\s*\*\*FROZEN\*\*/)
  })

  test('the §2.5 lifecycle contract is unchanged (the exact frozen block)', () => {
    expect(V5).toContain('registered → installed → activated ⇌ deactivated → revoked')
    expect(V5).toContain('installed: module validation/compilation may occur without execution')
    expect(V5).toContain('deactivated: active execution context terminated/deactivated')
    expect(V5).toContain('revoked: terminal state; future execution denied and active context terminated')
    expect(V5).toContain('Termination is an architectural abstraction.')
  })

  test('the architecture lock remains FROZEN and the dependency graph pins V5 as current', () => {
    // OBSERVED repository truth: the lock header still records the V4 freeze
    // (its historical publication record); the authoritative CURRENT-version
    // record is the dependency graph's governance line. WORK-022 changes
    // neither (W022-AC10).
    expect(LOCK).toMatch(/Status:\s*\*\*FROZEN\*\*/)
    const GRAPH = readSrc('spec/dependency-graph.md')
    expect(GRAPH).toContain('`IAAS-DOM-ARCH-5` is the current frozen domain architecture')
  })
})
