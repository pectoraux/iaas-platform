// =============================================================================
// Reward service — configurable engine with DECIMAL arithmetic (task 3).
//
// Rule 3: Contribution is not payment.
// Rule 4: Reward calculation must not directly send money.
// Rule 7: Reward references the exact policy version used.
//
// Task 3: all monetary calculations use Prisma.Decimal (exact, no float loss).
// Task 1: reward creation + outbox emit are atomic (same transaction).
// =============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { emit, DomainEventTypes } from '@/lib/domain/events'

export interface CreateRewardRuleInput {
  networkVersionId: string
  ruleType: 'fixed_rate' | 'revenue_share'
  rate: string
  unit: string
  currency?: string
  ruleVersion?: number
  config?: Record<string, unknown>
}

export async function createRewardRule(tenantId: string, input: CreateRewardRuleInput) {
  return db.rewardRule.create({
    data: {
      tenantId,
      networkVersionId: input.networkVersionId,
      ruleType: input.ruleType,
      rate: input.rate,
      unit: input.unit,
      currency: input.currency ?? 'USD',
      ruleVersion: input.ruleVersion ?? 1,
      configJson: JSON.stringify(input.config ?? {}),
    },
  })
}

export async function listRewardRules(tenantId: string) {
  return db.rewardRule.findMany({ where: { tenantId }, include: { networkVersion: true }, orderBy: { createdAt: 'desc' } })
}

export interface RewardResult {
  id: string
  contribution_id: string
  operator_id: string
  amount: string // Decimal as string for JSON safety
  currency: string
  rule_version: number
  status: string
  duplicate: boolean
  calculation: {
    rule_type: string
    rate: string
    quantity: string
    unit: string
    platform_fee_pct: number
    platform_fee: string
    net_amount: string
    gross: string
  }
}

/**
 * Calculate a reward for a contribution. Idempotent on (tenantId, idempotencyKey).
 *
 * Task 3: all arithmetic uses Prisma.Decimal (exact, no floating-point loss).
 * Task 1: reward creation + outbox emit are atomic.
 */
export async function calculateReward(
  tenantId: string,
  contributionId: string,
  idempotencyKey: string,
  actorId?: string,
): Promise<RewardResult> {
  // Idempotency
  const existing = await db.reward.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
  })
  if (existing) {
    const rule = await db.rewardRule.findUnique({ where: { id: existing.ruleId } })
    return {
      id: existing.id,
      contribution_id: existing.contributionId,
      operator_id: existing.operatorId,
      amount: existing.amount.toString(),
      currency: existing.currency,
      rule_version: existing.ruleVersion,
      status: existing.status,
      duplicate: true,
      calculation: {
        rule_type: rule?.ruleType ?? 'fixed_rate',
        rate: rule?.rate ?? '0',
        quantity: '0',
        unit: rule?.unit ?? '',
        platform_fee_pct: 0,
        platform_fee: '0',
        net_amount: existing.amount.toString(),
        gross: '0',
      },
    }
  }

  const contribution = await db.contribution.findFirst({
    where: { id: contributionId, tenantId },
    include: { networkVersion: true, operator: true },
  })
  if (!contribution) throw new NotFoundError('contribution', contributionId)

  const rule = await db.rewardRule.findFirst({
    where: { tenantId, networkVersionId: contribution.networkVersionId },
    orderBy: { ruleVersion: 'desc' },
  })
  if (!rule) throw new NotFoundError('reward_rule', `for version ${contribution.networkVersionId}`)

  // Task 3: Decimal arithmetic — no floating-point loss.
  const rate = new Prisma.Decimal(rule.rate)
  if (rate.isNaN()) throw new ValidationError(`Invalid rate on rule ${rule.id}`)
  const gross = new Prisma.Decimal(contribution.quantity).times(rate)
  const config = JSON.parse(rule.configJson || '{}') as { platform_fee_pct?: number }
  const feePct = config.platform_fee_pct ?? 0
  const platformFee = gross.times(feePct).div(100)
  const net = gross.minus(platformFee)

  // Task 1: atomic reward creation + outbox emit.
  const reward = await db.$transaction(async (tx) => {
    const created = await tx.reward.create({
      data: {
        tenantId,
        contributionId,
        operatorId: contribution.operatorId,
        amount: net,
        currency: rule.currency,
        ruleVersion: rule.ruleVersion,
        ruleId: rule.id,
        status: 'calculated',
        idempotencyKey,
      },
    })

    await emit(
      {
        event_type: DomainEventTypes.RewardCalculated,
        aggregate_id: created.id,
        tenant_id: tenantId,
        version: 1,
        payload: { contributionId, amount: net.toString(), currency: rule.currency, ruleVersion: rule.ruleVersion },
      },
      tx,
    )

    return created
  })

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.RewardCreated,
    resourceType: 'reward',
    resourceId: reward.id,
    metadata: {
      contributionId,
      operatorId: contribution.operatorId,
      amount: net.toString(),
      currency: rule.currency,
      ruleVersion: rule.ruleVersion,
      gross: gross.toString(),
      platformFee: platformFee.toString(),
    },
  })

  return {
    id: reward.id,
    contribution_id: contributionId,
    operator_id: contribution.operatorId,
    amount: net.toString(),
    currency: rule.currency,
    rule_version: rule.ruleVersion,
    status: reward.status,
    duplicate: false,
    calculation: {
      rule_type: rule.ruleType,
      rate: rule.rate,
      quantity: contribution.quantity.toString(),
      unit: contribution.unit,
      platform_fee_pct: feePct,
      platform_fee: platformFee.toString(),
      net_amount: net.toString(),
      gross: gross.toString(),
    },
  }
}

export async function listRewards(tenantId: string) {
  return db.reward.findMany({
    where: { tenantId },
    include: { contribution: true, operator: true, rule: true, settlement: true },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getReward(tenantId: string, id: string) {
  const r = await db.reward.findFirst({
    where: { id, tenantId },
    include: { contribution: true, operator: true, rule: true, settlement: true },
  })
  if (!r) throw new NotFoundError('reward', id)
  return r
}
