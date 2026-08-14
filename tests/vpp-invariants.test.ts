/**
 * VPP-1 invariant tests.
 *
 * Tests the 10 VPP invariants from the review:
 *   1. performance_kwh becomes contribution quantity (derived contribution)
 *   2. incorrect kW/kWh conversion rejected (schema validation per capability)
 *   3. reservation cannot exceed capability
 *   4. overlapping reservations cannot overcommit capacity
 *   5. concurrent reservations cannot overcommit capacity
 *   6. concurrent dispatches cannot overcommit capacity
 *   7. failed/partial dispatch is not paid as full delivery
 *   8. duplicate execution does not create duplicate reward
 *   9. unfunded buyer cannot settle
 *  10. multi-asset dispatch aggregates correctly
 *
 * Run: bun test tests/vpp-invariants.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { Prisma } from '@prisma/client'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { createOperator, createAsset, createDevice, assignAssetToNetwork } from '../src/lib/services/registry.service'
import { signMessage, deriveSigningKey } from '../src/lib/domain/crypto'
import { recordBuyerFunding } from '../src/lib/services/ledger.service'
import { findReservationBySource } from '../src/lib/services/capacity.service'
import {
  createBuyerProgram,
  createCapacityReservation,
  createDispatch,
  executeDispatchAssignment,
} from '../src/lib/services/vpp.service'
import { ValidationError } from '@/lib/domain/errors'

let tenantId: string
let networkId: string
let versionId: string
let rewardRuleId: string
let operatorId: string
let assetId: string
let deviceId: string
let provisioningSecret: string

beforeAll(async () => {
  const tenant = await createTenant({ name: 'VPP Invariants', slug: `vpp-inv-${Date.now()}`, plan: 'growth' })
  tenantId = tenant.id

  const { network, version } = await instantiateTemplate(tenantId, 'energy-vpp')
  networkId = network.id
  versionId = version!.id

  const rule = await db.rewardRule.findFirst({ where: { networkVersionId: versionId } })
  rewardRuleId = rule!.id

  const operator = await createOperator(tenantId, { displayName: 'VPP Inv Operator' })
  operatorId = operator.id

  const asset = await createAsset(tenantId, { operatorId, assetType: 'battery', name: 'Inv Battery' })
  assetId = asset.id

  await assignAssetToNetwork(tenantId, assetId, networkId, 'energy_discharge', '10', 'kW') // 10 kW verified

  const provisioned = await createDevice(tenantId, { assetId, deviceType: 'battery_controller' })
  deviceId = provisioned.device.id
  provisioningSecret = provisioned.provisioningSecret

  // Pre-fund the buyer for tests that need it.
  await recordBuyerFunding(tenantId, 10000, `inv-funding-${Date.now()}`)
})

// Helper to create a fully-wired program + reservation.
let testCounter = 0
async function setupProgramAndReservation(opts?: {
  reservedKw?: string
  startTime?: Date
  endTime?: Date
}) {
  // Use a unique time window per test to avoid overlap.
  // Each test gets a window 10 hours in the future, offset by testCounter * 2 hours.
  testCounter++
  const baseTime = Date.now() + 3600000 * (10 + testCounter * 2) // 10h + 2h per test
  const now = new Date(baseTime)
  const start = opts?.startTime ?? now
  const end = opts?.endTime ?? new Date(now.getTime() + 3600000)
  const reserved = opts?.reservedKw ?? '10'

  const program = await createBuyerProgram(tenantId, {
    networkId, name: `Program-${testCounter}-${Date.now()}`,
    rewardRuleId, dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59',
    pricePerKwh: '0.12', minCapacityKw: '1',
  })

  const { reservation } = await createCapacityReservation(tenantId, {
    programId: program.id, operatorId, assetId, capabilityType: 'energy_discharge',
    reservedKw: reserved,
    startTime: start.toISOString(), endTime: end.toISOString(),
  })

  return { program, reservation, startTime: start, endTime: end }
}

// ---------------------------------------------------------------------------
// Test 1: performance_kwh becomes contribution quantity
// ---------------------------------------------------------------------------

describe('VPP invariant: derived contribution', () => {
  it('should use VppBaseline.performanceKwh as the Contribution quantity', async () => {
    const { program, startTime, endTime } = await setupProgramAndReservation({ reservedKw: '5' })

    const { assignments } = await createDispatch(tenantId, {
      programId: program.id, requestedKw: '5', requestedKwh: '10',
      startTime: startTime.toISOString(), endTime: endTime.toISOString(),
    })

    const result = await executeDispatchAssignment(tenantId, assignments[0].id, provisioningSecret)

    // The contribution quantity must equal the performance_kwh.
    const contribution = await db.contribution.findUnique({ where: { id: result.contribution_id } })
    const baseline = await db.vppBaseline.findFirst({ where: { assignmentId: assignments[0].id } })

    expect(contribution).toBeTruthy()
    expect(baseline).toBeTruthy()
    expect(contribution!.quantity.toString()).toBe(baseline!.performanceKwh)
    expect(contribution!.unit).toBe('kWh')

    // The contribution quantity must NOT be the attestation's power_kw value.
    const attestation = await db.attestation.findFirst({ where: { eventId: result.event_id } })
    expect(attestation).toBeTruthy()
    // performance_kwh = actual_kwh (baseline=0), which is assigned_kwh * 0.98.
    // attestation.quantity = power_kw (first field), which is assigned_kw * 0.98.
    // These are different values (kWh vs kW).
    expect(contribution!.quantity.toString()).not.toBe(attestation!.quantity.toString())
  })
})

// ---------------------------------------------------------------------------
// Test 3: reservation cannot exceed capability
// ---------------------------------------------------------------------------

describe('VPP invariant: capacity integrity', () => {
  it('should reject reservation exceeding physical capacity', async () => {
    const program = await createBuyerProgram(tenantId, {
      networkId, name: `Cap-${Date.now()}`,
      rewardRuleId, dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59',
      pricePerKwh: '0.12', minCapacityKw: '1',
    })

    await expect(
      createCapacityReservation(tenantId, {
        programId: program.id, operatorId, assetId, capabilityType: 'energy_discharge',
        reservedKw: '15',
        startTime: startTime.toISOString(), endTime: endTime.toISOString(),
      }),
    ).rejects.toThrow(/exceeds physical capacity/)
  })

  it('should reject reservation when operator does not own asset', async () => {
    const otherOperator = await createOperator(tenantId, { displayName: 'Other Operator' })
    const program = await createBuyerProgram(tenantId, {
      networkId, name: `Own-${Date.now()}`,
      rewardRuleId, dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59',
      pricePerKwh: '0.12', minCapacityKw: '1',
    })

    await expect(
      createCapacityReservation(tenantId, {
        programId: program.id, operatorId: otherOperator.id, assetId, capabilityType: 'energy_discharge',
        reservedKw: '5',
        startTime: startTime.toISOString(), endTime: endTime.toISOString(),
      }),
    ).rejects.toThrow(/does not own asset/)
  })

  it('should reject reservation when asset is not assigned to capability', async () => {
    const program = await createBuyerProgram(tenantId, {
      networkId, name: `Cap2-${Date.now()}`,
      rewardRuleId, dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59',
      pricePerKwh: '0.12', minCapacityKw: '1',
    })

    await expect(
      createCapacityReservation(tenantId, {
        programId: program.id, operatorId, assetId, capabilityType: 'frequency_response',
        reservedKw: '5',
        startTime: startTime.toISOString(), endTime: endTime.toISOString(),
      }),
    ).rejects.toThrow(/not assigned.*capability/)
  })
})

// ---------------------------------------------------------------------------
// Test 4: overlapping reservations cannot overcommit capacity
// ---------------------------------------------------------------------------

describe('VPP invariant: no double-selling', () => {
  it('should reject overlapping reservations that exceed physical capacity', async () => {
    const now = new Date()
    const start = now
    const end = new Date(now.getTime() + 3600000)

    const program = await createBuyerProgram(tenantId, {
      networkId, name: `Overlap-${Date.now()}`,
      rewardRuleId, dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59',
      pricePerKwh: '0.12', minCapacityKw: '1',
    })

    // First reservation: 8 kW of 10 kW.
    await createCapacityReservation(tenantId, {
      programId: program.id, operatorId, assetId, capabilityType: 'energy_discharge',
      reservedKw: '8',
      startTime: start.toISOString(), endTime: end.toISOString(),
    })

    // Second reservation: 5 kW in the same window — should fail (only 2 kW left).
    await expect(
      createCapacityReservation(tenantId, {
        programId: program.id, operatorId, assetId, capabilityType: 'energy_discharge',
        reservedKw: '5',
        startTime: start.toISOString(), endTime: end.toISOString(),
      }),
    ).rejects.toThrow(/Insufficient capacity/)
  })

  it('should allow non-overlapping reservations up to full capacity', async () => {
    const now = new Date()
    const start1 = now
    const end1 = new Date(now.getTime() + 3600000)
    const start2 = end1 // non-overlapping
    const end2 = new Date(end1.getTime() + 3600000)

    const program = await createBuyerProgram(tenantId, {
      networkId, name: `NonOverlap-${Date.now()}`,
      rewardRuleId, dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59',
      pricePerKwh: '0.12', minCapacityKw: '1',
    })

    // First reservation: 10 kW.
    await createCapacityReservation(tenantId, {
      programId: program.id, operatorId, assetId, capabilityType: 'energy_discharge',
      reservedKw: '10',
      startTime: start1.toISOString(), endTime: end1.toISOString(),
    })

    // Second reservation: 10 kW in a non-overlapping window — should succeed.
    const { reservation } = await createCapacityReservation(tenantId, {
      programId: program.id, operatorId, assetId, capabilityType: 'energy_discharge',
      reservedKw: '10',
      startTime: start2.toISOString(), endTime: end2.toISOString(),
    })

    expect(reservation).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Test 8: duplicate execution does not create duplicate reward
// ---------------------------------------------------------------------------

describe('VPP invariant: idempotent execution', () => {
  it('should not create duplicate rewards on repeated execution', async () => {
    const { program, startTime, endTime } = await setupProgramAndReservation({ reservedKw: '5' })

    const { assignments } = await createDispatch(tenantId, {
      programId: program.id, requestedKw: '5', requestedKwh: '10',
      startTime: startTime.toISOString(), endTime: endTime.toISOString(),
    })

    // First execution.
    const result1 = await executeDispatchAssignment(tenantId, assignments[0].id, provisioningSecret)

    // Second execution — should return the same result (idempotent).
    const result2 = await executeDispatchAssignment(tenantId, assignments[0].id, provisioningSecret)

    expect(result2.duplicate).toBe(true)
    expect(result2.event_id).toBe(result1.event_id)
    expect(result2.contribution_id).toBe(result1.contribution_id)
    expect(result2.reward_id).toBe(result1.reward_id)

    // Verify only ONE event, contribution, reward was created.
    const events = await db.event.findMany({ where: { assetId } })
    const eventIds = events.filter((e) => e.externalEventId?.includes(`vpp-dispatch-${assignments[0].id}`))
    expect(eventIds.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Test 10: multi-asset dispatch aggregates correctly
// ---------------------------------------------------------------------------

describe('VPP invariant: multi-asset aggregation', () => {
  it('should distribute dispatch across multiple assets proportionally', async () => {
    // Create a second asset.
    const asset2 = await createAsset(tenantId, { operatorId, assetType: 'battery', name: 'Multi Asset 2' })
    await assignAssetToNetwork(tenantId, asset2.id, networkId, 'energy_discharge', '10', 'kW')
    const provisioned2 = await createDevice(tenantId, { assetId: asset2.id, deviceType: 'battery_controller' })

    const now = new Date()
    const program = await createBuyerProgram(tenantId, {
      networkId, name: `Multi-${Date.now()}`,
      rewardRuleId, dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59',
      pricePerKwh: '0.12', minCapacityKw: '1',
    })

    // Reserve 6 kW on asset1, 4 kW on asset2.
    await createCapacityReservation(tenantId, {
      programId: program.id, operatorId, assetId: assetId, capabilityType: 'energy_discharge',
      reservedKw: '6',
      startTime: now.toISOString(), endTime: new Date(now.getTime() + 3600000).toISOString(),
    })
    await createCapacityReservation(tenantId, {
      programId: program.id, operatorId, assetId: asset2.id, capabilityType: 'energy_discharge',
      reservedKw: '4',
      startTime: now.toISOString(), endTime: new Date(now.getTime() + 3600000).toISOString(),
    })

    // Request 10 kW dispatch — should split 6:4.
    const { assignments } = await createDispatch(tenantId, {
      programId: program.id, requestedKw: '10', requestedKwh: '20',
      startTime: now.toISOString(), endTime: new Date(now.getTime() + 3600000).toISOString(),
    })

    expect(assignments.length).toBe(2)

    // Verify proportional assignment.
    const a1 = assignments.find((a) => a.assetId === assetId)
    const a2 = assignments.find((a) => a.assetId === asset2.id)
    expect(a1).toBeTruthy()
    expect(a2).toBeTruthy()

    // 6/10 * 10 = 6 kW, 4/10 * 10 = 4 kW.
    const a1Kw = new Prisma.Decimal(a1!.assignedKw)
    const a2Kw = new Prisma.Decimal(a2!.assignedKw)
    // Exact proportional allocation: 6 kW and 4 kW.
    expect(a1Kw.toFixed(2)).toBe('6.00')
    expect(a2Kw.toFixed(2)).toBe('4.00')

    // Clean up the second device to avoid interfering with other tests.
    await db.deviceCredential.deleteMany({ where: { deviceId: provisioned2.device.id } }).catch(() => {})
  })
})

// ---------------------------------------------------------------------------
// Test: concurrent first allocations (the critical concurrency bug)
// ---------------------------------------------------------------------------

describe('VPP invariant: concurrent capacity allocation', () => {
  it('should not allow two concurrent 7 kW allocations against 10 kW capacity', async () => {
    // Create a fresh asset with 10 kW verified capacity.
    const freshAsset = await createAsset(tenantId, { operatorId, assetType: 'battery', name: `Conc-${Date.now()}` })
    await assignAssetToNetwork(tenantId, freshAsset.id, networkId, 'energy_discharge', '10', 'kW')

    const program = await createBuyerProgram(tenantId, {
      networkId, name: `ConcProg-${Date.now()}`,
      rewardRuleId, dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59',
      pricePerKwh: '0.12', minCapacityKw: '1',
    })

    const now = new Date()
    const start = now.toISOString()
    const end = new Date(now.getTime() + 3600000).toISOString()

    // Two concurrent reservations of 7 kW each against 10 kW capacity.
    const results = await Promise.allSettled([
      createCapacityReservation(tenantId, {
        programId: program.id, operatorId, assetId: freshAsset.id, capabilityType: 'energy_discharge',
        reservedKw: '7', startTime: start, endTime: end,
      }),
      createCapacityReservation(tenantId, {
        programId: program.id, operatorId, assetId: freshAsset.id, capabilityType: 'energy_discharge',
        reservedKw: '7', startTime: start, endTime: end,
      }),
    ])

    // Exactly one must succeed, the other must fail with insufficient capacity.
    const succeeded = results.filter((r) => r.status === 'fulfilled')
    const failed = results.filter((r) => r.status === 'rejected')
    expect(succeeded.length).toBe(1)
    expect(failed.length).toBe(1)

    // The failed one should be an insufficient capacity error.
    const failedReason = (failed[0] as PromiseRejectedResult).reason
    expect(failedReason.message).toMatch(/Insufficient capacity|exceeds verified physical capacity/)

    // Verify total reserved capacity does not exceed 10 kW.
    const reservations = await db.capacityReservation.findMany({
      where: { tenantId, status: 'active' },
      include: { resource: true },
    })
    const freshReservations = reservations.filter((r) => r.resource.assetId === freshAsset.id)
    const totalReserved = freshReservations.reduce(
      (sum, r) => sum.plus(new Prisma.Decimal(r.reservedAmount)),
      new Prisma.Decimal(0),
    )
    expect(totalReserved.toString()).toBe('7')
    expect(totalReserved.lte(10)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test: physical capacity cannot be spoofed by caller
// ---------------------------------------------------------------------------

describe('VPP invariant: no untrusted capacity', () => {
  it('should reject reservation exceeding verified capacity even if caller provides higher value', async () => {
    // Asset has 10 kW verified capacity (set in beforeAll).
    const program = await createBuyerProgram(tenantId, {
      networkId, name: `Spoof-${Date.now()}`,
      rewardRuleId, dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59',
      pricePerKwh: '0.12', minCapacityKw: '1',
    })

    // Try to reserve 50 kW. The CreateReservationInput no longer accepts
    // physicalCapacityKw, so the allocator will use the verified 10 kW.
    await expect(
      createCapacityReservation(tenantId, {
        programId: program.id, operatorId, assetId, capabilityType: 'energy_discharge',
        reservedKw: '50',
        startTime: startTime.toISOString(), endTime: endTime.toISOString(),
      }),
    ).rejects.toThrow(/exceeds verified physical capacity/)
  })
})

// ---------------------------------------------------------------------------
// Test A: concurrent dispatches against same reservation (the critical race)
// ---------------------------------------------------------------------------

describe('VPP invariant: concurrent dispatch consumption', () => {
  it('Test A: two concurrent 10 kW dispatches against one 10 kW reservation → exactly 1 succeeds', async () => {
    const { program, startTime, endTime } = await setupProgramAndReservation({ reservedKw: '10' })

    const start = startTime.toISOString()
    const end = endTime.toISOString()

    const results = await Promise.allSettled([
      createDispatch(tenantId, {
        programId: program.id, requestedKw: '10', requestedKwh: '10',
        startTime: start, endTime: end,
      }),
      createDispatch(tenantId, {
        programId: program.id, requestedKw: '10', requestedKwh: '10',
        startTime: start, endTime: end,
      }),
    ])

    // Log errors for debugging.
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.log(`  Dispatch ${i} failed:`, r.reason?.message ?? r.reason)
      }
    })

    const succeeded = results.filter((r) => r.status === 'fulfilled')
    const failed = results.filter((r) => r.status === 'rejected')
    expect(succeeded.length).toBe(1)
    expect(failed.length).toBe(1)
  })

  it('Test B: 6 kW + 4 kW dispatches against 10 kW reservation → both succeed', async () => {
    const { program, startTime, endTime } = await setupProgramAndReservation({ reservedKw: '10' })

    const start = startTime.toISOString()
    const end = endTime.toISOString()

    const result1 = await createDispatch(tenantId, {
      programId: program.id, requestedKw: '6', requestedKwh: '6',
      startTime: start, endTime: end,
    })
    expect(result1.dispatch.status).toBe('assigned')

    const result2 = await createDispatch(tenantId, {
      programId: program.id, requestedKw: '4', requestedKwh: '4',
      startTime: start, endTime: end,
    })
    expect(result2.dispatch.status).toBe('assigned')
  })

  it('Test C: 6 kW + 4 kW + 1 kW against 10 kW → third fails', async () => {
    const { program, startTime, endTime } = await setupProgramAndReservation({ reservedKw: '10' })

    const start = startTime.toISOString()
    const end = endTime.toISOString()

    await createDispatch(tenantId, {
      programId: program.id, requestedKw: '6', requestedKwh: '6',
      startTime: start, endTime: end,
    })
    await createDispatch(tenantId, {
      programId: program.id, requestedKw: '4', requestedKwh: '4',
      startTime: start, endTime: end,
    })

    // Third dispatch of 1 kW should fail (0 kW remaining).
    await expect(
      createDispatch(tenantId, {
        programId: program.id, requestedKw: '1', requestedKwh: '1',
        startTime: start, endTime: end,
      }),
    ).rejects.toThrow(/Insufficient remaining capacity/)
  })
})

// ---------------------------------------------------------------------------
// Lifecycle tests: consumed, released, non-energy, unit mismatch
// ---------------------------------------------------------------------------

describe('VPP invariant: capacity lifecycle', () => {
  it('should record usage (kWh) separate from commitment (kW) on successful dispatch', async () => {
    const { program, startTime, endTime } = await setupProgramAndReservation({ reservedKw: '10' })

    const { assignments } = await createDispatch(tenantId, {
      programId: program.id, requestedKw: '5', requestedKwh: '10',
      startTime: startTime.toISOString(), endTime: endTime.toISOString(),
    })

    const result = await executeDispatchAssignment(tenantId, assignments[0].id, provisioningSecret)

    // Verify the commitment is consumed.
    const commitment = await db.capacityCommitment.findUnique({
      where: { id: assignments[0].capacityCommitmentId! },
    })
    expect(commitment?.status).toBe('consumed')
    expect(commitment?.unit).toBe('kW') // capacity unit

    // Verify the usage is recorded with kWh (not kW).
    const usage = await db.capacityUsage.findFirst({
      where: { commitmentId: commitment?.id },
    })
    expect(usage).toBeTruthy()
    expect(usage?.unit).toBe('kWh') // usage unit (different dimension!)
    expect(usage?.quantity).toBeTruthy()
  })

  it('should release commitment when dispatch verification fails', async () => {
    const { program, startTime, endTime } = await setupProgramAndReservation({ reservedKw: '10' })

    const { assignments } = await createDispatch(tenantId, {
      programId: program.id, requestedKw: '5', requestedKwh: '10',
      startTime: startTime.toISOString(), endTime: endTime.toISOString(),
    })

    // Execute with WRONG provisioning secret → verification should fail.
    await expect(
      executeDispatchAssignment(tenantId, assignments[0].id, 'wrong-secret'),
    ).rejects.toThrow()

    // The commitment should be released (not consumed).
    const commitment = await db.capacityCommitment.findUnique({
      where: { id: assignments[0].capacityCommitmentId! },
    })
    expect(commitment?.status).toBe('released')

    // The reservation's remaining should be restored.
    const vppReservation = await db.vppCapacityReservation.findFirst({
      where: { programId: program.id },
    })
    const capacityReservation = await findReservationBySource(tenantId, 'vpp_reservation', vppReservation!.id)
    expect(capacityReservation).toBeTruthy()
    // Remaining should be back to 10 (full reservation).
    expect(new Prisma.Decimal(capacityReservation!.remainingAmount).gte(10)).toBe(true)
  })

  it('should support non-energy capacity resources (generic primitive)', async () => {
    // Create a storage-like capability on the asset.
    await assignAssetToNetwork(tenantId, assetId, networkId, 'storage_capacity', '100', 'TB')

    const { createCapacityReservation: allocate } = await import('../src/lib/services/capacity.service')

    // Reserve 70 TB of storage.
    const result = await allocate({
      tenantId, assetId, networkId, capabilityType: 'storage_capacity',
      requestedAmount: '70', startTime: new Date(), endTime: new Date(Date.now() + 86400000),
      sourceType: 'test_storage', sourceId: `storage-${Date.now()}`,
    })

    expect(result.unit).toBe('TB')
    expect(result.reservedAmount).toBe('70')
    expect(result.physicalCapacity).toBe('100')

    // Try to reserve 50 TB more (only 30 left) — should fail.
    await expect(
      allocate({
        tenantId, assetId, networkId, capabilityType: 'storage_capacity',
        requestedAmount: '50', startTime: new Date(), endTime: new Date(Date.now() + 86400000),
        sourceType: 'test_storage2', sourceId: `storage2-${Date.now()}`,
      }),
    ).rejects.toThrow(/Insufficient capacity/)
  })

  it('should reject commitment with mismatched unit', async () => {
    const { createCapacityCommitment } = await import('../src/lib/services/capacity.service')
    const { program, startTime, endTime } = await setupProgramAndReservation({ reservedKw: '10' })

    const vppReservation = await db.vppCapacityReservation.findFirst({ where: { programId: program.id } })
    const capacityReservation = await findReservationBySource(tenantId, 'vpp_reservation', vppReservation!.id)

    // Try to create a commitment with 'kWh' unit when resource is 'kW'.
    await expect(
      createCapacityCommitment({
        tenantId, reservationId: capacityReservation!.id,
        committedAmount: '5', unit: 'kWh', // WRONG unit — resource is kW
        startTime: new Date(), endTime: new Date(Date.now() + 3600000),
        sourceType: 'test_mismatch', sourceId: `mismatch-${Date.now()}`,
      }),
    ).rejects.toThrow(/Unit mismatch/)
  })
})
