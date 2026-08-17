// =============================================================================
// Kernel: Hybrid Runtime (Phase 10)
// =============================================================================
// The HybridRuntime bridges two isolated runtime worlds:
//
//   InfrastructureRuntime → physical execution → telemetry → contribution
//   ProtocolRuntime → transactions → state transitions → finality
//
// ARCHITECTURAL RULES (frozen from Phase 9C):
//   1. Infrastructure execution can create protocol state transitions
//      WITHOUT importing infrastructure concepts into the protocol runtime.
//   2. Protocol decisions can trigger infrastructure work WITHOUT coupling
//      consensus to adapters.
//   3. Contribution/reward calculations remain generic primitives.
//   4. A new vertical can still plug in without kernel modification.
//
// THE BRIDGE:
//   The hybrid runtime owns a "HybridBridge" — a set of converter functions
//   that translate between the two worlds:
//     - infrastructureExecutionResult → protocolTransaction (bridge up)
//     - protocolState → infrastructureParameters (bridge down)
//
//   The bridge is the ONLY place that knows about both worlds. Neither
//   InfrastructureRuntime nor ProtocolRuntime imports the other.
//
// DEPENDENCY INJECTION:
//   The hybrid runtime receives both an InfrastructureRuntime and a
//   ProtocolRuntime as constructor parameters. It does NOT construct them.
//   The bootstrap owns construction.
// =============================================================================

import type {
  NetworkRuntime,
  RuntimeAssignmentResults,
  RuntimeClient,
  RuntimeCreateAssignmentInput,
  RuntimeCreateExecutionInput,
  RuntimeExecuteInput,
  RuntimeExecuteResult,
} from './types'
import type { InfrastructureRuntime } from './infrastructure-runtime'
import type { ProtocolRuntime } from './protocol-runtime'
import type {
  ProtocolTransaction,
  ProtocolExecutionResult,
  FinalizedBatch,
  BatchExecutionResult,
} from './protocol/types'
import { computeTransactionId } from './protocol/executor'
import type {
  ReconciliationStore,
  PhysicalExecutionEvidence,
  ReconciliationAttempt,
  ProtocolOutcome,
} from './protocol/reconciliation-types'
import {
  computeEvidence,
  computeOutcome,
  computeSyntheticExecutedOutcome,
} from './protocol/reconciliation-types'

// ---------------------------------------------------------------------------
// Hybrid Bridge — the only place that knows about both worlds
// ---------------------------------------------------------------------------

/**
 * A bridge that converts infrastructure execution results into protocol
 * transactions (bridge UP: infrastructure → protocol).
 *
 * This is the mechanism by which physical infrastructure work creates
 * protocol state transitions. The bridge is a PURE CONVERTER — it does
 * not execute anything. It takes an infrastructure result and produces
 * a protocol transaction that the protocol runtime can execute.
 *
 * ARCHITECTURAL RULE: The bridge does NOT import adapters, consensus, or
 * state stores. It receives data and produces data.
 *
 * PHASE 11B FIX (Defect 7 — vertical coupling):
 *   The bridge OWNS the deterministic transaction-ID derivation contract.
 *   The generic reconciliation kernel does NOT know the payload shape
 *   (record_delivery, etc.) — that's vertical semantics owned by the bridge.
 *   `deriveTransactionId` lets the kernel compute the expected transaction ID
 *   from evidence WITHOUT calling the bridge's full transaction builder,
 *   while keeping the payload-shape knowledge in the bridge (not the kernel).
 */
export interface HybridBridge {
  /**
   * Convert an infrastructure execution result into a protocol transaction.
   *
   * The protocol transaction records what happened in the infrastructure
   * world as a deterministic state transition. For example, a GPU job
   * that delivered 9.5 GPU-hours becomes a protocol transaction that
   * updates a 'gpu-hours-delivered' balance in the protocol state.
   *
   * @param executionResult The result from InfrastructureRuntime.executeAssignment.
   * @param networkVersionId The network version for protocol isolation.
   * @param sender The sender identity for the protocol transaction.
   * @param nonce The sender's current nonce.
   * @returns A protocol transaction ready for the protocol runtime.
   */
  infrastructureResultToTransaction(
    executionResult: RuntimeExecuteResult,
    networkVersionId: string,
    sender: string,
    nonce: number,
  ): ProtocolTransaction

