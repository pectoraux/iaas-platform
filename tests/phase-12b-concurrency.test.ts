/**
 * Phase 12B Slice 2: PostgreSQL Concurrency Proof (revised)
 *
 * Three real PostgreSQL concurrency tests that force the contested conditions:
 *
 *   Test A: 8-GPU resource + identical concurrent 8-GPU request
 *           → one durable allocation/reservation, both callers converge.
 *
 *   Test B: 10-GPU resource + two different concurrent 8-GPU requests
 *           → exactly one succeeds, one fails; 8 reserved, 2 remaining.
 *
 *   Test C: 16-GPU resource + 8+8 concurrent
 *           → both succeed; 16 reserved, 0 remaining.
 *
 * These tests provision the ACTUAL universal resource stack:
 *   ResourceIdentity → NetworkResourceMembership → CapacityResource
 * and assert directly against PostgreSQL reservation/capacity totals.
 *
 * Run: DATABASE_URL=postgresql://... bun test tests/phase-12b-concurrency.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { submitNetworkRequest, type SubmitNetworkRequestInput } from '../src/lib/control-plane'

const databaseUrl = process.env.DATABASE_URL || ''
const isPostgres = databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')
const describeOrSkip = isPostgres ? describe : describe.skip

// Shared fixtures
let tenantId: string
let networkId: string
let networkVersionId: string
let requesterMembershipId: string

beforeAll(async () => {
  if (!isPostgres) return
  const tenant = await createTenant({
    name: 'Phase 12B Concurrency v2',
    slug: `p12b-concv2-${Date.now()}`,
    plan: 'growth',
  })
  tenantId = tenant.id

  const { network, version } = await instantiateTemplate(tenantId, 'protocol-network')
  networkId = network.id
  networkVersionId = version!.id

  // Create a ParticipantIdentity + ParticipantMembership + ParticipantRole
  const participant = await db.participantIdentity.create({ data: {} })
  const membership = await db.participantMembership.create({
    data: {
      participantId: participant.id,
      networkId: network.id,
      status: 'active',
    },
  })
  requesterMembershipId = membership.id
  await db.participantRole.create({
    data: { membershipId: membership.id, role: 'consumer', status: 'active' },
  })
})

/**
 * Provision a complete resource stack with a known finite capacity.
 * Creates: Asset → AssetNetworkAssignment → CapacityResource (auto from assignment)
 *          + ResourceIdentity → NetworkResourceMembership (with the capacity).
 *
 * Returns the assetId and capacityResourceId for direct DB assertions.
 */
async function provisionResource(
  capacityAmount: string,
  capabilityType: string,
  unit: string,
): Promise<{ assetId: string; resourceIdentityId: string; membershipId: string }> {
  // Create an Operator (required for Asset)
  const operator = await db.operator.create({
    data: {
      tenantId,
      organizationId: null,
      displayName: `op-${Date.now()}-${Math.random().toString(36).slice(0, 8)}`,
      status: 'active',
    },
  })

  // Create an Asset
  const asset = await db.asset.create({
    data: {
      tenantId,
      operatorId: operator.id,
      name: `asset-${Date.now()}-${Math.random().toString(36).slice(0, 8)}`,
      assetType: 'compute_node',
      status: 'active',
    },
  })

  // Create AssetNetworkAssignment with verified capacity
  await db.assetNetworkAssignment.create({
    data: {
      tenantId,
      assetId: asset.id,
      networkId,
      capabilityType,
      status: 'active',
      verifiedQuantity: capacityAmount,
      verifiedUnit: unit,
    },
  })

  // Trigger ensureCapacityResource by calling the capacity service once
  // (this creates the CapacityResource from the assignment)
  const { ensureCapacityResource } = await import('../src/lib/services/capacity.service')
  await ensureCapacityResource(tenantId, asset.id, networkId, capabilityType)

  // Create ResourceIdentity (with assetId in metadata for AssetCapacityProvider)
  const resourceIdentity = await db.resourceIdentity.create({
    data: {
      resourceKind: 'compute',
      status: 'active',
      metadataJson: JSON.stringify({ assetId: asset.id }),
    },
  })

  // Create NetworkResourceMembership
  const membership = await db.networkResourceMembership.create({
    data: {
      resourceId: resourceIdentity.id,
      networkId,
      participantMembershipId: requesterMembershipId,
      capabilitiesJson: JSON.stringify([capabilityType]),
      verifiedCapacityJson: JSON.stringify([
        { capabilityType, amount: capacityAmount, unit },
      ]),
      controlMode: 'default',
      verificationProfile: 'default',
      status: 'active',
    },
  })

  return { assetId: asset.id, resourceIdentityId: resourceIdentity.id, membershipId: membership.id }
}

