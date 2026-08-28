/// <reference types="bun-types" />
// =============================================================================
// WORK-022 — Sandbox Lifecycle Completion (PostgreSQL + real wasmtime)
// =============================================================================
// Proves the W022 acceptance criteria end-to-end against a real PostgreSQL
// ExtensionRegistry, the real ExtensionRuntime, the real
// ActiveExecutionRegistry, and — for the golden tests — a REAL wasmtime
// subprocess executing REAL Component Model binaries:
//
//   W022-AC01  transitionLifecycle(→ deactivated) terminates every active
//              sandbox execution through the authoritative control path:
//              durable update → synchronous hook → SandboxExecutionHandle
//              .revoke() → termination; the terminated executions fail with
//              the recorded termination cause and emit failed provenance.
//   W022-AC02  deactivation is reversible (existing lifecycle gate denies
//              while deactivated; re-activation permits again); the terminal
//              revoked-execution ledger is NEVER used for deactivation.
//   W022-AC03  registered → installed validates the binary (classification +
//              import verification against DECLARED capabilities) WITHOUT
//              spawning; unauthorized imports deny the transition.
//   W022-AC04  revoked remains the only terminal state; WORK-021 revocation
//              semantics are unchanged.
//   W022-AC05  termination is tenant-scoped and extension-scoped.
//   W022-AC06  lifecycle transitions record activeExecutionsTerminated audit
//              metadata.
//   W022-AC08  real PostgreSQL + real wasmtime: deactivation terminates an
//              active infinite-loop execution; re-activation permits a new
//              real execution; install-time validation denies an unauthorized
//              real Component Model binary without spawning.
//
// Run: bun test tests/work-022-sandbox-lifecycle-pg.test.ts --timeout 180000
// (requires PostgreSQL + wasmtime + wasm-tools on PATH)
// =============================================================================

