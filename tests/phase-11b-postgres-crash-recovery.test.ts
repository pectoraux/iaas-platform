/**
 * Phase 11B Criterion 8: PostgreSQL Crash-Recovery Restart Integration Proof
 *
 * This is THE test that closes the criterion-8 gap. It proves the full
 * PostgreSQL restart path:
 *
 *   PostgreSQL commit (PENDING attempt durably written)
 *       ↓
 *   simulated process crash (new runtime instance, same DB)
 *       ↓
 *   loadPending() finds the PENDING attempt
 *       ↓
 *   journal lookup / resubmission
 *       ↓
 *   single reconciliation outcome
 *       ↓
 *   no double-count
 *
 * This test is SKIPPED unless DATABASE_URL points to a real PostgreSQL
 * database. In the local sandbox (SQLite), it is skipped. In CI (PostgreSQL
 * service container) and against the live Neon database, it runs.
 *
 * To run locally against Neon:
 *   DATABASE_URL=postgresql://... bun test tests/phase-11b-postgres-crash-recovery.test.ts
 *
 * Run: bun test tests/phase-11b-postgres-crash-recovery.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { PostgresProtocolStateStore } from '../src/lib/kernel/runtime/protocol/postgres-state-store'
import { PostgresReconciliationStore } from '../src/lib/kernel/runtime/protocol/postgres-reconciliation-store'
import { DeterministicTransactionExecutor } from '../src/lib/kernel/runtime/protocol/executor'
import { TransferHandler, MintHandler, RecordDeliveryHandler } from '../src/lib/bootstrap/handlers'
import { ProtocolRuntime } from '../src/lib/kernel/runtime/protocol-runtime'
import { HybridRuntime, DefaultHybridBridge } from '../src/lib/kernel/runtime/hybrid-runtime'
import { InMemoryValidatorRegistry, SimpleConsensusEngine } from '../src/lib/kernel/runtime/protocol/validator-consensus'
import {
  computeEvidence,
  computeOutcome,
} from '../src/lib/kernel/runtime/protocol/reconciliation-types'
import type { ProtocolRuntimeDeps } from '../src/lib/kernel/runtime/protocol/types'
import type { RuntimeExecuteResult } from '../src/lib/kernel/runtime/types'

const databaseUrl = process.env.DATABASE_URL || ''
const isPostgres = databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')

// Skip entirely if not against real PostgreSQL. This keeps the test suite
// green in the local SQLite environment while running in CI/Neon.
const describeOrSkip = isPostgres ? describe : describe.skip

let tenantId: string
let networkVersionId: string

beforeAll(async () => {
  if (!isPostgres) return
  const tenant = await createTenant({
    name: 'Phase 11B Postgres Crash Recovery',
    slug: `p11b-pg-crash-${Date.now()}`,
    plan: 'growth',
  })
  tenantId = tenant.id
  const { version } = await instantiateTemplate(tenantId, 'protocol-network')
  networkVersionId = version!.id
})

describeOrSkip('Phase 11B Criterion 8: PostgreSQL crash-recovery restart proof', () => {
  it('a PENDING attempt in PostgreSQL survives a simulated process restart and resolves without double-counting', async () => {
    // This test proves the full PostgreSQL restart path.
    //
    // Scenario: physical execution succeeds, evidence + PENDING attempt are
    // durably written to PostgreSQL, but the process "crashes" before
    // submitTransaction completes. A NEW runtime instance (simulating a
    // fresh process) connects to the SAME PostgreSQL database and calls
    // recoverPending(). The PENDING attempt must be resolved to RECONCILED,
    // the protocol state must advance exactly ONCE, and re-calling
    // recoverPending() must be a no-op.

    // --- Setup: construct the first runtime instance ---
    const stateStore1 = new PostgresProtocolStateStore(networkVersionId)
    const reconStore1 = new PostgresReconciliationStore()
    await reconStore1.ensureC3UniqueIndex()

    const executor = new DeterministicTransactionExecutor()
    executor.registerHandler('transfer', new TransferHandler())
    executor.registerHandler('mint', new MintHandler())
    executor.registerHandler('record_delivery', new RecordDeliveryHandler())
    const protocolDeps: ProtocolRuntimeDeps = {
      stateStore: stateStore1,
      executor,
      validatorRegistry: new InMemoryValidatorRegistry(),
      consensusEngine: new SimpleConsensusEngine(),
    }
    const protocolRuntime1 = new ProtocolRuntime(protocolDeps)

    const bridge = new DefaultHybridBridge()

    // Simulate a physical execution result (without needing a real adapter).
    const physicalResult: RuntimeExecuteResult = {
      actualQuantity: '9.5',
      actualUnit: 'GPU-hours',
      telemetryPayload: { gpuCount: 4, duration: 3600 },
      success: true,
    }

    // Step 1: compute evidence (content-addressed).
    const evidence = computeEvidence(
      `crash-test-${Date.now()}`,
      networkVersionId,
      physicalResult,
      new Date(),
    )

    // Step 2: derive the intended transaction ID (input-consistency, from stored evidence).
    const intendedTransactionId = bridge.deriveTransactionId(
      evidence.resultJson,
      networkVersionId,
      'crash-test-sender',
      0,
    )

    // Step 3: DURABLE WRITE #1 — record the PENDING attempt in PostgreSQL.
    // This simulates: physical execution done → evidence + PENDING attempt
    // durably committed → CRASH before submitTransaction.
    const pendingAttempt = await reconStore1.recordPending(
      evidence,
      intendedTransactionId,
      'crash-test-sender',
      0,
    )
    expect(pendingAttempt.status).toBe('PENDING')

    // Verify the protocol state is at version 0 (no commit yet).
    const stateBefore = await stateStore1.getState()
    const versionBefore = stateBefore.version

    // --- Simulate process crash: construct a NEW runtime instance ---
    // sharing the SAME PostgreSQL database. In a real crash, the new process
    // loads from the same DB. Here we construct new store instances pointing
    // to the same Neon database.
    const stateStore2 = new PostgresProtocolStateStore(networkVersionId)
    const reconStore2 = new PostgresReconciliationStore()

    const protocolRuntime2 = new ProtocolRuntime(protocolDeps)

    const hybridRuntime2 = new HybridRuntime({
      infrastructureRuntime: null as never, // not used by recoverPending
      protocolRuntime: protocolRuntime2,
      bridge,
      protocolSender: 'crash-test-sender',
      reconciliationStore: reconStore2,
    })

    // Step 4: call recoverPending() — the restart recovery path.
    const resolved = await hybridRuntime2.recoverPending()

    // Step 5: verify the PENDING attempt was resolved.
    expect(resolved.length).toBeGreaterThanOrEqual(1)
    const ourResolution = resolved.find((a) => a.attemptId === pendingAttempt.attemptId)
    expect(ourResolution).toBeDefined()
    expect(ourResolution!.status).toBe('RECONCILED')
    expect(ourResolution!.resolvedAt).toBeDefined()

    // Step 6: verify the protocol state advanced exactly ONCE (no double-count).
    const stateAfter = await stateStore2.getState()
    expect(stateAfter.version).toBe(versionBefore + 1)

    // Step 7: verify re-calling recoverPending() is a no-op (idempotent).
    const resolvedAgain = await hybridRuntime2.recoverPending()
    const ourResolutionAgain = resolvedAgain.find((a) => a.attemptId === pendingAttempt.attemptId)
    expect(ourResolutionAgain).toBeUndefined() // already resolved, not re-processed

    const stateAfterAgain = await stateStore2.getState()
    expect(stateAfterAgain.version).toBe(versionBefore + 1) // still N+1, no double-count

    // Step 8: verify the PENDING attempt is no longer in loadPending().
    const stillPending = await reconStore2.loadPending()
    const ourPending = stillPending.find((a) => a.attemptId === pendingAttempt.attemptId)
    expect(ourPending).toBeUndefined() // resolved, not PENDING anymore
  })

  it('crash AFTER protocol commit but BEFORE resolve: recovery detects the journal entry and synthesizes EXECUTED without re-submitting', async () => {
    // Scenario: the protocol commit SUCCEEDED (transaction is in the
    // ProtocolTransition journal), but the process crashed before the
    // resolve() DURABLE WRITE #2. Recovery must detect the journal entry
    // and synthesize an EXECUTED outcome WITHOUT re-submitting (which
    // would double-count).

    const stateStore = new PostgresProtocolStateStore(networkVersionId)
    const reconStore = new PostgresReconciliationStore()
    await reconStore.ensureC3UniqueIndex()

    const executor = new DeterministicTransactionExecutor()
    executor.registerHandler('record_delivery', new RecordDeliveryHandler())
    const protocolRuntime = new ProtocolRuntime({
      stateStore,
      executor,
      validatorRegistry: new InMemoryValidatorRegistry(),
      consensusEngine: new SimpleConsensusEngine(),
    })

    const bridge = new DefaultHybridBridge()

    // Phase 1: execute a full hybrid cycle (commits the transaction + resolves).
    // This establishes the journal entry.
    const physicalResult: RuntimeExecuteResult = {
      actualQuantity: '5',
      actualUnit: 'GPU-hours',
      telemetryPayload: {},
      success: true,
    }
    const evidence = computeEvidence(
      `crash-after-commit-${Date.now()}`,
      networkVersionId,
      physicalResult,
      new Date(),
    )
    const intendedTxId = bridge.deriveTransactionId(
      evidence.resultJson,
      networkVersionId,
      'crash-after-commit-sender',
      0,
    )

    // Create a PENDING attempt, then manually submit the transaction to
    // create the journal entry (simulating: submit succeeded, crash before resolve).
    const attempt = await reconStore.recordPending(
      evidence,
      intendedTxId,
      'crash-after-commit-sender',
      0,
    )

    // Submit the transaction directly (this creates the ProtocolTransition journal entry).
    const transaction = bridge.infrastructureResultToTransaction(
      physicalResult,
      networkVersionId,
      'crash-after-commit-sender',
      0,
    )
    const protocolResult = await protocolRuntime.submitTransaction(transaction)
    expect(protocolResult.status).toBe('EXECUTED')
    expect(transaction.id).toBe(intendedTxId)

    const versionAfterCommit = (await stateStore.getState()).version

    // CRASH: do NOT call resolve(). The attempt is still PENDING, but the
    // transaction IS in the journal.

    // Phase 2: new runtime, call recoverPending().
    const reconStore2 = new PostgresReconciliationStore()
    const protocolRuntime2 = new ProtocolRuntime({
      stateStore, // share the same state store (same DB)
      executor,
      validatorRegistry: new InMemoryValidatorRegistry(),
      consensusEngine: new SimpleConsensusEngine(),
    })
    const hybridRuntime2 = new HybridRuntime({
      infrastructureRuntime: null as never,
      protocolRuntime: protocolRuntime2,
      bridge,
      protocolSender: 'crash-after-commit-sender',
      reconciliationStore: reconStore2,
    })

    const resolved = await hybridRuntime2.recoverPending()
    const ourResolution = resolved.find((a) => a.attemptId === attempt.attemptId)
    expect(ourResolution).toBeDefined()
    expect(ourResolution!.status).toBe('RECONCILED')

    // NO double-count: the protocol version did NOT advance again.
    // Recovery detected the journal entry and synthesized EXECUTED without
    // re-submitting.
    const versionAfterRecovery = (await stateStore.getState()).version
    expect(versionAfterRecovery).toBe(versionAfterCommit)
  })

  it('C3 partial unique index prevents two concurrent PENDING attempts for the same evidence', async () => {
    // This test proves the C3 race-proof guarantee on real PostgreSQL.
    // Two attempts to create a PENDING attempt for the same evidenceId
    // must result in exactly one success and one failure (P2002).

    const reconStore = new PostgresReconciliationStore()
    await reconStore.ensureC3UniqueIndex()

    const evidence = computeEvidence(
      `c3-concurrent-${Date.now()}`,
      networkVersionId,
      {
        actualQuantity: '5',
        actualUnit: 'GPU-hours',
        telemetryPayload: {},
        success: true,
      },
      new Date(),
    )
    const bridge = new DefaultHybridBridge()
    const txId = bridge.deriveTransactionId(evidence.resultJson, networkVersionId, 'c3-sender', 0)

    // First PENDING attempt — succeeds.
    const attempt1 = await reconStore.recordPending(evidence, txId, 'c3-sender', 0)
    expect(attempt1.status).toBe('PENDING')

    // Second PENDING attempt for the SAME evidence — must fail (C3).
    await expect(
      reconStore.recordPending(evidence, txId, 'c3-sender', 0),
    ).rejects.toThrow(/PENDING attempt already exists|C3|unique/i)
  })
})
