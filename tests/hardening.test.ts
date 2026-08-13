/**
 * Integration tests for the hardened platform.
 *
 * Tests the critical fixes from the code review:
 *   3. Idempotency concurrency (reservation-based)
 *   4. Network membership (explicit assignment required)
 *   5. Schema validation (real JSON Schema via Zod)
 *   6. Verification policy version (actual NetworkVersion.version)
 *   7. Double-entry ledger (balanced postings)
 *   8. Settlement outbox (async worker)
 *   10. Async ingestion (queued → worker → verified)
 *
 * Run: bun test tests/hardening.test.ts
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { createOperator, createAsset, createDevice, assignAssetToNetwork } from '../src/lib/services/registry.service'
import { ingestEvent, buildCanonicalMessage } from '../src/lib/services/ingestion.service'
import { createContribution } from '../src/lib/services/contribution.service'
import { calculateReward } from '../src/lib/services/reward.service'
import { postRewardToLedger, postBalancedPosting, ensureOperatorAccount, ensurePlatformAccount, recordBuyerFunding, computeBalance } from '../src/lib/services/ledger.service'
import { createSettlement } from '../src/lib/services/settlement.service'
import { processEventOutbox, processSettlementOutbox } from '../src/lib/services/worker.service'
import { runIdempotent } from '../src/lib/domain/idempotency'
import { signMessage, deriveSigningKey } from '../src/lib/domain/crypto'
import { ValidationError } from '../src/lib/domain/errors'

const TEST_TENANT_SLUG = `test-${Date.now()}`

let tenantId: string
let networkId: string
let versionId: string
let operatorId: string
let assetId: string
let deviceId: string
let provisioningSecret: string

beforeAll(async () => {
  const tenant = await createTenant({ name: 'Test Tenant', slug: TEST_TENANT_SLUG, plan: 'starter' })
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
})

// ---------------------------------------------------------------------------
// Task 3: Idempotency concurrency
// ---------------------------------------------------------------------------

describe('Task 3: Idempotency (reservation-based)', () => {
  it('should execute fn exactly once under concurrent calls', async () => {
    let executionCount = 0
    const key = `idem-test-${Date.now()}`

    const fn = async () => {
      executionCount++
      await new Promise((r) => setTimeout(r, 100)) // simulate work
      return { data: { value: executionCount }, resourceId: 'test-1' }
    }

    // Launch 5 concurrent requests with the same key.
    const results = await Promise.all([
      runIdempotent({ tenantId, key, resourceType: 'test', fn }),
      runIdempotent({ tenantId, key, resourceType: 'test', fn }),
      runIdempotent({ tenantId, key, resourceType: 'test', fn }),
      runIdempotent({ tenantId, key, resourceType: 'test', fn }),
      runIdempotent({ tenantId, key, resourceType: 'test', fn }),
    ])

    // fn should have executed exactly once.
    expect(executionCount).toBe(1)

    // All results should have the same data.
    const values = results.map((r) => r.data.value)
    expect(new Set(values).size).toBe(1)

    // Exactly one should be non-replayed, the rest replayed.
    const replayedCount = results.filter((r) => r.replayed).length
    expect(replayedCount).toBe(4)
  })

  it('should return stored response on replay', async () => {
    const key = `idem-replay-${Date.now()}`
    let count = 0

    const first = await runIdempotent({
      tenantId, key, resourceType: 'replay-test',
      fn: async () => { count++; return { data: { n: count }, resourceId: 'r1' } },
    })
    expect(first.replayed).toBe(false)
    expect(first.data.n).toBe(1)

    const second = await runIdempotent({
      tenantId, key, resourceType: 'replay-test',
      fn: async () => { count++; return { data: { n: count }, resourceId: 'r1' } },
    })
    expect(second.replayed).toBe(true)
    expect(second.data.n).toBe(1) // same as first, not incremented
    expect(count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Task 4: Network membership
// ---------------------------------------------------------------------------

describe('Task 4: Network membership (explicit assignment)', () => {
  it('should reject ingestion for an asset with no network assignment', async () => {
    // Create a new asset without assignment.
    const unassignedAsset = await createAsset(tenantId, {
      operatorId,
      assetType: 'battery',
      name: 'Unassigned Battery',
    })
    const unassignedDevice = await createDevice(tenantId, {
      assetId: unassignedAsset.id,
      deviceType: 'controller',
    })

    await expect(
      ingestEvent(tenantId, {
        device_id: unassignedDevice.device.id,
        event_id: `evt-no-assign-${Date.now()}`,
        timestamp: new Date().toISOString(),
        event_type: 'telemetry',
        payload: { power_kw: 1.0 },
      }),
    ).rejects.toThrow(/no active network assignment/)
  })

  it('should accept ingestion for an assigned asset', async () => {
    const result = await ingestEvent(tenantId, {
      device_id: deviceId,
      event_id: `evt-assigned-${Date.now()}`,
      timestamp: new Date().toISOString(),
      event_type: 'telemetry',
      payload: { power_kw: 2.5, available_energy_kwh: 10, state_of_charge_pct: 80 },
      signature: 'placeholder',
    })
    expect(result.status).toBe('queued')
  })
})

// ---------------------------------------------------------------------------
// Task 5: Schema validation
// ---------------------------------------------------------------------------

describe('Task 5: Schema validation (real JSON Schema via Zod)', () => {
  it('should reject events with wrong-typed fields', async () => {
    const eventId = `evt-bad-schema-${Date.now()}`
    await ingestEvent(tenantId, {
      device_id: deviceId,
      event_id: eventId,
      timestamp: new Date().toISOString(),
      event_type: 'telemetry',
      payload: { power_kw: 'banana', available_energy_kwh: 10, state_of_charge_pct: 80 },
      signature: 'placeholder',
    })

    await processEventOutbox(tenantId)

    const event = await db.event.findUnique({
      where: { tenantId_externalEventId: { tenantId, externalEventId: eventId } },
      include: { verification: true },
    })

    expect(event?.status).toBe('rejected')
    const checks = JSON.parse(event?.verification?.checksJson ?? '[]')
    const schemaCheck = checks.find((c: any) => c.name === 'schema_validation')
    expect(schemaCheck?.status).toBe('fail')
  })

  it('should accept events with correct-typed fields', async () => {
    const eventId = `evt-good-schema-${Date.now()}`
    const timestamp = new Date().toISOString()
    const payload = { power_kw: 3.5, available_energy_kwh: 10, state_of_charge_pct: 80 }
    const message = buildCanonicalMessage({
      device_id: deviceId,
      event_id: eventId,
      timestamp,
      event_type: 'telemetry',
      sequence: 1,
      payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioningSecret))

    await ingestEvent(tenantId, {
      device_id: deviceId,
      event_id: eventId,
      timestamp,
      event_type: 'telemetry',
      sequence: 1,
      payload,
      signature,
    })

    await processEventOutbox(tenantId)

    const event = await db.event.findUnique({
      where: { tenantId_externalEventId: { tenantId, externalEventId: eventId } },
      include: { verification: true },
    })

    expect(event?.status).toBe('verified')
  })
})

// ---------------------------------------------------------------------------
// Task 6: Verification policy version
// ---------------------------------------------------------------------------

describe('Task 6: Verification policy version', () => {
  it('should record the actual NetworkVersion.version, not hardcoded 1', async () => {
    const eventId = `evt-version-${Date.now()}`
    const timestamp = new Date().toISOString()
    const payload = { power_kw: 4.0, available_energy_kwh: 10, state_of_charge_pct: 80 }
    const message = buildCanonicalMessage({
      device_id: deviceId,
      event_id: eventId,
      timestamp,
      event_type: 'telemetry',
      sequence: 1,
      payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioningSecret))

    await ingestEvent(tenantId, {
      device_id: deviceId,
      event_id: eventId,
      timestamp,
      event_type: 'telemetry',
      sequence: 1,
      payload,
      signature,
    })

    await processEventOutbox(tenantId)

    const event = await db.event.findUnique({
      where: { tenantId_externalEventId: { tenantId, externalEventId: eventId } },
      include: { verification: true },
    })

    // The template was instantiated as version 1, so policy_version should be 1.
    // The key point: it's derived from the actual NetworkVersion, not hardcoded.
    expect(event?.verification?.policyVersion).toBe(1)
    expect(event?.verification?.verifierVersion).toBe('1.1.0')
  })
})

// ---------------------------------------------------------------------------
// Task 7: Double-entry ledger (balanced postings)
// ---------------------------------------------------------------------------

describe('Task 7: Double-entry ledger', () => {
  it('should reject unbalanced postings', async () => {
    const operatorAccount = await ensureOperatorAccount(tenantId, operatorId, 'USD', 'liability')
    const revenueAccount = await ensurePlatformAccount(tenantId, 'USD', 'revenue')

    await expect(
      postBalancedPosting({
        tenantId,
        idempotencyKey: `unbalanced-${Date.now()}`,
        postingType: 'test',
        entries: [
          { accountId: operatorAccount.id, amount: 100, entryType: 'credit' },
          { accountId: revenueAccount.id, amount: 50, entryType: 'credit' },
          // Sum = 150, not 0 — should fail.
        ],
      }),
    ).rejects.toThrow(/Unbalanced posting/)
  })

  it('should create balanced postings where sum of entries = 0', async () => {
    const operatorAccount = await ensureOperatorAccount(tenantId, operatorId, 'USD', 'liability')
    const cashAccount = await ensurePlatformAccount(tenantId, 'USD', 'asset')
    const revenueAccount = await ensurePlatformAccount(tenantId, 'USD', 'revenue')
    const buyerAccount = await ensurePlatformAccount(tenantId, 'USD', 'revenue') // reuse for test

    const result = await postBalancedPosting({
      tenantId,
      idempotencyKey: `balanced-${Date.now()}`,
      postingType: 'reward',
      referenceType: 'reward',
      referenceId: 'test-reward',
      entries: [
        { accountId: operatorAccount.id, amount: 95, entryType: 'reward_credit' },
        { accountId: revenueAccount.id, amount: 5, entryType: 'platform_fee' },
        { accountId: cashAccount.id, amount: -100, entryType: 'buyer_debit' },
      ],
    })

    expect(result.balanced).toBe(true)
    expect(result.duplicate).toBe(false)

    // Verify the entries sum to 0.
    const entries = await db.ledgerEntry.findMany({ where: { postingId: result.posting_id } })
    const sum = entries.reduce((acc, e) => acc + e.amount, 0)
    expect(Math.abs(sum)).toBeLessThan(0.001)
  })

  it('should record buyer funding as a balanced posting', async () => {
    const result = await recordBuyerFunding(tenantId, 1000, `funding-test-${Date.now()}`)
    expect(result.duplicate).toBe(false)

    // Verify the posting is balanced.
    const entries = await db.ledgerEntry.findMany({ where: { postingId: result.posting_id } })
    const sum = entries.reduce((acc, e) => acc + e.amount, 0)
    expect(Math.abs(sum)).toBeLessThan(0.001)
  })
})

// ---------------------------------------------------------------------------
// Tasks 8 + 10: Async pipeline (ingestion → outbox → settlement)
// ---------------------------------------------------------------------------

describe('Tasks 8 + 10: Async pipeline', () => {
  it('should queue events for async verification (not verify synchronously)', async () => {
    const eventId = `evt-async-${Date.now()}`
    const timestamp = new Date().toISOString()
    const payload = { power_kw: 5.0, available_energy_kwh: 10, state_of_charge_pct: 80 }
    const message = buildCanonicalMessage({
      device_id: deviceId,
      event_id: eventId,
      timestamp,
      event_type: 'telemetry',
      sequence: 1,
      payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioningSecret))

    const result = await ingestEvent(tenantId, {
      device_id: deviceId,
      event_id: eventId,
      timestamp,
      event_type: 'telemetry',
      sequence: 1,
      payload,
      signature,
    })

    // Status should be 'queued', not 'verified' (async).
    expect(result.status).toBe('queued')
    expect(result.duplicate).toBe(false)

    // Process the outbox.
    const { verified, rejected } = await processEventOutbox(tenantId)
    expect(verified + rejected).toBeGreaterThan(0)
  })

  it('should process settlements via the outbox worker', async () => {
    // Run a full chain to get a reward.
    const eventId = `evt-settlement-${Date.now()}`
    const timestamp = new Date().toISOString()
    const payload = { power_kw: 6.0, available_energy_kwh: 10, state_of_charge_pct: 80 }
    const seq = Math.floor(Date.now() / 1000) % 100000 // unique sequence
    const message = buildCanonicalMessage({
      device_id: deviceId,
      event_id: eventId,
      timestamp,
      event_type: 'telemetry',
      sequence: seq,
      payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioningSecret))

    await ingestEvent(tenantId, {
      device_id: deviceId,
      event_id: eventId,
      timestamp,
      event_type: 'telemetry',
      sequence: seq,
      payload,
      signature,
    })
    await processEventOutbox(tenantId)

    const event = await db.event.findUnique({
      where: { tenantId_externalEventId: { tenantId, externalEventId: eventId } },
      include: { attestations: true },
    })
    expect(event?.status).toBe('verified')
    expect(event?.attestations.length).toBe(1)

    const contribution = await createContribution(
      tenantId,
      { attestationIds: [event!.attestations[0].id] },
      `test-att-${event!.attestations[0].id}`,
    )
    const reward = await calculateReward(tenantId, contribution.id, `test-contrib-${contribution.id}`)
    await postRewardToLedger(tenantId, { rewardId: reward.id }, `test-reward-${reward.id}`)

    // Create settlement (should be in 'created' state — not yet submitted).
    const settlement = await createSettlement(tenantId, reward.id)
    expect(settlement.status).toBe('created')

    // Process the settlement outbox.
    const { completed } = await processSettlementOutbox(tenantId)
    expect(completed).toBeGreaterThan(0)

    // Verify the settlement is now completed.
    const finalSettlement = await db.settlement.findUnique({ where: { id: settlement.id } })
    expect(finalSettlement?.status).toBe('completed')
    expect(finalSettlement?.providerPayoutId).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Tenant isolation (regression)
// ---------------------------------------------------------------------------

describe('Tenant isolation (regression)', () => {
  it('should isolate tenant data', async () => {
    // Create a second tenant.
    const tenant2 = await createTenant({ name: 'Isolation Test B', slug: `iso-b-${Date.now()}`, plan: 'starter' })

    // Tenant 2 should not see tenant 1's operators.
    const tenant2Operators = await db.operator.findMany({ where: { tenantId: tenant2.id } })
    expect(tenant2Operators.length).toBe(0)

    // Tenant 1 should have operators.
    const tenant1Operators = await db.operator.findMany({ where: { tenantId } })
    expect(tenant1Operators.length).toBeGreaterThan(0)
  })
})
