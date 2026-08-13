// =============================================================================
// Settlement service.
//
// Lifecycle: created → submitted → processing → completed | failed | retrying.
// Uses idempotency keys: `reward-<reward_id>` so no duplicate reward can ever
// produce two external payouts.
//
// The PaymentsService interface is the ONLY dependency on the outside world.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, NotFoundError, PaymentError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { emit, DomainEventTypes } from '@/lib/domain/events'
import { paymentsService } from './payments.service'
import { ensureOperatorAccount, computeBalance } from './ledger.service'

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
}

/**
 * Create + submit a settlement for a posted reward. Idempotent on
 * (tenantId, idempotencyKey) where idempotencyKey = `reward-<reward_id>`.
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
      amount: existing.amount,
      currency: existing.currency,
      status: existing.status,
      provider: existing.provider,
      provider_payout_id: existing.providerPayoutId,
      duplicate: true,
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

  // Create the settlement instruction.
  const settlement = await db.settlement.create({
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

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.SettlementCreated,
    resourceType: 'settlement',
    resourceId: settlement.id,
    metadata: { rewardId: reward.id, amount: reward.amount, currency: reward.currency },
  })
  await emit({
    event_type: DomainEventTypes.SettlementRequested,
    aggregate_id: settlement.id,
    tenant_id: tenantId,
    version: 1,
    payload: { rewardId: reward.id, amount: reward.amount },
  })

  // Submit to the payments provider.
  await db.settlement.update({ where: { id: settlement.id }, data: { status: 'submitted' } })
  let payout
  try {
    payout = await paymentsService.create_payout({
      idempotency_key: idempotencyKey,
      recipient_ref: reward.operatorId,
      amount: reward.amount,
      currency: reward.currency,
      reference: `reward:${reward.id}`,
    })
  } catch (err) {
    await db.settlement.update({
      where: { id: settlement.id },
      data: { status: 'failed', failureReason: err instanceof Error ? err.message : 'payout failed' },
    })
    throw new PaymentError('Payout submission failed', { rewardId })
  }

  await db.settlement.update({
    where: { id: settlement.id },
    data: {
      status: payout.status === 'completed' ? 'completed' : payout.status,
      providerPayoutId: payout.provider_payout_id,
    },
  })

  // If completed: post the settlement debit to the ledger + mark reward settled.
  if (payout.status === 'completed') {
    await completeSettlementInternal(tenantId, settlement.id, reward.id, reward.operatorId, reward.amount, reward.currency, actorId)
  }

  const finalRow = await db.settlement.findUnique({ where: { id: settlement.id } })
  const final = finalRow!
  return {
    id: final.id,
    reward_id: final.rewardId,
    operator_id: final.operatorId,
    amount: final.amount,
    currency: final.currency,
    status: final.status,
    provider: final.provider,
    provider_payout_id: final.providerPayoutId,
    duplicate: false,
  }
}

/** Mark a settlement completed (called after webhook / reconcile). */
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
      amount: settlement.amount,
      currency: settlement.currency,
      status: settlement.status,
      provider: settlement.provider,
      provider_payout_id: settlement.providerPayoutId,
      duplicate: true,
    }
  }
  await completeSettlementInternal(tenantId, settlement.id, settlement.rewardId, settlement.operatorId, settlement.amount, settlement.currency, actorId)
  const finalRow = await db.settlement.findUnique({ where: { id: settlementId } })
  const final = finalRow!
  return {
    id: final.id,
    reward_id: final.rewardId,
    operator_id: final.operatorId,
    amount: final.amount,
    currency: final.currency,
    status: final.status,
    provider: final.provider,
    provider_payout_id: final.providerPayoutId,
    duplicate: false,
  }
}

async function completeSettlementInternal(
  tenantId: string,
  settlementId: string,
  rewardId: string,
  operatorId: string,
  amount: number,
  currency: string,
  actorId?: string,
) {
  const account = await ensureOperatorAccount(tenantId, operatorId, currency)
  // Post the settlement debit (money leaving the platform). Idempotent.
  const debitKey = `reward-${rewardId}:settlement_debit`
  const existing = await db.ledgerEntry.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: debitKey } },
  })
  if (!existing) {
    await db.ledgerEntry.create({
      data: {
        tenantId,
        accountId: account.id,
        amount: -amount,
        currency,
        entryType: 'settlement_debit',
        referenceType: 'settlement',
        referenceId: settlementId,
        idempotencyKey: debitKey,
      },
    })
  }
  await db.settlement.update({ where: { id: settlementId }, data: { status: 'completed' } })
  await db.reward.update({ where: { id: rewardId }, data: { status: 'settled' } })

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.SettlementCompleted,
    resourceType: 'settlement',
    resourceId: settlementId,
    metadata: { rewardId, amount, currency },
  })
  await emit({
    event_type: DomainEventTypes.SettlementCompleted,
    aggregate_id: settlementId,
    tenant_id: tenantId,
    version: 1,
    payload: { rewardId, amount, currency },
  })
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

export async function getSettlementByReward(tenantId: string, rewardId: string) {
  return db.settlement.findUnique({ where: { rewardId } }).then((s) => (s && s.tenantId === tenantId ? s : null))
}

export { computeBalance }
