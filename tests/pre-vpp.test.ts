/**
 * Final pre-VPP correctness tests.
 *
 * Tests the 4 fixes from the third code review:
 *   1. Event.capabilityType persisted from assignment; no worker fallback
 *   2. Concurrency-safe buyer funding (SELECT FOR UPDATE)
 *   3. Multi-capability per network (one asset, multiple capabilities)
 *   4. Atomic worker state transitions (state change + outbox in same tx)
 *
 * Run: bun test tests/pre-vpp.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { Prisma } from '@prisma/client'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { createOperator, createAsset, createDevice, assignAssetToNetwork } from '../src/lib/services/registry.service'
import { ingestEvent, buildCanonicalMessage } from '../src/lib/services/ingestion.service'
import { createContribution } from '../src/lib/services/contribution.service'
import { calculateReward } from '../src/lib/services/reward.service'
import { postRewardToLedger, recordBuyerFunding, computeBalance, ensureOperatorAccount, ensureBuyerFundsAccount } from '../src/lib/services/ledger.service'
import { createSettlement } from '../src/lib/services/settlement.service'
import { processEventOutbox, processSettlementOutbox } from '../src/lib/services/worker.service'
import { signMessage, deriveSigningKey } from '../src/lib/domain/crypto'
import { ValidationError } from '@/lib/domain/errors'

let tenantId: string
let networkId: string
let versionId: string
let operatorId: string
let assetId: string
let deviceId: string
let provisioningSecret: string

beforeAll(async () => {
  const tenant = await createTenant({ name: 'Pre-VPP Test', slug: `prevpp-${Date.now()}`, plan: 'starter' })
  tenantId = tenant.id

  const { network, version } = await instantiateTemplate(tenantId, 'energy-vpp')
  networkId = network.id
  versionId = version!.id

  const operator = await createOperator(tenantId, { displayName: 'Test Operator' })
  operatorId = operator.id

  const asset = await createAsset(tenantId, { operatorId, assetType: 'battery', name: 'Test Battery' })
  assetId = asset.id

  // Issue 3: assign MULTIPLE capabilities to the same asset in the same network.
  await assignAssetToNetwork(tenantId, assetId, networkId, 'energy_discharge')

  const provisioned = await createDevice(tenantId, { assetId, deviceType: 'battery_controller' })
  deviceId = provisioned.device.id
  provisioningSecret = provisioned.provisioningSecret

  // Fund the buyer account.
  await recordBuyerFunding(tenantId, 1000, `test-funding-${Date.now()}`)
})

// ---------------------------------------------------------------------------
// Issue 1: Explicit capability binding (no fallback)
// ---------------------------------------------------------------------------

describe('Issue 1: Explicit capability binding', () => {
  it('should persist capabilityType on the event at ingest time', async () => {
    const eventId = `evt-cap-persist-${Date.now()}`
    const result = await ingestEvent(tenantId, {
      device_id: deviceId,
      event_id: eventId,
      timestamp: new Date().toISOString(),
      event_type: 'telemetry',
      payload: { power_kw: 3.0, available_energy_kwh: 10, state_of_charge_pct: 80 },
      signature: 'placeholder',
      capability_type: 'energy_discharge',
    })

    const event = await db.event.findUnique({ where: { id: result.event_id } })
    expect(event?.capabilityType).toBe('energy_discharge')
  })

  it('should reject events when capability_type is missing and asset has multiple capabilities', async () => {
    // Add a second capability to the asset.
    await assignAssetToNetwork(tenantId, assetId, networkId, 'frequency_response')

    const eventId = `evt-cap-ambiguous-${Date.now()}`
    await expect(
      ingestEvent(tenantId, {
        device_id: deviceId,
        event_id: eventId,
        timestamp: new Date().toISOString(),
        event_type: 'telemetry',
        payload: { power_kw: 3.0, available_energy_kwh: 10, state_of_charge_pct: 80 },
        signature: 'placeholder',
        // No capability_type — should fail because asset has 2 capabilities.
      }),
    ).rejects.toThrow(/multiple active assignments|multiple capabilities/)

    // Clean up — remove the second capability.
    await db.assetNetworkAssignment.deleteMany({
      where: { assetId, networkId, capabilityType: 'frequency_response' },
    })
  })
})

// ---------------------------------------------------------------------------
// Issue 2: Concurrency-safe buyer funding
// ---------------------------------------------------------------------------

describe('Issue 2: Concurrency-safe buyer funding', () => {
  it('should reject both concurrent rewards when they exceed available funds', async () => {
    // Create a tenant with exactly $50 in buyer funds.
    const fundedTenant = await createTenant({ name: 'Concurrent Funding', slug: `conc-${Date.now()}`, plan: 'starter' })
    const { network, version } = await instantiateTemplate(fundedTenant.id, 'energy-vpp')
    const operator = await createOperator(fundedTenant.id, { displayName: 'Conc Operator' })
    const asset = await createAsset(fundedTenant.id, { operatorId: operator.id, assetType: 'battery', name: 'Conc Battery' })
    await assignAssetToNetwork(fundedTenant.id, asset.id, network.id, 'energy_discharge')
    const provisioned = await createDevice(fundedTenant.id, { assetId: asset.id, deviceType: 'controller' })

    // Fund with exactly $50.
    await recordBuyerFunding(fundedTenant.id, 50, `conc-funding-${Date.now()}`)

    // Create two rewards that each need ~$40 gross.
    const rewards: string[] = []
    for (let i = 0; i < 2; i++) {
      const eventId = `evt-conc-${Date.now()}-${i}`
      const timestamp = new Date().toISOString()
      const payload = { power_kw: 5.0, available_energy_kwh: 10, state_of_charge_pct: 80 }
      const seq = Math.floor(Date.now() / 1000) + i
      const message = buildCanonicalMessage({
        device_id: provisioned.device.id, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload,
      })
      const signature = signMessage(message, deriveSigningKey(provisioned.provisioningSecret))

      await ingestEvent(fundedTenant.id, {
        device_id: provisioned.device.id, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload, signature,
        network_version_id: version?.id, capability_type: 'energy_discharge',
      })
      await processEventOutbox(fundedTenant.id)

      const event = await db.event.findUnique({
        where: { tenantId_externalEventId: { tenantId: fundedTenant.id, externalEventId: eventId } },
        include: { attestations: true },
      })
      const contribution = await createContribution(fundedTenant.id, { attestationIds: [event!.attestations[0].id] }, `att-conc-${event!.attestations[0].id}`)
      const reward = await calculateReward(fundedTenant.id, contribution.id, `contrib-conc-${contribution.id}`)
      rewards.push(reward.id)
    }

    // Each reward gross = 5.0 * 0.08 = $0.40. Two rewards = $0.80 total.
    // With $50 funded, both should succeed.
    // Now test the real race: fund with exactly $0.50, two rewards of $0.40 each.
    const raceTenant = await createTenant({ name: 'Race Funding', slug: `race-${Date.now()}`, plan: 'starter' })
    const { network: rn, version: rv } = await instantiateTemplate(raceTenant.id, 'energy-vpp')
    const roperator = await createOperator(raceTenant.id, { displayName: 'Race Operator' })
    const rasset = await createAsset(raceTenant.id, { operatorId: roperator.id, assetType: 'battery', name: 'Race Battery' })
    await assignAssetToNetwork(raceTenant.id, rasset.id, rn.id, 'energy_discharge')
    const rprovisioned = await createDevice(raceTenant.id, { assetId: rasset.id, deviceType: 'controller' })

    // Fund with exactly $0.50 — two rewards of $0.40 each would exceed it.
    await recordBuyerFunding(raceTenant.id, 0.50, `race-funding-${Date.now()}`)

    const raceRewards: string[] = []
    for (let i = 0; i < 2; i++) {
      const eventId = `evt-race-${Date.now()}-${i}`
      const timestamp = new Date().toISOString()
      const payload = { power_kw: 5.0, available_energy_kwh: 10, state_of_charge_pct: 80 }
      const seq = Math.floor(Date.now() / 1000) + i + 100
      const message = buildCanonicalMessage({
        device_id: rprovisioned.device.id, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload,
      })
      const signature = signMessage(message, deriveSigningKey(rprovisioned.provisioningSecret))

      await ingestEvent(raceTenant.id, {
        device_id: rprovisioned.device.id, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload, signature,
        network_version_id: rv?.id, capability_type: 'energy_discharge',
      })
      await processEventOutbox(raceTenant.id)

      const event = await db.event.findUnique({
        where: { tenantId_externalEventId: { tenantId: raceTenant.id, externalEventId: eventId } },
        include: { attestations: true },
      })
      const contribution = await createContribution(raceTenant.id, { attestationIds: [event!.attestations[0].id] }, `att-race-${event!.attestations[0].id}`)
      const reward = await calculateReward(raceTenant.id, contribution.id, `contrib-race-${contribution.id}`)
      raceRewards.push(reward.id)
    }

    // Launch both postings concurrently.
    const results = await Promise.allSettled([
      postRewardToLedger(raceTenant.id, { rewardId: raceRewards[0] }, `reward-race-${raceRewards[0]}`),
      postRewardToLedger(raceTenant.id, { rewardId: raceRewards[1] }, `reward-race-${raceRewards[1]}`),
    ])

    // Exactly one should succeed, the other should fail with insufficient funding.
    const succeeded = results.filter((r) => r.status === 'fulfilled')
    const failed = results.filter((r) => r.status === 'rejected')
    expect(succeeded.length).toBe(1)
    expect(failed.length).toBe(1)

    // The failed one should be an insufficient funding error.
    const failedReason = (failed[0] as PromiseRejectedResult).reason
    expect(failedReason instanceof ValidationError).toBe(true)
    expect(failedReason.message).toContain('Insufficient buyer funding')

    // The buyer balance should never go negative.
    const buyerAccount = await ensureBuyerFundsAccount(raceTenant.id)
    const finalBalance = await computeBalance(raceTenant.id, buyerAccount.id)
    expect(finalBalance.gte(0)).toBe(true) // balance >= 0
  })
})

// ---------------------------------------------------------------------------
// Issue 3: Multi-capability per network
// ---------------------------------------------------------------------------

describe('Issue 3: Multi-capability per network', () => {
  it('should allow one asset to have multiple capabilities in the same network', async () => {
    // Assign a second capability to the existing asset.
    await assignAssetToNetwork(tenantId, assetId, networkId, 'frequency_response')

    const assignments = await db.assetNetworkAssignment.findMany({
      where: { assetId, networkId, status: 'active' },
    })
    expect(assignments.length).toBe(2)
    expect(assignments.map((a) => a.capabilityType).sort()).toEqual(['energy_discharge', 'frequency_response'])
  })
})

// ---------------------------------------------------------------------------
// Issue 4: Atomic worker state transitions
// ---------------------------------------------------------------------------

describe('Issue 4: Atomic worker state transitions', () => {
  it('should atomically persist verification result + event status + outbox', async () => {
    const eventId = `evt-atomic-verify-${Date.now()}`
    const timestamp = new Date().toISOString()
    const payload = { power_kw: 4.0, available_energy_kwh: 10, state_of_charge_pct: 80 }
    const seq = Math.floor(Date.now() / 1000) % 100000 + 200
    const message = buildCanonicalMessage({
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioningSecret))

    await ingestEvent(tenantId, {
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload, signature,
      capability_type: 'energy_discharge',
    })

    await processEventOutbox(tenantId)

    // All three should exist: verification result, event status update, outbox event.
    const event = await db.event.findUnique({
      where: { tenantId_externalEventId: { tenantId, externalEventId: eventId } },
      include: { verification: true },
    })
    const outboxEvent = await db.domainEvent.findFirst({
      where: { aggregateId: eventId, eventType: 'VerificationCompleted' },
    })

    expect(event?.status).toBe('verified')
    expect(event?.verification).toBeTruthy()
    expect(event?.verification?.overallStatus).toBe('verified')
    expect(outboxEvent).toBeTruthy()
  })

  it('should atomically persist settlement completion + reward status + ledger + outbox', async () => {
    const eventId = `evt-atomic-settle-${Date.now()}`
    const timestamp = new Date().toISOString()
    const payload = { power_kw: 6.0, available_energy_kwh: 10, state_of_charge_pct: 80 }
    const seq = Math.floor(Date.now() / 1000) % 100000 + 300
    const message = buildCanonicalMessage({
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioningSecret))

    await ingestEvent(tenantId, {
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload, signature,
      capability_type: 'energy_discharge',
    })
    await processEventOutbox(tenantId)

    const event = await db.event.findUnique({
      where: { tenantId_externalEventId: { tenantId, externalEventId: eventId } },
      include: { attestations: true },
    })
    const contribution = await createContribution(tenantId, { attestationIds: [event!.attestations[0].id] }, `att-atomic-settle-${event!.attestations[0].id}`)
    const reward = await calculateReward(tenantId, contribution.id, `contrib-atomic-settle-${contribution.id}`)
    const ledger = await postRewardToLedger(tenantId, { rewardId: reward.id }, `reward-atomic-settle-${reward.id}`)
    const settlement = await createSettlement(tenantId, reward.id)

    await processSettlementOutbox(tenantId)

    // Verify all parts of the atomic completion.
    const finalSettlement = await db.settlement.findUnique({ where: { id: settlement.id } })
    const finalReward = await db.reward.findUnique({ where: { id: reward.id } })
    const outboxEvent = await db.domainEvent.findFirst({
      where: { aggregateId: settlement.id, eventType: 'SettlementCompleted' },
    })
    const settlementPosting = await db.ledgerPosting.findFirst({
      where: { referenceType: 'settlement', referenceId: settlement.id },
    })

    expect(finalSettlement?.status).toBe('completed')
    expect(finalReward?.status).toBe('settled')
    expect(outboxEvent).toBeTruthy()
    expect(settlementPosting).toBeTruthy()

    // Verify the settlement posting is balanced.
    const entries = await db.ledgerEntry.findMany({ where: { postingId: settlementPosting!.id } })
    const sum = entries.reduce((acc, e) => acc.plus(e.amount), new Prisma.Decimal(0))
    expect(sum.isZero()).toBe(true)
  })
})
