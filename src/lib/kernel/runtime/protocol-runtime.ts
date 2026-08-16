// =============================================================================
// Kernel: Protocol Runtime (Phase 5 — stub)
// =============================================================================
// The ProtocolRuntime is the runtime implementation for
// runtimeKind = 'protocol'. In this model, the network operates via an
// on-chain or protocol-level consensus mechanism. Execution is governed by
// protocol rules, not direct asset dispatch.
//
// Phase 5 establishes the CONTRACT and REGISTRATION — the implementation is
// deliberately minimal. The important thing is dependency direction and
// runtime resolution: a NetworkVersion with runtimeKind='protocol' resolves
// to this runtime via the RuntimeRegistry, and execution enters through here.
//
// The full protocol execution model (consensus, attestation chains, slashing)
// will be implemented in Phase 9 (ProtocolRuntime contracts).
// =============================================================================

import type {
  NetworkRuntime,
  RuntimeAssignmentResults,
  RuntimeClient,
  RuntimeCreateAssignmentInput,
  RuntimeCreateExecutionInput,
} from './types'

// ---------------------------------------------------------------------------
// ProtocolRuntime — stub implementation
// ---------------------------------------------------------------------------

/**
 * Error thrown when a protocol runtime operation is attempted but not yet
 * implemented. The contract exists (Phase 5); the implementation lands in
 * Phase 9.
 */
export class ProtocolRuntimeNotImplementedError extends Error {
  constructor(operation: string) {
    super(
      `ProtocolRuntime.${operation} is not implemented. ` +
        `The protocol runtime contract is established (Phase 5) but the ` +
        `execution model lands in Phase 9 (ProtocolRuntime contracts).`,
    )
    this.name = 'ProtocolRuntimeNotImplementedError'
  }
}

export class ProtocolRuntime implements NetworkRuntime {
  readonly kind = 'protocol' as const

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
