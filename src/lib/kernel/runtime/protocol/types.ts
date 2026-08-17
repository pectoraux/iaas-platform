// =============================================================================
// Kernel: Protocol Runtime Contracts (Phase 9A)
// =============================================================================
// The protocol runtime operates via deterministic state transitions rather
// than physical asset execution. These contracts define the protocol side
// WITHOUT coupling to infrastructure concepts (Execution, ExecutionAssignment,
// adapters, telemetry, physical execution).
//
// ARCHITECTURAL RULE:
//   ProtocolRuntime owns: ProtocolStateStore, ProtocolTransactionExecutor,
//   ValidatorRegistry, ConsensusEngine.
//
//   ProtocolRuntime does NOT own or import:
//   - InfrastructureRuntime
//   - InfrastructureAdapter / AdapterRegistry
//   - VPP / Compute services
//   - The generic Execution/ExecutionAssignment models (those are
//     infrastructure-shaped; protocol has its own state model)
//
//   The economic kernel (Contribution, Reward, Ledger, Settlement) remains
//   shared — but that coupling is deferred to a later phase. Phase 9A
//   proves the protocol contracts in memory.
//
// DETERMINISM INVARIANT:
//   Given the same state + transaction, execution produces the same result.
//   This is the fundamental protocol invariant.
// =============================================================================

// ---------------------------------------------------------------------------
// Protocol Transaction
// ---------------------------------------------------------------------------

/**
 * An immutable transaction envelope submitted to the protocol runtime.
 *
 * No blockchain-specific concepts (UTXO, EVM, blocks, gas, slashing).
 * This is a generic signed state transition request.
 */
export interface ProtocolTransaction {
  /** Unique transaction ID (deterministic hash of the contents). */
  id: string
  /** The network version this transaction is bound to (immutable policy). */
  networkVersionId: string
  /** The sender's identity (public key, address, or operator ID). */
  sender: string
  /** Monotonic nonce to prevent replay. */
  nonce: number
  /** The transaction payload (domain-specific state transition data). */
  payload: ProtocolTransactionPayload
  /** The sender's signature over the transaction contents. */
  signature: string
  /** When the transaction was submitted. */
  submittedAt: Date
}

/**
 * A generic transaction payload. The protocol runtime's executor
 * interprets the `type` and `data` fields deterministically.
 *
 * Example (counter/state-transition protocol):
 *   { type: 'transfer', data: { from: 'alice', to: 'bob', amount: '10' } }
 */
export interface ProtocolTransactionPayload {
  type: string
  data: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Protocol Execution
// ---------------------------------------------------------------------------

/**
 * The result of executing a protocol transaction against a state.
 *
 * DETERMINISTIC: Given the same state + transaction, this result is identical.
 */
export interface ProtocolExecutionResult {
  /** Whether the transaction was valid and executed. */
  success: boolean
  /** The resulting state after applying the transaction. */
  resultingState: ProtocolStateSnapshot
  /** The execution receipt (proves the transaction was executed). */
  receipt: ProtocolReceipt
  /** Error message if the transaction was invalid. */
  error?: string
}

/**
 * A receipt proving a transaction was executed against a specific state.
 */
export interface ProtocolReceipt {
  /** The transaction ID that was executed. */
  transactionId: string
  /** The state hash BEFORE execution. */
  beforeStateHash: string
  /** The state hash AFTER execution. */
  afterStateHash: string
  /** When the execution occurred. */
  executedAt: Date
  /** The executor's identity (validator or runtime). */
  executor: string
}

// ---------------------------------------------------------------------------
// Protocol State Store
// ---------------------------------------------------------------------------

/**
 * A versioned snapshot of the protocol state.
 */
export interface ProtocolStateSnapshot {
  /** The version number (increments on each commit). */
  version: number
  /** The state hash (deterministic — same state → same hash). */
  hash: string
  /** The state entries (key → value). */
  entries: ReadonlyMap<string, string>
}

/**
 * Error thrown when a commit fails due to a stale version (optimistic
 * concurrency conflict). Two transactions that both read version N cannot
 * both commit to N+1 — the second must retry.
 */
export class StaleVersionError extends Error {
  constructor(
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `Stale version: expected ${expectedVersion}, but the current version is ${actualVersion}. ` +
        `Another transaction committed first — retry with the current state.`,
    )
    this.name = 'StaleVersionError'
  }
}

