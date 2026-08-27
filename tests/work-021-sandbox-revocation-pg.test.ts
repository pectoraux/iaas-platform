/// <reference types="bun-types" />
// =============================================================================
// WORK-021 — AR-021-17 authoritative revocation control path (PostgreSQL)
// =============================================================================
// Proves the EXACT chain the architect required for AR-021-17 — with a real
// PostgreSQL ExtensionRegistry, the real ExtensionRuntime, the real
// ActiveExecutionRegistry, and (for the golden tests) a REAL wasmtime
// subprocess:
//
//   ExtensionRegistry.revokeExtension(...)         (durable DB update)
//       ↓ runtime termination hook (synchronous, after the durable update)
//   ActiveExecutionRegistry.revokeActiveExecutionsForExtension(...)
//       ↓ runtime finds the ACTIVE execution (executionId → handle)
//   SandboxExecutionHandle.revoke()
//       ↓
//   termination (SIGTERM/SIGKILL → SandboxTerminatedError 'revoked')
//
// Before this control path existed, the Runtime stored the execution handle in
// a LOCAL variable, so an extension could be revoked in the catalog while an
// already-running sandbox continued until its own timeout/resource limit.
//
// Frozen V5 §2.5: "revoked: terminal state; future execution denied and
// active context terminated."
//
// Run: bun test tests/work-021-sandbox-revocation-pg.test.ts --timeout 120000
// (requires PostgreSQL + wasmtime + wasm-tools on PATH)
// =============================================================================
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTenant } from '../src/lib/services/tenant.service'
import {
  registerExtension,
  transitionLifecycle,
  revokeExtension,
  LIFECYCLE_STATE,
} from '../src/lib/services/extension-registry.service'
import {
  executeExtension,
  InMemoryExtensionProvenanceSink,
} from '../src/lib/services/extension-runtime.service'
import {
  SandboxTerminatedError,
  type SandboxHost,
  type SandboxExecutionHandle,
  type SandboxExecutionResult,
  type SandboxCeiling,
} from '../src/lib/services/sandbox-host.service'
import {
  listActiveExecutions,
  revokeActiveExecution,
  __resetActiveExecutionRegistryForTesting,
} from '../src/lib/services/active-execution-registry.service'
import { ValidationError } from '../src/lib/domain/errors'

const VERSION = '1.0.0'

let tenantA: string
let tenantB: string

beforeAll(async () => {
  const tA = await createTenant({
    name: 'W021 AR-021-17 Tenant A',
    slug: `w021-revoke-a-${Date.now()}`,
    plan: 'growth',
  })
  tenantA = tA.id
  const tB = await createTenant({
    name: 'W021 AR-021-17 Tenant B',
    slug: `w021-revoke-b-${Date.now()}`,
    plan: 'growth',
  })
  tenantB = tB.id
})

beforeEach(() => {
  // The ActiveExecutionRegistry is module-level state — reset for isolation.
  __resetActiveExecutionRegistryForTesting()
})

/** Register + install + activate an extension (helper). */
async function activateExtension(tenantId: string, extType: string): Promise<void> {
  await registerExtension(tenantId, {
    extensionType: extType,
    extensionVersion: VERSION,
    declaredResourceLimits: { memoryBytes: 64 * 1024 * 1024, timeMs: 30000 },
    idempotencyKey: `reg-${extType}-${Date.now()}`,
  })
  await transitionLifecycle(tenantId, extType, VERSION, LIFECYCLE_STATE.INSTALLED)
  await transitionLifecycle(tenantId, extType, VERSION, LIFECYCLE_STATE.ACTIVATED)
}

/** True infinite-loop Component Model fixture (no imports → no capabilities). */
function loadLoopComponent(): Buffer {
  return readFileSync(join(process.cwd(), 'tests', 'fixtures', 'work-021', 'infinite-loop.component.wasm'))
}

/**
 * Wait until the AUTHORITATIVE ActiveExecutionRegistry shows an execution in
 * the given state for the extension (the sandbox is spawned + attached).
 */
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
      throw new Error(
        `timed out waiting for ${count} active execution(s) of ${extType} (found ${active.length})`,
      )
    }
    await new Promise(r => setTimeout(r, 10))
  }
}

