// =============================================================================
// Kernel: Protocol Runtime (Phase 9A)
// =============================================================================
// The ProtocolRuntime is the runtime implementation for
// runtimeKind = 'protocol'. In this model, the network operates via
// deterministic state transitions rather than physical asset execution.
//
// Phase 9A: The runtime now owns protocol-specific contracts:
//   - ProtocolStateStore (deterministic, versioned state)
//   - ProtocolTransactionExecutor (deterministic execution)
//   - ValidatorRegistry (stub — Phase 9C)
//   - ConsensusEngine (stub — Phase 9C)
//
// The runtime accepts these as constructor parameters (dependency injection),
// mirroring how InfrastructureRuntime accepts an AdapterRegistry.
//
// ARCHITECTURAL RULE:
//   ProtocolRuntime does NOT import:
//   - InfrastructureRuntime
//   - InfrastructureAdapter / AdapterRegistry
//   - VPP / Compute services
//   - The generic Execution/ExecutionAssignment models (those are
//     infrastructure-shaped; protocol has its own state model)
//
// The NetworkRuntime interface methods (createExecution, completeAssignment,
// etc.) still throw NotImplemented — those are infrastructure-shaped and
// don't apply to the protocol model. The protocol runtime has its own
// entry point: executeTransaction().
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
import type {
  ProtocolRuntimeDeps,
  ProtocolTransaction,
  ProtocolExecutionResult,
  ProtocolReceipt,
  FinalizedBatch,
  BatchExecutionResult,
} from './protocol/types'
import { StaleVersionError } from './protocol/types'
import { computeFinalityCertificate } from './protocol/validator-consensus'

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ProtocolRuntimeNotImplementedError extends Error {
  constructor(operation: string) {
    super(
      `ProtocolRuntime.${operation} is not implemented. ` +
        `This method is infrastructure-shaped and does not apply to the ` +
        `protocol runtime. Use executeTransaction() for protocol execution.`,
    )
    this.name = 'ProtocolRuntimeNotImplementedError'
  }
}

// ---------------------------------------------------------------------------
// ProtocolRuntime
// ---------------------------------------------------------------------------

/**
 * The runtime implementation for runtimeKind = 'protocol'.
 *
 * Phase 9A: Accepts ProtocolRuntimeDeps in its constructor (dependency
 * injection). The runtime owns the protocol state store, executor,
 * validator registry, and consensus engine.
 *
 * The runtime's primary entry point is `executeTransaction()` — NOT the
 * infrastructure-shaped `executeAssignment()`. Protocol transactions are
 * deterministic state transitions, not physical asset executions.
 */
export class ProtocolRuntime implements NetworkRuntime {
  readonly kind = 'protocol' as const

  constructor(private readonly deps: ProtocolRuntimeDeps) {}

  /**
   * @returns The protocol state store (for direct state queries).
   */
  get stateStore() {
    return this.deps.stateStore
  }

  /**
   * @returns The transaction executor (for direct validation queries).
   */
  get executor() {
    return this.deps.executor
  }

  /**
   * @returns The consensus engine (for direct consensus queries).
   */
  get consensusEngine() {
    return this.deps.consensusEngine
  }

  // -------------------------------------------------------------------------
  // Protocol-specific entry point (Phase 9A)
  // -------------------------------------------------------------------------

