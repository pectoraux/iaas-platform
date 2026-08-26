// =============================================================================
// Settlement service — OUTBOX/WORKER model (task 8).
//
// createSettlement() only:
//   1. Creates the settlement in CREATED state
//   2. Emits a domain event to the outbox
//   3. Returns immediately
//
// The actual payment provider call + ledger finalization happens in the worker
// (worker.service.ts → processSettlementOutbox). This closes the crash window
// between "provider says completed" and "database records completed".
//
// Lifecycle: created → (worker) → submitted → processing → completed | failed | retrying
// Idempotency keys: `reward-<reward_id>` — no duplicate reward can produce two payouts.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { emit, DomainEventTypes } from '@/lib/domain/events'
import { paymentsService } from './payments.service'
import { computeBalance, ensureOperatorAccount } from './ledger.service'

export interface SettlementResult {
  id: string
  reward_id: string
  operator_id: string
  amount: number
  currency: string
  status: string
  provider: string
  provider_payout_id: string | null
  duplicate: boolean
  message: string
}

/**
 * Create a settlement instruction. Does NOT call the payment provider — that
 * happens in the worker. Emits a domain event to the outbox for async processing.
 *
 * Idempotent on (tenantId, idempotencyKey) where idempotencyKey = `reward-<reward_id>`.
 */
export async function createSettlement(
  tenantId: string,
  rewardId: string,
  actorId?: string,
): Promise<SettlementResult> {
  const idempotencyKey = `reward-${rewardId}`

  // Idempotency
  const existing = await db.settlement.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
  })
  if (existing) {
    return {
      id: existing.id,
      reward_id: existing.rewardId,
      operator_id: existing.operatorId,
      amount: parseFloat(existing.amount.toString()), // WORK-006 (BASE-007): Prisma Decimal → number
      currency: existing.currency,
      status: existing.status,
      provider: existing.provider,
      provider_payout_id: existing.providerPayoutId,
      duplicate: true,
      message: `Settlement already exists (status: ${existing.status}). Call /api/internal/worker/process to advance.`,
    }
  }

  const reward = await db.reward.findFirst({
    where: { id: rewardId, tenantId },
    include: { contribution: true },
  })
  if (!reward) throw new NotFoundError('reward', rewardId)
  if (reward.status !== 'posted') {
    throw new ValidationError(`Reward ${rewardId} must be posted before settlement (current: ${reward.status})`)
  }

  // ATOMIC (task 1): create settlement + emit outbox in the SAME transaction.
  const settlement = await db.$transaction(async (tx) => {
    const created = await tx.settlement.create({
      data: {
        tenantId,
        rewardId: reward.id,
        operatorId: reward.operatorId,
        amount: reward.amount,
        currency: reward.currency,
        status: 'created',
        idempotencyKey,
        provider: paymentsService.provider,
      },
    })

    // Emit the outbox event IN THE SAME TRANSACTION (task 1).
    await emit(
      {
        event_type: DomainEventTypes.SettlementRequested,
        aggregate_id: created.id,
        tenant_id: tenantId,
        version: 1,
        payload: { rewardId: reward.id, amount: reward.amount.toString() },
      },
      tx,
    )

    return created
  })

  // Audit is best-effort (outside the transaction).
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.SettlementCreated,
    resourceType: 'settlement',
    resourceId: settlement.id,
    metadata: { rewardId: reward.id, amount: reward.amount.toString(), currency: reward.currency },
  })

  return {
    id: settlement.id,
    reward_id: settlement.rewardId,
    operator_id: settlement.operatorId,
    amount: parseFloat(settlement.amount.toString()), // WORK-006 (BASE-007): Prisma Decimal → number
    currency: settlement.currency,
    status: settlement.status,
    provider: settlement.provider,
    provider_payout_id: null,
    duplicate: false,
    message: 'Settlement created. Call /api/internal/worker/process to submit to payment provider.',
  }
}

/**
 * Manually confirm/settle a settlement (for testing or webhook reconciliation).
 * In normal flow, the worker handles this.
 */
export async function completeSettlement(
  tenantId: string,
  settlementId: string,
  actorId?: string,
): Promise<SettlementResult> {
  const settlement = await db.settlement.findFirst({ where: { id: settlementId, tenantId } })
  if (!settlement) throw new NotFoundError('settlement', settlementId)
  if (settlement.status === 'completed') {
    return {
      id: settlement.id,
      reward_id: settlement.rewardId,
      operator_id: settlement.operatorId,
      amount: parseFloat(settlement.amount.toString()), // WORK-006 (BASE-007): Prisma Decimal → number
      currency: settlement.currency,
      status: settlement.status,
      provider: settlement.provider,
      provider_payout_id: settlement.providerPayoutId,
      duplicate: true,
      message: 'Already completed',
    }
  }

  // Call the payment provider.
  const payout = await paymentsService.create_payout({
    idempotency_key: settlement.idempotencyKey!,
    recipient_ref: settlement.operatorId,
    amount: settlement.amount.toString(), // WORK-006 (BASE-007): Prisma Decimal → string (PayoutRequest.amount is string for precision)
    currency: settlement.currency,
    reference: `reward:${settlement.rewardId}`,
  })

  if (payout.status === 'completed') {
    // Post the settlement debit via the worker logic.
    const { processSettlementOutbox } = await import('./worker.service')
    await db.settlement.update({ where: { id: settlement.id }, data: { status: 'submitted' } })
    await processSettlementOutbox(tenantId)
  }

  const final = await db.settlement.findUnique({ where: { id: settlementId } })
  return {
    id: final!.id,
    reward_id: final!.rewardId,
    operator_id: final!.operatorId,
    amount: parseFloat(final!.amount.toString()), // WORK-006 (BASE-007): Prisma Decimal → number
    currency: final!.currency,
    status: final!.status,
    provider: final!.provider,
    provider_payout_id: final!.providerPayoutId,
    duplicate: false,
    message: `Settlement ${final!.status}`,
  }
}

export async function listSettlements(tenantId: string) {
  return db.settlement.findMany({
    where: { tenantId },
    include: { reward: { include: { contribution: true } }, operator: true },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getSettlement(tenantId: string, id: string) {
  const s = await db.settlement.findFirst({
    where: { id, tenantId },
    include: { reward: { include: { contribution: true } }, operator: true },
  })
  if (!s) throw new NotFoundError('settlement', id)
  return s
}

export { computeBalance, ensureOperatorAccount }
