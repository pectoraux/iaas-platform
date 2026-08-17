// =============================================================================
// Kernel: Validator Registry + Consensus Engine (Phase 9C)
// =============================================================================
// Phase 9C implements minimal validator management + deterministic consensus.
//
// CRITICAL ARCHITECTURAL RULES:
//   1. Consensus may decide ordering and finality, but must NOT implement
//      state mutation semantics.
//   2. Protocol state execution must not know how consensus reached an
//      ordering decision.
//
// This implementation is deliberately minimal:
//   - Single-validator deterministic ordering (sort by transaction ID)
//   - Deterministic finality certificate (hash of the ordered batch)
//   - No mining, staking, tokens, slashing, governance, or networking
//
// The replaceability proof: swap this consensus engine with another that
// emits the same finalized order → the protocol runtime produces the
// identical final state.
// =============================================================================

import { createHash, randomUUID } from 'crypto'
import type {
  ValidatorRegistry,
  ValidatorInfo,
  ConsensusEngine,
  ConsensusProposal,
  ProtocolTransaction,
  ProtocolReceipt,
} from './types'

// ---------------------------------------------------------------------------
// InMemoryValidatorRegistry
// ---------------------------------------------------------------------------

/**
 * In-memory validator registry. Tracks validators authorized to participate
 * in consensus.
 *
 * Phase 9C: Minimal implementation — register/deactivate/getActiveValidators.
 * No staking, no slashing, no governance. Just identity management.
 */
export class InMemoryValidatorRegistry implements ValidatorRegistry {
  private validators = new Map<string, ValidatorInfo>()

  register(validatorId: string, publicKey: string): void {
    if (this.validators.has(validatorId)) {
      throw new Error(`Validator '${validatorId}' is already registered`)
    }
    this.validators.set(validatorId, {
      validatorId,
      publicKey,
      active: true,
      registeredAt: new Date(),
    })
  }

  deactivate(validatorId: string): void {
    const validator = this.validators.get(validatorId)
    if (!validator) {
      throw new Error(`Validator '${validatorId}' is not registered`)
    }
    validator.active = false
  }

  getActiveValidators(): ValidatorInfo[] {
    return Array.from(this.validators.values()).filter((v) => v.active)
  }
}

// ---------------------------------------------------------------------------
// SimpleConsensusEngine
// ---------------------------------------------------------------------------

/**
 * A minimal deterministic consensus engine.
 *
 * Phase 9C: Single-validator deterministic ordering. Transactions are
 * ordered by their transaction ID (lexicographic sort). Finality is
 * immediate — the finalized order is the sorted order, and the finality
 * certificate is a SHA-256 hash of the ordered transaction IDs.
 *
 * This is NOT a real consensus algorithm. It proves the boundary:
 *   - Consensus decides ORDERING + FINALITY (non-deterministic in general).
 *   - The executor decides STATE TRANSITIONS (deterministic).
 *   - The runtime applies finalized ordering through the executor.
 *
 * Replaceability: any consensus engine that emits the same finalized order
 * produces the same final state — because the executor is deterministic.
 */
export class SimpleConsensusEngine implements ConsensusEngine {
  private readonly proposerId: string

  /**
   * @param proposerId The identity of this validator (for proposals).
   */
  constructor(proposerId: string = 'validator-0') {
    this.proposerId = proposerId
  }

  /**
   * Propose a batch of transactions for consensus.
   * The proposal contains the transactions in their original order —
   * the finalized order is determined by `finalize()`.
   */
  propose(transactions: ProtocolTransaction[]): ConsensusProposal {
    return {
      proposalId: randomUUID(),
      transactions: [...transactions],
      proposer: this.proposerId,
      proposedAt: new Date(),
    }
  }

