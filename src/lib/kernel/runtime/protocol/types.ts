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
 * A deterministic, versioned key-value state store.
 *
 * The store maintains a current state snapshot. Each commit produces a new
 * version with a deterministic hash. The store is the source of truth for
 * protocol state — NOT the generic Execution model.
 *
 * DETERMINISM: The hash of a snapshot is computed from its entries in a
 * canonical order (sorted keys). Two snapshots with the same entries have
 * the same hash, regardless of insertion order.
 */
export interface ProtocolStateStore {
  /** Get the current state snapshot. */
  getState(): ProtocolStateSnapshot

  /** Get a specific key from the current state. */
  get(key: string): string | undefined

  /** Stage a key-value update (does not commit). */
  put(key: string, value: string): void

  /** Stage a key deletion (does not commit). */
  delete(key: string): void

  /** Commit staged changes → produces a new versioned snapshot. */
  commit(): ProtocolStateSnapshot

  /** Rollback staged changes (discard without committing). */
  rollback(): void

  /** Get a snapshot at a specific version (for deterministic replay). */
  getSnapshot(version: number): ProtocolStateSnapshot | undefined
}

// ---------------------------------------------------------------------------
// Protocol Transaction Executor
// ---------------------------------------------------------------------------

/**
 * A deterministic transaction executor.
 *
 * THE CRITICAL INVARIANT:
 *   Given the same state + transaction, execution produces the same result.
 *
 * The executor:
 *   1. Validates the transaction (signature, nonce, domain rules)
 *   2. Applies the transaction to the state
 *   3. Commits the resulting state
 *   4. Returns the execution result + receipt
 *
 * If validation fails, the state is unchanged and the result has
 * success=false + an error message.
 */
export interface ProtocolTransactionExecutor {
  /**
   * Validate a transaction against the current state WITHOUT executing it.
   * Returns null if valid, or an error message if invalid.
   */
  validate(transaction: ProtocolTransaction, state: ProtocolStateSnapshot): string | null

  /**
   * Execute a transaction against the current state.
   * If validation fails, the state is unchanged.
   * If execution succeeds, the state is committed.
   */
  execute(transaction: ProtocolTransaction): ProtocolExecutionResult
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