  /**
   * Execute a protocol transaction against the current state.
   *
   * Phase 9B.1: The RUNTIME coordinates the flow — the executor is a pure
   * calculator and does NOT own persistence:
   *
   *   1. Load current state (async, from store)
   *   2. Validate the transaction (pure, via executor)
   *   3. Calculate the transition (pure, via executor.apply)
   *   4. Stage the calculated entries on the store
   *   5. Commit with optimistic concurrency (async, version-checked)
   *   6. Build the receipt
   *
   * DETERMINISTIC: The calculation (steps 2-3) is pure — same input → same output.
   * The only non-deterministic part is the commit (which may fail due to OCC).
   *
   * ASYNC: The state store is async (supports persistent backends).
   */
  async executeTransaction(transaction: ProtocolTransaction): Promise<ProtocolExecutionResult> {
    // Phase 9B.2: NetworkVersion isolation check — reject transactions
    // bound to a different NetworkVersion than the store.
    if (transaction.networkVersionId !== this.deps.stateStore.networkVersionId) {
      return {
        success: false,
        resultingState: await this.deps.stateStore.getState(),
        receipt: {
          transactionId: transaction.id,
          beforeStateHash: '',
          afterStateHash: '',
          executedAt: transaction.submittedAt,
          executor: 'protocol-runtime',
        },
        error: `Transaction networkVersionId '${transaction.networkVersionId}' does not match store '${this.deps.stateStore.networkVersionId}'`,
      }
    }

    // 1. Load the current state (async).
    const beforeState = await this.deps.stateStore.getState()

    // 2-3. Calculate the transition (pure — returns an isolated WriteSet).
    const calc = this.deps.executor.apply(transaction, beforeState)

    if (!calc.valid) {
      return {
        success: false,
        resultingState: beforeState,
        receipt: {
          transactionId: transaction.id,
          beforeStateHash: beforeState.hash,
          afterStateHash: beforeState.hash,
          executedAt: transaction.submittedAt,
          executor: 'protocol-runtime',
        },
        error: calc.error,
      }
    }

    // 4-5. Commit the write set with optimistic concurrency (async, version-checked).
    // Phase 9B.2: The write set is passed directly — no shared staging buffer.
    try {
      const afterState = await this.deps.stateStore.commit(
        beforeState.version,
        calc.writeSet,
        transaction.id,
      )

      const receipt: ProtocolReceipt = {
        transactionId: transaction.id,
        beforeStateHash: beforeState.hash,
        afterStateHash: afterState.hash,
        executedAt: transaction.submittedAt,
        executor: 'protocol-runtime',
      }

      return {
        success: true,
        resultingState: afterState,
        receipt,
      }
    } catch (err) {
      if (err instanceof StaleVersionError) {
        const currentState = await this.deps.stateStore.getState()
        return {
          success: false,
          resultingState: currentState,
          receipt: {
            transactionId: transaction.id,
            beforeStateHash: beforeState.hash,
            afterStateHash: currentState.hash,
            executedAt: transaction.submittedAt,
            executor: 'protocol-runtime',
          },
          error: `Stale version: another transaction committed first (expected ${err.expectedVersion}, actual ${err.actualVersion})`,
        }
      }
      throw err
    }
  }

  /**
   * Validate a transaction without executing it.
   * Returns null if valid, or an error message.
   *
   * Phase 9B.2 closure: applies the same NetworkVersion isolation check
   * as executeTransaction — a transaction bound to a different
   * NetworkVersion is rejected at every protocol-runtime entry point.
   */
  async validateTransaction(transaction: ProtocolTransaction): Promise<string | null> {
    if (transaction.networkVersionId !== this.deps.stateStore.networkVersionId) {
      return `Transaction networkVersionId '${transaction.networkVersionId}' does not match store '${this.deps.stateStore.networkVersionId}'`
    }
    const state = await this.deps.stateStore.getState()
    return this.deps.executor.validate(transaction, state)
  }

  /**
   * Submit a transaction through the full consensus/finality path.
   *
   * Phase 10 final closure: This is the canonical protocol submission path.
   * It enforces the Phase 9C consensus sequence:
   *
   *   1. propose(transactions) → ConsensusProposal
   *   2. validateProposal(proposal) → boolean (validator authorization)
   *   3. finalize(proposal) → FinalizedBatch (ordered + certified)
   *   4. executeBatch(batch) → execution results
   *
   * This method is the ONLY way external callers (including HybridRuntime)
   * should submit protocol transactions. It ensures:
   *   - Validator authorization is checked (not bypassed)
   *   - Finality certificate is generated
   *   - Certificate is verified before execution
   *   - The protocol runtime owns its lifecycle (deps is private)
   *
   * @returns A BatchExecutionResult with explicit status. Status is
   *          REJECTED_BY_CONSENSUS if validator authorization fails,
   *          INVALID_FINALITY_CERTIFICATE if the batch is tampered,
   *          EXECUTED if the batch was processed (individual transactions
   *          may still have failed — check receipts).
   */
  async submitTransaction(transaction: ProtocolTransaction): Promise<BatchExecutionResult> {
    // 1. Propose.
    const proposal = this.deps.consensusEngine.propose([transaction])

    // 2. Validate the proposal (validator authorization).
    if (!this.deps.consensusEngine.validateProposal(proposal)) {
      return { status: 'REJECTED_BY_CONSENSUS', receipts: [], error: 'Proposal rejected by consensus (validator authorization)' }
    }

    // 3. Finalize (deterministic ordering + certificate).
    const batch = this.deps.consensusEngine.finalize(proposal)

    // 4. Execute the finalized batch (certificate verification + execution).
    return this.executeBatch(batch)
  }

