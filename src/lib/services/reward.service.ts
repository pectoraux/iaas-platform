// =============================================================================
// Reward service — configurable engine.
//
// Rule 3: Contribution is not payment.
// Rule 4: Reward calculation must not directly send money.
// Rule 7: Reward references the exact policy version used.
//
// Supported rule types: fixed_rate | revenue_share.
// Reward output is derived SERVER-SIDE from the contribution quantity + the
// versioned RewardRule attached to the network version. Never from client input.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/domain/errors'
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
  amount: number
  currency: string
  rule_version: number
  status: string
  duplicate: boolean
  // Breakdown for transparency
  calculation: {
    rule_type: string
    rate: string
    quantity: number
    unit: string
    platform_fee_pct: number
    platform_fee: number
    net_amount: number
  }
}

/**
 * Calculate a reward for a contribution. Idempotent on (tenantId, idempotencyKey).
 *
 * The reward amount is derived from:
 *   amount = quantity * rate   (fixed_rate)
 *   amount = quantity * rate   (revenue_share; rate is the share fraction)
 * minus platform_fee_pct.
 *
 * The reward does NOT move money. It only records an economic claim. The
 * ledger + settlement services handle movement.
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
      amount: existing.amount,
      currency: existing.currency,
      rule_version: existing.ruleVersion,
      status: existing.status,
      duplicate: true,
      calculation: {
        rule_type: rule?.ruleType ?? 'fixed_rate',
        rate: rule?.rate ?? '0',
        quantity: 0,
        unit: rule?.unit ?? '',
        platform_fee_pct: 0,
        platform_fee: 0,
        net_amount: existing.amount,
      },
    }
  }

  const contribution = await db.contribution.findFirst({
    where: { id: contributionId, tenantId },
    include: { networkVersion: true, operator: true },
  })
  if (!contribution) throw new NotFoundError('contribution', contributionId)

  // Resolve the reward rule for this network version.
  const rule = await db.rewardRule.findFirst({
    where: { tenantId, networkVersionId: contribution.networkVersionId },
    orderBy: { ruleVersion: 'desc' },
  })
  if (!rule) throw new NotFoundError('reward_rule', `for version ${contribution.networkVersionId}`)

  // Derive amount SERVER-SIDE.
  const rate = parseFloat(rule.rate)
  if (Number.isNaN(rate)) throw new ValidationError(`Invalid rate on rule ${rule.id}`)
  const gross = contribution.quantity * rate
  const config = JSON.parse(rule.configJson || '{}') as { platform_fee_pct?: number }
  const feePct = config.platform_fee_pct ?? 0
  const platformFee = gross * (feePct / 100)
  const net = gross - platformFee

  const reward = await db.reward.create({
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

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.RewardCreated,
    resourceType: 'reward',
    resourceId: reward.id,
    metadata: {
      contributionId,
      operatorId: contribution.operatorId,
      amount: net,
      currency: rule.currency,
      ruleVersion: rule.ruleVersion,
      gross,
      platformFee,
    },
  })
  await emit({
    event_type: DomainEventTypes.RewardCalculated,
    aggregate_id: reward.id,
    tenant_id: tenantId,
    version: 1,
    payload: { contributionId, amount: net, currency: rule.currency, ruleVersion: rule.ruleVersion },
  })

  return {
    id: reward.id,
    contribution_id: contributionId,
    operator_id: contribution.operatorId,
    amount: net,
    currency: rule.currency,
    rule_version: rule.ruleVersion,
    status: reward.status,
    duplicate: false,
    calculation: {
      rule_type: rule.ruleType,
      rate: rule.rate,
      quantity: contribution.quantity,
      unit: contribution.unit,
      platform_fee_pct: feePct,
      platform_fee: platformFee,
      net_amount: net,
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
