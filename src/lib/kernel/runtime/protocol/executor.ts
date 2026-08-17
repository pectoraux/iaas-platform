// =============================================================================
// Kernel: Deterministic Transaction Executor (Phase 10 closure)
// =============================================================================
// A deterministic transaction executor that delegates domain-specific logic
// to injectable TransactionHandlers.
//
// Phase 10 closure: The executor NO LONGER contains a switch statement with
// hard-coded transaction types. Instead, it delegates to registered
// TransactionHandler instances. The executor itself only handles generic
// concerns (signature, nonce). Transaction handlers are the ONLY place
// that knows about domain-specific semantics (transfer, mint,
// record_delivery, etc.).
//
// This keeps the executor vertical-neutral: a new vertical registers its
// own transaction handlers WITHOUT modifying the executor.
//
// THE CRITICAL INVARIANT:
//   Given the same state + transaction, the calculation is identical.
//
// DETERMINISM:
//   The executor does NOT use Date.now() or Math.random().
//   All calculations are pure functions of (state, transaction).
// =============================================================================

import { createHash } from 'crypto'
import type {
  ProtocolTransaction,
  ProtocolStateSnapshot,
  ProtocolTransactionExecutor,
  TransactionHandler,
  WriteSet,
} from './types'

/**
 * The result of calculating a transaction's state transition.
 */
export interface TransitionCalculation {
  valid: boolean
  writeSet: WriteSet
  error?: string
}

/**
 * A deterministic transaction executor that delegates to injectable handlers.
 *
 * Phase 10 closure: The executor is vertical-neutral. It handles only:
 *   - Signature check (non-empty)
 *   - Nonce check (matches expected)
 *   - Handler delegation (validate + apply)
 *
 * Domain-specific logic (transfer, mint, record_delivery, etc.) lives in
 * registered TransactionHandler instances. New verticals register their
 * handlers via registerHandler() — the executor source is NOT modified.
 */
export class DeterministicTransactionExecutor implements ProtocolTransactionExecutor {
  private readonly handlers = new Map<string, TransactionHandler>()

  registerHandler(payloadType: string, handler: TransactionHandler): void {
    if (this.handlers.has(payloadType)) {
      throw new Error(`Handler already registered for payload type '${payloadType}'`)
    }
    this.handlers.set(payloadType, handler)
  }

  validate(transaction: ProtocolTransaction, state: ProtocolStateSnapshot): string | null {
    // Generic: signature check.
    if (!transaction.signature) {
      return 'Transaction signature is empty'
    }

    // Generic: nonce check.
    const expectedNonce = this.getExpectedNonce(state, transaction.sender)
    if (transaction.nonce !== expectedNonce) {
      return `Invalid nonce: expected ${expectedNonce}, got ${transaction.nonce}`
    }

    // Domain-specific: delegate to the registered handler.
    const handler = this.handlers.get(transaction.payload.type)
    if (!handler) {
      return `Unknown transaction type: ${transaction.payload.type}`
    }

    return handler.validate(transaction, state)
  }

  apply(transaction: ProtocolTransaction, state: ProtocolStateSnapshot): TransitionCalculation {
    const validationError = this.validate(transaction, state)
    if (validationError) {
      return { valid: false, writeSet: [], error: validationError }
    }

    // Calculate the new entries (pure — does not mutate the input state).
    const newEntries = new Map(state.entries)

    // Delegate to the registered handler.
    const handler = this.handlers.get(transaction.payload.type)!
    handler.apply(transaction, newEntries)

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

  private computeWriteSet(oldEntries: ReadonlyMap<string, string>, newEntries: Map<string, string>): WriteSet {
    const writeSet: WriteSet = []
    const allKeys = new Set([...oldEntries.keys(), ...newEntries.keys()])

    for (const key of allKeys) {
      const oldValue = oldEntries.get(key)
      const newValue = newEntries.get(key)

      if (newValue === undefined && oldValue !== undefined) {
        writeSet.push({ op: 'delete', key })
      } else if (newValue !== undefined && oldValue !== newValue) {
        writeSet.push({ op: 'put', key, value: newValue })
      }
    }

    return writeSet
  }
}

/**
 * Compute a deterministic transaction ID from the transaction contents.
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
