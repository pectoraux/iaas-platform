// =============================================================================
// Kernel: Deterministic Transaction Executor (Phase 9B)
// =============================================================================
// A deterministic transaction executor that validates + executes transactions
// against the protocol state store.
//
// THE CRITICAL INVARIANT:
//   Given the same state + transaction, execution produces the same result.
//
// Phase 9B: The executor is now ASYNC (the state store is async). The
// commit is version-checked (optimistic concurrency). If another transaction
// committed first, the commit throws StaleVersionError and the result has
// success=false.
//
// Phase 9A reference state-transition protocol:
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
  ProtocolStateStore,
  ProtocolTransactionExecutor,
} from './types'
import { StaleVersionError } from './types'

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
 *
 * Optimistic concurrency:
 *   The executor reads the current state, stages changes, then commits with
 *   the expected version. If another transaction committed first, the commit
 *   throws StaleVersionError and the result has success=false.
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

  async execute(transaction: ProtocolTransaction): Promise<ProtocolExecutionResult> {
    // 1. Read the current state (async).
    const beforeState = await this.stateStore.getState()

    // 2. Validate the transaction.
    const validationError = this.validate(transaction, beforeState)

    if (validationError) {
      return {
        success: false,
        resultingState: beforeState,
        receipt: {
          transactionId: transaction.id,
          beforeStateHash: beforeState.hash,
          afterStateHash: beforeState.hash, // unchanged
          executedAt: transaction.submittedAt, // deterministic
          executor: 'deterministic-executor',
        },
        error: validationError,
      }
    }

    // 3. Apply the transaction to the staged state.
    this.applyTransaction(transaction, beforeState)

    // 4. Commit with optimistic concurrency (async, version-checked).
    try {
      const afterState = await this.stateStore.commit(beforeState.version)

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
    } catch (err) {
      // StaleVersionError — another transaction committed first.
      if (err instanceof StaleVersionError) {
        const currentState = await this.stateStore.getState()
        return {
          success: false,
          resultingState: currentState,
          receipt: {
            transactionId: transaction.id,
            beforeStateHash: beforeState.hash,
            afterStateHash: currentState.hash,
            executedAt: transaction.submittedAt,
            executor: 'deterministic-executor',
          },
          error: `Stale version: another transaction committed first (expected ${err.expectedVersion}, actual ${err.actualVersion})`,
        }
      }
      throw err
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

  private applyTransaction(transaction: ProtocolTransaction, state: ProtocolStateSnapshot): void {
    const sender = transaction.sender
    const nonceKey = `nonce:${sender}`

    switch (transaction.payload.type) {
      case 'transfer': {
        const { from, to, amount } = transaction.payload.data
        const fromKey = `balance:${from}`
        const toKey = `balance:${to}`
        const fromBalance = state.entries.get(fromKey)
        const toBalance = state.entries.get(toKey)
        const currentFrom = fromBalance ? parseFloat(fromBalance) : 0
        const currentTo = toBalance ? parseFloat(toBalance) : 0
        const transferAmount = parseFloat(amount as string)

        this.stateStore.put(fromKey, (currentFrom - transferAmount).toString())
        this.stateStore.put(toKey, (currentTo + transferAmount).toString())
        this.stateStore.put(nonceKey, (transaction.nonce + 1).toString())
        break
      }
      case 'mint': {
        const { to, amount } = transaction.payload.data
        const toKey = `balance:${to}`
        const toBalance = state.entries.get(toKey)
        const currentTo = toBalance ? parseFloat(toBalance) : 0
        const mintAmount = parseFloat(amount as string)

        this.stateStore.put(toKey, (currentTo + mintAmount).toString())
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