/**
 * A write set: the set of key-value changes to apply in a single atomic commit.
 *
 * Phase 9B.2: This replaces the old shared `stagedEntries` map. Each
 * transaction carries its OWN write set — there is no shared mutable
 * staging buffer on the store. This eliminates the concurrency bug where
 * two transactions using the same store could interleave staged mutations.
 *
 * A write set entry is either:
 *   - { op: 'put', key, value } — set a key
 *   - { op: 'delete', key } — delete a key
 */
export type WriteSetEntry =
  | { op: 'put'; key: string; value: string }
  | { op: 'delete'; key: string }

/**
 * A write set: an array of key-value changes to apply atomically.
 * Carried by the transaction, not by the store.
 */
export type WriteSet = WriteSetEntry[]

/**
 * A deterministic, versioned key-value state store.
 *
 * Phase 9B.2: The store has NO shared mutable staging buffer. The commit
 * method receives the write set directly from the caller. This eliminates
 * the concurrency bug where two transactions using the same store could
 * interleave staged mutations.
 *
 * The flow is:
 *   state = store.getState()           // read current state (async)
 *   writeSet = executor.apply(tx, state).writeSet  // pure calculation
 *   store.commit(state.version, writeSet, tx.id)   // atomic commit (async)
 *
 * The store is the source of truth for protocol state — NOT the generic
 * Execution model.
 *
 * DETERMINISM: The hash of a snapshot is computed from its entries in a
 * canonical order (sorted keys). Two snapshots with the same entries have
 * the same hash, regardless of insertion order.
 *
 * PERSISTENCE (Phase 9B): Implementations may be in-memory (for testing)
 * or PostgreSQL-backed (for production). Both implement the SAME async
 * interface — the test implementation is NOT a different protocol.
 */
export interface ProtocolStateStore {
  /** The network version this store is bound to (immutable policy scope). */
  readonly networkVersionId: string

  /** Get the current committed state snapshot. */
  getState(): Promise<ProtocolStateSnapshot>

  /** Get a specific key from the current state. */
  get(key: string): Promise<string | undefined>

  /**
   * Commit a write set → produces a new versioned snapshot.
   *
   * OPTIMISTIC CONCURRENCY: If `expectedVersion` doesn't match the current
   * committed version, the commit fails with `StaleVersionError`. This
   * prevents two transactions from both committing against the same state.
   *
   * ATOMIC: The commit is all-or-nothing. If it fails, the state is
   * unchanged.
   *
   * ISOLATED WRITE SET (Phase 9B.2): The write set is passed directly —
   * there is no shared mutable staging buffer. Two concurrent transactions
   * using the same store CANNOT interleave their mutations.
   *
   * TRANSITION JOURNAL (Phase 9B.1): If `transactionHash` is provided,
   * persistent implementations record a ProtocolTransition entry atomically
   * with the state snapshot.
   *
   * @param expectedVersion The version the caller read (for OCC).
   * @param writeSet The key-value changes to apply (carried by the caller).
   * @param transactionHash Optional hash of the transaction (for journal).
   */
  commit(
    expectedVersion: number,
    writeSet: WriteSet,
    transactionHash?: string,
  ): Promise<ProtocolStateSnapshot>

  /** Get a snapshot at a specific version (for deterministic replay). */
  getSnapshot(version: number): Promise<ProtocolStateSnapshot | undefined>
}

// ---------------------------------------------------------------------------
// Protocol Transaction Executor
// ---------------------------------------------------------------------------

