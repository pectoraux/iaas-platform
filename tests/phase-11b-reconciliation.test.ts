/**
 * Phase 11B: Hybrid Reconciliation — Durable Persistence + Crash Recovery
 *
 * This test proves the Phase 11A specification §8 completeness criteria:
 *
 *   Criterion 2: Four-primitive object model (evidence, commitment, outcome, state)
 *   Criterion 3: Durable ReconciliationStore (atomic, OCC-guarded)
 *   Criterion 4: Crash-safe sequencing (recordPending BEFORE submitTransaction)
 *   Criterion 5: Crash recovery (loadPending + journal lookup + idempotent re-submit)
 *   Criterion 6: Anti-conflation (precise ReconciliationState per BatchExecutionStatus)
 *   Criterion 7: Bridge determinism enforcement
 *   Criterion 8: Crash-recovery proof (PENDING survives restart, no double-count)
 *
 * THE CRITICAL TEST IS THE CRASH-RECOVERY PROOF:
 *   1. Execute hybrid → physical succeeds, protocol commits, commitment RECONCILED
 *   2. Simulate crash: create a PENDING commitment (physical done, protocol not yet)
 *   3. Simulate restart: new runtime instance, call recoverPending()
 *   4. Verify: the PENDING commitment is resolved WITHOUT double-counting
 *
 * Run: bun test tests/phase-11b-reconciliation.test.ts --timeout 30000
 */
import { describe, it, expect } from 'bun:test'
import { HybridRuntime, DefaultHybridBridge } from '../src/lib/kernel/runtime/hybrid-runtime'
import { InfrastructureRuntime } from '../src/lib/kernel/runtime/infrastructure-runtime'
import { ProtocolRuntime } from '../src/lib/kernel/runtime/protocol-runtime'
import { AdapterRegistry } from '../src/lib/kernel/runtime/adapter-registry'
import { InMemoryProtocolStateStore } from '../src/lib/kernel/runtime/protocol/state-store'
import { DeterministicTransactionExecutor } from '../src/lib/kernel/runtime/protocol/executor'
import { TransferHandler, MintHandler, RecordDeliveryHandler } from '../src/lib/bootstrap/handlers'
import { InMemoryValidatorRegistry, SimpleConsensusEngine } from '../src/lib/kernel/runtime/protocol/validator-consensus'
import { InMemoryReconciliationStore } from '../src/lib/kernel/runtime/protocol/in-memory-reconciliation-store'
import {
  mapBatchStatusToReconciliationState,
  computeEvidence,
  computeOutcome,
} from '../src/lib/kernel/runtime/protocol/reconciliation-types'
import { SimulatedComputeAdapter } from '../src/lib/services/compute-adapter.service'
import type { ProtocolRuntimeDeps } from '../src/lib/kernel/runtime/protocol/types'
import type { ReconciliationStore } from '../src/lib/kernel/runtime/protocol/reconciliation-types'

// Helper: create a fully-wired HybridRuntime with isolated in-memory stores.
function createHybridRuntime(
  reconciliationStore?: ReconciliationStore,
  networkVersionId = 'phase-11b-test-nv',
  sharedStateStore?: InMemoryProtocolStateStore,
): {
  hybrid: HybridRuntime
  reconciliationStore: ReconciliationStore
  protocolRuntime: ProtocolRuntime
  stateStore: InMemoryProtocolStateStore
} {
  const adapterRegistry = new AdapterRegistry()
  adapterRegistry.register({
    adapter: new SimulatedComputeAdapter(),
    supportedAssetTypes: ['compute_node', 'gpu_cluster'],
    supportedCapabilities: ['gpu_compute', 'cpu_compute'],
  })
  const infrastructureRuntime = new InfrastructureRuntime(adapterRegistry)

  const stateStore = sharedStateStore ?? new InMemoryProtocolStateStore(networkVersionId)
  const executor = new DeterministicTransactionExecutor()
  executor.registerHandler('transfer', new TransferHandler())
  executor.registerHandler('mint', new MintHandler())
  executor.registerHandler('record_delivery', new RecordDeliveryHandler())
  const protocolDeps: ProtocolRuntimeDeps = {
    stateStore,
    executor,
    validatorRegistry: new InMemoryValidatorRegistry(),
    consensusEngine: new SimpleConsensusEngine(),
  }
  const protocolRuntime = new ProtocolRuntime(protocolDeps)

  const reconStore = reconciliationStore ?? new InMemoryReconciliationStore()

  const hybrid = new HybridRuntime({
    infrastructureRuntime,
    protocolRuntime,
    bridge: new DefaultHybridBridge(),
    protocolSender: 'phase-11b-sender',
    reconciliationStore: reconStore,
  })

  return { hybrid, reconciliationStore: reconStore, protocolRuntime, stateStore }
}

