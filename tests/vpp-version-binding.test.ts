/**
 * VPP-2C: NetworkVersion binding authorization tests.
 *
 * Verifies that createBuyerProgram rejects:
 *   1. cross-network version  (Network A program ← Network B version)
 *   2. cross-tenant version   (tenant X program ← tenant Y version)
 *   3. unpublished version    (policy can still mutate → unsafe to bind)
 *
 * This is the authorization/integrity boundary for the immutable policy
 * boundary established in VPP-2C. Because networkVersionId now controls
 * verification, baseline, reward rules, and contribution policy, a
 * misbinding here would let a program execute under another network's
 * (or tenant's) economic configuration.
 *
 * Run: bun test tests/vpp-version-binding.test.ts --timeout 60000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { createNetwork, createNetworkVersion, publishNetworkVersion } from '../src/lib/services/network.service'
import { createRewardRule } from '../src/lib/services/reward.service'
import { createBuyerProgram } from '../src/lib/services/vpp.service'
import { ValidationError } from '@/lib/domain/errors'

const config = {
  asset_types: ['battery'],
  capabilities: [{ type: 'energy_discharge', unit: 'kWh', schema_version: 1, fields: { power_kw: 'number', available_energy_kwh: 'number', state_of_charge_pct: 'number' } }],
  verification: { checks: ['device_signature', 'timestamp_window', 'replay_protection', 'schema_validation', 'numeric_range'], numeric_ranges: { power_kw: { min: 0, max: 1000 }, state_of_charge_pct: { min: 0, max: 100 } }, timestamp_window_seconds: 120 },
  reward: { type: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD', platform_fee_pct: 5 },
}

// Tenant A — primary tenant, owns Network A (versions A1, A2).
let tenantA: string
let networkA: string
let versionA1: string // published
let versionA2Unpublished: string
let rewardRuleA1: string

// Tenant B — separate tenant, owns Network B (version B1).
let tenantB: string
let networkB: string
let versionB1: string // published
let rewardRuleB1: string

beforeAll(async () => {
  // Tenant A + Network A.
  const tA = await createTenant({ name: 'Binding Tenant A', slug: `bind-a-${Date.now()}`, plan: 'growth' })
  tenantA = tA.id
  const nA = await createNetwork(tenantA, { name: 'Network A', slug: `net-a-${Date.now()}`, vertical: 'energy_vpp' })
  networkA = nA.id

  versionA1 = (await createNetworkVersion(tenantA, networkA, config)).id
  await createRewardRule(tenantA, { networkVersionId: versionA1, ruleType: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD' })
  await publishNetworkVersion(tenantA, networkA, versionA1)
  rewardRuleA1 = (await db.rewardRule.findFirst({ where: { networkVersionId: versionA1 } }))!.id

  // A2 — unpublished draft in the same network.
  versionA2Unpublished = (await createNetworkVersion(tenantA, networkA, config)).id

  // Tenant B + Network B (cross-tenant).
  const tB = await createTenant({ name: 'Binding Tenant B', slug: `bind-b-${Date.now()}`, plan: 'growth' })
  tenantB = tB.id
  const nB = await createNetwork(tenantB, { name: 'Network B', slug: `net-b-${Date.now()}`, vertical: 'energy_vpp' })
  networkB = nB.id
  versionB1 = (await createNetworkVersion(tenantB, networkB, config)).id
  await createRewardRule(tenantB, { networkVersionId: versionB1, ruleType: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD' })
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
    // versionB1 belongs to tenantB/networkB, but we try to bind it to tenantA/networkA.
    // We use tenantA's reward rule so the only failing check is the version binding.
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
    // tenantB tries to bind tenantA's versionA1 to its own networkB.
    // Even though the version exists, it does not belong to (tenantB, networkB).
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
    // versionA2Unpublished has no publishedAt — policy can still mutate.
    // An active program must not bind to a version whose policy is not frozen.
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
    // Sanity check: the default path still works and binds to the current published version.
    const program = await createBuyerProgram(tenantA, {
      networkId: networkA,
      name: `Default Version ${Date.now()}`,
      rewardRuleId: rewardRuleA1,
      dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
    })
    expect(program.networkVersionId).toBe(versionA1)
  })
})
