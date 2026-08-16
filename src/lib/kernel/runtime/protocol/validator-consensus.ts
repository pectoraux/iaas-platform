// =============================================================================
// Kernel: Validator Registry + Consensus Engine Stubs (Phase 9A)
// =============================================================================
// Phase 9A establishes the CONTRACTS for validator management and consensus.
// The implementations are deliberately stubs that throw NotImplemented —
// real consensus lands in Phase 9C.
//
// The contracts are important even though the implementations are stubs:
// they define the boundary between deterministic execution (the executor)
// and non-deterministic ordering (the consensus engine). This separation
// is fundamental to the protocol architecture.
// =============================================================================

import type {
  ValidatorRegistry,
  ValidatorInfo,
  ConsensusEngine,
  ConsensusProposal,
  ProtocolTransaction,
  ProtocolReceipt,
} from './types'

// ---------------------------------------------------------------------------
// ValidatorRegistry stub
// ---------------------------------------------------------------------------

export class ValidatorRegistryNotImplementedError extends Error {
  constructor(operation: string) {
    super(
      `ValidatorRegistry.${operation} is not implemented. ` +
        `The validator registry contract is established (Phase 9A) but ` +
        `the implementation lands in Phase 9C (minimal validator reference).`,
    )
    this.name = 'ValidatorRegistryNotImplementedError'
  }
}

/**
 * Stub validator registry. The contract is defined; the implementation
 * lands in Phase 9C.
 */
export class StubValidatorRegistry implements ValidatorRegistry {
  register(_validatorId: string, _publicKey: string): void {
    throw new ValidatorRegistryNotImplementedError('register')
  }

  deactivate(_validatorId: string): void {
    throw new ValidatorRegistryNotImplementedError('deactivate')
  }

  getActiveValidators(): ValidatorInfo[] {
    throw new ValidatorRegistryNotImplementedError('getActiveValidators')
  }
}

// ---------------------------------------------------------------------------
// ConsensusEngine stub
// ---------------------------------------------------------------------------

export class ConsensusEngineNotImplementedError extends Error {
  constructor(operation: string) {
    super(
      `ConsensusEngine.${operation} is not implemented. ` +
        `The consensus engine contract is established (Phase 9A) but ` +
        `the implementation lands in Phase 9C (minimal consensus reference).`,
    )
    this.name = 'ConsensusEngineNotImplementedError'
  }
}

/**
 * Stub consensus engine. The contract is defined; the implementation
 * lands in Phase 9C.
 *
 * The consensus engine is deliberately separate from the executor:
 *   - The executor is deterministic (same input → same output).
 *   - The consensus engine is non-deterministic (ordering, voting, finality).
 */
export class StubConsensusEngine implements ConsensusEngine {
  propose(_transactions: ProtocolTransaction[]): ConsensusProposal {
    throw new ConsensusEngineNotImplementedError('propose')
  }

  validateProposal(_proposal: ConsensusProposal): boolean {
    throw new ConsensusEngineNotImplementedError('validateProposal')
  }

  finalize(_proposal: ConsensusProposal): ProtocolReceipt[] {
    throw new ConsensusEngineNotImplementedError('finalize')
  }
}