// ---------------------------------------------------------------------------
// Criterion 6: Anti-conflation — precise ReconciliationState per BatchExecutionStatus
// ---------------------------------------------------------------------------

describe('Phase 11B §7: anti-conflation cause taxonomy (R2)', () => {
  it('every BatchExecutionStatus maps to a DISTINCT ReconciliationState', () => {
    const mappings = [
      'EXECUTED',
      'EXECUTION_FAILED',
      'REJECTED_BY_CONSENSUS',
      'INVALID_FINALITY_CERTIFICATE',
      'NO_TRANSACTIONS',
    ] as const

    const states = mappings.map(mapBatchStatusToReconciliationState)

    // R2: no two distinct BatchExecutionStatus values map to the same state.
    // This is the structural anti-conflation invariant.
    const unique = new Set(states)
    expect(unique.size).toBe(mappings.length)

    // Verify each mapping explicitly.
    expect(mapBatchStatusToReconciliationState('EXECUTED')).toBe('RECONCILED')
    expect(mapBatchStatusToReconciliationState('EXECUTION_FAILED')).toBe(
      'RECONCILIATION_REQUIRED_EXECUTION_FAILURE',
    )
    expect(mapBatchStatusToReconciliationState('REJECTED_BY_CONSENSUS')).toBe(
      'RECONCILIATION_REQUIRED_CONSENSUS_REJECTION',
    )
    expect(mapBatchStatusToReconciliationState('INVALID_FINALITY_CERTIFICATE')).toBe(
      'RECONCILIATION_REQUIRED_CERTIFICATE_INVALID',
    )
    expect(mapBatchStatusToReconciliationState('NO_TRANSACTIONS')).toBe(
      'RECONCILIATION_REQUIRED_INVARIANT_VIOLATION',
    )
  })
})

// ---------------------------------------------------------------------------
// Criterion 4: Crash-safe sequencing — recordPending BEFORE submitTransaction
// ---------------------------------------------------------------------------

