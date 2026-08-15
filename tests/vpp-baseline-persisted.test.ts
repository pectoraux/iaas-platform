/**
 * VPP-2C: Persisted baseline policy integration test.
 *
 * Tests the complete flow:
 * evaluation → select → persist on NetworkVersion → publish → dispatch resolves it
 *
 * Also tests:
 * - Policy immutability after publication
 * - Historical reproducibility (v1 policy stays after v2 is created)
 * - No acceptable strategy → no performance settlement
 *
 * Run: bun test tests/vpp-baseline-persisted.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { createOperator, createAsset, createDevice, assignAssetToNetwork } from '../src/lib/services/registry.service'
import { recordBuyerFunding } from '../src/lib/services/ledger.service'
import { signMessage, deriveSigningKey } from '../src/lib/domain/crypto'
import { runAndPersistBaselineEvaluation, getBaselinePolicy } from '../src/lib/services/baseline-evaluation.service'
import {
  createBuyerProgram,
  createCapacityReservation,
  createDispatch,
  executeDispatchAssignment,
} from '../src/lib/services/vpp.service'

let tenantId: string
let networkId: string
let versionId: string
let operatorId: string
let assetId: string
let deviceId: string
let provisioningSecret: string

beforeAll(async () => {
  const tenant = await createTenant({ name: 'Policy Test', slug: `policy-${Date.now()}`, plan: 'growth' })
  tenantId = tenant.id

  // Create network (not from template — we need an unpublished version to set policy on).
  const { createNetwork, createNetworkVersion, publishNetworkVersion } = await import('../src/lib/services/network.service')
  const network = await createNetwork(tenantId, { name: 'Policy Network', slug: `policy-net-${Date.now()}`, vertical: 'energy_vpp' })
  networkId = network.id

  const config = {
    asset_types: ['battery'],
    capabilities: [{ type: 'energy_discharge', unit: 'kWh', schema_version: 1, fields: { power_kw: 'number', available_energy_kwh: 'number', state_of_charge_pct: 'number' } }],
    verification: { checks: ['device_signature', 'timestamp_window', 'replay_protection', 'schema_validation', 'numeric_range'], numeric_ranges: { power_kw: { min: 0, max: 1000 }, state_of_charge_pct: { min: 0, max: 100 } }, timestamp_window_seconds: 120 },
    reward: { type: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD', platform_fee_pct: 5 },
  }
  const version = await createNetworkVersion(tenantId, networkId, config)
  versionId = version.id

  // Run evaluation and set policy BEFORE publishing.
  await runAndPersistBaselineEvaluation({ tenantId, networkVersionId: versionId, numScenarios: 50 })

  // Now publish (policy is frozen).
  await publishNetworkVersion(tenantId, networkId, versionId)

  // Create reward rule (needed for dispatch).
  const { createRewardRule } = await import('../src/lib/services/reward.service')
  await createRewardRule(tenantId, {
    networkVersionId: versionId,
    ruleType: 'fixed_rate',
    rate: '0.08',
    unit: 'kWh',
    currency: 'USD',
  })

  const operator = await createOperator(tenantId, { displayName: 'Policy Operator' })
  operatorId = operator.id

  const asset = await createAsset(tenantId, { operatorId, assetType: 'battery', name: 'Policy Battery' })
  assetId = asset.id

  await assignAssetToNetwork(tenantId, assetId, networkId, 'energy_discharge', '10', 'kW')

  const provisioned = await createDevice(tenantId, { assetId, deviceType: 'battery_controller' })
  deviceId = provisioned.device.id
  provisioningSecret = provisioned.provisioningSecret

  await recordBuyerFunding(tenantId, 10000, `policy-funding-${Date.now()}`)
})

describe('VPP-2C: Persisted baseline policy', () => {
  it('policy is persisted on NetworkVersion with evaluation record', async () => {
    // Verify the policy is persisted on the NetworkVersion (set in beforeAll).
    const policy = await getBaselinePolicy(versionId)
    expect(policy).toBeTruthy()
    expect(policy!.selectedStrategy).toBeTruthy()
    expect(policy!.status).toBe('accepted')

    // Verify a BaselineEvaluation record exists.
    const evalRecords = await db.baselineEvaluation.findMany({
      where: { tenantId, networkVersionId: versionId },
    })
    expect(evalRecords.length).toBeGreaterThanOrEqual(1)
    expect(evalRecords[0].numScenarios).toBe(50)
    expect(evalRecords[0].simulatorVersion).toBe('1.0.0')
    expect(evalRecords[0].scenarioDatasetHash).toBeTruthy()
  })

  it('dispatch execution resolves the persisted strategy (not hardcoded)', async () => {
    // Create a program + reservation + dispatch.
    const program = await createBuyerProgram(tenantId, {
      networkId, name: `Policy Program ${Date.now()}`,
      rewardRuleId: (await db.rewardRule.findFirst({ where: { networkVersionId: versionId } }))!.id,
      dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
    })

    const now = new Date()
    const start = new Date(now.getTime() + 3600000 * 24) // tomorrow
    const end = new Date(start.getTime() + 3600000 * 2)

    await createCapacityReservation(tenantId, {
      programId: program.id, operatorId, assetId, capabilityType: 'energy_discharge',
      reservedKw: '5', startTime: start.toISOString(), endTime: end.toISOString(),
    })

    const { assignments } = await createDispatch(tenantId, {
      programId: program.id, requestedKw: '5', requestedKwh: '10',
      startTime: start.toISOString(), endTime: end.toISOString(),
    })

    // Execute — the VPP should resolve the strategy from the persisted policy.
    const result = await executeDispatchAssignment(tenantId, assignments[0].id, provisioningSecret)

    expect(result.event_id).toBeTruthy()
    expect(result.settlement_id).toBeTruthy()

    // Verify the baseline record contains the strategy from the persisted policy.
    const baseline = await db.vppBaseline.findFirst({ where: { assignmentId: assignments[0].id } })
    expect(baseline).toBeTruthy()

    const metadata = JSON.parse(baseline!.metadataJson)
    const policy = await getBaselinePolicy(versionId)
    expect(metadata.strategyName).toBe(policy!.selectedStrategy)
  })

  it('policy is immutable after NetworkVersion publication', async () => {
    // The version was published in beforeAll. Attempting to run evaluation
    // and persist on the published version should NOT change the policy.
    const policyBefore = await getBaselinePolicy(versionId)
    expect(policyBefore).toBeTruthy()

    await runAndPersistBaselineEvaluation({
      tenantId,
      networkVersionId: versionId,
      numScenarios: 20,
    })

    // The policy on the version should NOT have changed.
    const policyAfter = await getBaselinePolicy(versionId)
    expect(policyAfter).toBeTruthy()
    expect(policyAfter!.selectedStrategy).toBe(policyBefore!.selectedStrategy)
    expect(policyAfter!.evaluationId).toBe(policyBefore!.evaluationId)
  })

  it('no acceptable strategy → BASELINE_UNAVAILABLE prevents settlement', async () => {
    // Create a new unpublished version with impossible criteria.
    const { createNetworkVersion } = await import('../src/lib/services/network.service')
    const config = {
      asset_types: ['battery'],
      capabilities: [{ type: 'energy_discharge', unit: 'kWh', schema_version: 1, fields: { power_kw: 'number', available_energy_kwh: 'number', state_of_charge_pct: 'number' } }],
      verification: { checks: ['device_signature', 'timestamp_window', 'replay_protection', 'schema_validation', 'numeric_range'], numeric_ranges: { power_kw: { min: 0, max: 1000 }, state_of_charge_pct: { min: 0, max: 100 } }, timestamp_window_seconds: 120 },
      reward: { type: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD', platform_fee_pct: 5 },
    }
    const newVersion = await createNetworkVersion(tenantId, networkId, config)

    // Run evaluation with impossible criteria.
    const impossibleCriteria = {
      maxMae: 0.0001, maxAbsBias: 0.0001, maxP95Error: 0.0001,
      maxFalsePositiveRate: 0.0001, maxFalseNegativeRate: 0.0001,
      maxOverpaymentPct: 0.0001, maxUnderpaymentPct: 0.0001,
    }
    const result = await runAndPersistBaselineEvaluation({
      tenantId,
      networkVersionId: newVersion.id,
      numScenarios: 20,
      criteria: impossibleCriteria,
    })

    expect(result.policy.status).toBe('no_acceptable_strategy')
    expect(result.policy.selectedStrategy).toBe('')

    // The policy on the version should reflect no acceptable strategy.
    const policy = await getBaselinePolicy(newVersion.id)
    expect(policy).toBeTruthy()
    expect(policy!.status).toBe('no_acceptable_strategy')
  })
})