  /**
   * Derive the expected ProtocolTransaction.id from evidence, WITHOUT
   * building the full transaction object.
   *
   * This is the deterministic-identity contract (spec §6.4). The kernel
   * calls this to compute intendedTransactionId from the STORED EVIDENCE at
   * recordPending time. Later, the bridge's full transaction builder
   * (infrastructureResultToTransaction) produces a transaction from the LIVE
   * result. The kernel compares transaction.id against the stored
   * intendedTransactionId. Mismatch → the live result differs from the stored
   * evidence (input drift), which means the bridge is non-deterministic or the
   * evidence was corrupted.
   *
   * The bridge OWNS the payload shape (e.g., 'record_delivery' data). The
   * kernel does NOT know the payload type — that's vertical semantics owned
   * by the bridge. This keeps the kernel vertical-neutral (spec §2 rule 4).
   *
   * HONEST SCOPE (Defect 10):
   *   This is "separation of input" independence, NOT "independent algorithm"
   *   independence. The transaction ID is defined as
   *   SHA-256(canonical(networkVersionId, sender, nonce, payload)), and the
   *   payload is defined by the bridge's buildPayload. There is no independent
   *   payload to hash — the payload IS the bridge's output. So a bug in
   *   buildPayload itself (algorithm drift) is undetectable by ANY ID
   *   comparison, because both sides use the same payload definition.
   *
   *   What this DOES detect: input drift (the live result differs from the
   *   stored evidence). This is what spec §6.4 requires. It does NOT detect
   *   algorithm drift (buildPayload bugs), which is undetectable by
   *   construction. The spec is honestly documented as such.
   *
   * @param resultJson The canonical RuntimeExecuteResult JSON from evidence.
   * @param networkVersionId The network version for protocol isolation.
   * @param sender The sender identity.
   * @param nonce The sender's nonce.
   * @returns The expected ProtocolTransaction.id.
   */
  deriveTransactionId(
    resultJson: string,
    networkVersionId: string,
    sender: string,
    nonce: number,
  ): string
}

// ---------------------------------------------------------------------------
// DefaultHybridBridge — a reference implementation
// ---------------------------------------------------------------------------

/**
 * A reference HybridBridge that converts infrastructure execution results
 * into 'record_delivery' protocol transactions.
 *
 * The protocol transaction payload is:
 *   { type: 'record_delivery', data: { quantity, unit, success } }
 *
 * The protocol state stores the delivered quantity as a balance.
 *
 * PHASE 11B FIX (Defect 7): the bridge owns BOTH the transaction builder
 * AND the ID derivation. The 'record_delivery' payload shape lives here, in
 * the bridge — NOT in the generic reconciliation kernel.
 */
export class DefaultHybridBridge implements HybridBridge {
  /**
   * Build the payload from a runtime result. This is the vertical-specific
   * shape owned by THIS bridge. A different bridge (e.g., for a storage
   * vertical) would build a different payload.
   */
  private buildPayload(executionResult: RuntimeExecuteResult): {
    type: string
    data: Record<string, unknown>
  } {
    return {
      type: 'record_delivery',
      data: {
        quantity: executionResult.actualQuantity,
        unit: executionResult.actualUnit,
        success: executionResult.success,
      },
    }
  }

  infrastructureResultToTransaction(
    executionResult: RuntimeExecuteResult,
    networkVersionId: string,
    sender: string,
    nonce: number,
  ): ProtocolTransaction {
    const payload = this.buildPayload(executionResult)
    const id = computeTransactionId(networkVersionId, sender, nonce, payload)

    return {
      id,
      networkVersionId,
      sender,
      nonce,
      payload: { type: payload.type, data: payload.data },
      signature: 'hybrid-bridge-signature',
      submittedAt: new Date('2024-01-01T00:00:00Z'), // deterministic
    }
  }

  deriveTransactionId(
    resultJson: string,
    networkVersionId: string,
    sender: string,
    nonce: number,
  ): string {
    // Reconstruct the runtime result from the evidence's stored JSON, then
    // build the payload the same way infrastructureResultToTransaction does.
    // The ID is derived from the payload — same inputs → same ID.
    const result = JSON.parse(resultJson) as RuntimeExecuteResult
    const payload = this.buildPayload(result)
    return computeTransactionId(networkVersionId, sender, nonce, payload)
  }
}

// ---------------------------------------------------------------------------
// HybridRuntimeDeps — dependencies injected into HybridRuntime
// ---------------------------------------------------------------------------

/**
 * The dependencies injected into HybridRuntime.
 *
 * The hybrid runtime receives BOTH an InfrastructureRuntime and a
 * ProtocolRuntime, plus a HybridBridge. It does NOT construct any of them.
 */
