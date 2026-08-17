// =============================================================================
// Kernel: Deterministic Transaction Executor (Phase 9B.1)
// =============================================================================
// A deterministic transaction executor that CALCULATES state transitions.
//
// Phase 9B.1: The executor is now a PURE CALCULATOR. It does NOT own
// persistence — it does not read from or commit to the state store.
// The executor takes a state snapshot + transaction, validates, and returns
// the resulting entries. The RUNTIME coordinates the load → validate →
// calculate → stage → commit → receipt flow.
//
// This separation makes consensus integration easier: the consensus engine
// can use the executor to calculate transitions without committing, then
// order them, then commit in order.
//
// THE CRITICAL INVARIANT:
//   Given the same state + transaction, the calculation is identical.
//
// Reference state-transition protocol:
//   - 'transfer' transactions move a balance from one account to another
//   - 'mint' transactions create balance (for testing/initialization)
//   - State keys: 'balance:<account>' → string (decimal)
// =============================================================================

import { createHash } from 'crypto'
import type {
  ProtocolTransaction,
  ProtocolExecutionResult,
  ProtocolReceipt,
  ProtocolStateSnapshot,
  ProtocolTransactionExecutor,
  WriteSet,
} from './types'

/**
 * The result of calculating a transaction's state transition.
 * This is a PURE value — no side effects, no store mutation.
 *
 * Phase 9B.2: Returns a WriteSet (not raw entries) — the write set is
 * the isolated set of changes the runtime should commit. There is no
 * shared staging buffer; the write set is carried by the caller.
 */
export interface TransitionCalculation {
  /** Whether the transaction is valid. */
  valid: boolean
  /** The write set to commit (only if valid). */
  writeSet: WriteSet
  /** Error message if invalid. */
  error?: string
}

/**
 * A deterministic transaction executor for the reference state-transition
 * protocol.
 *
 * Phase 9B.1: The executor is a PURE CALCULATOR. It does NOT read from or
 * commit to the state store. All methods are synchronous (no I/O).
 *
 * The executor:
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
 * Determinism:
 *   The executor does NOT use Date.now() or Math.random().
 *   All calculations are pure functions of (state, transaction).
 */
export class DeterministicTransactionExecutor implements ProtocolTransactionExecutor {
  validate(transaction: ProtocolTransaction, state: ProtocolStateSnapshot): string | null {
    // Signature check (simplified — real implementation would verify the signature).
    if (!transaction.signature) {
      return 'Transaction signature is empty'
    }

    // Nonce check: the sender's nonce must match the expected nonce.
    const expectedNonce = this.getExpectedNonce(state, transaction.sender)
    if (transaction.nonce !== expectedNonce) {
      return `Invalid nonce: expected ${expectedNonce}, got ${transaction.nonce}`
    }

    // Payload-type-specific validation.
    switch (transaction.payload.type) {
      case 'transfer':
        return this.validateTransfer(transaction, state)
      case 'mint':
        return this.validateMint(transaction, state)
      case 'record_delivery':
        return this.validateRecordDelivery(transaction, state)
      default:
        return `Unknown transaction type: ${transaction.payload.type}`
    }
  }