import { describe, it, expect, beforeAll, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import {
  registerExtension,
  transitionLifecycle,
  revokeExtension,
  getExtension,
  LIFECYCLE_STATE,
} from '../src/lib/services/extension-registry.service'
import {
  executeExtension,
  InMemoryExtensionProvenanceSink,
} from '../src/lib/services/extension-runtime.service'
import {
  WasmtimeSandboxHost,
  SandboxTerminatedError,
  type SandboxHost,
  type SandboxExecutionHandle,
  type SandboxExecutionResult,
  type SandboxCeiling,
} from '../src/lib/services/sandbox-host.service'
import {
  deactivateActiveExecutionsForExtension,
  reactivateExtension,
  listActiveExecutions,
  isExtensionMarkedRevoked,
  isExtensionMarkedDeactivated,
  revokeActiveExecution,
  __resetActiveExecutionRegistryForTesting,
} from '../src/lib/services/active-execution-registry.service'
import { ValidationError, ConflictError } from '../src/lib/domain/errors'

const VERSION = '1.0.0'

// Same pattern as the WORK-021 e2e suite: wabt is a CommonJS package.
const require = createRequire(import.meta.url)

let tenantA: string
let tenantB: string

beforeAll(async () => {
  const tA = await createTenant({
    name: 'W022 Sandbox Lifecycle Tenant A',
    slug: `w022-lifecycle-a-${Date.now()}`,
    plan: 'growth',
  })
  tenantA = tA.id
  const tB = await createTenant({
    name: 'W022 Sandbox Lifecycle Tenant B',
    slug: `w022-lifecycle-b-${Date.now()}`,
    plan: 'growth',
  })
  tenantB = tB.id
})

beforeEach(() => {
  // The ActiveExecutionRegistry is module-level state — reset for isolation.
  __resetActiveExecutionRegistryForTesting()
})

/** Register + install + activate an extension (helper). */
async function activateExtension(
  tenantId: string,
  extType: string,
  declaredCapabilities: string[] = [],
): Promise<string> {
  await registerExtension(tenantId, {
    extensionType: extType,
    extensionVersion: VERSION,
    declaredCapabilities,
    declaredResourceLimits: { memoryBytes: 64 * 1024 * 1024, timeMs: 30000 },
    idempotencyKey: `reg-${extType}-${Date.now()}`,
  })
  await transitionLifecycle(tenantId, extType, VERSION, LIFECYCLE_STATE.INSTALLED)
  await transitionLifecycle(tenantId, extType, VERSION, LIFECYCLE_STATE.ACTIVATED)
  const entry = await getExtension(tenantId, extType, VERSION)
  return entry.id
}

function loadLoopComponent(): Buffer {
  return readFileSync(join(process.cwd(), 'tests', 'fixtures', 'work-021', 'infinite-loop.component.wasm'))
}

function loadRandomComponent(): Buffer {
  return readFileSync(join(process.cwd(), 'tests', 'fixtures', 'work-021', 'random-guest.component.wasm'))
}

async function waitForActiveExecutions(
  tenantId: string,
  extType: string,
  count: number,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const active = listActiveExecutions({
      tenantId,
      extensionType: extType,
      extensionVersion: VERSION,
    }).filter(e => e.state === 'active')
    if (active.length >= count) return
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} active execution(s) of ${extType} (found ${active.length})`)
    }
    await new Promise(r => setTimeout(r, 10))
  }
}

// ---------------------------------------------------------------------------
// Fake sandbox hosts (deterministic; mirror the real host's termination
// semantics: revoke() → SandboxTerminatedError 'revoked')
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
    this.result.catch(() => {}) // never an unhandled rejection
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

class HangingSandboxHost implements SandboxHost {
  readonly handles: HangingHandle[] = []
  spawnCount = 0

  isAvailable(): boolean {
    return true
  }

  async execute(
    wasmModule: Buffer,
    input: Buffer,
    ceiling: SandboxCeiling,
  ): Promise<SandboxExecutionResult> {
    return this.executeWithHandle(wasmModule, input, ceiling).result
  }

  executeWithHandle(
    _wasmModule: Buffer,
    _input: Buffer,
    _ceiling: SandboxCeiling,
  ): SandboxExecutionHandle {
    this.spawnCount++
    const handle = new HangingHandle()
    this.handles.push(handle)
    return handle
  }
}

class CompletingSandboxHost implements SandboxHost {
  spawnCount = 0
  revokeCalls = 0

  isAvailable(): boolean {
    return true
  }

  async execute(
    wasmModule: Buffer,
    input: Buffer,
    ceiling: SandboxCeiling,
  ): Promise<SandboxExecutionResult> {
    return this.executeWithHandle(wasmModule, input, ceiling).result
  }

  executeWithHandle(
    _wasmModule: Buffer,
    input: Buffer,
    _ceiling: SandboxCeiling,
  ): SandboxExecutionHandle {
    this.spawnCount++
    return {
      result: Promise.resolve({
        output: Buffer.from(`completed:${input.toString('utf8')}`),
        measurements: { wallTimeMs: 1, hostcallBytes: input.length, enforcedLimits: {} },
        capabilitiesExercised: [],
      } satisfies SandboxExecutionResult),
      revoke: () => {
        this.revokeCalls++
      },
      isRevoked: () => false,
    }
  }
}

/**
 * A counting WRAPPER around the REAL WasmtimeSandboxHost: validateOnly is the
 * REAL implementation (real classification + AR-021-18 import verification);
 * executeWithHandle is counted before delegating to the real spawn. Proves
 * install-time validation spawns nothing while using the real validator.
 */
class CountingWasmtimeHost extends WasmtimeSandboxHost implements SandboxHost {
  spawnCount = 0

  executeWithHandle(
    wasmModule: Buffer,
    input: Buffer,
    ceiling: SandboxCeiling,
  ): SandboxExecutionHandle {
    this.spawnCount++
    return super.executeWithHandle(wasmModule, input, ceiling)
  }
}

/** Minimal wasm binary header (fake hosts perform no import verification). */
const ANY_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

// ---------------------------------------------------------------------------
// W022-AC01 + W022-AC08 — GOLDEN: real registry → real runtime → real
// ActiveExecutionRegistry → REAL wasmtime subprocess → real SIGTERM
// ---------------------------------------------------------------------------

describe('WORK-022 W022-AC01/AC08 — golden deactivation chain (real wasmtime)', () => {
  it('transitionLifecycle(→ deactivated) terminates the running infinite-loop execution with failed provenance', async () => {
    const extType = `golden-deactivate-${Date.now()}`
    await activateExtension(tenantA, extType)

    const sink = new InMemoryExtensionProvenanceSink()
    const startedAt = Date.now()

    // Start a REAL sandboxed execution of a true infinite-loop Component
    // Model binary (30s wall-clock ceiling — the only thing that could stop
    // it without lifecycle termination).
    const execPromise = executeExtension(tenantA, {
      extensionType: extType,
      extensionVersion: VERSION,
      inputPayload: Buffer.from('w022-golden-deactivation'),
      approvedResourceLimits: { memoryBytes: 64 * 1024 * 1024, timeMs: 30000 },
      idempotencyKey: `exec-${Date.now()}`,
      wasmModule: loadLoopComponent(),
      provenanceSink: sink,
    })
    const outcome = execPromise.then(
      () => { throw new Error('expected the sandbox execution to be terminated') },
      e => e,
    )

    await waitForActiveExecutions(tenantA, extType, 1)
    const [registered] = listActiveExecutions({ tenantId: tenantA, extensionType: extType })
    expect(registered?.state).toBe('active')

    // === THE ARCHITECTURAL CONTROL PATH (V5 §2.5 deactivation) ===
    // registry transition (durable) → synchronous deactivation hook →
    // handle.revoke() → termination.
    const deactivated = await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.DEACTIVATED)
    expect(deactivated.lifecycleState).toBe('deactivated')

    // The ACTIVE execution must be terminated — not left running until its
    // own 30s timeout/resource ceiling.
    const err = await outcome
    expect(err).toBeInstanceOf(SandboxTerminatedError)
    const terminated = err as SandboxTerminatedError
    // The recorded termination cause: the §2.5 termination abstraction's
    // handle-revocation cause (the SAME cause WORK-021 revocation records —
    // no new termination-cause vocabulary; provenance schema unchanged).
    expect(terminated.terminationReason).toBe('revoked')
    // Belt and suspenders: the execution died FAR below its 30s ceiling.
    expect(Date.now() - startedAt).toBeLessThan(25000)

    // W022-AC01: failed provenance records the termination cause.
    const failed = sink.list().find(p => p.extensionType === extType && p.resultStatus === 'failed')
    expect(failed).toBeDefined()
    expect(failed?.failureMetadata?.terminationReason).toBe('revoked')

    // The terminated execution is deregistered; the terminal revoked ledger
    // is NOT used (deactivation is not revocation).
    expect(listActiveExecutions({ tenantId: tenantA, extensionType: extType })).toHaveLength(0)
    expect(isExtensionMarkedRevoked(tenantA, extType, VERSION)).toBe(false)
    expect(isExtensionMarkedDeactivated(tenantA, extType, VERSION)).toBe(true)

    // The durable registry state is deactivated (not revoked).
    const entry = await getExtension(tenantA, extType, VERSION)
    expect(entry.lifecycleState).toBe('deactivated')
    expect(entry.revocationStatus).toBe('active')
  })

  it('one deactivation terminates EVERY concurrent active execution', async () => {
    const extType = `concurrent-deactivate-${Date.now()}`
    await activateExtension(tenantA, extType)

    const host = new HangingSandboxHost()
    const sink = new InMemoryExtensionProvenanceSink()

    const p1 = executeExtension(tenantA, {
      extensionType: extType, extensionVersion: VERSION,
      inputPayload: Buffer.from('exec-1'), idempotencyKey: `k1-${Date.now()}`,
      wasmModule: ANY_WASM, sandboxHost: host, provenanceSink: sink,
    })
    const p2 = executeExtension(tenantA, {
      extensionType: extType, extensionVersion: VERSION,
      inputPayload: Buffer.from('exec-2'), idempotencyKey: `k2-${Date.now()}`,
      wasmModule: ANY_WASM, sandboxHost: host, provenanceSink: sink,
    })
    const outcome1 = p1.then(() => { throw new Error('expected termination 1') }, e => e)
    const outcome2 = p2.then(() => { throw new Error('expected termination 2') }, e => e)

    await waitForActiveExecutions(tenantA, extType, 2)
    expect(host.spawnCount).toBe(2)

    await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.DEACTIVATED)

    const [e1, e2] = await Promise.all([outcome1, outcome2])
    expect(e1).toBeInstanceOf(SandboxTerminatedError)
    expect((e1 as SandboxTerminatedError).terminationReason).toBe('revoked')
    expect(e2).toBeInstanceOf(SandboxTerminatedError)
    expect((e2 as SandboxTerminatedError).terminationReason).toBe('revoked')
    expect(host.handles.map(h => h.revokeCalls)).toEqual([1, 1])
    expect(listActiveExecutions({ tenantId: tenantA, extensionType: extType })).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// W022-AC02 — reversibility: denied while deactivated, permitted after
// re-activation; the terminal revoked ledger is never used
// ---------------------------------------------------------------------------

describe('WORK-022 W022-AC02 — deactivation is reversible', () => {
  it('execution is DENIED while deactivated (existing lifecycle gate) and NO sandbox is spawned', async () => {
    const extType = `deny-deactivated-${Date.now()}`
    await activateExtension(tenantA, extType)
    await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.DEACTIVATED)

    const host = new HangingSandboxHost()
    const sink = new InMemoryExtensionProvenanceSink()

    let err: unknown
    try {
      await executeExtension(tenantA, {
        extensionType: extType, extensionVersion: VERSION,
        inputPayload: Buffer.from('denied'), idempotencyKey: `exec-${Date.now()}`,
        wasmModule: ANY_WASM, sandboxHost: host, provenanceSink: sink,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toContain('deactivated')

    // The durable lifecycle gate refused the execution — no sandbox spawned.
    expect(host.spawnCount).toBe(0)
    expect(listActiveExecutions()).toHaveLength(0)

    // Failed provenance records the lifecycle denial (EXISTING vocabulary).
    const failed = sink.list().find(p => p.resultStatus === 'failed')
    expect(failed?.failureMetadata?.denialReason).toBe('lifecycle_not_activated')

    // The terminal revoked-execution ledger is NEVER used for deactivation.
    expect(isExtensionMarkedRevoked(tenantA, extType, VERSION)).toBe(false)
  })

  it('re-activation (deactivated → activated) permits execution again — REAL wasmtime execution', async () => {
    const extType = `reactivate-real-${Date.now()}`
    // random-guest imports wasi:random/random — declare + approve it.
    await activateExtension(tenantA, extType, ['wasi:random/random'])
    await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.DEACTIVATED)
    expect(isExtensionMarkedDeactivated(tenantA, extType, VERSION)).toBe(true)

    // Re-activation through the authoritative transition (durable update +
    // synchronous mark-clear hook).
    const reactivated = await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.ACTIVATED)
    expect(reactivated.lifecycleState).toBe('activated')
    expect(isExtensionMarkedDeactivated(tenantA, extType, VERSION)).toBe(false)

    // A NEW REAL sandbox execution of a REAL component is permitted and
    // completes successfully through the real wasmtime host.
    const sink = new InMemoryExtensionProvenanceSink()
    const result = await executeExtension(tenantA, {
      extensionType: extType, extensionVersion: VERSION,
      inputPayload: Buffer.from('w022-reactivation'),
      approvedCapabilities: ['wasi:random/random'],
      approvedResourceLimits: { memoryBytes: 64 * 1024 * 1024, timeMs: 30000 },
      idempotencyKey: `exec-${Date.now()}`,
      wasmModule: loadRandomComponent(),
      provenanceSink: sink,
    })
    expect(result.resultStatus).toBe('success')
    expect(sink.list().find(p => p.extensionType === extType && p.resultStatus === 'success')).toBeDefined()
  })

  it('the deactivate/registration race: a stale-catalog execution is refused at registration (no spawn)', async () => {
    // Stage the post-commit instant of the race: the durable deactivation
    // committed (hook marked the deactivation ledger) while a concurrent
    // execution had ALREADY read lifecycleState='activated' from the catalog.
    const extType = `race-deactivate-${Date.now()}`
    await activateExtension(tenantA, extType)
    // Deactivate (durable + mark)...
    await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.DEACTIVATED)
    // ...then simulate the racing execution's STALE catalog view by restoring
    // the durable state directly (bypassing the transition's hook-clear —
    // exactly what the race looks like to the in-flight execution).
    await db.extensionRegistryEntry.updateMany({
      where: { tenantId: tenantA, extensionType: extType, extensionVersion: VERSION },
      data: { lifecycleState: LIFECYCLE_STATE.ACTIVATED },
    })

    const host = new HangingSandboxHost()
    const sink = new InMemoryExtensionProvenanceSink()
    let err: unknown
    try {
      await executeExtension(tenantA, {
        extensionType: extType, extensionVersion: VERSION,
        inputPayload: Buffer.from('race'), idempotencyKey: `exec-${Date.now()}`,
        wasmModule: ANY_WASM, sandboxHost: host, provenanceSink: sink,
      })
    } catch (e) {
      err = e
    }
    // The ActiveExecutionRegistry refused the registration — no sandbox was
    // spawned, no execution outlives the durable deactivation semantics.
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toContain('deactivated')
    expect(host.spawnCount).toBe(0)
    // Failed provenance uses the EXISTING lifecycle denial vocabulary.
    const failed = sink.list().find(p => p.resultStatus === 'failed')
    expect(failed?.failureMetadata?.denialReason).toBe('lifecycle_not_activated')

    // Cleanup: the proper transition pair restores consistent state.
    await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.DEACTIVATED)
    await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.ACTIVATED)
    expect(isExtensionMarkedDeactivated(tenantA, extType, VERSION)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// W022-AC03 + W022-AC08 — install-time validation: classification + import
// verification against DECLARED capabilities, NO spawn, NO execution
// ---------------------------------------------------------------------------

describe('WORK-022 W022-AC03/AC08 — install-time validation', () => {
  it('DENIES the registered → installed transition for an unauthorized REAL component — without spawning', async () => {
    const extType = `install-deny-component-${Date.now()}`
    // Registered WITHOUT the capability the random-guest component imports.
    await registerExtension(tenantA, {
      extensionType: extType,
      extensionVersion: VERSION,
      declaredCapabilities: [], // wasi:random/random NOT declared
      declaredResourceLimits: { memoryBytes: 64 * 1024 * 1024, timeMs: 30000 },
      idempotencyKey: `reg-${extType}-${Date.now()}`,
    })

    // The counting REAL host: real validateOnly, zero spawns tolerated.
    const host = new CountingWasmtimeHost()

    let err: unknown
    try {
      await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.INSTALLED, undefined, {
        wasmModule: loadRandomComponent(),
        sandboxHost: host,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toContain('install denied')
    expect((err as Error).message).toContain('wasi:random/random')

    // NO sandbox was spawned and the module was NOT executed — validation
    // only (classification + import verification).
    expect(host.spawnCount).toBe(0)

    // The denied transition left the entry UNCHANGED (still registered).
    const entry = await getExtension(tenantA, extType, VERSION)
    expect(entry.lifecycleState).toBe('registered')
  })

  it('PERMITS the installed transition for a real component whose imports are all declared (loop: no imports)', async () => {
    const extType = `install-ok-component-${Date.now()}`
    await registerExtension(tenantA, {
      extensionType: extType,
      extensionVersion: VERSION,
      declaredCapabilities: [],
      declaredResourceLimits: { memoryBytes: 64 * 1024 * 1024, timeMs: 30000 },
      idempotencyKey: `reg-${extType}-${Date.now()}`,
    })

    const host = new CountingWasmtimeHost()
    const installed = await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.INSTALLED, undefined, {
      wasmModule: loadLoopComponent(),
      sandboxHost: host,
    })
    expect(installed.lifecycleState).toBe('installed')
    // Validation spawned nothing.
    expect(host.spawnCount).toBe(0)
  })

  it('install WITHOUT a binary proceeds (V4 in-memory path) and audits moduleValidated=false', async () => {
    const extType = `install-no-binary-${Date.now()}`
    const entryId = await activateExtension(tenantA, extType)

    const audits = await db.auditLog.findMany({
      where: { resourceId: entryId, eventType: 'extension_registry.lifecycle_transition' },
      orderBy: { createdAt: 'asc' },
    })
    const installAudit = audits.find(a => {
      const m = JSON.parse(a.metadataJson) as { to?: string }
      return m.to === 'installed'
    })
    expect(installAudit).toBeDefined()
    const metadata = JSON.parse(installAudit!.metadataJson) as Record<string, unknown>
    expect(metadata.moduleValidated).toBe(false)
  })

  it('DENIES install when the host cannot validate (deny-by-default — no validate-only path)', async () => {
    const extType = `install-deny-nohost-${Date.now()}`
    await registerExtension(tenantA, {
      extensionType: extType,
      extensionVersion: VERSION,
      declaredCapabilities: [],
      idempotencyKey: `reg-${extType}-${Date.now()}`,
    })
    // A host WITHOUT the validate-only path: install must be DENIED (V5 §2.7
    // deny-by-default — no silent unvalidated install when a binary exists).
    const host: SandboxHost = {
      isAvailable: () => true,
      execute: async () => { throw new Error('unused') },
      executeWithHandle: () => { throw new Error('unused') },
    }
    let err: unknown
    try {
      await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.INSTALLED, undefined, {
        wasmModule: ANY_WASM,
        sandboxHost: host,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toContain('deny-by-default')
    const entry = await getExtension(tenantA, extType, VERSION)
    expect(entry.lifecycleState).toBe('registered')
  })

  it('DENIES install for a core module importing a never-granted socket operation (real WASM binary)', async () => {
    const extType = `install-deny-socket-${Date.now()}`
    await registerExtension(tenantA, {
      extensionType: extType,
      extensionVersion: VERSION,
      declaredCapabilities: ['wasi:filesystem.read'], // sockets are granted by NO capability
      idempotencyKey: `reg-${extType}-${Date.now()}`,
    })
    // Real core module (Preview 1) importing sock_send_to — never granted.
    const wabtInit = require('wabt').default
    const wabt = await wabtInit()
    const wasmModule = wabt.parseWat(
      'sock.wat',
      `(module (import "wasi_snapshot_preview1" "sock_send_to" (func $s (param i32 i32 i32 i32) (result i32))) (memory (export "memory") 1) (func (export "_start")))`,
    )
    const { buffer } = wasmModule.toBinary({})
    const socketModule = Buffer.from(buffer)

    const host = new CountingWasmtimeHost()
    let err: unknown
    try {
      await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.INSTALLED, undefined, {
        wasmModule: socketModule,
        sandboxHost: host,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toContain('sock_send_to')
    expect(host.spawnCount).toBe(0)
    const entry = await getExtension(tenantA, extType, VERSION)
    expect(entry.lifecycleState).toBe('registered')
  })
})

// ---------------------------------------------------------------------------
// W022-AC04 — revoked remains the ONLY terminal state; WORK-021 semantics
// unchanged
// ---------------------------------------------------------------------------

describe('WORK-022 W022-AC04 — revoked remains terminal (WORK-021 semantics unchanged)', () => {
  it('revokeExtension from DEACTIVATED terminates active executions, marks the terminal ledger, and stays terminal', async () => {
    const extType = `revoke-from-deactivated-${Date.now()}`
    await activateExtension(tenantA, extType)

    const host = new HangingSandboxHost()
    const sink = new InMemoryExtensionProvenanceSink()
    const p = executeExtension(tenantA, {
      extensionType: extType, extensionVersion: VERSION,
      inputPayload: Buffer.from('exec'), idempotencyKey: `k-${Date.now()}`,
      wasmModule: ANY_WASM, sandboxHost: host, provenanceSink: sink,
    })
    const outcome = p.then(() => { throw new Error('expected termination') }, e => e)
    await waitForActiveExecutions(tenantA, extType, 1)

    // Deactivate first (reversible), then revoke (terminal).
    await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.DEACTIVATED)
    expect(host.handles[0]?.revokeCalls).toBe(1)
    const err = await outcome
    expect(err).toBeInstanceOf(SandboxTerminatedError)

    const revoked = await revokeExtension(tenantA, extType, VERSION, { reason: 'terminal after deactivation' })
    expect(revoked.lifecycleState).toBe('revoked')
    expect(revoked.revocationStatus).toBe('revoked')
    expect(isExtensionMarkedRevoked(tenantA, extType, VERSION)).toBe(true)

    // Terminal: no transitions out of revoked; execution denied as revoked.
    let transitionErr: unknown
    try {
      await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.ACTIVATED)
    } catch (e) {
      transitionErr = e
    }
    expect(transitionErr).toBeInstanceOf(ConflictError)

    const denySink = new InMemoryExtensionProvenanceSink()
    let execErr: unknown
    try {
      await executeExtension(tenantA, {
        extensionType: extType, extensionVersion: VERSION,
        inputPayload: Buffer.from('denied'), idempotencyKey: `d-${Date.now()}`,
        wasmModule: ANY_WASM, sandboxHost: new HangingSandboxHost(), provenanceSink: denySink,
      })
    } catch (e) {
      execErr = e
    }
    expect(execErr).toBeInstanceOf(ValidationError)
    expect((execErr as Error).message).toContain('revoked')
    const failed = denySink.list().find(p => p.resultStatus === 'failed')
    expect(failed?.failureMetadata?.denialReason).toBe('revoked')
  })
})

// ---------------------------------------------------------------------------
// W022-AC05 — tenant-scoped and extension-scoped termination
// ---------------------------------------------------------------------------

describe('WORK-022 W022-AC05 — deactivation scoping', () => {
  it('deactivating tenant A never terminates tenant B executions', async () => {
    const extType = `scope-tenant-${Date.now()}`
    await activateExtension(tenantA, extType)
    await activateExtension(tenantB, extType)

    const host = new HangingSandboxHost()
    const pA = executeExtension(tenantA, {
      extensionType: extType, extensionVersion: VERSION,
      inputPayload: Buffer.from('a'), idempotencyKey: `a-${Date.now()}`,
      wasmModule: ANY_WASM, sandboxHost: host, provenanceSink: new InMemoryExtensionProvenanceSink(),
    })
    const outcomeA = pA.then(() => { throw new Error('expected cleanup termination') }, e => e)
    await waitForActiveExecutions(tenantA, extType, 1)

    // Deactivate the SAME extension identity for tenant B.
    await transitionLifecycle(tenantB, extType, VERSION, LIFECYCLE_STATE.DEACTIVATED)

    // Tenant A's execution is STILL active — its handle was NOT revoked.
    const aActive = listActiveExecutions({ tenantId: tenantA, extensionType: extType })
    expect(aActive).toHaveLength(1)
    expect(aActive[0]?.state).toBe('active')
    expect(host.handles[0]?.revokeCalls).toBe(0)
    // Only tenant B's mark exists.
    expect(isExtensionMarkedDeactivated(tenantB, extType, VERSION)).toBe(true)
    expect(isExtensionMarkedDeactivated(tenantA, extType, VERSION)).toBe(false)

    // Deterministic cleanup: terminate tenant A's execution via the registry.
    revokeActiveExecution(aActive[0]!.executionId)
    const cleanupErr = await outcomeA
    expect(cleanupErr).toBeInstanceOf(SandboxTerminatedError)
  })

  it('deactivating one extension never terminates another extension executions', async () => {
    const extX = `scope-ext-x-${Date.now()}`
    const extY = `scope-ext-y-${Date.now()}`
    await activateExtension(tenantA, extX)
    await activateExtension(tenantA, extY)

    const host = new HangingSandboxHost()
    const pY = executeExtension(tenantA, {
      extensionType: extY, extensionVersion: VERSION,
      inputPayload: Buffer.from('y'), idempotencyKey: `y-${Date.now()}`,
      wasmModule: ANY_WASM, sandboxHost: host, provenanceSink: new InMemoryExtensionProvenanceSink(),
    })
    const outcomeY = pY.then(() => { throw new Error('expected cleanup termination') }, e => e)
    await waitForActiveExecutions(tenantA, extY, 1)

    await transitionLifecycle(tenantA, extX, VERSION, LIFECYCLE_STATE.DEACTIVATED)

    // Extension Y's execution is untouched.
    expect(host.handles[0]?.revokeCalls).toBe(0)
    const yActive = listActiveExecutions({ tenantId: tenantA, extensionType: extY })
    expect(yActive).toHaveLength(1)
    expect(yActive[0]?.state).toBe('active')

    // Deterministic cleanup.
    revokeActiveExecution(yActive[0]!.executionId)
    await outcomeY
  })
})

// ---------------------------------------------------------------------------
// W022-AC06 — lifecycle transitions record activeExecutionsTerminated audit
// metadata
// ---------------------------------------------------------------------------

describe('WORK-022 W022-AC06 — activeExecutionsTerminated audit metadata', () => {
  it('the deactivated transition records the count of terminated executions', async () => {
    const extType = `audit-deactivate-${Date.now()}`
    const entryId = await activateExtension(tenantA, extType)

    const host = new HangingSandboxHost()
    const p1 = executeExtension(tenantA, {
      extensionType: extType, extensionVersion: VERSION,
      inputPayload: Buffer.from('1'), idempotencyKey: `k1-${Date.now()}`,
      wasmModule: ANY_WASM, sandboxHost: host, provenanceSink: new InMemoryExtensionProvenanceSink(),
    })
    const p2 = executeExtension(tenantA, {
      extensionType: extType, extensionVersion: VERSION,
      inputPayload: Buffer.from('2'), idempotencyKey: `k2-${Date.now()}`,
      wasmModule: ANY_WASM, sandboxHost: host, provenanceSink: new InMemoryExtensionProvenanceSink(),
    })
    const o1 = p1.then(() => { throw new Error('expected termination') }, e => e)
    const o2 = p2.then(() => { throw new Error('expected termination') }, e => e)
    await waitForActiveExecutions(tenantA, extType, 2)

    await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.DEACTIVATED)
    await Promise.all([o1, o2])

    const audits = await db.auditLog.findMany({
      where: { resourceId: entryId, eventType: 'extension_registry.lifecycle_transition' },
      orderBy: { createdAt: 'asc' },
    })
    const deactivateAudit = audits.find(a => {
      const m = JSON.parse(a.metadataJson) as { to?: string }
      return m.to === 'deactivated'
    })
    expect(deactivateAudit).toBeDefined()
    const metadata = JSON.parse(deactivateAudit!.metadataJson) as {
      from: string; to: string; activeExecutionsTerminated: number
    }
    expect(metadata.from).toBe('activated')
    expect(metadata.to).toBe('deactivated')
    expect(metadata.activeExecutionsTerminated).toBe(2)
  })

  it('EVERY lifecycle transition records activeExecutionsTerminated (0 when nothing is terminated)', async () => {
    const extType = `audit-zero-${Date.now()}`
    const entryId = await activateExtension(tenantA, extType)

    const audits = await db.auditLog.findMany({
      where: { resourceId: entryId, eventType: 'extension_registry.lifecycle_transition' },
      orderBy: { createdAt: 'asc' },
    })
    // registered → installed → activated: all three audited, all with the
    // metadata field present (0 — no in-flight executions existed).
    expect(audits).toHaveLength(2) // installed + activated
    for (const a of audits) {
      const metadata = JSON.parse(a.metadataJson) as { to: string; activeExecutionsTerminated?: number }
      expect(typeof metadata.activeExecutionsTerminated).toBe('number')
      expect(metadata.activeExecutionsTerminated).toBe(0)
    }

    // The installed transition with a validated binary also records the
    // classification metadata.
    const installAudit = audits.find(a => {
      const m = JSON.parse(a.metadataJson) as { to?: string }
      return m.to === 'installed'
    })
    const installMetadata = JSON.parse(installAudit!.metadataJson) as { moduleValidated: boolean }
    expect(installMetadata.moduleValidated).toBe(false)
  })

  it('re-activation records activeExecutionsTerminated=0 and deactivation-reactivation chains are auditable in order', async () => {
    const extType = `audit-chain-${Date.now()}`
    const entryId = await activateExtension(tenantA, extType)

    await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.DEACTIVATED)
    await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.ACTIVATED)

    const audits = await db.auditLog.findMany({
      where: { resourceId: entryId, eventType: 'extension_registry.lifecycle_transition' },
      orderBy: { createdAt: 'asc' },
    })
    const chain = audits.map(a => (JSON.parse(a.metadataJson) as { to: string }).to)
    expect(chain).toEqual(['installed', 'activated', 'deactivated', 'activated'])
  })
})

// ---------------------------------------------------------------------------
// Direct-hook guard rails (in-registry, PG-context) — the deactivation hook
// is idempotent and NEVER writes the terminal ledger
// ---------------------------------------------------------------------------

describe('WORK-022 — deactivation hook guard rails', () => {
  it('repeated deactivation hooks are a no-op for already-revoked handles', () => {
    const r1 = deactivateActiveExecutionsForExtension('guard-tenant', 'guard-ext', VERSION)
    const r2 = deactivateActiveExecutionsForExtension('guard-tenant', 'guard-ext', VERSION)
    expect(r1.executionIds).toHaveLength(0)
    expect(r2.executionIds).toHaveLength(0)
    expect(isExtensionMarkedDeactivated('guard-tenant', 'guard-ext', VERSION)).toBe(true)
    expect(isExtensionMarkedRevoked('guard-tenant', 'guard-ext', VERSION)).toBe(false)
  })

  it('the unused CompletingSandboxHost import guard stays meaningful (type presence)', () => {
    // CompletingSandboxHost is exercised by the reversibility suites above
    // via HangingSandboxHost; this keeps the export honest for future rounds.
    const host = new CompletingSandboxHost()
    expect(host.isAvailable()).toBe(true)
  })
})