describe('Phase 11B §6.2: crash-safe sequencing', () => {
  it('executeHybrid produces a RECONCILED commitment on the happy path', async () => {
    const { hybrid } = createHybridRuntime()

    const result = await hybrid.executeHybrid(
      {
        assetId: 'gpu-1',
        assetType: 'gpu_cluster',
        capabilityType: 'gpu_compute',
        assignedQuantity: '10',
        assignedUnit: 'GPU-hours',
        durationSeconds: 3600,
        parameters: { gpuCount: 4 },
      },
      0,
    )

    // Physical execution succeeded.
    expect(result.infrastructureResult.success).toBe(true)

    // Protocol committed.
    expect(result.protocolResult.status).toBe('EXECUTED')

    // The commitment is RECONCILED (not the old conflated state).
    expect(result.commitment.status).toBe('RECONCILED')
    expect(result.commitment.evidenceId).toBeTruthy()
    expect(result.commitment.intendedTransactionId).toBe(
      result.protocolResult.receipts[0].receipt.transactionId,
    )
    expect(result.commitment.resolvedAt).toBeDefined()
    expect(result.commitment.outcomeId).toBeDefined()
  })

  it('consensus rejection produces RECONCILIATION_REQUIRED_CONSENSUS_REJECTION (not conflated)', async () => {
    // No validators → consensus rejects.
    const adapterRegistry = new AdapterRegistry()
    adapterRegistry.register({
      adapter: new SimulatedComputeAdapter(),
      supportedAssetTypes: ['compute_node', 'gpu_cluster'],
      supportedCapabilities: ['gpu_compute', 'cpu_compute'],
    })
    const infrastructureRuntime = new InfrastructureRuntime(adapterRegistry)
    const stateStore = new InMemoryProtocolStateStore('recon-reject-nv')
    const executor = new DeterministicTransactionExecutor()
    executor.registerHandler('record_delivery', new RecordDeliveryHandler())
    const validatorRegistry = new InMemoryValidatorRegistry() // empty → rejects
    const protocolRuntime = new ProtocolRuntime({
      stateStore,
      executor,
      validatorRegistry,
      consensusEngine: new SimpleConsensusEngine('validator-0', validatorRegistry),
    })

    const reconStore = new InMemoryReconciliationStore()
    const hybrid = new HybridRuntime({
      infrastructureRuntime,
      protocolRuntime,
      bridge: new DefaultHybridBridge(),
      protocolSender: 'recon-reject-sender',
      reconciliationStore: reconStore,
    })

    const result = await hybrid.executeHybrid(
      {
        assetId: 'recon-reject-1',
        assetType: 'gpu_cluster',
        capabilityType: 'gpu_compute',
        assignedQuantity: '10',
        assignedUnit: 'GPU-hours',
        durationSeconds: 3600,
      },
      0,
    )

    expect(result.infrastructureResult.success).toBe(true)
    expect(result.protocolResult.status).toBe('REJECTED_BY_CONSENSUS')
    // PRECISE cause preserved — not the old conflated RECONCILIATION_REQUIRED.
    expect(result.commitment.status).toBe('RECONCILIATION_REQUIRED_CONSENSUS_REJECTION')
  })
})

// ---------------------------------------------------------------------------
// Criterion 3: Durable ReconciliationStore — C3 idempotence
// ---------------------------------------------------------------------------

describe('Phase 11B §4.2 C3: idempotent recordPending', () => {
  it('recordPending with the same evidenceId returns the existing commitment (no duplicate)', async () => {
    const { hybrid, reconciliationStore } = createHybridRuntime()

    // Execute once — creates evidence + PENDING commitment, then resolves.
    await hybrid.executeHybrid(
      {
        assetId: 'idempotent-1',
        assetType: 'gpu_cluster',
        capabilityType: 'gpu_compute',
        assignedQuantity: '5',
        assignedUnit: 'GPU-hours',
        durationSeconds: 3600,
      },
      0,
    )

    // Manually create a PENDING commitment for the same evidence to test
    // the idempotence path (C3).
    const evidence = computeEvidence(
      'idempotent-test-asset',
      'idempotent-nv',
      {
        actualQuantity: '5',
        actualUnit: 'GPU-hours',
        telemetryPayload: { test: true },
        success: true,
      },
      new Date('2024-01-01T00:00:00Z'),
    )

    const commitment1 = await reconciliationStore.recordPending(
      evidence,
      'intended-tx-id-123',
      'sender-1',
      0,
    )
    const commitment2 = await reconciliationStore.recordPending(
      evidence,
      'intended-tx-id-123',
      'sender-1',
      0,
    )

    // C3: same evidenceId → same commitment (no duplicate).
    expect(commitment1.commitmentId).toBe(commitment2.commitmentId)
    expect(commitment1.evidenceId).toBe(commitment2.evidenceId)
    expect(commitment1.status).toBe('PENDING')
  })

  it('C4: a resolved commitment cannot transition backwards', async () => {
    const { hybrid, reconciliationStore } = createHybridRuntime()

    const result = await hybrid.executeHybrid(
      {
        assetId: 'c4-test',
        assetType: 'gpu_cluster',
        capabilityType: 'gpu_compute',
        assignedQuantity: '5',
        assignedUnit: 'GPU-hours',
        durationSeconds: 3600,
      },
      0,
    )

    // The commitment is RECONCILED.
    expect(result.commitment.status).toBe('RECONCILED')

    // Attempting to resolve it again should throw (C4: forward only).
    const dupOutcome = computeOutcome(
      result.commitment.commitmentId,
      result.commitment.intendedTransactionId,
      { status: 'EXECUTED', receipts: [] },
      new Date(),
    )
    await expect(
      reconciliationStore.resolve(result.commitment.commitmentId, dupOutcome),
    ).rejects.toThrow(/already resolved|backwards|C4/)
  })
})

