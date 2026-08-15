/**
 * VPP-2C: Historical reproducibility test.
 *
 * Proves that a dispatch created under NetworkVersion V12 uses V12's
 * baseline policy AND V12's telemetry verification policy even after V13
 * is published and becomes current.
 *
 * Also proves V13 dispatches use V13's policy for both.
 *
 * This is the "immutable policy boundary" invariant:
 *   every event AND every economic calculation associated with a dispatch
 *   must resolve against the SAME immutable NetworkVersion
 *   (dispatch.program.networkVersionId).
 *
 * Run: bun test tests/vpp-baseline-reproducibility.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { createNetwork, createNetworkVersion, publishNetworkVersion } from '../src/lib/services/network.service'
import { createOperator, createAsset, createDevice, assignAssetToNetwork } from '../src/lib/services/registry.service'
import { createRewardRule } from '../src/lib/services/reward.service'
import { recordBuyerFunding } from '../src/lib/services/ledger.service'
import { runAndPersistBaselineEvaluation, getBaselinePolicy } from '../src/lib/services/baseline-evaluation.service'
import {
  createBuyerProgram,
  createCapacityReservation,
  createDispatch,
  executeDispatchAssignment,
} from '../src/lib/services/vpp.service'
import { WeekdayWeekendAverageBaseline, RegressionBaseline, getStrategy } from '../src/lib/services/baseline-engine.service'

let tenantId: string
let networkId: string
let v12Id: string
let v13Id: string
let operatorId: string
let assetId: string
let provisioningSecret: string

const config = {
  asset_types: ['battery'],
  capabilities: [{ type: 'energy_discharge', unit: 'kWh', schema_version: 1, fields: { power_kw: 'number', available_energy_kwh: 'number', state_of_charge_pct: 'number' } }],
  verification: { checks: ['device_signature', 'timestamp_window', 'replay_protection', 'schema_validation', 'numeric_range'], numeric_ranges: { power_kw: { min: 0, max: 1000 }, state_of_charge_pct: { min: 0, max: 100 } }, timestamp_window_seconds: 120 },
  reward: { type: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD', platform_fee_pct: 5 },
}

beforeAll(async () => {
  const tenant = await createTenant({ name: 'Repro Test', slug: `repro-${Date.now()}`, plan: 'growth' })
  tenantId = tenant.id

  const network = await createNetwork(tenantId, { name: 'Repro Network', slug: `repro-net-${Date.now()}`, vertical: 'energy_vpp' })
  networkId = network.id

  // Create V12 (unpublished).
  v12Id = (await createNetworkVersion(tenantId, networkId, config)).id

  // Create reward rule for V12.
  await createRewardRule(tenantId, { networkVersionId: v12Id, ruleType: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD' })

  // Run evaluation and set V12 policy (strategy will be whatever the evaluation selects).
  await runAndPersistBaselineEvaluation({ tenantId, networkVersionId: v12Id, numScenarios: 50 })

  // Publish V12.
  await publishNetworkVersion(tenantId, networkId, v12Id)

  // Create operator + asset + device.
  const operator = await createOperator(tenantId, { displayName: 'Repro Operator' })
  operatorId = operator.id
  const asset = await createAsset(tenantId, { operatorId, assetType: 'battery', name: 'Repro Battery' })
  assetId = asset.id
  await assignAssetToNetwork(tenantId, assetId, networkId, 'energy_discharge', '10', 'kW')
  const provisioned = await createDevice(tenantId, { assetId, deviceType: 'battery_controller' })
  provisioningSecret = provisioned.provisioningSecret

  await recordBuyerFunding(tenantId, 100000, `repro-funding-${Date.now()}`)

  // Create V13 (unpublished) with a DIFFERENT policy.
  v13Id = (await createNetworkVersion(tenantId, networkId, config)).id
  await createRewardRule(tenantId, { networkVersionId: v13Id, ruleType: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD' })

  // Force V13 to use a different strategy by manually setting the policy.
  const v12Policy = await getBaselinePolicy(v12Id)
  const v13Strategy = v12Policy?.selectedStrategy === 'weekday_weekend_average' ? 'same_time_historical' : 'weekday_weekend_average'
  await db.networkVersion.update({
    where: { id: v13Id },
    data: {
      baselinePolicyJson: JSON.stringify({
        selectedStrategy: v13Strategy,
        evaluationId: 'manual-v13',
        evaluatedAt: new Date().toISOString(),
        criteria: { maxMae: 3, maxAbsBias: 1.5, maxP95Error: 5, maxFalsePositiveRate: 0.15, maxFalseNegativeRate: 0.15, maxOverpaymentPct: 30, maxUnderpaymentPct: 30 },
        metrics: { mae: 1, bias: 0, p95Error: 2, falsePositiveRate: 0.05, falseNegativeRate: 0.05, overpaymentPct: 10, underpaymentPct: 10 },
        status: 'accepted',
      }),
    },
  })

  // Publish V13 (now current).
  await publishNetworkVersion(tenantId, networkId, v13Id)
})

describe('VPP-2C: Historical reproducibility', () => {
  it('V12 dispatch uses V12 baseline policy AND V12 telemetry verification, even after V13 is current', async () => {
    const v12Policy = await getBaselinePolicy(v12Id)
    const v13Policy = await getBaselinePolicy(v13Id)

    // Verify V12 and V13 have different strategies.
    expect(v12Policy?.selectedStrategy).not.toBe(v13Policy?.selectedStrategy)

    // Create a program bound to V12.
    const programV12 = await createBuyerProgram(tenantId, {
      networkId,
      networkVersionId: v12Id,
      name: `V12 Program ${Date.now()}`,
      rewardRuleId: (await db.rewardRule.findFirst({ where: { networkVersionId: v12Id } }))!.id,
      dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
    })

    const now = new Date()
    const start = new Date(now.getTime() + 3600000 * 48) // 2 days from now
    const end = new Date(start.getTime() + 3600000 * 2)

    await createCapacityReservation(tenantId, {
      programId: programV12.id, operatorId, assetId, capabilityType: 'energy_discharge',
      reservedKw: '5', startTime: start.toISOString(), endTime: end.toISOString(),
    })

    const { assignments } = await createDispatch(tenantId, {
      programId: programV12.id, requestedKw: '5', requestedKwh: '10',
      startTime: start.toISOString(), endTime: end.toISOString(),
    })

    // Execute the V12 dispatch (V13 is now current — this is the historical case).
    const result = await executeDispatchAssignment(tenantId, assignments[0].id, provisioningSecret)
    expect(result.duplicate).toBe(false)
    const eventId = result.event_id!

    // -------------------------------------------------------------------------
    // INVARIANT 1: telemetry Event.networkVersionId == V12.
    // This is the key assertion that was previously missing. Without it, the
    // test would pass while the system simultaneously did:
    //   baseline    → V12 policy ✅
    //   verification → V13 policy ❌
    // -------------------------------------------------------------------------
    const event = await db.event.findUnique({ where: { id: eventId } })
    expect(event).toBeTruthy()
    expect(event!.networkVersionId).toBe(v12Id)
    expect(event!.networkVersionId).not.toBe(v13Id)

    // -------------------------------------------------------------------------
    // INVARIANT 2: baseline uses V12's strategy, NOT V13's.
    // -------------------------------------------------------------------------
    const baseline = await db.vppBaseline.findFirst({ where: { assignmentId: assignments[0].id } })
    expect(baseline).toBeTruthy()
    const metadata = JSON.parse(baseline!.metadataJson)
    expect(metadata.strategyName).toBe(v12Policy!.selectedStrategy)
    expect(metadata.strategyName).not.toBe(v13Policy!.selectedStrategy)

    // -------------------------------------------------------------------------
    // INVARIANT 3: no version split — the baseline's recorded networkVersionId
    // MUST equal the event's networkVersionId. If they diverge, baseline and
    // verification resolved against different NetworkVersions.
    // -------------------------------------------------------------------------
    expect(metadata.networkVersionId).toBe(v12Id)
    expect(metadata.networkVersionId).toBe(event!.networkVersionId)
  })

  it('V13 dispatch uses V13 baseline policy AND V13 telemetry verification', async () => {
    const v13Policy = await getBaselinePolicy(v13Id)

    // Create a program bound to V13.
    const programV13 = await createBuyerProgram(tenantId, {
      networkId,
      networkVersionId: v13Id,
      name: `V13 Program ${Date.now()}`,
      rewardRuleId: (await db.rewardRule.findFirst({ where: { networkVersionId: v13Id } }))!.id,
      dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59', pricePerKwh: '0.12', minCapacityKw: '1',
    })

    const now = new Date()
    const start = new Date(now.getTime() + 3600000 * 72) // 3 days from now
    const end = new Date(start.getTime() + 3600000 * 2)

    await createCapacityReservation(tenantId, {
      programId: programV13.id, operatorId, assetId, capabilityType: 'energy_discharge',
      reservedKw: '5', startTime: start.toISOString(), endTime: end.toISOString(),
    })

    const { assignments } = await createDispatch(tenantId, {
      programId: programV13.id, requestedKw: '5', requestedKwh: '10',
      startTime: start.toISOString(), endTime: end.toISOString(),
    })

    const result = await executeDispatchAssignment(tenantId, assignments[0].id, provisioningSecret)
    expect(result.duplicate).toBe(false)
    const eventId = result.event_id!

    // INVARIANT 1: telemetry Event.networkVersionId == V13.
    const event = await db.event.findUnique({ where: { id: eventId } })
    expect(event).toBeTruthy()
    expect(event!.networkVersionId).toBe(v13Id)

    // INVARIANT 2: baseline uses V13's strategy.
    const baseline = await db.vppBaseline.findFirst({ where: { assignmentId: assignments[0].id } })
    expect(baseline).toBeTruthy()
    const metadata = JSON.parse(baseline!.metadataJson)
    expect(metadata.strategyName).toBe(v13Policy!.selectedStrategy)

    // INVARIANT 3: no version split.
    expect(metadata.networkVersionId).toBe(v13Id)
    expect(metadata.networkVersionId).toBe(event!.networkVersionId)
  })
})
