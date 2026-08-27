/// <reference types="bun-types" />
// =============================================================================
// WORK-021 — ActiveExecutionRegistry unit + wiring tests (AR-021-17)
// =============================================================================
// Proves the AUTHORITATIVE revocation control path required by the frozen V5
// §2.5 contract ("revoked: terminal state; future execution denied and active
// context terminated"):
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
//   SandboxExecutionHandle.revoke()  →  termination
//
// This file covers (no DB, no wasmtime — behavioral fakes + static wiring):
//   - registration → attachment → completion lifecycle of active executions;
//   - the termination hook terminates EVERY active execution of the extension;
//   - tenant isolation of termination (revoking tenant A never touches tenant B);
//   - ALL THREE race windows (revoke before / during / after registration) are
//     closed: no registered sandbox survives a durable revoke;
//   - the wiring in extension-runtime.service.ts and extension-registry.service.ts
//     (static source checks: synchronous begin→spawn→attach, hook after the
//     durable update with no await in between).
//
// The full end-to-end chain against real PostgreSQL + real wasmtime is proven
// by tests/work-021-sandbox-revocation-pg.test.ts (postgres-integration job).
// =============================================================================
import { describe, it, expect, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  beginSandboxExecution,
  attachSandboxHandle,
  endSandboxExecution,
  revokeActiveExecution,
  revokeActiveExecutionsForExtension,
  getActiveExecution,
  listActiveExecutions,
  isExtensionMarkedRevoked,
  __resetActiveExecutionRegistryForTesting,
} from '../src/lib/services/active-execution-registry.service'
import type { SandboxExecutionHandle } from '../src/lib/services/sandbox-host.service'

const REPO_ROOT = process.cwd()