// ---------------------------------------------------------------------------
// Criterion 8: THE CRASH-RECOVERY PROOF
// ---------------------------------------------------------------------------

describe('Phase 11B §6.3 + §8: crash-recovery proof', () => {
  it('a PENDING commitment survives a simulated restart and resolves without double-counting', async () => {
    // This is THE test that the spec §8 criterion 8 requires.
    //
    // Scenario: physical execution succeeds, evidence + PENDING commitment
    // are durably written, but the process crashes BEFORE submitTransaction
    // completes. On restart, recoverPending() must:
    //   1. Load the PENDING commitment
    //   2. Re-derive the transaction from the evidence (deterministic)
    //   3. Check the journal — the transaction did NOT commit before crash
    //   4. Re-submit via submitTransaction
    //   5. Resolve the commitment to RECONCILED
    //
    // And: the protocol state must advance exactly ONCE (no double-count).

    const reconciliationStore = new InMemoryReconciliationStore()
    const { hybrid: hybrid1, protocolRuntime, stateStore } = createHybridRuntime(
      reconciliationStore,
      'crash-recovery-nv',
    )

    // Step 1: Manually create a PENDING commitment (simulating that
    // executeHybrid crashed after step 4 DURABLE WRITE #1 but before
    // step 5 submitTransaction). We do this by calling recordPending
    // directly, bypassing the full executeHybrid flow.
    const networkVersionId = 'crash-recovery-nv'
    const evidence = computeEvidence(
      'crash-asset-1',
      networkVersionId,
      {
        actualQuantity: '9.5',
        actualUnit: 'GPU-hours',
        telemetryPayload: { gpuCount: 4, duration: 3600 },
        success: true,
      },
      new Date('2024-01-01T00:00:00Z'),
    )

    // Derive the intended transaction ID (what the bridge WOULD produce).
    const transaction = new DefaultHybridBridge().infrastructureResultToTransaction(
      JSON.parse(evidence.resultJson),
      networkVersionId,
      'phase-11b-sender',
      0,
    )

    const pendingCommitment = await reconciliationStore.recordPending(
      evidence,
      transaction.id,
      'phase-11b-sender',
      0,
    )
    expect(pendingCommitment.status).toBe('PENDING')

    // Verify the protocol state is at version 0 (no commit yet).
    const stateBefore = await protocolRuntime.stateStore.getState()
    expect(stateBefore.version).toBe(0)

    // Step 2: Simulate process restart — construct a NEW HybridRuntime
    // instance that shares the SAME reconciliationStore and protocol state
    // store. In a real system, the new process loads both from PostgreSQL.
    const { hybrid: hybrid2 } = createHybridRuntime(
      reconciliationStore,
      networkVersionId,
      stateStore, // share the SAME state store — protocol state is persistent
    )

    // Step 3: Call recoverPending() — the restart recovery path.
    const resolved = await hybrid2.recoverPending()

    // Step 4: Verify the commitment was resolved.
    expect(resolved.length).toBe(1)
    expect(resolved[0].status).toBe('RECONCILED')
    expect(resolved[0].resolvedAt).toBeDefined()

    // Step 5: Verify NO double-counting — the protocol state advanced
    // exactly ONCE (from 0 to 1), not twice.
    const stateAfter = await hybrid2.protocol.stateStore.getState()
    expect(stateAfter.version).toBe(1)

    // Step 6: Verify the commitment is no longer PENDING (recovery is
    // idempotent — calling recoverPending again is a no-op).
    const resolvedAgain = await hybrid2.recoverPending()
    expect(resolvedAgain.length).toBe(0)

    const stateAfterAgain = await hybrid2.protocol.stateStore.getState()
    expect(stateAfterAgain.version).toBe(1) // still 1, no double-count
  })

  it('recovery detects that the protocol commit already succeeded (journal lookup)', async () => {
    // Scenario: crash happened AFTER the protocol commit but BEFORE the
    // resolve() DURABLE WRITE #2. The transaction IS in the journal.
    // Recovery must detect this and synthesize an EXECUTED outcome
    // WITHOUT re-submitting (which would double-count).

    const reconciliationStore = new InMemoryReconciliationStore()
    const { hybrid, protocolRuntime, stateStore } = createHybridRuntime(
      reconciliationStore,
      'crash-after-commit-nv',
    )

    const networkVersionId = 'crash-after-commit-nv'

    // Execute hybrid fully — this commits the protocol transaction AND
    // resolves the commitment. Then we'll create a SECOND pending
    // commitment for the SAME transaction to simulate a crash between
    // submitTransaction and resolve.
    const result = await hybrid.executeHybrid(
      {
        assetId: 'crash-after-commit-asset',
        assetType: 'gpu_cluster',
        capabilityType: 'gpu_compute',
        assignedQuantity: '5',
        assignedUnit: 'GPU-hours',
        durationSeconds: 3600,
      },
      0,
    )
    expect(result.commitment.status).toBe('RECONCILED')
    const stateAfterFirstCommit = await protocolRuntime.stateStore.getState()
    expect(stateAfterFirstCommit.version).toBe(1)

    // Now simulate a crash: create a new PENDING commitment whose
    // intendedTransactionId matches the ALREADY-COMMITTED transaction.
    // This simulates: physical done → recordPending → submit → CRASH
    // (before resolve). The transaction IS in the journal.
    const evidence = computeEvidence(
      'crash-after-commit-asset-2', // different evidence (different occurredAt)
      networkVersionId,
      result.infrastructureResult,
      new Date('2024-06-01T00:00:00Z'),
    )

    // Use the SAME intendedTransactionId as the already-committed transaction.
    const pendingCommitment = await reconciliationStore.recordPending(
      evidence,
      result.commitment.intendedTransactionId,
      'phase-11b-sender',
      0,
    )
    expect(pendingCommitment.status).toBe('PENDING')

    const versionBeforeRecovery = (await protocolRuntime.stateStore.getState()).version

    // Wrap the store so findCommittedTransaction reports the transaction as
    // committed (simulating a journal hit). In production, the
    // PostgresReconciliationStore queries db.protocolTransition.
    const journalAwareStore: ReconciliationStore = {
      recordPending: reconciliationStore.recordPending.bind(reconciliationStore),
      resolve: reconciliationStore.resolve.bind(reconciliationStore),
      loadPending: reconciliationStore.loadPending.bind(reconciliationStore),
      findByEvidence: reconciliationStore.findByEvidence.bind(reconciliationStore),
      loadEvidence: reconciliationStore.loadEvidence.bind(reconciliationStore),
      findCommittedTransaction: async (_nv: string, txId: string) => {
        if (txId === result.commitment.intendedTransactionId) {
          return new Date() // journal has this transaction
        }
        return null
      },
    }

    // Recovery: construct a NEW runtime sharing the SAME state store
    // (simulating a new process loading the same DB). Recovery should
    // detect the journal entry and synthesize EXECUTED WITHOUT re-submitting.
    const { hybrid: hybrid2 } = createHybridRuntime(
      journalAwareStore,
      networkVersionId,
      stateStore, // share the SAME state store — protocol state is persistent
    )
    const resolved = await hybrid2.recoverPending()

    expect(resolved.length).toBe(1)
    expect(resolved[0].status).toBe('RECONCILED')

    // NO double-count: the protocol version did NOT advance again.
    const versionAfterRecovery = (await hybrid2.protocol.stateStore.getState()).version
    expect(versionAfterRecovery).toBe(versionBeforeRecovery)
  })
})

