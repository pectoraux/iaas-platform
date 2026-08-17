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
  FinalizedBatch,
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
  private readonly validatorRegistry: ValidatorRegistry | null

  /**
   * @param proposerId The identity of this validator (for proposals).
   * @param validatorRegistry Optional registry for proposal authorization.
   *   If provided, validateProposal rejects proposals from unregistered/inactive
   *   validators. If null, all structurally valid proposals are accepted
   *   (for testing without a registry).
   */
  constructor(proposerId: string = 'validator-0', validatorRegistry?: ValidatorRegistry) {
    this.proposerId = proposerId
    this.validatorRegistry = validatorRegistry ?? null
  }

  /**
   * Propose a batch of transactions for consensus.
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
   * Phase 9C closure: If a ValidatorRegistry is provided, rejects proposals
   * from unregistered or inactive validators. This connects the validator
   * registry to the consensus authorization boundary.
   */
  validateProposal(proposal: ConsensusProposal): boolean {
    if (!proposal.proposalId || !proposal.transactions || !proposal.proposer) {
      return false
    }

    // Phase 9C closure: Validator authorization.
    if (this.validatorRegistry) {
      const activeValidators = this.validatorRegistry.getActiveValidators()
      const isAuthorized = activeValidators.some((v) => v.validatorId === proposal.proposer)
      if (!isAuthorized) {
        return false
      }
    }

    return true
  }

  /**
   * Finalize a proposal — produces the finalized ordered batch.
   *
   * DETERMINISTIC ORDERING: Transactions are sorted by their transaction ID.
   * FINALITY CERTIFICATE: SHA-256 of the ordered transaction IDs (via the
   * shared computeFinalityCertificate function).
   */
  finalize(proposal: ConsensusProposal): FinalizedBatch {
    const orderedTransactions = [...proposal.transactions].sort((a, b) =>
      a.id.localeCompare(b.id),
    )

    const finalityCertificate = computeFinalityCertificate(orderedTransactions)

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
// Deterministic certificate computation (shared by consensus + runtime)
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic finality certificate from an ordered transaction set.
 *
 * Phase 9C closure: This function is SHARED between the consensus engine
 * (which generates the certificate) and the runtime (which verifies it).
 * Both must agree on the exact certificate computation — a tampered batch
 * will produce a different certificate and be rejected.
 *
 * The certificate is SHA-256 of the ordered transaction IDs joined by ':'.
 * This is intentionally simple for Phase 9C. Future phases may bind the
 * certificate to more than just the ordered IDs.
 */
export function computeFinalityCertificate(orderedTransactions: ProtocolTransaction[]): string {
  const orderedIds = orderedTransactions.map((tx) => tx.id).join(':')
  return createHash('sha256').update(orderedIds).digest('hex')
}

// ---------------------------------------------------------------------------
// BucketSortedConsensusEngine — true replaceability proof
// ---------------------------------------------------------------------------

/**
 * A second consensus implementation that produces the SAME finalized order
 * as SimpleConsensusEngine but via a DIFFERENT algorithm.
 *
 * SimpleConsensusEngine uses: Array.sort() (lexicographic comparison)
 * BucketSortedConsensusEngine uses: bucket-by-first-character, then sort within buckets
 *
 * Both produce identical output for the same input — proving that consensus
 * is replaceable: the state machine consumes only the finalized order, not
 * the algorithm that produced it.
 *
 * Phase 9C: This exists ONLY for the replaceability test. It is not
 * registered in the bootstrap.
 */
export class BucketSortedConsensusEngine implements ConsensusEngine {
  private readonly proposerId: string

  constructor(proposerId: string = 'validator-bucket') {
    this.proposerId = proposerId
  }

  propose(transactions: ProtocolTransaction[]): ConsensusProposal {
    return {
      proposalId: randomUUID(),
      transactions: [...transactions],
      proposer: this.proposerId,
      proposedAt: new Date(),
    }
  }

  validateProposal(proposal: ConsensusProposal): boolean {
    if (!proposal.proposalId || !proposal.transactions || !proposal.proposer) {
      return false
    }
    return true
  }

  /**
   * Finalize using a DIFFERENT algorithm (bucket sort) that produces the
   * SAME result as SimpleConsensusEngine's lexicographic sort.
   */
  finalize(proposal: ConsensusProposal): FinalizedBatch {
    // Bucket by first character of tx ID.
    const buckets = new Map<string, ProtocolTransaction[]>()
    for (const tx of proposal.transactions) {
      const firstChar = tx.id.charAt(0)
      let bucket = buckets.get(firstChar)
      if (!bucket) {
        bucket = []
        buckets.set(firstChar, bucket)
      }
      bucket.push(tx)
    }

    // Sort bucket keys, then sort within each bucket, and concatenate.
    const orderedTransactions: ProtocolTransaction[] = []
    const sortedBucketKeys = Array.from(buckets.keys()).sort()
    for (const key of sortedBucketKeys) {
      const bucket = buckets.get(key)!
      bucket.sort((a, b) => a.id.localeCompare(b.id))
      orderedTransactions.push(...bucket)
    }

    const finalityCertificate = computeFinalityCertificate(orderedTransactions)

    return {
      proposalId: proposal.proposalId,
      orderedTransactions,
      finalityCertificate,
      finalizedAt: new Date(),
      finalizedBy: this.proposerId,
    }
  }
}
