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
   * DETERMINISTIC ORDERING: Uses nonce-aware ordering (preserves per-sender
   * nonce monotonicity, deterministic global interleaving via tx ID tie-breaker).
   * FINALITY CERTIFICATE: SHA-256 of the ordered transaction IDs.
   */
  finalize(proposal: ConsensusProposal): FinalizedBatch {
    const orderedTransactions = nonceAwareOrder(proposal.transactions)

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
 */
export function computeFinalityCertificate(orderedTransactions: ProtocolTransaction[]): string {
  const orderedIds = orderedTransactions.map((tx) => tx.id).join(':')
  return createHash('sha256').update(orderedIds).digest('hex')
}

// ---------------------------------------------------------------------------
// Nonce-aware deterministic ordering (shared by all consensus engines)
// ---------------------------------------------------------------------------

/**
 * Deterministically order transactions while preserving per-sender nonce
 * monotonicity.
 *
 * Phase 9C final closure: This replaces the plain lexical sort-by-ID
 * with a ready-queue topological ordering:
 *
 *   1. Group transactions by sender.
 *   2. Within each sender, sort by ascending nonce.
 *   3. Use a ready-queue: at each step, the "ready" set is the
 *      lowest-nonce transaction from each sender that hasn't been
 *      emitted yet. Pick the one with the smallest transaction ID
 *      (deterministic tie-breaker). Emit it. The next nonce from
 *      that sender becomes ready.
 *   4. Repeat until all transactions are emitted.
 *
 * This guarantees:
 *   - Per-sender nonce order is preserved (nonce N always precedes N+1).
 *   - Global ordering is deterministic (same input → same output).
 *   - Independent senders can interleave (determined by tx ID tie-breaker).
 *
 * Example:
 *   alice: nonce 0, nonce 1, nonce 2
 *   bob:   nonce 0, nonce 1
 *
 *   Ready set: {alice-0, bob-0}
 *   Pick: whichever has smaller tx ID
 *   If alice-0 picked: ready set becomes {alice-1, bob-0}
 *   Continue until empty.
 */
export function nonceAwareOrder(transactions: ProtocolTransaction[]): ProtocolTransaction[] {
  // Group by sender, sorted by nonce.
  const bySender = new Map<string, ProtocolTransaction[]>()
  for (const tx of transactions) {
    let queue = bySender.get(tx.sender)
    if (!queue) {
      queue = []
      bySender.set(tx.sender, queue)
    }
    queue.push(tx)
  }
  for (const queue of bySender.values()) {
    queue.sort((a, b) => a.nonce - b.nonce)
  }

  // Ready-queue: track the index of the next-ready tx for each sender.
  const result: ProtocolTransaction[] = []
  const indices = new Map<string, number>()
  for (const sender of bySender.keys()) {
    indices.set(sender, 0)
  }

  const remaining = transactions.length
  for (let i = 0; i < remaining; i++) {
    // Build the ready set: the next tx from each sender that still has txs.
    const ready: ProtocolTransaction[] = []
    for (const [sender, idx] of indices) {
      const queue = bySender.get(sender)!
      if (idx < queue.length) {
        ready.push(queue[idx])
      }
    }

    if (ready.length === 0) break

    // Pick the one with the smallest tx ID (deterministic tie-breaker).
    ready.sort((a, b) => a.id.localeCompare(b.id))
    const picked = ready[0]

    result.push(picked)
    indices.set(picked.sender, indices.get(picked.sender)! + 1)
  }

  return result
}

// ---------------------------------------------------------------------------
// BucketSortedConsensusEngine — independently implemented replaceability proof
// ---------------------------------------------------------------------------

/**
 * A second consensus implementation that produces the SAME finalized order
 * as SimpleConsensusEngine but via a COMPLETELY DIFFERENT algorithm.
 *
 * Phase 10.5A: This engine does NOT delegate to nonceAwareOrder().
 * It implements its own nonce-aware ordering using a priority-queue
 * approach (binary heap) instead of the ready-queue approach used by
 * nonceAwareOrder(). Both produce the same output — proving that
 * consensus is truly replaceable: the state machine consumes only
 * the finalized artifact, not the consensus implementation.
 *
 * Algorithm comparison:
 *   nonceAwareOrder(): ready-queue (linear scan for minimum each step)
 *   BucketSortedConsensusEngine: binary min-heap (heapify + extract-min)
 *
 * Both produce identical output because the ordering semantics are the same:
 *   - Per-sender nonce ascending
 *   - Global tie-break by transaction ID
 */

// WORK-006 (BASE-007): HeapNode is used by the BucketSortedConsensusEngine's
// private buildMinHeap/siftDown helpers. Previously declared inside the
// method body, it was out of scope for the class methods (TS2304). Moved to
// module scope so the methods can reference it.
interface HeapNode {
  tx: ProtocolTransaction
  sender: string
  nextIdx: number
}

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
   * Finalize using an INDEPENDENTLY IMPLEMENTED nonce-aware ordering
   * algorithm (binary heap priority queue). This does NOT call
   * nonceAwareOrder() — it implements its own heap-based approach.
   */
  finalize(proposal: ConsensusProposal): FinalizedBatch {
    const orderedTransactions = this.heapBasedNonceOrder(proposal.transactions)
    const finalityCertificate = computeFinalityCertificate(orderedTransactions)

    return {
      proposalId: proposal.proposalId,
      orderedTransactions,
      finalityCertificate,
      finalizedAt: new Date(),
      finalizedBy: this.proposerId,
    }
  }

  /**
   * Independently implemented nonce-aware ordering using a binary min-heap.
   *
   * Steps:
   *   1. Group transactions by sender, sort by nonce ascending.
   *   2. Build a min-heap of the first (lowest-nonce) tx from each sender,
   *      keyed by transaction ID.
   *   3. Extract-min: pop the tx with the smallest ID.
   *   4. Advance that sender's pointer, push the next tx from that sender.
   *   5. Repeat until all txs are emitted.
   *
   * This is a DIFFERENT implementation from nonceAwareOrder() (which does
   * a linear scan for the minimum), but produces the same output because
   * the ordering semantics are identical.
   */
  private heapBasedNonceOrder(transactions: ProtocolTransaction[]): ProtocolTransaction[] {
    if (transactions.length <= 1) return [...transactions]

    // Group by sender, sorted by nonce.
    const bySender = new Map<string, ProtocolTransaction[]>()
    for (const tx of transactions) {
      let queue = bySender.get(tx.sender)
      if (!queue) {
        queue = []
        bySender.set(tx.sender, queue)
      }
      queue.push(tx)
    }
    for (const queue of bySender.values()) {
      queue.sort((a, b) => a.nonce - b.nonce)
    }

    // Build a min-heap of (txId, sender) pairs for the first tx of each sender.
    // (HeapNode interface is declared at module scope — WORK-006 BASE-007.)
    const heap: HeapNode[] = []
    for (const [sender, queue] of bySender) {
      if (queue.length > 0) {
        heap.push({ tx: queue[0], sender, nextIdx: 1 })
      }
    }

    // Heapify (build min-heap by tx ID).
    this.buildMinHeap(heap)

    const result: ProtocolTransaction[] = []
    while (heap.length > 0) {
      // Extract minimum.
      const min = heap[0]
      result.push(min.tx)

      // Replace root with the next tx from the same sender (or remove).
      const queue = bySender.get(min.sender)!
      if (min.nextIdx < queue.length) {
        heap[0] = { tx: queue[min.nextIdx], sender: min.sender, nextIdx: min.nextIdx + 1 }
        this.siftDown(heap, 0)
      } else {
        // Remove last element and put it at root.
        const last = heap.pop()!
        if (heap.length > 0) {
          heap[0] = last
          this.siftDown(heap, 0)
        }
      }
    }

    return result
  }

  // --- Binary min-heap helpers (keyed by tx ID) ---

  private buildMinHeap(heap: HeapNode[]): void {
    for (let i = Math.floor(heap.length / 2) - 1; i >= 0; i--) {
      this.siftDown(heap, i)
    }
  }

  private siftDown(heap: HeapNode[], idx: number): void {
    const n = heap.length
    while (true) {
      let smallest = idx
      const left = 2 * idx + 1
      const right = 2 * idx + 2

      if (left < n && heap[left].tx.id < heap[smallest].tx.id) {
        smallest = left
      }
      if (right < n && heap[right].tx.id < heap[smallest].tx.id) {
        smallest = right
      }

      if (smallest === idx) break
      ;[heap[idx], heap[smallest]] = [heap[smallest], heap[idx]]
      idx = smallest
    }
  }
}
