// =============================================================================
// Kernel: Hybrid Runtime (Phase 5 — stub)
// =============================================================================
// The HybridRuntime is the runtime implementation for
// runtimeKind = 'hybrid'. In this model, the network uses infrastructure for
// physical execution but protocol for settlement/attestation.
//
// Phase 5 establishes the CONTRACT and REGISTRATION — the implementation is
// deliberately minimal. The full hybrid execution model (infrastructure +
// protocol coordination) will be implemented in Phase 10 (Hybrid reference
// network).
// =============================================================================

import type {
  NetworkRuntime,
  RuntimeAssignmentResults,
  RuntimeClient,
  RuntimeCreateAssignmentInput,
  RuntimeCreateExecutionInput,
} from './types'

// ---------------------------------------------------------------------------
// HybridRuntime — stub implementation
// ---------------------------------------------------------------------------

/**
 * Error thrown when a hybrid runtime operation is attempted but not yet
 * implemented. The contract exists (Phase 5); the implementation lands in
 * Phase 10.
 */
export class HybridRuntimeNotImplementedError extends Error {
  constructor(operation: string) {
    super(
      `HybridRuntime.${operation} is not implemented. ` +
        `The hybrid runtime contract is established (Phase 5) but the ` +
        `execution model lands in Phase 10 (Hybrid reference network).`,
    )
    this.name = 'HybridRuntimeNotImplementedError'
  }
}

export class HybridRuntime implements NetworkRuntime {
  readonly kind = 'hybrid' as const

  async createExecution(
    _tx: RuntimeClient,
    _input: RuntimeCreateExecutionInput,
  ): Promise<{ id: string }> {
    throw new HybridRuntimeNotImplementedError('createExecution')
  }

  async linkExecutionSource(
    _tx: RuntimeClient,
    _executionId: string,
    _sourceId: string,
  ): Promise<void> {
    throw new HybridRuntimeNotImplementedError('linkExecutionSource')
  }

  async createExecutionAssignment(
    _tx: RuntimeClient,
    _input: RuntimeCreateAssignmentInput,
  ): Promise<{ id: string }> {
    throw new HybridRuntimeNotImplementedError('createExecutionAssignment')
  }

  async beginAssignmentExecution(
    _tx: RuntimeClient,
    _executionId: string,
    _executionAssignmentId: string,
  ): Promise<void> {
    throw new HybridRuntimeNotImplementedError('beginAssignmentExecution')
  }

  async recordAssignmentResults(
    _tx: RuntimeClient,
    _executionAssignmentId: string,
    _results: RuntimeAssignmentResults,
  ): Promise<void> {
    throw new HybridRuntimeNotImplementedError('recordAssignmentResults')
  }

  async completeAssignment(
    _tx: RuntimeClient,
    _tenantId: string,
    _executionAssignmentId: string,
    _executionId: string,
  ): Promise<void> {
    throw new HybridRuntimeNotImplementedError('completeAssignment')
  }

  async failAssignment(
    _tx: RuntimeClient,
    _tenantId: string,
    _executionAssignmentId: string,
    _executionId: string,
  ): Promise<void> {
    throw new HybridRuntimeNotImplementedError('failAssignment')
  }

  async finalizeIfTerminal(
    _tx: RuntimeClient,
    _tenantId: string,
    _executionId: string,
  ): Promise<string | null> {
    throw new HybridRuntimeNotImplementedError('finalizeIfTerminal')
  }
}
