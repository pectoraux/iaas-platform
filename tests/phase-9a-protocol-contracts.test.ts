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
import { InMemoryValidatorRegistry, SimpleConsensusEngine, AlternateOrderingConsensusEngine } from '../src/lib/kernel/runtime/protocol/validator-consensus'
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
    validatorRegistry: new InMemoryValidatorRegistry(),
    consensusEngine: new SimpleConsensusEngine(),
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

    const writeSet = [{ op: 'put' as const, key: 'alice', value: '100' }]
    const snapshot = await store.commit(0, writeSet)
    expect(snapshot.version).toBe(1)
    expect(snapshot.entries.get('alice')).toBe('100')
    expect((await store.getState()).version).toBe(1)
  })

  it('getSnapshot retrieves historical versions', async () => {
    const store = new InMemoryProtocolStateStore('nv1')
    await store.commit(0, [{ op: 'put', key: 'v1', value: 'a' }])
    await store.commit(1, [{ op: 'put', key: 'v2', value: 'b' }])

    expect((await store.getSnapshot(0))?.entries.get('v1')).toBeUndefined()
    expect((await store.getSnapshot(1))?.entries.get('v1')).toBe('a')
    expect((await store.getSnapshot(2))?.entries.get('v2')).toBe('b')
  })

  it('Phase 9B: commit with stale version throws StaleVersionError', async () => {
    const store = new InMemoryProtocolStateStore('nv1')
    await store.commit(0, [{ op: 'put', key: 'alice', value: '100' }]) // version → 1

    // Try to commit with the OLD expected version (0) — should fail.
    await expect(
      store.commit(0, [{ op: 'put', key: 'bob', value: '50' }]),
    ).rejects.toThrow(/Stale version/)
  })
})

// ---------------------------------------------------------------------------
// In-memory tests: deterministic executor
// ---------------------------------------------------------------------------