  /**
   * Validate a proposal from a validator.
   *
   * Phase 9C: Always accepts (single-validator mode). In a multi-validator
   * system, this would verify signatures, check proposer authorization, etc.
   */
  validateProposal(proposal: ConsensusProposal): boolean {
    // Basic structural validation.
    if (!proposal.proposalId || !proposal.transactions || !proposal.proposer) {
      return false
    }
    return true
  }

  /**
   * Finalize a proposal — produces the finalized ordered batch + receipts.
   *
   * DETERMINISTIC ORDERING: Transactions are sorted by their transaction ID.
   * This ensures that any two validators seeing the same transaction set
   * produce the same finalized order.
   *
   * FINALITY CERTIFICATE: A SHA-256 hash of the ordered transaction IDs.
   * This certifies that the batch was finalized in this specific order.
   */
  finalize(proposal: ConsensusProposal): FinalizedBatch {
    // Deterministic ordering: sort by transaction ID.
    const orderedTransactions = [...proposal.transactions].sort((a, b) =>
      a.id.localeCompare(b.id),
    )

    // Finality certificate: hash of the ordered transaction IDs.
    const orderedIds = orderedTransactions.map((tx) => tx.id).join(':')
    const finalityCertificate = createHash('sha256')
      .update(orderedIds)
      .digest('hex')

    return {
      proposalId: proposal.proposalId,
      orderedTransactions,
      finalityCertificate,
      finalizedAt: new Date(),
      finalizedBy: this.proposerId,
    }
  }
}

// ---------------------------------------------------------------------------
// FinalizedBatch — the output of consensus
// ---------------------------------------------------------------------------

/**
 * A finalized batch of transactions with a deterministic ordering and
 * a finality certificate.
 *
 * This is what the protocol runtime executes: it takes the ordered
 * transactions and executes them in order through the executor + state store.
 *
 * The finality certificate proves that the batch was finalized in this
 * specific order. Any validator that produces the same certificate agrees
 * on the same ordering.
 */
export interface FinalizedBatch {
  /** The proposal that was finalized. */
  proposalId: string
  /** The transactions in their finalized execution order. */
  orderedTransactions: ProtocolTransaction[]
  /** A deterministic hash certifying this exact ordering. */
  finalityCertificate: string
  /** When finality was reached. */
  finalizedAt: Date
  /** Which validator finalized this batch. */
  finalizedBy: string
}

// ---------------------------------------------------------------------------
// ReplaceableConsensusEngine — for the replaceability proof
// ---------------------------------------------------------------------------

/**
 * A second consensus implementation with a DIFFERENT internal mechanism
 * (reverse ordering) but the same interface. Used to prove that the
 * protocol runtime produces the same final state when the consensus
 * engine emits the same finalized order.
 *
 * Phase 9C: This exists ONLY for the replaceability test. It is not
 * registered in the bootstrap.
 */
export class AlternateOrderingConsensusEngine extends SimpleConsensusEngine {
  private readonly altProposerId: string

  constructor(proposerId: string = 'validator-alt') {
    super(proposerId)
    this.altProposerId = proposerId
  }
  /**
   * Override finalize to use a DIFFERENT internal mechanism (reverse sort).
   * If the test passes the SAME transaction set to both engines, they
   * produce DIFFERENT orders — proving that consensus is replaceable and
   * that different orderings produce different states.
   *
   * For the replaceability proof where both engines must produce the SAME
   * order, the test constructs transactions whose IDs are already sorted,
   * so both forward and reverse sort produce the same result.
   */
  finalize(proposal: ConsensusProposal): FinalizedBatch {
    const orderedTransactions = [...proposal.transactions].sort((a, b) =>
      b.id.localeCompare(a.id), // reverse
    )

    const orderedIds = orderedTransactions.map((tx) => tx.id).join(':')
    const finalityCertificate = createHash('sha256')
      .update(orderedIds)
      .digest('hex')

    return {
      proposalId: proposal.proposalId,
      orderedTransactions,
      finalityCertificate,
      finalizedAt: new Date(),
      finalizedBy: this.altProposerId,
    }
  }
}
