/**
 * Correctness tests for the second hardening pass.
 *
 * Tests the 6 fixes from the second code review:
 *   1. Atomic outbox (event + outbox row in same DB transaction)
 *   2. Worker claiming/leases (FOR UPDATE SKIP LOCKED, no double-processing)
 *   3. Decimal arithmetic (no Float for monetary values)
 *   4. Explicit capability binding (not capabilities[0])
 *   5. Sufficient buyer funding enforcement
 *   6. Crash/concurrency scenarios for the above
 *
 * Run: bun test tests/correctness.test.ts --timeout 120000
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
import { ValidationError } from '../src/lib/domain/errors'

const TEST_TENANT_SLUG = `correctness-${Date.now()}`

let tenantId: string
let networkId: string
let versionId: string
let operatorId: string
let assetId: string
let deviceId: string
let provisioningSecret: string
let buyerFundsAccountId: string

beforeAll(async () => {
  const tenant = await createTenant({ name: 'Correctness Test', slug: TEST_TENANT_SLUG, plan: 'starter' })
  tenantId = tenant.id

  const { network, version } = await instantiateTemplate(tenantId, 'energy-vpp')
  networkId = network.id
  versionId = version!.id

  const operator = await createOperator(tenantId, { displayName: 'Test Operator' })
  operatorId = operator.id

  const asset = await createAsset(tenantId, {
    operatorId,
    assetType: 'battery',
    name: 'Test Battery',
  })
  assetId = asset.id

  await assignAssetToNetwork(tenantId, assetId, networkId, 'energy_discharge')

  const provisioned = await createDevice(tenantId, {
    assetId,
    deviceType: 'battery_controller',
  })
  deviceId = provisioned.device.id
  provisioningSecret = provisioned.provisioningSecret

  // Fund the buyer account for reward posting tests.
  await recordBuyerFunding(tenantId, 10000, `test-funding-${Date.now()}`)
  const buyerAccount = await ensureBuyerFundsAccount(tenantId)
  buyerFundsAccountId = buyerAccount.id
})

// ---------------------------------------------------------------------------
// Task 1: Atomic outbox
// ---------------------------------------------------------------------------

describe('Task 1: Atomic outbox', () => {
  it('should create event + outbox row in the same transaction', async () => {
    const eventId = `evt-atomic-${Date.now()}`
    const result = await ingestEvent(tenantId, {
      device_id: deviceId,
      event_id: eventId,
      timestamp: new Date().toISOString(),
      event_type: 'telemetry',
      payload: { power_kw: 3.0, available_energy_kwh: 10, state_of_charge_pct: 80 },
      signature: 'placeholder',
    })

    // Verify both the event and the outbox row exist.
    const event = await db.event.findUnique({ where: { id: result.event_id } })
    const outboxEvent = await db.domainEvent.findFirst({
      where: { aggregateId: result.event_id, eventType: 'DeviceEventAccepted' },
    })

    expect(event).toBeTruthy()
    expect(outboxEvent).toBeTruthy()
    expect(event?.status).toBe('queued')
    expect(outboxEvent?.processed).toBe(false)
  })

  it('should create settlement + outbox row in the same transaction', async () => {
    // Run a quick chain to get a reward.
    const eventId = `evt-settlement-atomic-${Date.now()}`
    const timestamp = new Date().toISOString()
    const payload = { power_kw: 4.0, available_energy_kwh: 10, state_of_charge_pct: 80 }
    const seq = Math.floor(Date.now() / 1000) % 100000
    const message = buildCanonicalMessage({
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioningSecret))

    await ingestEvent(tenantId, {
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload, signature,
    })
    await processEventOutbox(tenantId)

    const event = await db.event.findUnique({
      where: { tenantId_externalEventId: { tenantId, externalEventId: eventId } },
      include: { attestations: true },
    })
    const contribution = await createContribution(tenantId, { attestationIds: [event!.attestations[0].id] }, `att-atomic-${event!.attestations[0].id}`)
    const reward = await calculateReward(tenantId, contribution.id, `contrib-atomic-${contribution.id}`)
    await postRewardToLedger(tenantId, { rewardId: reward.id }, `reward-atomic-${reward.id}`)

    const settlement = await createSettlement(tenantId, reward.id)

    // Verify both settlement + outbox exist.
    const outboxEvent = await db.domainEvent.findFirst({
      where: { aggregateId: settlement.id, eventType: 'SettlementRequested' },
    })

    expect(settlement).toBeTruthy()
    expect(outboxEvent).toBeTruthy()
    expect(settlement.status).toBe('created')
  })
})

// ---------------------------------------------------------------------------
// Task 2: Worker claiming (concurrency-safe)
// ---------------------------------------------------------------------------

describe('Task 2: Worker claiming (FOR UPDATE SKIP LOCKED)', () => {
  it('should not process the same event twice under concurrent workers', async () => {
    // Queue multiple events.
    const eventIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const eventId = `evt-concurrent-${Date.now()}-${i}`
      const result = await ingestEvent(tenantId, {
        device_id: deviceId,
        event_id: eventId,
        timestamp: new Date().toISOString(),
        event_type: 'telemetry',
        sequence: Math.floor(Date.now() / 1000) + i,
        payload: { power_kw: 2.0 + i * 0.1, available_energy_kwh: 10, state_of_charge_pct: 80 },
        signature: 'placeholder',
      })
      eventIds.push(result.event_id)
    }

    // Launch two concurrent workers.
    const [worker1, worker2] = await Promise.all([
      processEventOutbox(tenantId),
      processEventOutbox(tenantId),
    ])

    // Total processed should equal the number of events (no double-processing).
    const totalProcessed = worker1.processed + worker2.processed
    expect(totalProcessed).toBeLessThanOrEqual(5)

    // Each event should have exactly ONE verification result (not two).
    for (const eventId of eventIds) {
      const verifications = await db.verificationResult.findMany({ where: { eventId } })
      expect(verifications.length).toBe(1)
    }

    // Each event should have at most one attestation.
    for (const eventId of eventIds) {
      const attestations = await db.attestation.findMany({ where: { eventId } })
      expect(attestations.length).toBeLessThanOrEqual(1)
    }
  })

  it('should transition events through processing → verified/rejected', async () => {
    const eventId = `evt-status-${Date.now()}`
    const result = await ingestEvent(tenantId, {
      device_id: deviceId,
      event_id: eventId,
      timestamp: new Date().toISOString(),
      event_type: 'telemetry',
      payload: { power_kw: 5.0, available_energy_kwh: 10, state_of_charge_pct: 80 },
      signature: 'placeholder',
    })

    // Before processing: queued.
    const before = await db.event.findUnique({ where: { id: result.event_id } })
    expect(before?.status).toBe('queued')

    await processEventOutbox(tenantId)

    // After processing: verified or rejected (not queued or processing).
    const after = await db.event.findUnique({ where: { id: result.event_id } })
    expect(['verified', 'rejected']).toContain(after?.status ?? '') // WORK-006 (BASE-007): coerce undefined to '' for toContain
  })
})

// ---------------------------------------------------------------------------
// Task 3: Decimal arithmetic
// ---------------------------------------------------------------------------

describe('Task 3: Decimal arithmetic (no Float for money)', () => {
  it('should store amounts as Decimal, not Float', async () => {
    // Check the database column type — Prisma should return Decimal objects.
    const eventId = `evt-decimal-${Date.now()}`
    const timestamp = new Date().toISOString()
    const payload = { power_kw: 4.8, available_energy_kwh: 10, state_of_charge_pct: 80 }
    const seq = Math.floor(Date.now() / 1000) % 100000 + 42
    const message = buildCanonicalMessage({
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioningSecret))

    await ingestEvent(tenantId, {
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload, signature,
    })
    await processEventOutbox(tenantId)

    const event = await db.event.findUnique({
      where: { tenantId_externalEventId: { tenantId, externalEventId: eventId } },
      include: { attestations: true },
    })
    const contribution = await createContribution(tenantId, { attestationIds: [event!.attestations[0].id] }, `att-decimal-${event!.attestations[0].id}`)
    const reward = await calculateReward(tenantId, contribution.id, `contrib-decimal-${contribution.id}`)

    // The reward amount should be a string (exact decimal representation).
    expect(typeof reward.amount).toBe('string')
    expect(reward.amount).toBe('0.3648') // 4.8 * 0.08 = 0.384, minus 5% = 0.3648

    // The attestation quantity should be a Decimal object.
    const attestation = await db.attestation.findUnique({ where: { id: event!.attestations[0].id } })
    expect(attestation?.quantity).toBeInstanceOf(Prisma.Decimal)
    expect(attestation?.quantity.toString()).toBe('4.8')
  })

  it('should handle precise decimal calculations without floating-point loss', async () => {
    // Test a value that would cause floating-point issues.
    const eventId = `evt-precision-${Date.now()}`
    const timestamp = new Date().toISOString()
    const payload = { power_kw: 0.1 + 0.2, available_energy_kwh: 10, state_of_charge_pct: 80 } // 0.30000000000000004 in float
    const seq = Math.floor(Date.now() / 1000) % 100000 + 99
    const message = buildCanonicalMessage({
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioningSecret))

    await ingestEvent(tenantId, {
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload, signature,
    })
    await processEventOutbox(tenantId)

    const event = await db.event.findUnique({
      where: { tenantId_externalEventId: { tenantId, externalEventId: eventId } },
      include: { attestations: true },
    })

    // The quantity should be stored exactly, not with floating-point error.
    const quantity = event!.attestations[0].quantity.toString()
    expect(quantity).not.toContain('00000004') // no floating-point artifacts
  })

  it('should enforce exact balance (sum = 0) using Decimal comparison', async () => {
    const eventId = `evt-balance-${Date.now()}`
    const timestamp = new Date().toISOString()
    const payload = { power_kw: 7.777, available_energy_kwh: 10, state_of_charge_pct: 80 }
    const seq = Math.floor(Date.now() / 1000) % 100000 + 77
    const message = buildCanonicalMessage({
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioningSecret))

    await ingestEvent(tenantId, {
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload, signature,
    })
    await processEventOutbox(tenantId)

    const event = await db.event.findUnique({
      where: { tenantId_externalEventId: { tenantId, externalEventId: eventId } },
      include: { attestations: true },
    })
    const contribution = await createContribution(tenantId, { attestationIds: [event!.attestations[0].id] }, `att-balance-${event!.attestations[0].id}`)
    const reward = await calculateReward(tenantId, contribution.id, `contrib-balance-${contribution.id}`)
    const ledger = await postRewardToLedger(tenantId, { rewardId: reward.id }, `reward-balance-${reward.id}`)

    // Verify the posting entries sum to exactly zero.
    const entries = await db.ledgerEntry.findMany({ where: { postingId: ledger.posting_id } })
    const sum = entries.reduce((acc, e) => acc.plus(e.amount), new Prisma.Decimal(0))
    expect(sum.isZero()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Task 4: Explicit capability binding
// ---------------------------------------------------------------------------

describe('Task 4: Explicit capability binding', () => {
  it('should store capabilityType on the event at ingest time', async () => {
    const eventId = `evt-cap-${Date.now()}`
    const result = await ingestEvent(tenantId, {
      device_id: deviceId,
      event_id: eventId,
      timestamp: new Date().toISOString(),
      event_type: 'telemetry',
      payload: { power_kw: 3.0, available_energy_kwh: 10, state_of_charge_pct: 80 },
      signature: 'placeholder',
    })

    const event = await db.event.findUnique({ where: { id: result.event_id } })
    expect(event?.capabilityType).toBe('energy_discharge')
  })

  it('should resolve the specific capability schema for validation, not capabilities[0]', async () => {
    // This test verifies that the worker uses the event's capabilityType to
    // find the specific capability schema. If the event has capabilityType
    // 'energy_discharge', the schema validation should validate against the
    // energy_discharge fields (power_kw, available_energy_kwh, state_of_charge_pct),
    // NOT against a different capability's fields.
    const eventId = `evt-cap-resolve-${Date.now()}`
    const timestamp = new Date().toISOString()
    const payload = { power_kw: 3.0, available_energy_kwh: 10, state_of_charge_pct: 80 }
    const seq = Math.floor(Date.now() / 1000) % 100000 + 123
    const message = buildCanonicalMessage({
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioningSecret))

    await ingestEvent(tenantId, {
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload, signature,
    })
    await processEventOutbox(tenantId)

    const event = await db.event.findUnique({
      where: { tenantId_externalEventId: { tenantId, externalEventId: eventId } },
      include: { verification: true, attestations: true },
    })

    // The event should be verified (schema validation passed against the correct capability).
    expect(event?.status).toBe('verified')

    // The schema_validation check should have passed.
    const checks = JSON.parse(event?.verification?.checksJson ?? '[]')
    const schemaCheck = checks.find((c: any) => c.name === 'schema_validation')
    expect(schemaCheck?.status).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// Task 5: Sufficient buyer funding enforcement
// ---------------------------------------------------------------------------

describe('Task 5: Sufficient buyer funding', () => {
  it('should reject reward posting when buyer funds are insufficient', async () => {
    // Create a new tenant with no buyer funding.
    const unfundedTenant = await createTenant({ name: 'Unfunded Test', slug: `unfunded-${Date.now()}`, plan: 'starter' })
    const { network, version } = await instantiateTemplate(unfundedTenant.id, 'energy-vpp')
    const operator = await createOperator(unfundedTenant.id, { displayName: 'Unfunded Operator' })
    const asset = await createAsset(unfundedTenant.id, { operatorId: operator.id, assetType: 'battery', name: 'Unfunded Battery' })
    await assignAssetToNetwork(unfundedTenant.id, asset.id, network.id, 'energy_discharge')
    const provisioned = await createDevice(unfundedTenant.id, { assetId: asset.id, deviceType: 'controller' })

    // Run the chain up to reward calculation.
    const eventId = `evt-unfunded-${Date.now()}`
    const timestamp = new Date().toISOString()
    const payload = { power_kw: 4.8, available_energy_kwh: 10, state_of_charge_pct: 80 }
    const message = buildCanonicalMessage({
      device_id: provisioned.device.id, event_id: eventId, timestamp, event_type: 'telemetry', sequence: 1, payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioned.provisioningSecret))

    await ingestEvent(unfundedTenant.id, {
      device_id: provisioned.device.id, event_id: eventId, timestamp, event_type: 'telemetry', sequence: 1, payload, signature,
      network_version_id: version?.id,
    })
    await processEventOutbox(unfundedTenant.id)

    const event = await db.event.findUnique({
      where: { tenantId_externalEventId: { tenantId: unfundedTenant.id, externalEventId: eventId } },
      include: { attestations: true },
    })
    const contribution = await createContribution(unfundedTenant.id, { attestationIds: [event!.attestations[0].id] }, `att-unfunded-${event!.attestations[0].id}`)
    const reward = await calculateReward(unfundedTenant.id, contribution.id, `contrib-unfunded-${contribution.id}`)

    // Posting to ledger should fail with insufficient funding error.
    await expect(
      postRewardToLedger(unfundedTenant.id, { rewardId: reward.id }, `reward-unfunded-${reward.id}`),
    ).rejects.toThrow(/Insufficient buyer funding/)

    // Reward should still be in 'calculated' state (not posted).
    const unpostedReward = await db.reward.findUnique({ where: { id: reward.id } })
    expect(unpostedReward?.status).toBe('calculated')
  })

  it('should accept reward posting when buyer funds are sufficient', async () => {
    // The main test tenant already has buyer funding (10000 in beforeAll).
    const eventId = `evt-funded-${Date.now()}`
    const timestamp = new Date().toISOString()
    const payload = { power_kw: 5.0, available_energy_kwh: 10, state_of_charge_pct: 80 }
    const seq = Math.floor(Date.now() / 1000) % 100000 + 456
    const message = buildCanonicalMessage({
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioningSecret))

    await ingestEvent(tenantId, {
      device_id: deviceId, event_id: eventId, timestamp, event_type: 'telemetry', sequence: seq, payload, signature,
    })
    await processEventOutbox(tenantId)

    const event = await db.event.findUnique({
      where: { tenantId_externalEventId: { tenantId, externalEventId: eventId } },
      include: { attestations: true },
    })
    const contribution = await createContribution(tenantId, { attestationIds: [event!.attestations[0].id] }, `att-funded-${event!.attestations[0].id}`)
    const reward = await calculateReward(tenantId, contribution.id, `contrib-funded-${contribution.id}`)

    // Should succeed because buyer is funded.
    const ledger = await postRewardToLedger(tenantId, { rewardId: reward.id }, `reward-funded-${reward.id}`)
    expect(ledger.duplicate).toBe(false)
    expect(ledger.breakdown.funding_sufficient).toBe(true)

    // Reward should be posted.
    const postedReward = await db.reward.findUnique({ where: { id: reward.id } })
    expect(postedReward?.status).toBe('posted')
  })
})