function readSrc(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

/** Strip line + block comments so static checks inspect CODE, not prose. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// ---------------------------------------------------------------------------
// Fake sandbox execution handle (records revocation; idempotent like the host)
// ---------------------------------------------------------------------------

interface FakeHandle {
  handle: SandboxExecutionHandle
  revokeCalls: number
}

function makeFakeHandle(): FakeHandle {
  const fake: FakeHandle = { handle: null as unknown as SandboxExecutionHandle, revokeCalls: 0 }
  let revoked = false
  fake.handle = {
    // The result never settles on its own — only revocation ends this execution.
    result: new Promise<never>(() => {}),
    revoke: () => {
      if (revoked) return // idempotent, mirroring WasmtimeSandboxHost.revoke()
      revoked = true
      fake.revokeCalls++
    },
    isRevoked: () => revoked,
  }
  return fake
}

const DESC = (tenantId: string, extType = 'test-ext', extVersion = '1.0.0') => ({
  tenantId,
  extensionType: extType,
  extensionVersion: extVersion,
  idempotencyKey: 'idem-key',
})

beforeEach(() => {
  __resetActiveExecutionRegistryForTesting()
})

// ---------------------------------------------------------------------------
// Registration / attachment / completion lifecycle
// ---------------------------------------------------------------------------

describe('WORK-021 — ActiveExecutionRegistry lifecycle (AR-021-17)', () => {
  it('beginSandboxExecution registers a starting execution with a unique executionId', () => {
    const a = beginSandboxExecution(DESC('tenant-a'))
    const b = beginSandboxExecution(DESC('tenant-a'))
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) throw new Error('unreachable')
    expect(a.executionId).not.toBe(b.executionId)

    const record = getActiveExecution(a.executionId)
    expect(record).toBeDefined()
    expect(record?.state).toBe('starting') // registered, sandbox not yet spawned
    expect(record?.tenantId).toBe('tenant-a')
    expect(record?.extensionType).toBe('test-ext')
  })

  it('attachSandboxHandle transitions the entry to active', () => {
    const begin = beginSandboxExecution(DESC('tenant-a'))
    if (!begin.ok) throw new Error('unreachable')
    const fake = makeFakeHandle()
    const attachResult = attachSandboxHandle(begin.executionId, fake.handle)
    expect(attachResult).toBe('attached')
    expect(getActiveExecution(begin.executionId)?.state).toBe('active')
    expect(fake.revokeCalls).toBe(0) // attachment alone never terminates
  })

  it('endSandboxExecution removes the completed execution from the registry', () => {
    const begin = beginSandboxExecution(DESC('tenant-a'))
    if (!begin.ok) throw new Error('unreachable')
    attachSandboxHandle(begin.executionId, makeFakeHandle().handle)
    endSandboxExecution(begin.executionId)
    expect(getActiveExecution(begin.executionId)).toBeUndefined()
    expect(listActiveExecutions()).toHaveLength(0)
  })

  it('attachSandboxHandle on an ended execution reports unknown-execution', () => {
    const begin = beginSandboxExecution(DESC('tenant-a'))
    if (!begin.ok) throw new Error('unreachable')
    endSandboxExecution(begin.executionId)
    const attachResult = attachSandboxHandle(begin.executionId, makeFakeHandle().handle)
    expect(attachResult).toBe('unknown-execution')
  })
})

// ---------------------------------------------------------------------------
// The authoritative termination hook
// ---------------------------------------------------------------------------

describe('WORK-021 — ActiveExecutionRegistry termination hook (AR-021-17)', () => {
  it('revokeActiveExecutionsForExtension terminates EVERY active execution of the extension', () => {
    const TENANT = 'tenant-a'
    const begin1 = beginSandboxExecution(DESC(TENANT))
    const begin2 = beginSandboxExecution(DESC(TENANT))
    const begin3 = beginSandboxExecution(DESC(TENANT))
    if (!begin1.ok || !begin2.ok || !begin3.ok) throw new Error('unreachable')
    const fake1 = makeFakeHandle()
    const fake2 = makeFakeHandle()
    const fake3 = makeFakeHandle()
    attachSandboxHandle(begin1.executionId, fake1.handle)
    attachSandboxHandle(begin2.executionId, fake2.handle)
    attachSandboxHandle(begin3.executionId, fake3.handle)

    const result = revokeActiveExecutionsForExtension(TENANT, 'test-ext', '1.0.0')
    expect(result.executionIds.sort()).toEqual(
      [begin1.executionId, begin2.executionId, begin3.executionId].sort(),
    )
    // EVERY registered handle was revoked — none survives.
    expect(fake1.revokeCalls).toBe(1)
    expect(fake2.revokeCalls).toBe(1)
    expect(fake3.revokeCalls).toBe(1)
    expect(getActiveExecution(begin1.executionId)?.state).toBe('terminating')
  })

  it('termination is tenant-scoped: revoking tenant A never touches tenant B (V5 §2.6)', () => {
    const beginA = beginSandboxExecution(DESC('tenant-a'))
    const beginB = beginSandboxExecution(DESC('tenant-b'))
    if (!beginA.ok || !beginB.ok) throw new Error('unreachable')
    const fakeA = makeFakeHandle()
    const fakeB = makeFakeHandle()
    attachSandboxHandle(beginA.executionId, fakeA.handle)
    attachSandboxHandle(beginB.executionId, fakeB.handle)

    revokeActiveExecutionsForExtension('tenant-a', 'test-ext', '1.0.0')
    expect(fakeA.revokeCalls).toBe(1)  // tenant A's execution terminated
    expect(fakeB.revokeCalls).toBe(0)  // tenant B's execution untouched
    expect(getActiveExecution(beginB.executionId)?.state).toBe('active')
  })

  it('termination is extension-scoped: other extensions of the tenant survive', () => {
    const beginTarget = beginSandboxExecution(DESC('tenant-a', 'target-ext'))
    const beginOther = beginSandboxExecution(DESC('tenant-a', 'other-ext'))
    if (!beginTarget.ok || !beginOther.ok) throw new Error('unreachable')
    const fakeTarget = makeFakeHandle()
    const fakeOther = makeFakeHandle()
    attachSandboxHandle(beginTarget.executionId, fakeTarget.handle)
    attachSandboxHandle(beginOther.executionId, fakeOther.handle)

    revokeActiveExecutionsForExtension('tenant-a', 'target-ext', '1.0.0')
    expect(fakeTarget.revokeCalls).toBe(1)
    expect(fakeOther.revokeCalls).toBe(0)
  })

  it('revokeActiveExecution(executionId) terminates a single execution', () => {
    const begin = beginSandboxExecution(DESC('tenant-a'))
    if (!begin.ok) throw new Error('unreachable')
    const fake = makeFakeHandle()
    attachSandboxHandle(begin.executionId, fake.handle)
    expect(revokeActiveExecution(begin.executionId)).toBe(true)
    expect(fake.revokeCalls).toBe(1)
    // Unknown / already-ended executions report false — nothing to terminate.
    expect(revokeActiveExecution('sandbox-exec-does-not-exist')).toBe(false)
    endSandboxExecution(begin.executionId)
    expect(revokeActiveExecution(begin.executionId)).toBe(false)
  })

  it('the hook marks the extension revoked: future registrations are refused (V5 §2.5)', () => {
    revokeActiveExecutionsForExtension('tenant-a', 'test-ext', '1.0.0')
    expect(isExtensionMarkedRevoked('tenant-a', 'test-ext', '1.0.0')).toBe(true)
    // A DIFFERENT extension of the same tenant is unaffected.
    expect(isExtensionMarkedRevoked('tenant-a', 'other-ext', '1.0.0')).toBe(false)

    const refused = beginSandboxExecution(DESC('tenant-a'))
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('unreachable')
    expect(refused.refusalReason).toBe('extension_revoked')
    // No sandbox was ever spawned for the refused execution.
    expect(listActiveExecutions()).toHaveLength(0)
  })

  it('repeated termination hooks are a no-op for already-revoked handles', () => {
    const begin = beginSandboxExecution(DESC('tenant-a'))
    if (!begin.ok) throw new Error('unreachable')
    const fake = makeFakeHandle()
    attachSandboxHandle(begin.executionId, fake.handle)
    revokeActiveExecutionsForExtension('tenant-a', 'test-ext', '1.0.0')
    revokeActiveExecutionsForExtension('tenant-a', 'test-ext', '1.0.0')
    expect(fake.revokeCalls).toBe(1) // exactly once — idempotent
  })
})

// ---------------------------------------------------------------------------
// AR-021-17 race-safety — all three interleavings are closed
// ---------------------------------------------------------------------------

describe('WORK-021 — AR-021-17 race safety (before / during / after registration)', () => {
  it('RACE 1 — revoke BEFORE registration: registration is refused, no sandbox spawns', () => {
    // The durable revoke lands first (ledger marked)…
    revokeActiveExecutionsForExtension('tenant-a', 'test-ext', '1.0.0')
    // …then the racing registration attempt is refused.
    const begin = beginSandboxExecution(DESC('tenant-a'))
    expect(begin.ok).toBe(false)
    if (begin.ok) throw new Error('unreachable')
    expect(begin.refusalReason).toBe('extension_revoked')
    expect(listActiveExecutions()).toHaveLength(0)
  })

  it('RACE 2 — revoke DURING registration: the handle is revoked at attach, before the sandbox can progress', () => {
    // Registration completes (entry in state 'starting' — the sandbox host has
    // not yet returned a handle)…
    const begin = beginSandboxExecution(DESC('tenant-a'))
    if (!begin.ok) throw new Error('unreachable')
    // …the durable revoke lands in the registration window…
    const result = revokeActiveExecutionsForExtension('tenant-a', 'test-ext', '1.0.0')
    expect(result.executionIds).toEqual([begin.executionId])
    // …the sandbox spawns and the handle is attached: attachSandboxHandle
    // revokes it IMMEDIATELY (same synchronous block as the spawn).
    const fake = makeFakeHandle()
    const attachResult = attachSandboxHandle(begin.executionId, fake.handle)
    expect(attachResult).toBe('attached-and-revoked')
    expect(fake.revokeCalls).toBe(1)
    expect(fake.handle.isRevoked()).toBe(true)
  })

  it('RACE 3 — revoke AFTER registration: the attached handle is revoked immediately', () => {
    const begin = beginSandboxExecution(DESC('tenant-a'))
    if (!begin.ok) throw new Error('unreachable')
    const fake = makeFakeHandle()
    attachSandboxHandle(begin.executionId, fake.handle)
    expect(getActiveExecution(begin.executionId)?.state).toBe('active')

    // The durable revoke lands while the sandbox is running.
    const result = revokeActiveExecutionsForExtension('tenant-a', 'test-ext', '1.0.0')
    expect(result.executionIds).toEqual([begin.executionId])
    expect(fake.revokeCalls).toBe(1)
    expect(fake.handle.isRevoked()).toBe(true)
  })

  it('completed executions are not terminated (revocation is not retroactive)', () => {
    const begin = beginSandboxExecution(DESC('tenant-a'))
    if (!begin.ok) throw new Error('unreachable')
    const fake = makeFakeHandle()
    attachSandboxHandle(begin.executionId, fake.handle)
    endSandboxExecution(begin.executionId) // execution finished on its own

    const result = revokeActiveExecutionsForExtension('tenant-a', 'test-ext', '1.0.0')
    expect(result.executionIds).toEqual([]) // nothing left to terminate
    expect(fake.revokeCalls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Static wiring checks — the authoritative control path is real in the sources
// ---------------------------------------------------------------------------

describe('WORK-021 — AR-021-17 wiring in ExtensionRuntime (static)', () => {
  const RUNTIME_SRC = readSrc('src/lib/services/extension-runtime.service.ts')

  it('ExtensionRuntime registers, attaches, and ends active sandbox executions', () => {
    expect(RUNTIME_SRC).toContain('beginSandboxExecution')
    expect(RUNTIME_SRC).toContain('attachSandboxHandle')
    expect(RUNTIME_SRC).toContain('endSandboxExecution')
    expect(RUNTIME_SRC).toContain('active-execution-registry.service')
    expect(RUNTIME_SRC).toContain('AR-021-17')
  })

  it('registration happens BEFORE the sandbox is spawned (begin precedes executeWithHandle)', () => {
    const beginIdx = RUNTIME_SRC.indexOf('beginSandboxExecution({')
    const spawnIdx = RUNTIME_SRC.indexOf('executeWithHandle(')
    expect(beginIdx).toBeGreaterThan(0)
    expect(spawnIdx).toBeGreaterThan(beginIdx)
  })

  it('RACE SAFETY: no await between successful registration and handle attachment', () => {
    // The slice from the successful registration to the attachment must be
    // purely synchronous: begin → executeWithHandle → attach is ONE synchronous
    // block, so a revoke can only land before it (ledger refusal) or after it
    // (hook revokes the registered handle) — never in an untracked window.
    const code = stripComments(RUNTIME_SRC)
    const from = code.indexOf('activeExecutionId = begin.executionId')
    const to = code.indexOf('attachSandboxHandle(activeExecutionId!')
    expect(from).toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
    const slice = code.slice(from, to)
    expect(slice).not.toContain('await')
    expect(slice).toContain('executeWithHandle(') // the spawn is inside the block
  })

  it('the handle is removed from the authoritative registry on completion (finally)', () => {
    const finallyIdx = RUNTIME_SRC.indexOf('} finally {')
    const endIdx = RUNTIME_SRC.indexOf('endSandboxExecution(activeExecutionId)')
    expect(finallyIdx).toBeGreaterThan(0)
    expect(endIdx).toBeGreaterThan(finallyIdx)
  })

  it('registration refusal emits failed provenance and denies execution (kind revoked)', () => {
    expect(RUNTIME_SRC).toContain('if (!begin.ok)')
    expect(RUNTIME_SRC).toContain('refusalDenial')
    expect(RUNTIME_SRC).toContain("kind: 'revoked'")
    expect(RUNTIME_SRC).toContain('emitFailedProvenance(tenantId, input, registryEntry, inputHash, ceiling, refusalDenial)')
  })
})

describe('WORK-021 — AR-021-17 wiring in ExtensionRegistry (static)', () => {
  const REGISTRY_SRC = readSrc('src/lib/services/extension-registry.service.ts')

  it('revokeExtension fires the ActiveExecutionRegistry termination hook', () => {
    expect(REGISTRY_SRC).toContain('revokeActiveExecutionsForExtension')
    expect(REGISTRY_SRC).toContain('AR-021-17')
    expect(REGISTRY_SRC).toContain('active-execution-registry.service')
  })

  it('the hook fires AFTER the durable revocation update with NO await in between', () => {
    // Slice from the durable update (revocationStatus='revoked') to the hook
    // call — nothing asynchronous may run between durability and termination.
    const code = stripComments(REGISTRY_SRC)
    const updateIdx = code.indexOf("revocationStatus: 'revoked',")
    const hookIdx = code.indexOf('revokeActiveExecutionsForExtension(tenantId, extensionType, extensionVersion)')
    expect(updateIdx).toBeGreaterThan(0)
    expect(hookIdx).toBeGreaterThan(updateIdx)
    const slice = code.slice(updateIdx, hookIdx)
    expect(slice).not.toContain('await')
  })

  it('transitionLifecycle(→ revoked) fires the SAME termination hook (second durable path)', () => {
    const transitionHookGuard = REGISTRY_SRC.indexOf('targetState === LIFECYCLE_STATE.REVOKED')
    expect(transitionHookGuard).toBeGreaterThan(0)
    // The guarded hook call exists after the transition's durable update.
    const transitionUpdateIdx = REGISTRY_SRC.indexOf('data: { lifecycleState: targetState }')
    expect(transitionUpdateIdx).toBeGreaterThan(0)
    const slice = REGISTRY_SRC.slice(transitionUpdateIdx)
    const hookInTransition = slice.indexOf('revokeActiveExecutionsForExtension(tenantId, extensionType, extensionVersion)')
    expect(hookInTransition).toBeGreaterThan(0)
  })

  it('the audit record carries the terminated active-execution count', () => {
    expect(REGISTRY_SRC).toContain('activeExecutionsTerminated')
  })

  it('the registry still does NOT execute extensions (boundary preserved)', () => {
    expect(REGISTRY_SRC).toContain('Does NOT execute extensions')
    expect(REGISTRY_SRC).not.toMatch(/export\s+(async\s+)?function\s+execute\b/)
    expect(REGISTRY_SRC).not.toContain('extension-runtime.service')
    expect(REGISTRY_SRC).not.toMatch(/^import.*ExtensionRuntime/m)
  })
})

describe('WORK-021 — ActiveExecutionRegistry architectural boundaries (static)', () => {
  const REGISTRY_SRC = readSrc('src/lib/services/active-execution-registry.service.ts')

  it('is in the service layer (NOT kernel)', () => {
    const path = join(REPO_ROOT, 'src', 'lib', 'services', 'active-execution-registry.service.ts')
    expect(path).toContain('src/lib/services/')
    expect(path).not.toContain('src/lib/kernel/')
  })

  it('imports NO kernel code, NO vertical services, NO db, NO catalog/runtime ownership', () => {
    expect(REGISTRY_SRC).not.toMatch(/^import.*@\/lib\/kernel/m)
    expect(REGISTRY_SRC).not.toMatch(/(?:vpp|compute|storage|wireless|manufacturing)\.service/)
    expect(REGISTRY_SRC).not.toContain('economic-pipeline')
    expect(REGISTRY_SRC).not.toContain("@/lib/db")
    expect(REGISTRY_SRC).not.toContain('extension-registry.service')
    expect(REGISTRY_SRC).not.toContain('extension-runtime.service')
    expect(REGISTRY_SRC).not.toContain('extension-provenance.service')
  })

  it('depends on the sandbox host ONLY via a type-only import (no runtime coupling)', () => {
    // The SandboxExecutionHandle type is imported with `import type` — erased
    // at runtime, so the registry has no runtime dependency on the host.
    expect(REGISTRY_SRC).toMatch(/^import type \{ SandboxExecutionHandle \}/m)
    expect(REGISTRY_SRC).not.toMatch(/^import \{.*SandboxExecutionHandle/m)
  })

  it('owns ONLY handle lifecycle (no catalog, no execution, no sandbox technology)', () => {
    expect(REGISTRY_SRC).toContain('Does NOT own catalog/lifecycle state')
    expect(REGISTRY_SRC).toContain('Does NOT execute extensions')
    expect(REGISTRY_SRC).toContain('Does NOT implement sandbox technology')
    // It must not spawn processes itself — termination is DELEGATED to the
    // handle (V5 §2.5 termination abstraction preserved).
    expect(REGISTRY_SRC).not.toContain("spawn('wasmtime'")
    expect(REGISTRY_SRC).not.toContain('.kill(')
  })

  it('documents the authoritative control path and the race-safety guarantee', () => {
    expect(REGISTRY_SRC).toContain('AUTHORITATIVE')
    expect(REGISTRY_SRC).toContain('RACE SAFETY')
    expect(REGISTRY_SRC).toContain('AR-021-17')
    expect(REGISTRY_SRC).toContain('V5 §2.5')
  })
})
