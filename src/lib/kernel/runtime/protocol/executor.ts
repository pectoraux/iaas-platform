// =============================================================================
// Kernel: Deterministic Transaction Executor (Phase 9A)
// =============================================================================
// A deterministic transaction executor that validates + executes transactions
// against the protocol state store.
//
// THE CRITICAL INVARIANT:
//   Given the same state + transaction, execution produces the same result.
//
// Phase 9A implements a minimal reference state-transition protocol:
//   - 'transfer' transactions move a balance from one account to another
//   - 'mint' transactions create balance (for testing/initialization)
//   - State keys: 'balance:<account>' → string (decimal)
//
// This is deliberately tiny — no UTXO, no EVM, no gas, no slashing.
// The point is to prove deterministic execution against a versioned state.
// =============================================================================

import { createHash } from 'crypto'
import type {
  ProtocolTransaction,
  ProtocolExecutionResult,
  ProtocolReceipt,
  ProtocolStateSnapshot,
  ProtocolStateStore,
  ProtocolTransactionExecutor,
} from './types'

/**
 * Error thrown when a transaction fails validation.
 */
export class ProtocolValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolValidationError'
  }
}

/**
 * A deterministic transaction executor for the reference state-transition
 * protocol.
 *
 * Supports:
 *   - 'transfer': move balance from sender to recipient
 *   - 'mint': create balance (testing only — would require governance in production)
 *
 * Validation rules:
 *   - Signature must be non-empty (simplified — real implementation would verify)
 *   - Nonce must match the expected nonce for the sender
 *   - 'transfer': sender must have sufficient balance
 *
 * Determinism:
 *   The executor does NOT use Date.now() or Math.random() during execution.
 *   The receipt's executedAt is set from the transaction's submittedAt
 *   (not the current time) to ensure determinism.
 */
export class DeterministicTransactionExecutor implements ProtocolTransactionExecutor {
  private readonly stateStore: ProtocolStateStore

  constructor(stateStore: ProtocolStateStore) {
    this.stateStore = stateStore
  }

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
      default:
        return `Unknown transaction type: ${transaction.payload.type}`
    }
  }

  execute(transaction: ProtocolTransaction): ProtocolExecutionResult {
    const beforeState = this.stateStore.getState()
    const validationError = this.validate(transaction, beforeState)

    if (validationError) {
      return {
        success: false,
        resultingState: beforeState,
        receipt: {
          transactionId: transaction.id,
          beforeStateHash: beforeState.hash,
          afterStateHash: beforeState.hash, // unchanged
          executedAt: transaction.submittedAt, // deterministic — not Date.now()
          executor: 'deterministic-executor',
        },
        error: validationError,
      }
    }

    // Apply the transaction to the staged state.
    this.applyTransaction(transaction)

    // Commit the staged changes.
    const afterState = this.stateStore.commit()

    const receipt: ProtocolReceipt = {
      transactionId: transaction.id,
      beforeStateHash: beforeState.hash,
      afterStateHash: afterState.hash,
      executedAt: transaction.submittedAt, // deterministic
      executor: 'deterministic-executor',
    }

    return {
      success: true,
      resultingState: afterState,
      receipt,
    }
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

  private applyTransaction(transaction: ProtocolTransaction): void {
    const sender = transaction.sender
    const nonceKey = `nonce:${sender}`

    switch (transaction.payload.type) {
      case 'transfer': {
        const { from, to, amount } = transaction.payload.data
        const fromKey = `balance:${from}`
        const toKey = `balance:${to}`
        const fromBalance = parseFloat(this.stateStore.get(fromKey) ?? '0')
        const toBalance = parseFloat(this.stateStore.get(toKey) ?? '0')
        const transferAmount = parseFloat(amount as string)

        this.stateStore.put(fromKey, (fromBalance - transferAmount).toString())
        this.stateStore.put(toKey, (toBalance + transferAmount).toString())
        this.stateStore.put(nonceKey, (transaction.nonce + 1).toString())
        break
      }
      case 'mint': {
        const { to, amount } = transaction.payload.data
        const toKey = `balance:${to}`
        const toBalance = parseFloat(this.stateStore.get(toKey) ?? '0')
        const mintAmount = parseFloat(amount as string)

        this.stateStore.put(toKey, (toBalance + mintAmount).toString())
        this.stateStore.put(nonceKey, (transaction.nonce + 1).toString())
        break
      }
    }
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
