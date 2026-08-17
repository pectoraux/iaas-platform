// =============================================================================
// Bootstrap: Protocol Transaction Handlers (Phase 10 final closure)
// =============================================================================
// Concrete transaction handlers registered by the application bootstrap.
//
// Phase 10 final closure: These handlers live OUTSIDE the kernel protocol
// executor module. The kernel executor (executor.ts) is vertical-neutral —
// it contains NO domain-specific transaction types. The handlers are
// application-layer implementations of the TransactionHandler contract.
//
// A new vertical adds its own handlers here (or in its own module) and
// registers them via the bootstrap. The kernel executor source is NEVER
// modified for a new vertical.
// =============================================================================

import type {
  ProtocolTransaction,
  ProtocolStateSnapshot,
  TransactionHandler,
} from '@/lib/kernel/runtime/protocol/types'

// ---------------------------------------------------------------------------
// TransferHandler — moves balance from one account to another
// ---------------------------------------------------------------------------

export class TransferHandler implements TransactionHandler {
  validate(transaction: ProtocolTransaction, state: ProtocolStateSnapshot): string | null {
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

  apply(transaction: ProtocolTransaction, entries: Map<string, string>): void {
    const { from, to, amount } = transaction.payload.data
    const fromKey = `balance:${from}`
    const toKey = `balance:${to}`
    const nonceKey = `nonce:${transaction.sender}`
    const fromBalance = entries.get(fromKey)
    const toBalance = entries.get(toKey)
    const currentFrom = fromBalance ? parseFloat(fromBalance) : 0
    const currentTo = toBalance ? parseFloat(toBalance) : 0
    const transferAmount = parseFloat(amount as string)

    entries.set(fromKey, (currentFrom - transferAmount).toString())
    entries.set(toKey, (currentTo + transferAmount).toString())
    entries.set(nonceKey, (transaction.nonce + 1).toString())
  }
}

// ---------------------------------------------------------------------------
// MintHandler — creates balance (testing only)
// ---------------------------------------------------------------------------

export class MintHandler implements TransactionHandler {
  validate(transaction: ProtocolTransaction, _state: ProtocolStateSnapshot): string | null {
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

  apply(transaction: ProtocolTransaction, entries: Map<string, string>): void {
    const { to, amount } = transaction.payload.data
    const toKey = `balance:${to}`
    const nonceKey = `nonce:${transaction.sender}`
    const toBalance = entries.get(toKey)
    const currentTo = toBalance ? parseFloat(toBalance) : 0
    const mintAmount = parseFloat(amount as string)

    entries.set(toKey, (currentTo + mintAmount).toString())
    entries.set(nonceKey, (transaction.nonce + 1).toString())
  }
}

// ---------------------------------------------------------------------------
// RecordDeliveryHandler — records infrastructure execution results as
// protocol state (from the HybridBridge)
// ---------------------------------------------------------------------------

export class RecordDeliveryHandler implements TransactionHandler {
  validate(transaction: ProtocolTransaction, _state: ProtocolStateSnapshot): string | null {
    const { quantity, unit } = transaction.payload.data
    if (quantity === undefined || unit === undefined) {
      return 'record_delivery requires quantity and unit'
    }
    return null
  }

  apply(transaction: ProtocolTransaction, entries: Map<string, string>): void {
    const { quantity, unit } = transaction.payload.data
    const deliveryKey = `delivery:${transaction.sender}`
    const nonceKey = `nonce:${transaction.sender}`
    const currentDelivery = entries.get(deliveryKey)
    const currentAmount = currentDelivery ? parseFloat(currentDelivery) : 0
    const deliveryAmount = parseFloat(quantity as string)

    entries.set(deliveryKey, (currentAmount + deliveryAmount).toString())
    entries.set(`delivery_unit:${transaction.sender}`, unit as string)
    entries.set(nonceKey, (transaction.nonce + 1).toString())
  }
}