// ---------------------------------------------------------------------------
// Fake sandbox hosts (deterministic; mirror the real host's termination
// semantics: revoke() → SandboxTerminatedError 'revoked')
// ---------------------------------------------------------------------------

/** A hanging execution handle that only terminates via revoke(). */
class HangingHandle implements SandboxExecutionHandle {
  revokeCalls = 0
  private revoked = false
  readonly result: Promise<SandboxExecutionResult>
  private rejectResult!: (err: Error) => void

  constructor() {
    // The result never settles on its own — only revocation ends it.
    this.result = new Promise<SandboxExecutionResult>((_resolve, reject) => {
      this.rejectResult = reject
    })
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

/** A SandboxHost whose executions hang until revoked (spawn-counted). */
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

/** A SandboxHost whose executions complete immediately and successfully. */
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
        measurements: {
          wallTimeMs: 1,
          hostcallBytes: input.length,
          enforcedLimits: {},
        },
        capabilitiesExercised: [],
      } satisfies SandboxExecutionResult),
      revoke: () => {
        this.revokeCalls++
      },
      isRevoked: () => false,
    }
  }
}

/** Minimal wasm binary header (fake hosts perform no import verification). */
const ANY_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

// ---------------------------------------------------------------------------
// GOLDEN PATH — real registry → real runtime → real ActiveExecutionRegistry →
// REAL wasmtime subprocess → real SIGTERM termination
// ---------------------------------------------------------------------------