  /**
   * Execute a finalized batch of transactions in their consensus-determined order.
   *
   * Phase 9C: This is the consensus integration point. The consensus engine
   * produces a FinalizedBatch (ordered + certified). The runtime executes
   * each transaction in order through the executor + state store.
   *
   * PHASE 9C CLOSURE — FINALITY CERTIFICATE VERIFICATION:
   *   Before executing ANY transaction, the runtime recomputes the finality
   *   certificate from the batch's orderedTransactions and compares it to
   *   the supplied finalityCertificate. If they don't match, the batch is
   *   REJECTED — no transactions are executed. This prevents a tampered
   *   batch from being executed.
   *
   * BATCH FAILURE SEMANTICS:
   *   A finalized batch is an ordered execution schedule, NOT an atomic
   *   database transaction. If transaction N fails, transactions 1..N-1
   *   remain committed. Transactions N+1.. are NOT executed. The caller
   *   can retry the remaining transactions in a new batch.
   *
   * CRITICAL INVARIANT:
   *   Consensus decides ORDERING. The executor decides STATE TRANSITIONS.
   *   The runtime applies the ordering through the executor. Neither layer
   *   knows how the other works.
   *
   * @returns A BatchExecutionResult with explicit status.
   */
  async executeBatch(batch: FinalizedBatch): Promise<BatchExecutionResult> {
    if (batch.orderedTransactions.length === 0) {
      return { status: 'NO_TRANSACTIONS', receipts: [] }
    }

    // Phase 9C closure: Verify the finality certificate BEFORE execution.
    const recomputedCertificate = computeFinalityCertificate(batch.orderedTransactions)
    if (recomputedCertificate !== batch.finalityCertificate) {
      return { status: 'INVALID_FINALITY_CERTIFICATE', receipts: [], error: 'Finality certificate mismatch' }
    }

    const results: ProtocolExecutionResult[] = []
    let hasFailure = false

    for (const transaction of batch.orderedTransactions) {
      const result = await this.executeTransaction(transaction)
      results.push(result)

      if (!result.success) {
        hasFailure = true
        break
      }
    }

    // Phase 10.5D: EXECUTED means ALL transactions succeeded.
    // EXECUTION_FAILED means at least one failed.
    if (hasFailure) {
      const failedReceipt = results.find(r => !r.success)
      return {
        status: 'EXECUTION_FAILED',
        receipts: results,
        error: failedReceipt?.error ?? 'Transaction execution failed',
      }
    }

    return { status: 'EXECUTED', receipts: results }
  }

  // -------------------------------------------------------------------------
  // NetworkRuntime interface (infrastructure-shaped — NOT used for protocol)
  // -------------------------------------------------------------------------

  async createExecution(
    _tx: RuntimeClient,
    _input: RuntimeCreateExecutionInput,
  ): Promise<{ id: string }> {
    throw new ProtocolRuntimeNotImplementedError('createExecution')
  }

  async linkExecutionSource(
    _tx: RuntimeClient,
    _executionId: string,
    _sourceId: string,
  ): Promise<void> {
    throw new ProtocolRuntimeNotImplementedError('linkExecutionSource')
  }

  async createExecutionAssignment(
    _tx: RuntimeClient,
    _input: RuntimeCreateAssignmentInput,
  ): Promise<{ id: string }> {
    throw new ProtocolRuntimeNotImplementedError('createExecutionAssignment')
  }

  async beginAssignmentExecution(
    _tx: RuntimeClient,
    _executionId: string,
    _executionAssignmentId: string,
  ): Promise<void> {
    throw new ProtocolRuntimeNotImplementedError('beginAssignmentExecution')
  }

  async executeAssignment(
    _input: RuntimeExecuteInput,
  ): Promise<RuntimeExecuteResult> {
    throw new ProtocolRuntimeNotImplementedError('executeAssignment')
  }

  async recordAssignmentResults(
    _tx: RuntimeClient,
    _executionAssignmentId: string,
    _results: RuntimeAssignmentResults,
  ): Promise<void> {
    throw new ProtocolRuntimeNotImplementedError('recordAssignmentResults')
  }

  async linkContribution(
    _tx: RuntimeClient,
    _executionAssignmentId: string,
    _contributionId: string,
  ): Promise<void> {
    throw new ProtocolRuntimeNotImplementedError('linkContribution')
  }

  async completeAssignment(
    _tx: RuntimeClient,
    _tenantId: string,
    _executionAssignmentId: string,
    _executionId: string,
  ): Promise<void> {
    throw new ProtocolRuntimeNotImplementedError('completeAssignment')
  }

  async failAssignment(
    _tx: RuntimeClient,
    _tenantId: string,
    _executionAssignmentId: string,
    _executionId: string,
  ): Promise<void> {
    throw new ProtocolRuntimeNotImplementedError('failAssignment')
  }

  async finalizeIfTerminal(
    _tx: RuntimeClient,
    _tenantId: string,
    _executionId: string,
  ): Promise<string | null> {
    throw new ProtocolRuntimeNotImplementedError('finalizeIfTerminal')
  }
}
