/**
 * VPP-1 Integration Test
 *
 * Proves that one battery asset can simultaneously have:
 *   energy_discharge
 *   frequency_response
 *   energy_capacity
 *
 * within the same network, and that telemetry for each capability is validated
 * against the correct schema. Also proves the full VPP dispatch flow uses the
 * generic pipeline (Event → Attestation → Contribution → Reward → Ledger → Settlement)
 * without creating parallel energy-specific abstractions.
 *
 * Run: bun test tests/vpp.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { createOperator, createAsset, createDevice, assignAssetToNetwork } from '../src/lib/services/registry.service'
import { ingestEvent, buildCanonicalMessage } from '../src/lib/services/ingestion.service'
import { processEventOutbox } from '../src/lib/services/worker.service'
import { signMessage, deriveSigningKey } from '../src/lib/domain/crypto'
import {
  createBuyerProgram,
  createCapacityReservation,
  createDispatch,
  executeDispatchAssignment,
} from '../src/lib/services/vpp.service'

let tenantId: string
let networkId: string
let versionId: string
let rewardRuleId: string
let operatorId: string
let assetId: string
let deviceId: string
let provisioningSecret: string

beforeAll(async () => {
  const tenant = await createTenant({ name: 'VPP Test', slug: `vpp-${Date.now()}`, plan: 'growth' })
  tenantId = tenant.id

  const { network, version } = await instantiateTemplate(tenantId, 'energy-vpp')
  networkId = network.id
  versionId = version!.id

  // Get the reward rule created during template instantiation.
  const rule = await db.rewardRule.findFirst({ where: { networkVersionId: versionId } })
  rewardRuleId = rule!.id

  const operator = await createOperator(tenantId, { displayName: 'VPP Operator' })
  operatorId = operator.id

  const asset = await createAsset(tenantId, {
    operatorId,
    assetType: 'battery',
    name: 'Multi-Capability Battery',
  })
  assetId = asset.id

  // Issue 3 proof: assign MULTIPLE capabilities to the same asset in the same network.
  await assignAssetToNetwork(tenantId, assetId, networkId, 'energy_discharge', '10')
  await assignAssetToNetwork(tenantId, assetId, networkId, 'frequency_response', '10')
  await assignAssetToNetwork(tenantId, assetId, networkId, 'energy_capacity', '10')

  const provisioned = await createDevice(tenantId, {
    assetId,
    deviceType: 'battery_controller',
    manufacturer: 'Simulated',
    model: 'DER-Adapter-v1',
  })
  deviceId = provisioned.device.id
  provisioningSecret = provisioned.provisioningSecret
})

describe('VPP-1: Multi-capability battery', () => {
  it('should have 3 active capability assignments for one asset in one network', async () => {
    const assignments = await db.assetNetworkAssignment.findMany({
      where: { assetId, networkId, status: 'active' },
    })
    expect(assignments.length).toBe(3)
    const caps = assignments.map((a) => a.capabilityType).sort()
    expect(caps).toEqual(['energy_capacity', 'energy_discharge', 'frequency_response'])
  })

  it('should validate telemetry for energy_discharge against the correct schema', async () => {
    const eventId = `evt-discharge-${Date.now()}`
    const timestamp = new Date().toISOString()
    const payload = { power_kw: 5.0, available_energy_kwh: 13.5, state_of_charge_pct: 80 }
    const message = buildCanonicalMessage({
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: 1, payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioningSecret))

    await ingestEvent(tenantId, {
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: 1, payload, signature,
      capability_type: 'energy_discharge',
    })
    await processEventOutbox(tenantId)

    const event = await db.event.findUnique({
      where: { tenantId_externalEventId: { tenantId, externalEventId: eventId } },
      include: { verification: true, attestations: true },
    })

    expect(event?.status).toBe('verified')
    expect(event?.capabilityType).toBe('energy_discharge')
    expect(event?.attestations[0]?.unit).toBe('kWh')
  })

  it('should validate telemetry for frequency_response against the correct schema', async () => {
    const eventId = `evt-freq-${Date.now()}`
    const timestamp = new Date().toISOString()
    const payload = { frequency_hz: 49.8, response_kw: 3.0, duration_seconds: 300 }
    const message = buildCanonicalMessage({
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: 2, payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioningSecret))

    await ingestEvent(tenantId, {
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: 2, payload, signature,
      capability_type: 'frequency_response',
    })
    await processEventOutbox(tenantId)

    const event = await db.event.findUnique({
      where: { tenantId_externalEventId: { tenantId, externalEventId: eventId } },
      include: { verification: true, attestations: true },
    })

    expect(event?.status).toBe('verified')
    expect(event?.capabilityType).toBe('frequency_response')
    expect(event?.attestations[0]?.unit).toBe('kW')
  })

  it('should reject telemetry with wrong fields for the specified capability', async () => {
    const eventId = `evt-wrong-${Date.now()}`
    // Send frequency_response capability but with energy_discharge fields.
    const payload = { power_kw: 5.0, available_energy_kwh: 13.5, state_of_charge_pct: 80 }
    const message = buildCanonicalMessage({
      device_id: deviceId, event_id: eventId, timestamp: new Date().toISOString(), event_type: 'telemetry', sequence: 3, payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioningSecret))

    await ingestEvent(tenantId, {
      device_id: deviceId, event_id: eventId, timestamp: new Date().toISOString(), event_type: 'telemetry', sequence: 3, payload, signature,
      capability_type: 'frequency_response',
    })
    await processEventOutbox(tenantId)

    const event = await db.event.findUnique({
      where: { tenantId_externalEventId: { tenantId, externalEventId: eventId } },
      include: { verification: true },
    })

    // Should be rejected because frequency_response expects frequency_hz/response_kw/duration_seconds.
    expect(event?.status).toBe('rejected')
    const checks = JSON.parse(event?.verification?.checksJson ?? '[]')
    const schemaCheck = checks.find((c: any) => c.name === 'schema_validation')
    expect(schemaCheck?.status).toBe('fail')
  })
})

describe('VPP-1: Full dispatch flow using generic pipeline', () => {
  it('should execute a dispatch assignment through the full generic pipeline', async () => {
    // 1. Create a buyer program.
    const program = await createBuyerProgram(tenantId, {
      networkId,
      name: 'Peak Demand Program',
      description: 'Discharge during peak hours',
      rewardRuleId,
      dispatchWindowStart: '16:00',
      dispatchWindowEnd: '21:00',
      pricePerKwh: '0.12',
      currency: 'USD',
      minCapacityKw: '1',
    })

    // 2. Reserve capacity.
    await createCapacityReservation(tenantId, {
      programId: program.id,
      operatorId,
      assetId,
      capabilityType: 'energy_discharge',
      reservedKw: '10',
      reservedKwh: '20',
    })

    // 3. Create dispatch.
    const { dispatch, assignments } = await createDispatch(tenantId, {
      programId: program.id,
      requestedKw: '5',
      requestedKwh: '10',
      startTime: new Date().toISOString(),
      endTime: new Date(Date.now() + 3600000).toISOString(),
      reason: 'test_dispatch',
    })

    expect(dispatch.status).toBe('assigned')
    expect(assignments.length).toBe(1)

    // 4. Execute the dispatch assignment (simulated DER adapter).
    const result = await executeDispatchAssignment(tenantId, assignments[0].id, provisioningSecret)

    // 5. Verify the full chain used the generic pipeline.
    expect(result.event_id).toBeTruthy()
    expect(result.attestation_id).toBeTruthy()
    expect(result.baseline_id).toBeTruthy()
    expect(result.contribution_id).toBeTruthy()
    expect(result.reward_id).toBeTruthy()
    expect(result.settlement_id).toBeTruthy()
    expect(parseFloat(result.performance_kwh)).toBeGreaterThan(0)

    // 6. Verify the dispatch assignment is completed.
    const assignment = await db.vppDispatchAssignment.findUnique({
      where: { id: assignments[0].id },
    })
    expect(assignment?.status).toBe('completed')
    expect(assignment?.eventId).toBe(result.event_id)
    expect(assignment?.contributionId).toBe(result.contribution_id)

    // 7. Verify no parallel energy-specific abstractions were created.
    // The event should be a generic Event, not an EnergyEvent.
    const event = await db.event.findUnique({ where: { id: result.event_id } })
    expect(event).toBeTruthy()
    expect(event?.capabilityType).toBe('energy_discharge')

    // The contribution should be a generic Contribution.
    const contribution = await db.contribution.findUnique({ where: { id: result.contribution_id } })
    expect(contribution).toBeTruthy()

    // The settlement should be a generic Settlement.
    const settlement = await db.settlement.findUnique({ where: { id: result.settlement_id } })
    expect(settlement).toBeTruthy()
    expect(settlement?.status).toBe('completed')
  })
})
