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
} from './protocol/types'

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

  // -------------------------------------------------------------------------
  // Protocol-specific entry point (Phase 9A)
  // -------------------------------------------------------------------------

  /**
   * Execute a protocol transaction against the current state.
   *
   * This is the protocol runtime's primary entry point. It delegates to
   * the deterministic executor, which:
   *   1. Validates the transaction
   *   2. Applies the state transition
   *   3. Commits the resulting state
   *   4. Returns the execution result + receipt
   *
   * DETERMINISTIC: Given the same state + transaction, the result is identical.
   */
  executeTransaction(transaction: ProtocolTransaction): ProtocolExecutionResult {
    return this.deps.executor.execute(transaction)
  }

  /**
   * Validate a transaction without executing it.
   * Returns null if valid, or an error message.
   */
  validateTransaction(transaction: ProtocolTransaction): string | null {
    return this.deps.executor.validate(transaction, this.deps.stateStore.getState())
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