/**
 * Query the total reserved amount for an asset via CapacityReservation records.
 * The capacity service tracks remaining as: physicalCapacity - sum(active reservations).
 * Note: reservedAmount is stored as String (decimal-as-string), so we sum in JS.
 */
async function getTotalReserved(assetId: string, capabilityType: string): Promise<number> {
  const resource = await db.capacityResource.findUnique({
    where: {
      assetId_networkId_capabilityType: { assetId, networkId, capabilityType },
    },
  })
  if (!resource) return -1

  const reservations = await db.capacityReservation.findMany({
    where: { resourceId: resource.id, status: 'active' },
    select: { reservedAmount: true },
  })
  return reservations.reduce((sum, r) => sum + parseFloat(r.reservedAmount), 0)
}

async function getPhysicalCapacity(assetId: string, capabilityType: string): Promise<number> {
  const resource = await db.capacityResource.findUnique({
    where: {
      assetId_networkId_capabilityType: {
        assetId,
        networkId,
        capabilityType,
      },
    },
  })
  return resource ? parseFloat(resource.physicalCapacity) : -1
}

describeOrSkip('Phase 12B Slice 2: PostgreSQL concurrency proof (revised)', () => {
  it('Test A: 8-GPU resource + identical concurrent 8-GPU request → one durable allocation', async () => {
    // Provision: 8 GPU capacity
    const { assetId } = await provisionResource('8', 'compute', 'GPU')

    const input: SubmitNetworkRequestInput = {
      requesterMembershipId,
      networkId,
      networkVersionId,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      ],
      timeWindow: {
        start: new Date('2024-07-01T00:00:00Z'),
        end: new Date('2024-07-01T04:00:00Z'),
      },
      idempotencyKey: `conc-A-${Date.now()}`,
    }

    // Launch two concurrent calls with the SAME idempotency key
    const results = await Promise.allSettled([
      submitNetworkRequest(input),
      submitNetworkRequest(input),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    // At least one must succeed
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    if (fulfilled.length === 2) {
      // Both succeeded → must be the same result (idempotent)
      const r1 = (fulfilled[0] as PromiseFulfilledResult<any>).value
      const r2 = (fulfilled[1] as PromiseFulfilledResult<any>).value
      expect(r2.decision.decisionId).toBe(r1.decision.decisionId)
      expect(r2.request.requestId).toBe(r1.request.requestId)
    }

    // Assert directly against PostgreSQL: exactly ONE NetworkRequest
    // Use the requestId from the fulfilled result (it's deterministic)
    const winner = fulfilled.length >= 1
      ? (fulfilled[0] as PromiseFulfilledResult<any>).value
      : null

    if (winner) {
      const requests = await db.networkRequest.findMany({
        where: { id: winner.request.requestId },
      })
      expect(requests.length).toBe(1)

      // Assert: exactly ONE AllocationDecision
      const decisions = await db.allocationDecision.findMany({
        where: { requestId: winner.request.requestId },
      })
      expect(decisions.length).toBe(1)

      // Assert: exactly ONE AllocationReservation
      const reservations = await db.allocationReservation.findMany({
        where: { decisionId: decisions[0].id },
      })
      expect(reservations.length).toBe(1)
      expect(reservations[0].allocatedAmount).toBe('8')
    }

    // Assert: the capacity shows 8 reserved (0 remaining of 8 total)
    const reserved = await getTotalReserved(assetId, 'compute')
    const physical = await getPhysicalCapacity(assetId, 'compute')
    expect(reserved).toBe(8)
    expect(physical - reserved).toBe(0)
  })

  it('Test B: 10-GPU resource + two different concurrent 8-GPU requests → one wins, one fails', async () => {
    // Provision: 10 GPU capacity
    const { assetId } = await provisionResource('10', 'compute', 'GPU')

    const timeWindow = {
      start: new Date('2024-07-02T00:00:00Z'),
      end: new Date('2024-07-02T04:00:00Z'),
    }

    const inputA: SubmitNetworkRequestInput = {
      requesterMembershipId,
      networkId,
      networkVersionId,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      ],
      timeWindow,
      idempotencyKey: `conc-B-A-${Date.now()}`,
    }

    const inputB: SubmitNetworkRequestInput = {
      requesterMembershipId,
      networkId,
      networkVersionId,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      ],
      timeWindow,
      idempotencyKey: `conc-B-B-${Date.now()}`,
    }

    // Launch two concurrent calls with DIFFERENT idempotency keys
    const results = await Promise.allSettled([
      submitNetworkRequest(inputA),
      submitNetworkRequest(inputB),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    // EXACTLY ONE must succeed (capacity = 10, each asks 8; 8+8=16 > 10)
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)

    // The winner has a valid allocation
    const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value
    expect(winner.decision).toBeDefined()
    // Log for debugging
    console.log('Test B winner decisionId:', winner.decision.decisionId)
    console.log('Test B winner reservations:', JSON.stringify(winner.reservations))
    expect(winner.reservations.length).toBe(1)
    expect(winner.reservations[0].allocatedAmount).toBe('8')

    // The loser gets a clean Error
    const loserError = (rejected[0] as PromiseRejectedResult).reason
    console.log('Test B loser error:', loserError.message)
    expect(loserError).toBeInstanceOf(Error)

    // Assert directly against PostgreSQL:
    // Total reserved = 8, remaining = 2 (10 - 8)
    const reserved = await getTotalReserved(assetId, 'compute')
    const physical = await getPhysicalCapacity(assetId, 'compute')
    console.log('Test B DB: reserved=', reserved, 'physical=', physical)
    expect(reserved).toBe(8)
    expect(physical - reserved).toBe(2)
  })

  it('Test C: 16-GPU resource + 8+8 concurrent → both succeed, 16 reserved, 0 remaining', async () => {
    // Provision: 16 GPU capacity
    const { assetId } = await provisionResource('16', 'compute', 'GPU')

    const timeWindow = {
      start: new Date('2024-07-03T00:00:00Z'),
      end: new Date('2024-07-03T04:00:00Z'),
    }

    const inputA: SubmitNetworkRequestInput = {
      requesterMembershipId,
      networkId,
      networkVersionId,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      ],
      timeWindow,
      idempotencyKey: `conc-C-A-${Date.now()}`,
    }

    const inputB: SubmitNetworkRequestInput = {
      requesterMembershipId,
      networkId,
      networkVersionId,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      ],
      timeWindow,
      idempotencyKey: `conc-C-B-${Date.now()}`,
    }

    // Launch two concurrent calls with DIFFERENT idempotency keys
    const results = await Promise.allSettled([
      submitNetworkRequest(inputA),
      submitNetworkRequest(inputB),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    // BOTH must succeed (capacity = 16, each asks 8; 8+8=16 = 16)
    expect(fulfilled.length).toBe(2)
    expect(rejected.length).toBe(0)

    // Distinct decision IDs
    const r1 = (fulfilled[0] as PromiseFulfilledResult<any>).value
    const r2 = (fulfilled[1] as PromiseFulfilledResult<any>).value
    expect(r2.decision.decisionId).not.toBe(r1.decision.decisionId)

    // Assert directly against PostgreSQL:
    // Total reserved = 16, remaining = 0
    const reserved = await getTotalReserved(assetId, 'compute')
    const physical = await getPhysicalCapacity(assetId, 'compute')
    expect(reserved).toBe(16)
    expect(physical - reserved).toBe(0)
  })
})
