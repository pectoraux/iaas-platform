/**
 * VPP-2C: NetworkVersion binding authorization + policy-closure tests.
 *
 * Verifies that createBuyerProgram rejects:
 *   1. cross-network version      (Network A program ← Network B version)
 *   2. cross-tenant version       (tenant X program ← tenant Y version)
 *   3. unpublished version        (policy can still mutate → unsafe to bind)
 *   4. non-existent version id
 *   5. reward rule from a DIFFERENT version (V12 program ← V13 reward rule)
 *   6. published VPP version without an accepted baseline policy
 *
 * This is the authorization/integrity boundary for the immutable policy
 * boundary established in VPP-2C. Because networkVersionId now controls
 * verification, baseline, reward rules, and contribution policy, a
 * misbinding here would let a program execute under another network's
 * (or tenant's, or version's) economic configuration.
 *
 * The architectural invariant enforced here is "version-closed":
 *   program.networkVersionId    = N
 *   rewardRule.networkVersionId = N
 *   baseline policy             = N's accepted policy
 *
 * Run: bun test tests/vpp-version-binding.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { createNetwork, createNetworkVersion, publishNetworkVersion } from '../src/lib/services/network.service'
import { createRewardRule } from '../src/lib/services/reward.service'
import { runAndPersistBaselineEvaluation } from '../src/lib/services/baseline-evaluation.service'
import { createBuyerProgram } from '../src/lib/services/vpp.service'
import { ValidationError } from '@/lib/domain/errors'

const config = {
  asset_types: ['battery'],
  capabilities: [{ type: 'energy_discharge', unit: 'kWh', schema_version: 1, fields: { power_kw: 'number', available_energy_kwh: 'number', state_of_charge_pct: 'number' } }],
  verification: { checks: ['device_signature', 'timestamp_window', 'replay_protection', 'schema_validation', 'numeric_range'], numeric_ranges: { power_kw: { min: 0, max: 1000 }, state_of_charge_pct: { min: 0, max: 100 } }, timestamp_window_seconds: 120 },
  reward: { type: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD', platform_fee_pct: 5 },
}

// Tenant A — primary tenant, owns Network A (versions A1, A2, A3).
let tenantA: string
let networkA: string
let versionA1: string // published, with accepted baseline policy
let versionA2Unpublished: string
let versionA3: string // published, with accepted baseline policy (different from A1)
let rewardRuleA1: string
let rewardRuleA3: string

// Tenant B — separate tenant, owns Network B (version B1).
let tenantB: string
let networkB: string
let versionB1: string // published, with accepted baseline policy
let rewardRuleB1: string

// A network with a published version that has NO baseline policy — used to
// verify the strict-baseline rule rejects program creation.
let networkNoPolicy: string
let versionNoPolicy: string // published, baselinePolicyJson = null

// A network with a published version whose baseline policy status is
// 'no_acceptable_strategy' — used to verify rejection of non-accepted policies.
let networkNoAcceptable: string
let versionNoAcceptable: string
let rewardRuleNoAcceptable: string

beforeAll(async () => {
  // Tenant A + Network A.
  const tA = await createTenant({ name: 'Binding Tenant A', slug: `bind-a-${Date.now()}`, plan: 'growth' })
  tenantA = tA.id
  const nA = await createNetwork(tenantA, { name: 'Network A', slug: `net-a-${Date.now()}`, vertical: 'energy_vpp' })
  networkA = nA.id

  versionA1 = (await createNetworkVersion(tenantA, networkA, config)).id
  await createRewardRule(tenantA, { networkVersionId: versionA1, ruleType: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD' })
  // Strict-baseline rule: A1 must have an accepted baseline policy before any
  // program can bind to it.
  await runAndPersistBaselineEvaluation({ tenantId: tenantA, networkVersionId: versionA1, numScenarios: 50 })
  await publishNetworkVersion(tenantA, networkA, versionA1)
  rewardRuleA1 = (await db.rewardRule.findFirst({ where: { networkVersionId: versionA1 } }))!.id

  // A2 — unpublished draft in the same network.
  versionA2Unpublished = (await createNetworkVersion(tenantA, networkA, config)).id

  // A3 — second published version with its own baseline policy + reward rule.
  // Used to test reward-rule cross-version rejection (V12 program ← V13 rule).
  versionA3 = (await createNetworkVersion(tenantA, networkA, config)).id
  await createRewardRule(tenantA, { networkVersionId: versionA3, ruleType: 'fixed_rate', rate: '0.10', unit: 'kWh', currency: 'USD' })
  await runAndPersistBaselineEvaluation({ tenantId: tenantA, networkVersionId: versionA3, numScenarios: 50 })
  await publishNetworkVersion(tenantA, networkA, versionA3)
  rewardRuleA3 = (await db.rewardRule.findFirst({ where: { networkVersionId: versionA3 } }))!.id

  // Tenant B + Network B (cross-tenant).
  const tB = await createTenant({ name: 'Binding Tenant B', slug: `bind-b-${Date.now()}`, plan: 'growth' })
  tenantB = tB.id
  const nB = await createNetwork(tenantB, { name: 'Network B', slug: `net-b-${Date.now()}`, vertical: 'energy_vpp' })
  networkB = nB.id
  versionB1 = (await createNetworkVersion(tenantB, networkB, config)).id
  await createRewardRule(tenantB, { networkVersionId: versionB1, ruleType: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD' })
  await runAndPersistBaselineEvaluation({ tenantId: tenantB, networkVersionId: versionB1, numScenarios: 50 })
  await publishNetworkVersion(tenantB, networkB, versionB1)
  rewardRuleB1 = (await db.rewardRule.findFirst({ where: { networkVersionId: versionB1 } }))!.id

  // Network with a published version but NO baseline policy.
  const nNoPolicy = await createNetwork(tenantA, { name: 'No-Policy Network', slug: `net-nopolicy-${Date.now()}`, vertical: 'energy_vpp' })
  networkNoPolicy = nNoPolicy.id
  versionNoPolicy = (await createNetworkVersion(tenantA, networkNoPolicy, config)).id
  await createRewardRule(tenantA, { networkVersionId: versionNoPolicy, ruleType: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD' })
  // Deliberately do NOT run runAndPersistBaselineEvaluation.
  await publishNetworkVersion(tenantA, networkNoPolicy, versionNoPolicy)

  // Network with a published version whose baseline policy status is
  // 'no_acceptable_strategy' (simulated by manually setting the policy JSON).
  const nNoAcc = await createNetwork(tenantA, { name: 'No-Acceptable Network', slug: `net-noacc-${Date.now()}`, vertical: 'energy_vpp' })
  networkNoAcceptable = nNoAcc.id
  versionNoAcceptable = (await createNetworkVersion(tenantA, networkNoAcceptable, config)).id
  await createRewardRule(tenantA, { networkVersionId: versionNoAcceptable, ruleType: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD' })
  // Set a no_acceptable_strategy policy before publishing (allowed on unpublished versions).
  await db.networkVersion.update({
    where: { id: versionNoAcceptable },
    data: {
      baselinePolicyJson: JSON.stringify({
        selectedStrategy: null,
        evaluationId: 'manual-no-acceptable',
        evaluatedAt: new Date().toISOString(),
        criteria: {},
        metrics: {},
        status: 'no_acceptable_strategy',
      }),
    },
  })
  await publishNetworkVersion(tenantA, networkNoAcceptable, versionNoAcceptable)
  rewardRuleNoAcceptable = (await db.rewardRule.findFirst({ where: { networkVersionId: versionNoAcceptable } }))!.id
})

describe('VPP-2C: createBuyerProgram networkVersionId authorization', () => {
  it('accepts a published version that belongs to the same network + tenant', async () => {
    const program = await createBuyerProgram(tenantA, {
      networkId: networkA,
      networkVersionId: versionA1,
      name: `Valid Program ${Date.now()}`,
      rewardRuleId: rewardRuleA1,
      dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
    })
    expect(program.networkVersionId).toBe(versionA1)
    expect(program.networkId).toBe(networkA)
    expect(program.tenantId).toBe(tenantA)
  })

  it('rejects a cross-network version (Network A program ← Network B version)', async () => {
    await expect(
      createBuyerProgram(tenantA, {
        networkId: networkA,
        networkVersionId: versionB1,
        name: `Cross-Net ${Date.now()}`,
        rewardRuleId: rewardRuleA1,
        dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('rejects a cross-tenant version (tenant X program ← tenant Y version)', async () => {
    await expect(
      createBuyerProgram(tenantB, {
        networkId: networkB,
        networkVersionId: versionA1,
        name: `Cross-Tenant ${Date.now()}`,
        rewardRuleId: rewardRuleB1,
        dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('rejects an unpublished version for an active program', async () => {
    await expect(
      createBuyerProgram(tenantA, {
        networkId: networkA,
        networkVersionId: versionA2Unpublished,
        name: `Unpublished ${Date.now()}`,
        rewardRuleId: rewardRuleA1,
        dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('rejects a non-existent version id', async () => {
    await expect(
      createBuyerProgram(tenantA, {
        networkId: networkA,
        networkVersionId: 'cls_nonexistent_version_xyz',
        name: `Ghost ${Date.now()}`,
        rewardRuleId: rewardRuleA1,
        dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('defaults to network.currentVersionId when no explicit version is supplied', async () => {
    // Note: networkA's current version is now A3 (last published). A3 has an
    // accepted baseline policy + rewardRuleA3, so this must succeed.
    const program = await createBuyerProgram(tenantA, {
      networkId: networkA,
      name: `Default Version ${Date.now()}`,
      rewardRuleId: rewardRuleA3,
      dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
    })
    expect(program.networkVersionId).toBe(versionA3)
  })
})

describe('VPP-2C: reward rule must be version-closed with the program', () => {
  it('accepts a reward rule that belongs to the same NetworkVersion', async () => {
    const program = await createBuyerProgram(tenantA, {
      networkId: networkA,
      networkVersionId: versionA1,
      name: `V1 Rule ${Date.now()}`,
      rewardRuleId: rewardRuleA1,
      dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
    })
    expect(program.rewardRuleId).toBe(rewardRuleA1)
    expect(program.networkVersionId).toBe(versionA1)
  })

  it('rejects a reward rule from a DIFFERENT NetworkVersion (V12 program ← V13 rule)', async () => {
    // versionA1 program with versionA3's reward rule — both belong to the
    // same tenant + network, but different versions. This must be rejected
    // because the reward rule directly determines economic settlement.
    await expect(
      createBuyerProgram(tenantA, {
        networkId: networkA,
        networkVersionId: versionA1,
        name: `Mismatched Rule ${Date.now()}`,
        rewardRuleId: rewardRuleA3, // ← V13's rule on a V12 program
        dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('rejects a reward rule from a different tenant (even if version matches)', async () => {
    // tenantB's rewardRuleB1 on tenantA's program — rejected by tenant
    // scoping, surfaced as a version-closure violation.
    await expect(
      createBuyerProgram(tenantA, {
        networkId: networkA,
        networkVersionId: versionA1,
        name: `Cross-Tenant Rule ${Date.now()}`,
        rewardRuleId: rewardRuleB1,
        dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
      }),
    ).rejects.toThrow(ValidationError)
  })
})

describe('VPP-2C: strict baseline policy (no hardcoded fallback)', () => {
  it('rejects a program bound to a published version with NO baseline policy', async () => {
    // versionNoPolicy is published but has baselinePolicyJson = null.
    // Previously this would silently fall back to 'weekday_weekend_average'.
    // Now it must be rejected at program creation.
    await expect(
      createBuyerProgram(tenantA, {
        networkId: networkNoPolicy,
        networkVersionId: versionNoPolicy,
        name: `No Policy ${Date.now()}`,
        rewardRuleId: (await db.rewardRule.findFirst({ where: { networkVersionId: versionNoPolicy } }))!.id,
        dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('rejects a program bound to a version with a no_acceptable_strategy policy', async () => {
    // versionNoAcceptable has a persisted policy but status='no_acceptable_strategy'.
    // This must be rejected — no accepted strategy means no valid settlement.
    await expect(
      createBuyerProgram(tenantA, {
        networkId: networkNoAcceptable,
        networkVersionId: versionNoAcceptable,
        name: `No Acceptable ${Date.now()}`,
        rewardRuleId: rewardRuleNoAcceptable,
        dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('accepts a program bound to a version with an accepted baseline policy', async () => {
    // versionA3 has an accepted baseline policy (from runAndPersistBaselineEvaluation).
    // This is the happy path — program creation succeeds.
    const program = await createBuyerProgram(tenantA, {
      networkId: networkA,
      networkVersionId: versionA3,
      name: `Accepted Policy ${Date.now()}`,
      rewardRuleId: rewardRuleA3,
      dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
    })
    expect(program.networkVersionId).toBe(versionA3)
    expect(program.status).toBe('active')
  })
})