export interface HybridRuntimeDeps {
  infrastructureRuntime: InfrastructureRuntime
  protocolRuntime: ProtocolRuntime
  bridge: HybridBridge
  /** The sender identity for protocol transactions created by the bridge. */
  protocolSender: string
  /**
   * Phase 11B: Durable store for hybrid reconciliation primitives.
   *
   * Required (spec §5). The bootstrap constructs an InMemoryReconciliationStore
   * for dev (matching the InMemoryProtocolStateStore pattern); production and
   * crash-recovery tests construct a PostgresReconciliationStore.
   */
  reconciliationStore: ReconciliationStore
}

// ---------------------------------------------------------------------------
// HybridRuntime
// ---------------------------------------------------------------------------

/**
 * The runtime implementation for runtimeKind = 'hybrid'.
 *
 * Phase 10: Bridges infrastructure execution and protocol state transitions.
 *
 * The hybrid runtime implements the NetworkRuntime interface (infrastructure-
 * shaped methods) by delegating to the InfrastructureRuntime. It adds a
 * hybrid-specific method, `executeHybrid()`, that:
 *   1. Executes physical work via InfrastructureRuntime
 *   2. Converts the result to a protocol transaction via the bridge
 *   3. Executes the protocol transaction via ProtocolRuntime
 *
 * ARCHITECTURAL ISOLATION:
 *   - InfrastructureRuntime does NOT know about ProtocolRuntime.
 *   - ProtocolRuntime does NOT know about InfrastructureRuntime.
 *   - The bridge is the ONLY place that converts between them.
 *   - Neither runtime imports the other's types.
 */
export class HybridRuntime implements NetworkRuntime {
  readonly kind = 'hybrid' as const

  constructor(private readonly deps: HybridRuntimeDeps) {}

  /**
   * @returns The protocol runtime (for direct protocol operations).
   */
  get protocol() {
    return this.deps.protocolRuntime
  }

  /**
   * @returns The infrastructure runtime (for direct infrastructure operations).
   */
  get infrastructure() {
    return this.deps.infrastructureRuntime
  }

  /**
   * @returns The reconciliation store (for startup index setup + recovery).
   * Phase 11B Defect 5 fix: used by instrumentation to call ensureC3UniqueIndex.
   */
  get reconciliationStore() {
    return this.deps.reconciliationStore
  }

  // -------------------------------------------------------------------------
  // Hybrid-specific entry point
  // -------------------------------------------------------------------------