/**
 * A deterministic transaction executor.
 *
 * THE CRITICAL INVARIANT:
 *   Given the same state + transaction, the calculation is identical.
 *
 * Phase 9B.1: The executor is a PURE CALCULATOR. It does NOT own persistence
 * — it does not read from or commit to the state store. The executor:
 *   1. validate(transaction, state) — checks signature, nonce, domain rules
 *   2. apply(transaction, state) — calculates the new entries (pure)
 *
 * The RUNTIME is responsible for:
 *   - Loading state from the store (async)
 *   - Calling executor.validate + executor.apply
 *   - Staging the calculated entries on the store
 *   - Committing with optimistic concurrency (async)
 *   - Building the receipt
 *
 * This separation makes consensus integration easier: the consensus engine
 * can use the executor to calculate transitions without committing, then
 * order them, then commit in order.
 */
export interface ProtocolTransactionExecutor {
  /**
   * Validate a transaction against the given state WITHOUT executing it.
   * PURE: does not mutate the state or the store.
   * Returns null if valid, or an error message if invalid.
   */
  validate(transaction: ProtocolTransaction, state: ProtocolStateSnapshot): string | null

  /**
   * Calculate the state transition for a transaction.
   * PURE: does not mutate the store or the input state.
   * Returns the new entries that would result from applying the transaction.
   *
   * If the transaction is invalid, returns valid=false + error.
   */
  apply(transaction: ProtocolTransaction, state: ProtocolStateSnapshot): { valid: boolean; writeSet: WriteSet; error?: string }
}

// ---------------------------------------------------------------------------
// Validator Registry
// ---------------------------------------------------------------------------

/**
 * A registry of validators authorized to participate in consensus.
 *
 * Phase 9A: This is a contract definition only. The implementation is a
 * stub that throws NotImplemented. Real validator management lands in
 * Phase 9C.
 */
export interface ValidatorRegistry {
  /** Register a validator. */
  register(validatorId: string, publicKey: string): void

  /** Deactivate a validator. */
  deactivate(validatorId: string): void

  /** Get all active validators. */
  getActiveValidators(): ValidatorInfo[]
}

/**
 * Information about a registered validator.
 */
export interface ValidatorInfo {
  validatorId: string
  publicKey: string
  active: boolean
  registeredAt: Date
}

// ---------------------------------------------------------------------------
// Consensus Engine
// ---------------------------------------------------------------------------

/**
 * A consensus engine that orders and finalizes transactions.
 *
 * Phase 9A: This is a contract definition only. The implementation is a
 * stub that throws NotImplemented. Real consensus lands in Phase 9C.
 *
 * The consensus engine is deliberately separate from the executor:
 *   - The executor is deterministic (same input → same output).
 *   - The consensus engine is non-deterministic (ordering, voting, finality).
 */
export interface ConsensusEngine {
  /** Propose a block/batch of transactions for consensus. */
  propose(transactions: ProtocolTransaction[]): ConsensusProposal

  /** Validate a proposal from another validator. */
  validateProposal(proposal: ConsensusProposal): boolean

  /** Finalize a proposal (after consensus is reached). */
  finalize(proposal: ConsensusProposal): ProtocolReceipt[]
}

/**
 * A consensus proposal containing a batch of transactions.
 */
export interface ConsensusProposal {
  proposalId: string
  transactions: ProtocolTransaction[]
  proposer: string
  proposedAt: Date
}

// ---------------------------------------------------------------------------
// Protocol Runtime Dependencies
// ---------------------------------------------------------------------------

/**
 * The dependencies injected into ProtocolRuntime.
 *
 * Phase 9A: The runtime accepts these as constructor parameters
 * (dependency injection), mirroring how InfrastructureRuntime accepts
 * an AdapterRegistry.
 */
export interface ProtocolRuntimeDeps {
  stateStore: ProtocolStateStore
  executor: ProtocolTransactionExecutor
  validatorRegistry: ValidatorRegistry
  consensusEngine: ConsensusEngine
}