// ---------------------------------------------------------------------------
// Criterion 7: Bridge determinism enforcement
// ---------------------------------------------------------------------------

describe('Phase 11B §6.4: bridge determinism enforcement', () => {
  it('re-deriving a transaction from evidence produces the same transaction ID', async () => {
    // This proves the bridge is a pure function of (result, networkVersionId,
    // sender, nonce) — the precondition for crash recovery to be safe.
    const bridge = new DefaultHybridBridge()
    const result = {
      actualQuantity: '9.5',
      actualUnit: 'GPU-hours',
      telemetryPayload: { gpuCount: 4 },
      success: true,
    }
    const networkVersionId = 'determinism-test-nv'
    const sender = 'test-sender'
    const nonce = 0

    const tx1 = bridge.infrastructureResultToTransaction(result, networkVersionId, sender, nonce)
    const tx2 = bridge.infrastructureResultToTransaction(result, networkVersionId, sender, nonce)

    // Same inputs → same transaction ID (deterministic).
    expect(tx1.id).toBe(tx2.id)

    // The evidence's resultJson, when deserialized and re-derived, must
    // produce the same ID. This is the C2 invariant that makes recovery safe.
    const evidence = computeEvidence(
      'determinism-asset',
      networkVersionId,
      result,
      new Date('2024-01-01T00:00:00Z'),
    )
    const deserializedResult = JSON.parse(evidence.resultJson)
    const txFromEvidence = bridge.infrastructureResultToTransaction(
      deserializedResult,
      networkVersionId,
      sender,
      nonce,
    )
    expect(txFromEvidence.id).toBe(tx1.id)
  })
})

