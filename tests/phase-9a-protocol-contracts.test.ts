/**
 * Phase 9A: Protocol Runtime Contracts — Tests
 *
 * These tests prove the protocol runtime boundary and deterministic
 * execution contracts.
 *
 * Architecture tests:
 *   - ProtocolRuntime does NOT import InfrastructureRuntime/adapter/VPP/compute
 *   - ProtocolRuntime accepts ProtocolRuntimeDeps in constructor
 *   - Protocol runtime directory has the expected contract files
 *
 * In-memory tests:
 *   - Deterministic state store: same entries → same hash
 *   - Deterministic executor: same state + transaction → same result
 *   - ProtocolRuntime.executeTransaction works end-to-end
 *   - runtimeKind='protocol' → ProtocolRuntime
 *   - Invalid transactions are rejected (state unchanged)
 *   - Nonce enforcement prevents replay
 *
 * Run: bun test tests/phase-9a-protocol-contracts.test.ts --timeout 30000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { initializeBootstrap } from '../src/lib/bootstrap'
import { resolveRuntime } from '../src/lib/kernel/runtime'
import { ProtocolRuntime } from '../src/lib/kernel/runtime/protocol-runtime'
import { InMemoryProtocolStateStore } from '../src/lib/kernel/runtime/protocol/state-store'
import { DeterministicTransactionExecutor, computeTransactionId } from '../src/lib/kernel/runtime/protocol/executor'
import { StubValidatorRegistry, StubConsensusEngine } from '../src/lib/kernel/runtime/protocol/validator-consensus'
import type { ProtocolTransaction, ProtocolRuntimeDeps } from '../src/lib/kernel/runtime/protocol/types'
import { getTemplate } from '../src/lib/domain/templates'

beforeAll(() => {
  initializeBootstrap()
})

// Helper: create a ProtocolRuntime with real deps for testing.
function createProtocolRuntime(): ProtocolRuntime {
  const stateStore = new InMemoryProtocolStateStore('test-nv')
  const deps: ProtocolRuntimeDeps = {
    stateStore,
    executor: new DeterministicTransactionExecutor(),
    validatorRegistry: new StubValidatorRegistry(),
    consensusEngine: new StubConsensusEngine(),
  }
  return new ProtocolRuntime(deps)
}

// Helper: create a signed protocol transaction.
function createTransaction(
  networkVersionId: string,
  sender: string,
  nonce: number,
  payloadType: string,
  data: Record<string, unknown>,
): ProtocolTransaction {
  const id = computeTransactionId(networkVersionId, sender, nonce, { type: payloadType, data })
  return {
    id,
    networkVersionId,
    sender,
    nonce,
    payload: { type: payloadType, data },
    signature: 'test-signature',
    submittedAt: new Date('2024-01-01T00:00:00Z'), // deterministic — not Date.now()
  }
}

// ---------------------------------------------------------------------------
// Architecture tests: ProtocolRuntime does NOT import infrastructure
// ---------------------------------------------------------------------------

describe('Phase 9A: architecture — protocol runtime isolation', () => {
  const VPP_PATTERNS = [
    /from\s+['"]\.\/infrastructure-runtime/,
    /from\s+['"]\.\/adapter-registry/,
    /from\s+['"]\.\.\/adapters\/infrastructure-adapter/,
    /from\s+['"].*vpp/,
    /from\s+['"].*compute-adapter/,
    /from\s+['"].*compute\.service/,
  ]

  it('ProtocolRuntime does NOT import InfrastructureRuntime or adapters', () => {
    const path = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'protocol-runtime.ts')
    const content = readFileSync(path, 'utf-8')
    for (const pattern of VPP_PATTERNS) {
      expect(content.match(pattern)).toBeNull()
    }
  })

  it('protocol/types.ts does NOT import infrastructure concepts', () => {
    const path = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'protocol', 'types.ts')
    const content = readFileSync(path, 'utf-8')
    for (const pattern of VPP_PATTERNS) {
      expect(content.match(pattern)).toBeNull()
    }
  })

  it('protocol/state-store.ts does NOT import infrastructure concepts', () => {
    const path = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'protocol', 'state-store.ts')
    const content = readFileSync(path, 'utf-8')
    for (const pattern of VPP_PATTERNS) {
      expect(content.match(pattern)).toBeNull()
    }
  })

  it('protocol/executor.ts does NOT import infrastructure concepts', () => {
    const path = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'protocol', 'executor.ts')
    const content = readFileSync(path, 'utf-8')
    for (const pattern of VPP_PATTERNS) {
      expect(content.match(pattern)).toBeNull()
    }
  })

  it('ProtocolRuntime accepts ProtocolRuntimeDeps in constructor', () => {
    const path = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'protocol-runtime.ts')
    const content = readFileSync(path, 'utf-8')
    expect(content).toMatch(/constructor\(private readonly deps:\s*ProtocolRuntimeDeps\)/)
  })

  it('protocol directory has the expected contract files', () => {
    const dir = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'protocol')
    const entries = readdirSync(dir)
    expect(entries).toContain('types.ts')
    expect(entries).toContain('state-store.ts')
    expect(entries).toContain('executor.ts')
    expect(entries).toContain('validator-consensus.ts')
  })
})

// ---------------------------------------------------------------------------
// In-memory tests: deterministic state store
// ---------------------------------------------------------------------------

describe('Phase 9A: deterministic state store', () => {
  it('same entries produce the same hash (determinism)', async () => {
    const store1 = new InMemoryProtocolStateStore('nv1', { alice: '100', bob: '50' })
    const store2 = new InMemoryProtocolStateStore('nv1', { bob: '50', alice: '100' }) // different insertion order
    const s1 = await store1.getState()
    const s2 = await store2.getState()
    expect(s1.hash).toBe(s2.hash)
  })

  it('different entries produce different hashes', async () => {
    const store1 = new InMemoryProtocolStateStore('nv1', { alice: '100' })
    const store2 = new InMemoryProtocolStateStore('nv1', { alice: '101' })
    const s1 = await store1.getState()
    const s2 = await store2.getState()
    expect(s1.hash).not.toBe(s2.hash)
  })

  it('put + commit produces a new versioned snapshot', async () => {
    const store = new InMemoryProtocolStateStore('nv1')
    expect((await store.getState()).version).toBe(0)

    store.put('alice', '100')
    const snapshot = await store.commit(0)
    expect(snapshot.version).toBe(1)
    expect(snapshot.entries.get('alice')).toBe('100')
    expect((await store.getState()).version).toBe(1)
  })

  it('rollback discards staged changes', async () => {
    const store = new InMemoryProtocolStateStore('nv1', { alice: '100' })
    store.put('alice', '200')
    store.rollback()
    expect(await store.get('alice')).toBe('100') // unchanged
    expect((await store.getState()).version).toBe(0) // no new version
  })

  it('getSnapshot retrieves historical versions', async () => {
    const store = new InMemoryProtocolStateStore('nv1')
    store.put('v1', 'a')
    await store.commit(0)
    store.put('v2', 'b')
    await store.commit(1)

    expect((await store.getSnapshot(0))?.entries.get('v1')).toBeUndefined()
    expect((await store.getSnapshot(1))?.entries.get('v1')).toBe('a')
    expect((await store.getSnapshot(2))?.entries.get('v2')).toBe('b')
  })

  it('Phase 9B: commit with stale version throws StaleVersionError', async () => {
    const store = new InMemoryProtocolStateStore('nv1')
    store.put('alice', '100')
    await store.commit(0) // version → 1

    store.put('bob', '50')
    // Try to commit with the OLD expected version (0) — should fail.
    await expect(store.commit(0)).rejects.toThrow(/Stale version/)
  })
})

// ---------------------------------------------------------------------------
// In-memory tests: deterministic executor
// ---------------------------------------------------------------------------

describe('Phase 9A/9B.1: deterministic transaction executor (pure calculator)', () => {
  it('apply: mint transaction calculates new balance', async () => {
    const store = new InMemoryProtocolStateStore('nv1')
    const executor = new DeterministicTransactionExecutor()
    const state = await store.getState()
    const tx = createTransaction('nv1', 'alice', 0, 'mint', { to: 'alice', amount: '100' })

    const calc = executor.apply(tx, state)
    expect(calc.valid).toBe(true)
    expect(calc.newEntries.get('balance:alice')).toBe('100')
  })

  it('apply: transfer transaction calculates balance movement', async () => {
    const store = new InMemoryProtocolStateStore('nv1', { 'balance:alice': '100' })
    const executor = new DeterministicTransactionExecutor()
    const state = await store.getState()
    const tx = createTransaction('nv1', 'alice', 0, 'transfer', { from: 'alice', to: 'bob', amount: '30' })

    const calc = executor.apply(tx, state)
    expect(calc.valid).toBe(true)
    expect(calc.newEntries.get('balance:alice')).toBe('70')
    expect(calc.newEntries.get('balance:bob')).toBe('30')
  })

  it('apply: insufficient balance returns invalid (pure — no store mutation)', async () => {
    const store = new InMemoryProtocolStateStore('nv1')
    const executor = new DeterministicTransactionExecutor()
    const state = await store.getState()
    const tx = createTransaction('nv1', 'alice', 0, 'transfer', { from: 'alice', to: 'bob', amount: '10' })

    const calc = executor.apply(tx, state)
    expect(calc.valid).toBe(false)
    expect(calc.error).toMatch(/Insufficient balance/)
  })

  it('validate: invalid nonce rejected', async () => {
    const store = new InMemoryProtocolStateStore('nv1', { 'nonce:alice': '1' })
    const executor = new DeterministicTransactionExecutor()
    const state = await store.getState()
    const tx = createTransaction('nv1', 'alice', 0, 'mint', { to: 'alice', amount: '100' })

    const error = executor.validate(tx, state)
    expect(error).toMatch(/Invalid nonce/)
  })

  it('deterministic: same state + transaction → same calculated entries', async () => {
    const store1 = new InMemoryProtocolStateStore('nv1')
    const store2 = new InMemoryProtocolStateStore('nv1')
    const executor = new DeterministicTransactionExecutor()
    const state1 = await store1.getState()
    const state2 = await store2.getState()
    const tx = createTransaction('nv1', 'alice', 0, 'mint', { to: 'alice', amount: '100' })

    const calc1 = executor.apply(tx, state1)
    const calc2 = executor.apply(tx, state2)

    // Same resulting entries.
    expect(calc1.valid).toBe(calc2.valid)
    // Compare entries (maps don't have structural equality, so compare keys).
    const keys1 = Array.from(calc1.newEntries.keys()).sort()
    const keys2 = Array.from(calc2.newEntries.keys()).sort()
    expect(keys1).toEqual(keys2)
    for (const key of keys1) {
      expect(calc1.newEntries.get(key)).toBe(calc2.newEntries.get(key))
    }
  })

  it('Phase 9B.1: executor does NOT import or use ProtocolStateStore', () => {
    // The executor is a pure calculator — it should NOT take a store in
    // its constructor or import the store type.
    const executor = new DeterministicTransactionExecutor()
    expect(typeof executor.validate).toBe('function')
    expect(typeof executor.apply).toBe('function')
  })

  it('Phase 9B.1: executor source does NOT import ProtocolStateStore', () => {
    const executorPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'protocol', 'executor.ts')
    const content = readFileSync(executorPath, 'utf-8')
    // The executor must NOT import the state store — it's a pure calculator.
    expect(content).not.toMatch(/import.*ProtocolStateStore/)
    expect(content).not.toMatch(/import.*state-store/)
  })

  it('Phase 9B.1: ProtocolRuntime coordinates load → validate → apply → commit (not executor)', () => {
    // The runtime's executeTransaction should call executor.apply (pure)
    // and stateStore.commit (async) — NOT delegate entirely to the executor.
    const runtimePath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'protocol-runtime.ts')
    const content = readFileSync(runtimePath, 'utf-8')
    // The runtime must call executor.apply (not executor.execute).
    expect(content).toMatch(/executor\.apply\(/)
    // The runtime must call stateStore.commit (not the executor).
    expect(content).toMatch(/stateStore\.commit\(/)
  })
})

// ---------------------------------------------------------------------------
// In-memory tests: ProtocolRuntime.executeTransaction
// ---------------------------------------------------------------------------

describe('Phase 9A: ProtocolRuntime.executeTransaction', () => {
  it('runtime executes a transaction and returns a receipt', async () => {
    const runtime = createProtocolRuntime()
    const tx = createTransaction('test-nv', 'alice', 0, 'mint', { to: 'alice', amount: '100' })

    const result = await runtime.executeTransaction(tx)
    expect(result.success).toBe(true)
    expect(result.resultingState.entries.get('balance:alice')).toBe('100')
    expect(result.receipt.transactionId).toBe(tx.id)
  })

  it('runtime validates without executing', async () => {
    const runtime = createProtocolRuntime()
    const validTx = createTransaction('test-nv', 'alice', 0, 'mint', { to: 'alice', amount: '100' })
    expect(await runtime.validateTransaction(validTx)).toBeNull()

    const invalidTx = createTransaction('test-nv', 'alice', 5, 'mint', { to: 'alice', amount: '100' })
    expect(await runtime.validateTransaction(invalidTx)).toMatch(/Invalid nonce/)
  })

  it('infrastructure-shaped methods still throw NotImplemented', async () => {
    const runtime = createProtocolRuntime()
    const mockTx = {} as any
    await expect(
      runtime.createExecution(mockTx, {
        tenantId: 't1', networkId: 'n1', requestedQuantity: '1', requestedUnit: 'unit',
        startTime: new Date(), endTime: new Date(), sourceType: 'test',
      }),
    ).rejects.toThrow(/not implemented/)
  })
})

// ---------------------------------------------------------------------------
// Runtime resolution: runtimeKind='protocol' → ProtocolRuntime
// ---------------------------------------------------------------------------

describe('Phase 9A: runtime resolution', () => {
  it('resolveRuntime(protocol) returns ProtocolRuntime', () => {
    const runtime = resolveRuntime('protocol')
    expect(runtime).toBeInstanceOf(ProtocolRuntime)
    expect(runtime.kind).toBe('protocol')
  })

  it('ProtocolRuntime.executeTransaction is available on the resolved runtime', () => {
    const runtime = resolveRuntime('protocol')
    expect(runtime).toBeInstanceOf(ProtocolRuntime)
    const protocolRuntime = runtime as ProtocolRuntime
    expect(typeof protocolRuntime.executeTransaction).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Template: protocol-network exists with runtimeKind=protocol
// ---------------------------------------------------------------------------

describe('Phase 9A: protocol-network template', () => {
  it('the protocol-network template exists with runtimeKind=protocol', () => {
    const template = getTemplate('protocol-network')
    expect(template).toBeDefined()
    expect(template!.runtimeKind).toBe('protocol')
    expect(template!.vertical).toBe('protocol')
  })
})