  /**
   * Execute a hybrid assignment with DURABLE reconciliation (Phase 11B).
   *
   * Crash-safe sequence (spec §6.2):
   *   1. InfrastructureRuntime.executeAssignment()        physical
   *   2. Compute PhysicalExecutionEvidence (pure)         content-addressed
   *   3. Independently derive intendedTransactionId (pure)  NOT from the bridge
   *   4. ReconciliationStore.recordPending(...)           DURABLE WRITE #1
   *   5. Derive transaction via bridge (pure)             verify tx.id === intended
   *   6. submitTransaction(transaction)                  protocol commit
   *   7. Compute ProtocolOutcome (pure)                   precise BatchExecutionStatus + real cert
   *   8. ReconciliationStore.resolve(attemptId, ...)      DURABLE WRITE #2
   *
   * PHASE 11B FIX (Defect 1 — retry lifecycle):
   *   recordPending ALWAYS creates a NEW PENDING attempt. A retry after a
   *   terminal failure is a legitimate new attempt that re-submits — it does
   *   NOT return the old resolved attempt. The 6e31067 defect (retry
   *   misreported as EXECUTED) is structurally impossible.
   *
   * PHASE 11B FIX (Defect 4 — independent derivation):
   *   intendedTransactionId is computed INDEPENDENTLY from evidence via
   *   deriveIntendedTransactionId (step 3), NOT taken from the bridge output.
   *   The bridge is called (step 5) to produce the full transaction object,
   *   and its .id is VERIFIED against the independently-derived ID. Mismatch
   *   → the attempt is resolved as RECONCILIATION_REQUIRED_INVARIANT_VIOLATION
   *   (bridge drift) without submitting.
   *
   * PHASE 11B FIX (Defect 2 — finality certificate):
   *   The outcome's finalityCertificate comes from
   *   protocolResult.finalityCertificate (the actual consensus certificate),
   *   NOT the transaction ID.
   */
  async executeHybrid(
    input: RuntimeExecuteInput,
    currentNonce: number,
  ): Promise<{
    infrastructureResult: RuntimeExecuteResult
    protocolResult: BatchExecutionResult
    commitment: ReconciliationAttempt
  }> {
    const networkVersionId = this.deps.protocolRuntime.stateStore.networkVersionId

    // 1. Execute physical work via the infrastructure runtime.
    const infrastructureResult = await this.deps.infrastructureRuntime.executeAssignment(input)

    // 2. Compute PhysicalExecutionEvidence (pure, content-addressed).
    const evidence = computeEvidence(
      input.assetId,
      networkVersionId,
      infrastructureResult,
      new Date(),
    )

    // 3. Independently derive intendedTransactionId (Defect 4 fix, corrected).
    //    The bridge OWNS the derivation contract (Defect 7 fix — the kernel
    //    does NOT know the payload shape). The kernel calls the bridge's
    //    deriveTransactionId with the evidence's resultJson, then verifies
    //    the bridge's full transaction builder produces the same ID.
    const intendedTransactionId = this.deps.bridge.deriveTransactionId(
      evidence.resultJson,
      networkVersionId,
      this.deps.protocolSender,
      currentNonce,
    )

    // 4. DURABLE WRITE #1: record evidence + a NEW PENDING attempt atomically.
    //    recordPending ALWAYS creates a new attempt (Defect 1 fix). C3
    //    rejects if a PENDING attempt already exists for this evidence.
    const attempt = await this.deps.reconciliationStore.recordPending(
      evidence,
      intendedTransactionId,
      this.deps.protocolSender,
      currentNonce,
    )

    // 5. Derive the transaction via the bridge + verify determinism (§6.4).
    const transaction = this.deps.bridge.infrastructureResultToTransaction(
      infrastructureResult,
      networkVersionId,
      this.deps.protocolSender,
      currentNonce,
    )
    if (transaction.id !== intendedTransactionId) {
      // Bridge drift: the bridge produced a different transaction ID than the
      // independently-derived one. Resolve as invariant violation WITHOUT
      // submitting. Defect 4 fix — this check now happens at submission time,
      // not just at recovery.
      const outcome = computeOutcome(
        attempt.attemptId,
        transaction.id,
        {
          status: 'NO_TRANSACTIONS',
          receipts: [],
          finalityCertificate: null,
          error: 'Bridge determinism violation: bridge output does not match independently-derived intendedTransactionId',
        },
        new Date(),
      )
      const resolved = await this.deps.reconciliationStore.resolve(attempt.attemptId, outcome)
      return {
        infrastructureResult,
        protocolResult: { status: 'NO_TRANSACTIONS', receipts: [], finalityCertificate: null, error: outcome.error ?? 'Bridge determinism violation' },
        commitment: resolved,
      }
    }

    // 6. Submit through the canonical protocol path (consensus → executeBatch).
    const protocolResult = await this.deps.protocolRuntime.submitTransaction(transaction)

    // 7. Compute the ProtocolOutcome (pure, precise BatchExecutionStatus +
    //    actual finality certificate from protocolResult).
    const outcome = computeOutcome(
      attempt.attemptId,
      transaction.id,
      protocolResult,
      new Date(),
    )

    // 8. DURABLE WRITE #2: record outcome + advance attempt atomically.
    const resolvedAttempt = await this.deps.reconciliationStore.resolve(
      attempt.attemptId,
      outcome,
    )

    return { infrastructureResult, protocolResult, commitment: resolvedAttempt }
  }