describe('WORK-021 AR-021-17 — registry revoke terminates an ACTIVE real sandbox', () => {
  it('revokeExtension terminates the running wasmtime execution (terminationReason revoked)', async () => {
    const extType = `golden-revoke-${Date.now()}`
    await activateExtension(tenantA, extType)

    const sink = new InMemoryExtensionProvenanceSink()
    const startedAt = Date.now()

    // Start a REAL sandboxed execution of a true infinite-loop Component Model
    // binary (30s wall-clock ceiling — the only thing that could stop it
    // without revocation).
    const execPromise = executeExtension(tenantA, {
      extensionType: extType,
      extensionVersion: VERSION,
      inputPayload: Buffer.from('ar-021-17-golden-revocation'),
      approvedResourceLimits: { memoryBytes: 64 * 1024 * 1024, timeMs: 30000 },
      idempotencyKey: `exec-${Date.now()}`,
      wasmModule: loadLoopComponent(),
      provenanceSink: sink,
    })
    // Attach a handler immediately so the termination rejection (which may
    // land while this test is still awaiting revokeExtension) is never an
    // unhandled rejection; the outcome resolves to the thrown error.
    const outcome = execPromise.then(
      () => { throw new Error('expected the sandbox execution to be terminated') },
      e => e,
    )

    // Wait until the AUTHORITATIVE registry shows the execution ACTIVE
    // (spawned + handle attached) — the sandbox is genuinely running now.
    await waitForActiveExecutions(tenantA, extType, 1)
    const [registered] = listActiveExecutions({ tenantId: tenantA, extensionType: extType })
    expect(registered?.state).toBe('active')

    // === THE ARCHITECT-REQUIRED CONTROL PATH ===
    // registry revoke (durable) → runtime termination hook → handle.revoke()
    // → termination.
    const revokedEntry = await revokeExtension(tenantA, extType, VERSION, {
      reason: 'AR-021-17 golden revocation proof',
    })
    expect(revokedEntry.revocationStatus).toBe('revoked')
    expect(revokedEntry.lifecycleState).toBe('revoked')

    // The ACTIVE execution must be terminated — not left running until its
    // own 30s timeout/resource ceiling.
    const err = await outcome
    expect(err).toBeInstanceOf(SandboxTerminatedError)
    const terminated = err as SandboxTerminatedError
    // The explicit initiating cause is 'revoked' — NOT 'timeout' (AR-021-19).
    expect(terminated.terminationReason).toBe('revoked')
    // Belt and suspenders: the execution died FAR below its 30s ceiling.
    expect(Date.now() - startedAt).toBeLessThan(25000)

    // Failed provenance records the explicit termination cause.
    const failed = sink.list().find(p => p.extensionType === extType && p.resultStatus === 'failed')
    expect(failed).toBeDefined()
    expect(failed?.failureMetadata?.terminationReason).toBe('revoked')

    // The completed (terminated) execution is deregistered.
    expect(listActiveExecutions({ tenantId: tenantA, extensionType: extType })).toHaveLength(0)
  })

  it('transitionLifecycle(→ revoked) — the second durable path — terminates the running sandbox too', async () => {
    const extType = `lifecycle-revoke-${Date.now()}`
    await activateExtension(tenantA, extType)

    const sink = new InMemoryExtensionProvenanceSink()
    const execPromise = executeExtension(tenantA, {
      extensionType: extType,
      extensionVersion: VERSION,
      inputPayload: Buffer.from('lifecycle-revocation'),
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

    // Durable path #2 to the revoked lifecycle state: direct transition.
    const transitioned = await transitionLifecycle(tenantA, extType, VERSION, LIFECYCLE_STATE.REVOKED)
    expect(transitioned.lifecycleState).toBe('revoked')

    const err = await outcome
    expect(err).toBeInstanceOf(SandboxTerminatedError)
    expect((err as SandboxTerminatedError).terminationReason).toBe('revoked')
    expect(listActiveExecutions({ tenantId: tenantA, extensionType: extType })).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Future execution denied (V5 §2.5) — no sandbox is ever spawned
// ---------------------------------------------------------------------------

describe('WORK-021 AR-021-17 — revoked extension denies future execution', () => {
  it('executeExtension on a revoked extension is denied and NO sandbox is spawned', async () => {
    const extType = `deny-revoked-${Date.now()}`
    await activateExtension(tenantA, extType)
    await revokeExtension(tenantA, extType, VERSION, { reason: 'deny future executions' })

    const host = new HangingSandboxHost()
    const sink = new InMemoryExtensionProvenanceSink()

    let err: unknown
    try {
      await executeExtension(tenantA, {
        extensionType: extType,
        extensionVersion: VERSION,
        inputPayload: Buffer.from('denied'),
        idempotencyKey: `exec-${Date.now()}`,
        wasmModule: ANY_WASM,
        sandboxHost: host,
        provenanceSink: sink,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toContain('revoked')

    // The durable lifecycle gate refused the execution — no sandbox spawned.
    expect(host.spawnCount).toBe(0)
    expect(listActiveExecutions()).toHaveLength(0)

    // Failed provenance records the revocation denial.
    const failed = sink.list().find(p => p.resultStatus === 'failed')
    expect(failed?.failureMetadata?.denialReason).toBe('revoked')
  })
})

// ---------------------------------------------------------------------------
// Every concurrent active execution is terminated
// ---------------------------------------------------------------------------

describe('WORK-021 AR-021-17 — revoke terminates EVERY concurrent execution', () => {
  it('two concurrent sandboxed executions are both terminated by one revokeExtension', async () => {
    const extType = `concurrent-revoke-${Date.now()}`
    await activateExtension(tenantA, extType)

    const host = new HangingSandboxHost()
    const sink = new InMemoryExtensionProvenanceSink()

    const p1 = executeExtension(tenantA, {
      extensionType: extType,
      extensionVersion: VERSION,
      inputPayload: Buffer.from('exec-1'),
      idempotencyKey: `k1-${Date.now()}`,
      wasmModule: ANY_WASM,
      sandboxHost: host,
      provenanceSink: sink,
    })
    const p2 = executeExtension(tenantA, {
      extensionType: extType,
      extensionVersion: VERSION,
      inputPayload: Buffer.from('exec-2'),
      idempotencyKey: `k2-${Date.now()}`,
      wasmModule: ANY_WASM,
      sandboxHost: host,
      provenanceSink: sink,
    })
    // Attach handlers IMMEDIATELY: the fake host rejects synchronously inside
    // revokeExtension below (before the test would otherwise await these
    // promises) — without an attached handler that would surface as an
    // unhandled rejection instead of the assertion below.
    const outcome1 = p1.then(
      () => { throw new Error('expected the first execution to be terminated') },
      e => e,
    )
    const outcome2 = p2.then(
      () => { throw new Error('expected the second execution to be terminated') },
      e => e,
    )

    await waitForActiveExecutions(tenantA, extType, 2)
    expect(host.spawnCount).toBe(2)

    await revokeExtension(tenantA, extType, VERSION, { reason: 'terminate all concurrent' })

    // BOTH executions terminated with the explicit 'revoked' cause.
    const [e1, e2] = await Promise.all([outcome1, outcome2])
    expect(e1).toBeInstanceOf(SandboxTerminatedError)
    expect((e1 as SandboxTerminatedError).terminationReason).toBe('revoked')
    expect(e2).toBeInstanceOf(SandboxTerminatedError)
    expect((e2 as SandboxTerminatedError).terminationReason).toBe('revoked')
    // Every handle was revoked exactly once.
    expect(host.handles.map(h => h.revokeCalls)).toEqual([1, 1])
    // Nothing remains registered.
    expect(listActiveExecutions({ tenantId: tenantA, extensionType: extType })).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tenant isolation of termination (V5 §2.6)
// ---------------------------------------------------------------------------

describe('WORK-021 AR-021-17 — termination is tenant-scoped', () => {
  it('revoking tenant B’s extension leaves tenant A’s active execution untouched', async () => {
    const extType = `tenant-iso-revoke-${Date.now()}`
    await activateExtension(tenantA, extType)
    await activateExtension(tenantB, extType)

    const host = new HangingSandboxHost()
    const pA = executeExtension(tenantA, {
      extensionType: extType,
      extensionVersion: VERSION,
      inputPayload: Buffer.from('tenant-a'),
      idempotencyKey: `a-${Date.now()}`,
      wasmModule: ANY_WASM,
      sandboxHost: host,
      provenanceSink: new InMemoryExtensionProvenanceSink(),
    })
    const outcomeA = pA.then(
      () => { throw new Error('expected tenant A cleanup termination') },
      e => e,
    )
    await waitForActiveExecutions(tenantA, extType, 1)

    // Revoke the SAME extension identity for tenant B.
    await revokeExtension(tenantB, extType, VERSION, { reason: 'tenant B revocation' })

    // Tenant A's execution is STILL active — its handle was NOT revoked.
    const aActive = listActiveExecutions({ tenantId: tenantA, extensionType: extType })
    expect(aActive).toHaveLength(1)
    expect(aActive[0]?.state).toBe('active')
    expect(host.handles[0]?.revokeCalls).toBe(0)

    // Deterministic cleanup: terminate tenant A's execution via the registry.
    revokeActiveExecution(aActive[0]!.executionId)
    const cleanupErr = await outcomeA
    expect(cleanupErr).toBeInstanceOf(SandboxTerminatedError)
    expect((cleanupErr as SandboxTerminatedError).terminationReason).toBe('revoked')
  })
})

// ---------------------------------------------------------------------------
// Completed executions are deregistered (revocation is not retroactive)
// ---------------------------------------------------------------------------

describe('WORK-021 AR-021-17 — completed executions leave nothing to terminate', () => {
  it('a successful execution deregisters itself; a later revoke terminates nothing', async () => {
    const extType = `completed-revoke-${Date.now()}`
    await activateExtension(tenantA, extType)

    const host = new CompletingSandboxHost()
    const sink = new InMemoryExtensionProvenanceSink()

    const result = await executeExtension(tenantA, {
      extensionType: extType,
      extensionVersion: VERSION,
      inputPayload: Buffer.from('finish'),
      idempotencyKey: `exec-${Date.now()}`,
      wasmModule: ANY_WASM,
      sandboxHost: host,
      provenanceSink: sink,
    })
    expect(result.resultStatus).toBe('success')
    expect(host.spawnCount).toBe(1)

    // The execution completed and deregistered — nothing is active.
    expect(listActiveExecutions({ tenantId: tenantA, extensionType: extType })).toHaveLength(0)

    // A late revoke terminates nothing: no handle is revoked afterwards.
    const revoked = await revokeExtension(tenantA, extType, VERSION, { reason: 'late revocation' })
    expect(revoked.revocationStatus).toBe('revoked')
    expect(host.revokeCalls).toBe(0)
  })
})