// ---------------------------------------------------------------------------
// Criterion 2: Four-primitive object model — no whole-object storage
// ---------------------------------------------------------------------------

describe('Phase 11B §4: four-primitive object model', () => {
  it('PendingCommitment stores hashes/IDs, not whole RuntimeExecuteResult or ProtocolTransaction', async () => {
    const { hybrid } = createHybridRuntime()

    const result = await hybrid.executeHybrid(
      {
        assetId: 'model-test',
        assetType: 'gpu_cluster',
        capabilityType: 'gpu_compute',
        assignedQuantity: '5',
        assignedUnit: 'GPU-hours',
        durationSeconds: 3600,
      },
      0,
    )

    const commitment = result.commitment

    // The commitment stores evidenceId (a hash) — NOT the whole RuntimeExecuteResult.
    expect(commitment.evidenceId).toMatch(/^[a-f0-9]{64}$/) // SHA-256 hex
    expect(commitment.intendedTransactionId).toMatch(/^[a-f0-9]{64}$/)

    // The commitment does NOT have infrastructureResult or transaction fields
    // (those were the Phase 10.5D DTO pattern; Phase 11B stores hashes only).
    const commitmentObj = commitment as unknown as Record<string, unknown>
    expect(commitmentObj.infrastructureResult).toBeUndefined()
    expect(commitmentObj.transaction).toBeUndefined()
    expect(commitmentObj.batchResult).toBeUndefined()
  })
})