describe('Phase 9A/9B.1: deterministic transaction executor (pure calculator)', () => {
  it('apply: mint transaction calculates write set', async () => {
    const store = new InMemoryProtocolStateStore('nv1')
    const executor = new DeterministicTransactionExecutor()
    const state = await store.getState()
    const tx = createTransaction('nv1', 'alice', 0, 'mint', { to: 'alice', amount: '100' })

    const calc = executor.apply(tx, state)
    expect(calc.valid).toBe(true)
    // Write set should contain balance:alice and nonce:alice
    const puts = calc.writeSet.filter(e => e.op === 'put')
    expect(puts.find(e => e.key === 'balance:alice')?.value).toBe('100')
    expect(puts.find(e => e.key === 'nonce:alice')?.value).toBe('1')
  })

  it('apply: transfer transaction calculates write set', async () => {
    const store = new InMemoryProtocolStateStore('nv1', { 'balance:alice': '100', 'nonce:alice': '0' })
    const executor = new DeterministicTransactionExecutor()
    const state = await store.getState()
    const tx = createTransaction('nv1', 'alice', 0, 'transfer', { from: 'alice', to: 'bob', amount: '30' })

    const calc = executor.apply(tx, state)
    expect(calc.valid).toBe(true)
    const puts = calc.writeSet.filter(e => e.op === 'put')
    expect(puts.find(e => e.key === 'balance:alice')?.value).toBe('70')
    expect(puts.find(e => e.key === 'balance:bob')?.value).toBe('30')
  })

  it('apply: insufficient balance returns invalid (pure — no store mutation)', async () => {
    const store = new InMemoryProtocolStateStore('nv1')
    const executor = new DeterministicTransactionExecutor()
    const state = await store.getState()
    const tx = createTransaction('nv1', 'alice', 0, 'transfer', { from: 'alice', to: 'bob', amount: '10' })

    const calc = executor.apply(tx, state)
    expect(calc.valid).toBe(false)
    expect(calc.error).toMatch(/Insufficient balance/)
    expect(calc.writeSet).toEqual([]) // empty write set
  })

  it('validate: invalid nonce rejected', async () => {
    const store = new InMemoryProtocolStateStore('nv1', { 'nonce:alice': '1' })
    const executor = new DeterministicTransactionExecutor()
    const state = await store.getState()
    const tx = createTransaction('nv1', 'alice', 0, 'mint', { to: 'alice', amount: '100' })

    const error = executor.validate(tx, state)
    expect(error).toMatch(/Invalid nonce/)
  })

  it('deterministic: same state + transaction → same write set', async () => {
    const store1 = new InMemoryProtocolStateStore('nv1')
    const store2 = new InMemoryProtocolStateStore('nv1')
    const executor = new DeterministicTransactionExecutor()
    const state1 = await store1.getState()
    const state2 = await store2.getState()
    const tx = createTransaction('nv1', 'alice', 0, 'mint', { to: 'alice', amount: '100' })

    const calc1 = executor.apply(tx, state1)
    const calc2 = executor.apply(tx, state2)

    expect(calc1.valid).toBe(calc2.valid)
    expect(calc1.writeSet).toEqual(calc2.writeSet)
  })

  it('Phase 9B.2: store has NO put/delete/rollback methods (no shared staging)', () => {
    const store = new InMemoryProtocolStateStore('nv1')
    expect(typeof (store as any).put).toBe('undefined')
    expect(typeof (store as any).delete).toBe('undefined')
    expect(typeof (store as any).rollback).toBe('undefined')
  })

  it('Phase 9B.2: commit takes a write set directly', async () => {
    const store = new InMemoryProtocolStateStore('nv1')
    const state = await store.getState()
    const writeSet = [{ op: 'put' as const, key: 'test', value: 'value' }]
    const snapshot = await store.commit(state.version, writeSet)
    expect(snapshot.version).toBe(1)
    expect(snapshot.entries.get('test')).toBe('value')
  })

  it('Phase 9B.2: NetworkVersion isolation — wrong networkVersionId rejected in executeTransaction', async () => {
    const runtime = createProtocolRuntime()
    const tx = createTransaction('wrong-nv', 'alice', 0, 'mint', { to: 'alice', amount: '100' })
    const result = await runtime.executeTransaction(tx)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/does not match store/)
  })

  it('Phase 9B.2 closure: NetworkVersion isolation — wrong networkVersionId rejected in validateTransaction', async () => {
    const runtime = createProtocolRuntime()
    const tx = createTransaction('wrong-nv', 'alice', 0, 'mint', { to: 'alice', amount: '100' })
    const error = await runtime.validateTransaction(tx)
    expect(error).toMatch(/does not match store/)
  })

  it('Phase 9B.2 closure: same-store concurrent write sets do not interleave', async () => {
    // This is the regression test for the original shared-staging-buffer bug.
    // Two transactions use the SAME store instance. Each calculates its own
    // write set (isolated). Tx A commits first; Tx B gets StaleVersionError.
    // The resulting state contains ONLY A's changes — not a mixture of A+B.
    const store = new InMemoryProtocolStateStore('nv1')
    const executor = new DeterministicTransactionExecutor()

    // Both read the same state (version 0).
    const state = await store.getState()

    // Tx A: mint alice 100
    const txA = createTransaction('nv1', 'alice', 0, 'mint', { to: 'alice', amount: '100' })
    const calcA = executor.apply(txA, state)

    // Tx B: mint bob 200 (different key, same version)
    const txB = createTransaction('nv1', 'bob', 0, 'mint', { to: 'bob', amount: '200' })
    const calcB = executor.apply(txB, state)

    // A commits first — succeeds.
    const afterA = await store.commit(state.version, calcA.writeSet, txA.id)
    expect(afterA.version).toBe(1)
    expect(afterA.entries.get('balance:alice')).toBe('100')
    // B's key should NOT be present yet.
    expect(afterA.entries.get('balance:bob')).toBeUndefined()

    // B tries to commit with the old version — StaleVersionError.
    await expect(store.commit(state.version, calcB.writeSet, txB.id)).rejects.toThrow(/Stale version/)

    // Reload state — verify it contains ONLY A's changes.
    const finalState = await store.getState()
    expect(finalState.entries.get('balance:alice')).toBe('100') // A's change
    expect(finalState.entries.get('balance:bob')).toBeUndefined() // B's change was NOT committed
  })

  it('Phase 9B.1: executor does NOT import or use ProtocolStateStore', () => {
    const executor = new DeterministicTransactionExecutor()
    expect(typeof executor.validate).toBe('function')
    expect(typeof executor.apply).toBe('function')
  })

  it('Phase 9B.1: executor source does NOT import ProtocolStateStore', () => {
    const executorPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'protocol', 'executor.ts')
    const content = readFileSync(executorPath, 'utf-8')
    expect(content).not.toMatch(/import.*ProtocolStateStore/)
    expect(content).not.toMatch(/import.*state-store/)
  })

  it('Phase 9B.1: ProtocolRuntime coordinates load → apply → commit (not executor)', () => {
    const runtimePath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'protocol-runtime.ts')
    const content = readFileSync(runtimePath, 'utf-8')
    expect(content).toMatch(/executor\.apply\(/)
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
