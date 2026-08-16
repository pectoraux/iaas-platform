/**
 * VPP-2C: NetworkVersion binding authorization + publication-readiness tests.
 *
 * Verifies four layers of the version-closed policy boundary:
 *
 *   1. networkVersionId authorization (createBuyerProgram):
 *        - cross-network version rejected
 *        - cross-tenant version rejected
 *        - unpublished version rejected
 *        - non-existent version rejected
 *        - default current version accepted
 *
 *   2. reward rule version-closure (createBuyerProgram):
 *        - same-version reward rule accepted
 *        - cross-version reward rule rejected (V12 program ← V13 rule)
 *        - cross-tenant reward rule rejected
 *
 *   3. publication-readiness gate (publishNetworkVersion) — the immutable-
 *      version boundary. This is the most important layer because after
 *      publication the version becomes an immutable policy artifact.
 *        - energy_vpp draft with NO baseline policy → publication rejected
 *        - energy_vpp draft with no_acceptable_strategy → publication rejected
 *        - energy_vpp draft with accepted baseline policy → publication succeeds
 *        - instantiateTemplate (which runs eval before publish) still works
 *
 *   4. program-level baseline guard (createBuyerProgram) — defense-in-depth
 *      for any version that somehow lacks an accepted policy.
 *
 * Architectural invariant enforced:
 *   Every VPP program must be version-closed:
 *     program.networkVersionId    = N
 *     rewardRule.networkVersionId = N
 *     baseline policy             = N's accepted policy
 *   AND every published energy_vpp NetworkVersion N must have an accepted
 *   baseline policy — enforced at the publication boundary itself.
 *
 * Run: bun test tests/vpp-version-binding.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import {
  createNetwork,
  createNetworkVersion,
  publishNetworkVersion,
  instantiateTemplate,
} from '../src/lib/services/network.service'
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

beforeAll(async () => {
  // Tenant A + Network A.
  const tA = await createTenant({ name: 'Binding Tenant A', slug: `bind-a-${Date.now()}`, plan: 'growth' })
  tenantA = tA.id
  const nA = await createNetwork(tenantA, { name: 'Network A', slug: `net-a-${Date.now()}`, vertical: 'energy_vpp' })
  networkA = nA.id

  versionA1 = (await createNetworkVersion(tenantA, networkA, config)).id
  await createRewardRule(tenantA, { networkVersionId: versionA1, ruleType: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD' })
  // Strict-baseline rule: A1 must have an accepted baseline policy before it
  // can be published (enforced by publishNetworkVersion).
  await runAndPersistBaselineEvaluation({ tenantId: tenantA, networkVersionId: versionA1, numScenarios: 50 })
  await publishNetworkVersion(tenantA, networkA, versionA1)
  rewardRuleA1 = (await db.rewardRule.findFirst({ where: { networkVersionId: versionA1 } }))!.id

  // A2 — unpublished draft in the same network (no baseline policy).
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

describe('VPP-2C: publication-readiness gate (publishNetworkVersion)', () => {
  // This is the immutable-version boundary — the most important defense layer.
  // After publication the version becomes an immutable policy artifact, so the
  // baseline invariant MUST be enforced here, not just at program creation.

  it('rejects publication of an energy_vpp version with NO baseline policy', async () => {
    // Create a draft energy_vpp version without running baseline evaluation.
    const net = await createNetwork(tenantA, {
      name: `Pub-Gate No-Policy ${Date.now()}`,
      slug: `pubgate-nopolicy-${Date.now()}`,
      vertical: 'energy_vpp',
    })
    const draft = await createNetworkVersion(tenantA, net.id, config)
    await createRewardRule(tenantA, { networkVersionId: draft.id, ruleType: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD' })
    // Deliberately do NOT run runAndPersistBaselineEvaluation.

    // Publication must be rejected — the version has no baselinePolicyJson.
    await expect(
      publishNetworkVersion(tenantA, net.id, draft.id),
    ).rejects.toThrow(ValidationError)

    // The version must remain unpublished (no partial state).
    const stillDraft = await db.networkVersion.findUnique({ where: { id: draft.id } })
    expect(stillDraft?.publishedAt).toBeNull()
    // And the network must NOT point to it as current.
    const netCheck = await db.networkDefinition.findUnique({ where: { id: net.id } })
    expect(netCheck?.currentVersionId).toBeNull()
  })

  it('rejects publication of an energy_vpp version with a no_acceptable_strategy policy', async () => {
    const net = await createNetwork(tenantA, {
      name: `Pub-Gate No-Acc ${Date.now()}`,
      slug: `pubgate-noacc-${Date.now()}`,
      vertical: 'energy_vpp',
    })
    const draft = await createNetworkVersion(tenantA, net.id, config)
    await createRewardRule(tenantA, { networkVersionId: draft.id, ruleType: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD' })

    // Set a no_acceptable_strategy policy on the unpublished draft (allowed
    // on unpublished versions — it's just data).
    await db.networkVersion.update({
      where: { id: draft.id },
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

    // Publication must be rejected — status != 'accepted'.
    await expect(
      publishNetworkVersion(tenantA, net.id, draft.id),
    ).rejects.toThrow(ValidationError)

    const stillDraft = await db.networkVersion.findUnique({ where: { id: draft.id } })
    expect(stillDraft?.publishedAt).toBeNull()
  })

  it('accepts publication of an energy_vpp version with an accepted baseline policy', async () => {
    const net = await createNetwork(tenantA, {
      name: `Pub-Gate Accepted ${Date.now()}`,
      slug: `pubgate-accepted-${Date.now()}`,
      vertical: 'energy_vpp',
    })
    const draft = await createNetworkVersion(tenantA, net.id, config)
    await createRewardRule(tenantA, { networkVersionId: draft.id, ruleType: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD' })
    await runAndPersistBaselineEvaluation({ tenantId: tenantA, networkVersionId: draft.id, numScenarios: 50 })

    // Publication must succeed — the version has an accepted baseline policy.
    const published = await publishNetworkVersion(tenantA, net.id, draft.id)
    expect(published?.publishedAt).toBeTruthy()

    // The network must now point to it as current.
    const netCheck = await db.networkDefinition.findUnique({ where: { id: net.id } })
    expect(netCheck?.currentVersionId).toBe(draft.id)
  })

  it('instantiateTemplate still works (runs eval before publish internally)', async () => {
    // instantiateTemplate must continue to produce a usable published
    // energy_vpp version — it runs baseline evaluation before publishing.
    const slug = `inst-${Date.now()}`
    const { network, version } = await instantiateTemplate(tenantA, 'energy-vpp', { slug })
    expect(version?.publishedAt).toBeTruthy()

    // The published version must have an accepted baseline policy.
    const v = await db.networkVersion.findUnique({ where: { id: version!.id } })
    expect(v?.baselinePolicyJson).toBeTruthy()
    const policy = JSON.parse(v!.baselinePolicyJson!)
    expect(policy.status).toBe('accepted')
    expect(policy.selectedStrategy).toBeTruthy()

    // And the network must be active with this version as current.
    const netCheck = await db.networkDefinition.findUnique({ where: { id: network.id } })
    expect(netCheck?.currentVersionId).toBe(version!.id)
  })
})

describe('VPP-2C: program-level baseline guard (defense-in-depth)', () => {
  // Even though publishNetworkVersion now prevents a published energy_vpp
  // version from lacking an accepted baseline policy, createBuyerProgram
  // still independently checks. This is defense-in-depth: if a version is
  // ever published without a policy (e.g. via direct DB access, or a future
  // migration), program creation still rejects it.

  it('createBuyerProgram requires an accepted baseline policy on the bound version', async () => {
    // Manually create a published version with no baseline policy by
    // bypassing the service layer (simulating a DB-level migration or tamper).
    const net = await createNetwork(tenantA, {
      name: `DB-Tamper ${Date.now()}`,
      slug: `dbtamper-${Date.now()}`,
      vertical: 'energy_vpp',
    })
    const draft = await createNetworkVersion(tenantA, net.id, config)
    await createRewardRule(tenantA, { networkVersionId: draft.id, ruleType: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD' })
    // Bypass publishNetworkVersion — directly set publishedAt + currentVersionId.
    await db.$transaction(async (tx) => {
      await tx.networkVersion.update({ where: { id: draft.id }, data: { publishedAt: new Date() } })
      await tx.networkDefinition.update({ where: { id: net.id }, data: { status: 'active', currentVersionId: draft.id } })
    })

    const rule = (await db.rewardRule.findFirst({ where: { networkVersionId: draft.id } }))!

    // createBuyerProgram must STILL reject — the version has no baseline policy.
    await expect(
      createBuyerProgram(tenantA, {
        networkId: net.id,
        networkVersionId: draft.id,
        name: `DB-Tamper Program ${Date.now()}`,
        rewardRuleId: rule.id,
        dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('createBuyerProgram accepts a version with an accepted baseline policy', async () => {
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