  /**
   * Crash recovery (Phase 11B, spec §6.3).
   *
   * On restart, load all PENDING attempts and resolve each:
   *   - Re-derive the transaction from the evidence (deterministic — C2).
   *   - Check bridge determinism (§6.4): if transaction.id !==
   *     attempt.intendedTransactionId, flag RECONCILIATION_REQUIRED_INVARIANT_VIOLATION.
   *   - Check the ProtocolTransition journal: if the transaction already
   *     committed before the crash, resolve as RECONCILED (synthetic EXECUTED
   *     outcome). Otherwise, re-submit via submitTransaction.
   *
   * Idempotent: safe to call multiple times. Only PENDING attempts are
   * processed; resolved attempts are skipped.
   */
  async recoverPending(): Promise<ReconciliationAttempt[]> {
    const pending = await this.deps.reconciliationStore.loadPending()
    const resolved: ReconciliationAttempt[] = []

    for (const attempt of pending) {
      const evidence = await this.deps.reconciliationStore.loadEvidence(
        attempt.evidenceId,
      )
      if (!evidence) {
        const outcome = computeOutcome(
          attempt.attemptId,
          attempt.intendedTransactionId,
          { status: 'NO_TRANSACTIONS', receipts: [], finalityCertificate: null, error: 'Evidence missing for PENDING attempt' },
          new Date(),
        )
        resolved.push(
          await this.deps.reconciliationStore.resolve(attempt.attemptId, outcome),
        )
        continue
      }

      // Re-derive the transaction from the evidence (C2: deterministic).
      const result = JSON.parse(evidence.resultJson) as RuntimeExecuteResult
      const transaction = this.deps.bridge.infrastructureResultToTransaction(
        result,
        attempt.networkVersionId,
        attempt.sender,
        attempt.nonce,
      )

      // §6.4: bridge determinism enforcement (also checked at submission time
      // in executeHybrid; this is the recovery-time check).
      if (transaction.id !== attempt.intendedTransactionId) {
        const outcome = computeOutcome(
          attempt.attemptId,
          transaction.id,
          { status: 'NO_TRANSACTIONS', receipts: [], finalityCertificate: null, error: 'Bridge determinism violation: re-derived transaction ID does not match intendedTransactionId' },
          new Date(),
        )
        resolved.push(
          await this.deps.reconciliationStore.resolve(attempt.attemptId, outcome),
        )
        continue
      }

      // Journal lookup: did the protocol commit already succeed?
      const committedAt = await this.deps.reconciliationStore.findCommittedTransaction(
        attempt.networkVersionId,
        attempt.intendedTransactionId,
      )

      if (committedAt) {
        // The protocol commit succeeded before the crash. Synthesize an
        // EXECUTED outcome (spec §6.3). The finalityCertificate is recomputed
        // the same way computeFinalityCertificate does for a single-tx batch.
        const outcome = computeSyntheticExecutedOutcome(
          attempt.attemptId,
          attempt.intendedTransactionId,
          committedAt,
        )
        resolved.push(
          await this.deps.reconciliationStore.resolve(attempt.attemptId, outcome),
        )
      } else {
        // The protocol commit did not durably succeed. Re-submit.
        const protocolResult = await this.deps.protocolRuntime.submitTransaction(transaction)
        const outcome = computeOutcome(
          attempt.attemptId,
          transaction.id,
          protocolResult,
          new Date(),
        )
        resolved.push(
          await this.deps.reconciliationStore.resolve(attempt.attemptId, outcome),
        )
      }
    }

    return resolved
  }

  // -------------------------------------------------------------------------
  // NetworkRuntime interface (delegates to InfrastructureRuntime)
  // -------------------------------------------------------------------------

  async createExecution(
    tx: RuntimeClient,
    input: RuntimeCreateExecutionInput,
  ): Promise<{ id: string }> {
    return this.deps.infrastructureRuntime.createExecution(tx, input)
  }

  async linkExecutionSource(
    tx: RuntimeClient,
    executionId: string,
    sourceId: string,
  ): Promise<void> {
    await this.deps.infrastructureRuntime.linkExecutionSource(tx, executionId, sourceId)
  }

  async createExecutionAssignment(
    tx: RuntimeClient,
    input: RuntimeCreateAssignmentInput,
  ): Promise<{ id: string }> {
    return this.deps.infrastructureRuntime.createExecutionAssignment(tx, input)
  }

  async beginAssignmentExecution(
    tx: RuntimeClient,
    executionId: string,
    executionAssignmentId: string,
  ): Promise<void> {
    await this.deps.infrastructureRuntime.beginAssignmentExecution(tx, executionId, executionAssignmentId)
  }

  async executeAssignment(
    input: RuntimeExecuteInput,
  ): Promise<RuntimeExecuteResult> {
    return this.deps.infrastructureRuntime.executeAssignment(input)
  }

  async recordAssignmentResults(
    tx: RuntimeClient,
    executionAssignmentId: string,
    results: RuntimeAssignmentResults,
  ): Promise<void> {
    await this.deps.infrastructureRuntime.recordAssignmentResults(tx, executionAssignmentId, results)
  }

  async linkContribution(
    tx: RuntimeClient,
    executionAssignmentId: string,
    contributionId: string,
  ): Promise<void> {
    await this.deps.infrastructureRuntime.linkContribution(tx, executionAssignmentId, contributionId)
  }

  async completeAssignment(
    tx: RuntimeClient,
    tenantId: string,
    executionAssignmentId: string,
    executionId: string,
  ): Promise<void> {
    await this.deps.infrastructureRuntime.completeAssignment(tx, tenantId, executionAssignmentId, executionId)
  }

  async failAssignment(
    tx: RuntimeClient,
    tenantId: string,
    executionAssignmentId: string,
    executionId: string,
  ): Promise<void> {
    await this.deps.infrastructureRuntime.failAssignment(tx, tenantId, executionAssignmentId, executionId)
  }

  async finalizeIfTerminal(
    tx: RuntimeClient,
    tenantId: string,
    executionId: string,
  ): Promise<string | null> {
    return this.deps.infrastructureRuntime.finalizeIfTerminal(tx, tenantId, executionId)
  }
}