  /**
   * Calculate the state transition for a transaction.
   * PURE: does not mutate the store or the input state.
   *
   * Phase 9B.2: Returns a WriteSet — the isolated set of key-value changes
   * the runtime should commit. The write set is derived by diffing the
   * old entries against the calculated new entries. There is no shared
   * staging buffer; the write set is carried by the caller.
   *
   * If the transaction is invalid, returns valid=false + empty write set + error.
   */
  apply(transaction: ProtocolTransaction, state: ProtocolStateSnapshot): TransitionCalculation {
    const validationError = this.validate(transaction, state)
    if (validationError) {
      return { valid: false, writeSet: [], error: validationError }
    }

    // Calculate the new entries (pure — does not mutate the input state).
    const newEntries = new Map(state.entries)
    this.applyTransactionToEntries(transaction, newEntries)

    // Compute the write set (diff between old and new).
    const writeSet = this.computeWriteSet(state.entries, newEntries)

    return { valid: true, writeSet }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getExpectedNonce(state: ProtocolStateSnapshot, sender: string): number {
    const nonceKey = `nonce:${sender}`
    const value = state.entries.get(nonceKey)
    return value ? parseInt(value, 10) : 0
  }

  private validateTransfer(transaction: ProtocolTransaction, state: ProtocolStateSnapshot): string | null {
    const { from, to, amount } = transaction.payload.data
    if (!from || !to || amount === undefined) {
      return 'Transfer requires from, to, and amount'
    }
    const fromBalance = state.entries.get(`balance:${from}`)
    const currentBalance = fromBalance ? parseFloat(fromBalance) : 0
    const transferAmount = parseFloat(amount as string)
    if (transferAmount <= 0) {
      return 'Transfer amount must be positive'
    }
    if (currentBalance < transferAmount) {
      return `Insufficient balance: ${currentBalance} < ${transferAmount}`
    }
    return null
  }

  private validateMint(transaction: ProtocolTransaction, _state: ProtocolStateSnapshot): string | null {
    const { to, amount } = transaction.payload.data
    if (!to || amount === undefined) {
      return 'Mint requires to and amount'
    }
    const mintAmount = parseFloat(amount as string)
    if (mintAmount <= 0) {
      return 'Mint amount must be positive'
    }
    return null
  }

  /**
   * Validate a 'record_delivery' transaction (from the HybridBridge).
   * Records infrastructure execution results as protocol state.
   *
   * State keys: 'delivery:<sender>' → cumulative quantity (string)
   */
  private validateRecordDelivery(transaction: ProtocolTransaction, _state: ProtocolStateSnapshot): string | null {
    const { quantity, unit } = transaction.payload.data
    if (quantity === undefined || unit === undefined) {
      return 'record_delivery requires quantity and unit'
    }
    return null
  }

  /**
   * Apply a transaction to a mutable entries map (pure mutation of the
   * passed-in map — does not touch any store).
   */
  private applyTransactionToEntries(transaction: ProtocolTransaction, entries: Map<string, string>): void {
    const sender = transaction.sender
    const nonceKey = `nonce:${sender}`

    switch (transaction.payload.type) {
      case 'transfer': {
        const { from, to, amount } = transaction.payload.data
        const fromKey = `balance:${from}`
        const toKey = `balance:${to}`
        const fromBalance = entries.get(fromKey)
        const toBalance = entries.get(toKey)
        const currentFrom = fromBalance ? parseFloat(fromBalance) : 0
        const currentTo = toBalance ? parseFloat(toBalance) : 0
        const transferAmount = parseFloat(amount as string)

        entries.set(fromKey, (currentFrom - transferAmount).toString())
        entries.set(toKey, (currentTo + transferAmount).toString())
        entries.set(nonceKey, (transaction.nonce + 1).toString())
        break
      }
      case 'mint': {
        const { to, amount } = transaction.payload.data
        const toKey = `balance:${to}`
        const toBalance = entries.get(toKey)
        const currentTo = toBalance ? parseFloat(toBalance) : 0
        const mintAmount = parseFloat(amount as string)

        entries.set(toKey, (currentTo + mintAmount).toString())
        entries.set(nonceKey, (transaction.nonce + 1).toString())
        break
      }
      case 'record_delivery': {
        const { quantity, unit } = transaction.payload.data
        const deliveryKey = `delivery:${transaction.sender}`
        const currentDelivery = entries.get(deliveryKey)
        const currentAmount = currentDelivery ? parseFloat(currentDelivery) : 0
        const deliveryAmount = parseFloat(quantity as string)

        entries.set(deliveryKey, (currentAmount + deliveryAmount).toString())
        entries.set(`delivery_unit:${transaction.sender}`, unit as string)
        entries.set(nonceKey, (transaction.nonce + 1).toString())
        break
      }
    }
  }

  /**
   * Compute the write set (diff) between old and new entries.
   * Returns only the keys that changed.
   */
  private computeWriteSet(oldEntries: ReadonlyMap<string, string>, newEntries: Map<string, string>): WriteSet {
    const writeSet: WriteSet = []
    const allKeys = new Set([...oldEntries.keys(), ...newEntries.keys()])

    for (const key of allKeys) {
      const oldValue = oldEntries.get(key)
      const newValue = newEntries.get(key)

      if (newValue === undefined && oldValue !== undefined) {
        // Key was deleted.
        writeSet.push({ op: 'delete', key })
      } else if (newValue !== undefined && oldValue !== newValue) {
        // Key was added or changed.
        writeSet.push({ op: 'put', key, value: newValue })
      }
    }

    return writeSet
  }

  /**
   * Compute a deterministic SHA-256 hash from entries.
   */
  private computeHash(entries: Map<string, string>): string {
    const sortedKeys = Array.from(entries.keys()).sort()
    const canonical: Record<string, string> = {}
    for (const key of sortedKeys) {
      canonical[key] = entries.get(key)!
    }
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
  }
}

/**
 * Compute a deterministic transaction ID from the transaction contents.
 * This ensures the same transaction always produces the same ID.
 */
export function computeTransactionId(
  networkVersionId: string,
  sender: string,
  nonce: number,
  payload: Record<string, unknown>,
): string {
  const content = JSON.stringify({ networkVersionId, sender, nonce, payload })
  return createHash('sha256').update(content).digest('hex')
}
