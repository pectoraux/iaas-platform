/**
 * Phase 12B Slice 2: PostgreSQL Concurrency Proof (isolated fixtures)
 *
 * Each test provisions a COMPLETELY FRESH topology — its own Tenant, Network,
 * published NetworkVersion, ParticipantMembership, and single Resource — so
 * the deterministic scheduler has EXACTLY ONE eligible candidate.
 *
 * This isolates the capacity-concurrency primitive (FOR UPDATE + overlap
 * arithmetic) from candidate selection. A shared network accidentally turns
 * the "single-resource" test into a "multi-resource" test, where the scheduler
 * may select a resource that was already exhausted by an earlier test.
 *
 *   Test A: 8-GPU resource + identical concurrent 8-GPU request
 *           → one durable allocation/reservation, both callers converge.
 *           Assert: 1 NetworkRequest, 1 AllocationDecision,
 *                   1 AllocationReservation, 1 CapacityReservation,
 *                   8 reserved, 0 remaining.
 *
 *   Test B: 10-GPU resource + two different concurrent 8-GPU requests
 *           → exactly one succeeds, one fails; 8 reserved, 2 remaining.
 *
 *   Test C: 16-GPU resource + 8+8 concurrent
 *           → both succeed; 16 reserved, 0 remaining.
 *
 * Assertions are made against the resource SELECTED by the decision
 * (AllocationDecision.selectedMembershipId → NetworkResourceMembership →
 * ResourceIdentity → metadataJson.assetId → CapacityResource), not merely
 * against the provisioned fixture. For these single-candidate tests, the
 * selected resource and the provisioned resource are asserted to be identical.
 *
 * Run: DATABASE_URL=postgresql://... bun test tests/phase-12b-concurrency.test.ts --timeout 180000
 */
import { describe, it, expect } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import {
  submitNetworkRequest,
  type SubmitNetworkRequestInput,
  type SubmitNetworkRequestResult,
} from '../src/lib/control-plane'

const databaseUrl = process.env.DATABASE_URL || ''
const isPostgres =
  databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')
const describeOrSkip = isPostgres ? describe : describe.skip

// ---------------------------------------------------------------------------
// Fixture: a completely isolated network topology for ONE concurrency test.
// ---------------------------------------------------------------------------

interface ConcurrencyFixture {
  tenantId: string
  networkId: string
  networkVersionId: string
  requesterMembershipId: string
  // The single provisioned resource candidate.
  assetId: string
  resourceIdentityId: string
  membershipId: string
  capacityResourceId: string
  physicalCapacity: string
  unit: string
  capabilityType: string
}

/**
 * Create a fully isolated topology for one concurrency test:
 *
 *   Tenant (own scope)
 *     └─ Network + published NetworkVersion (own scope)
 *          ├─ ParticipantIdentity + ParticipantMembership (active)
 *          │     └─ ParticipantRole (consumer)
 *          └─ Operator → Asset → AssetNetworkAssignment → CapacityResource
 *                     + ResourceIdentity → NetworkResourceMembership (active)
 *
 * The scheduler will see EXACTLY ONE eligible candidate membership.
 */
async function createConcurrencyFixture(opts: {
  label: string
  capacityAmount: string
  capabilityType?: string
  unit?: string
}): Promise<ConcurrencyFixture> {
  const capabilityType = opts.capabilityType ?? 'compute'
  const unit = opts.unit ?? 'GPU'
  // Unique stamp so re-runs against the same Neon DB do not collide on
  // @@unique([tenantId, slug]) for NetworkDefinition or tenant slug.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const label = opts.label
  const labelLc = label.toLowerCase()

  // --- Fresh tenant (own scope) ---
  const tenant = await createTenant({
    name: `Phase 12B Concurrency — ${label}`,
    slug: `p12b-${labelLc}-${stamp}`,
    plan: 'growth',
  })

  // --- Fresh network + published NetworkVersion (own scope) ---
  const instantiated = await instantiateTemplate(
    tenant.id,
    'protocol-network',
    {
      name: `Concurrency Net ${label}`,
      slug: `net-${labelLc}-${stamp}`,
    },
  )
  const network = instantiated.network
  const version = instantiated.version
  if (!version) {
    throw new Error(`instantiateTemplate did not return a published version for test ${label}`)
  }

  // --- Fresh requester: ParticipantIdentity + Membership (active) + Role ---
  const participant = await db.participantIdentity.create({ data: {} })
  const membership = await db.participantMembership.create({
    data: {
      participantId: participant.id,
      networkId: network.id,
      status: 'active',
    },
  })
  await db.participantRole.create({
    data: { membershipId: membership.id, role: 'consumer', status: 'active' },
  })

  // --- Fresh resource: Operator → Asset → AssetNetworkAssignment ---
  const operator = await db.operator.create({
    data: {
      tenantId: tenant.id,
      organizationId: null,
      displayName: `op-${labelLc}-${stamp}`,
      status: 'active',
    },
  })
  const asset = await db.asset.create({
    data: {
      tenantId: tenant.id,
      operatorId: operator.id,
      name: `asset-${labelLc}-${stamp}`,
      assetType: 'compute_node',
      status: 'active',
    },
  })
  await db.assetNetworkAssignment.create({
    data: {
      tenantId: tenant.id,
      assetId: asset.id,
      networkId: network.id,
      capabilityType,
      status: 'active',
      verifiedQuantity: opts.capacityAmount,
      verifiedUnit: unit,
    },
  })

  // Materialize the CapacityResource from the assignment.
  const { ensureCapacityResource } = await import('../src/lib/services/capacity.service')
  const capResource = await ensureCapacityResource(
    tenant.id,
    asset.id,
    network.id,
    capabilityType,
  )

  // ResourceIdentity carries the assetId in metadata for AssetCapacityProvider.
  const resourceIdentity = await db.resourceIdentity.create({
    data: {
      resourceKind: 'compute',
      status: 'active',
      metadataJson: JSON.stringify({ assetId: asset.id }),
    },
  })
  const resourceMembership = await db.networkResourceMembership.create({
    data: {
      resourceId: resourceIdentity.id,
      networkId: network.id,
      participantMembershipId: membership.id,
      capabilitiesJson: JSON.stringify([capabilityType]),
      verifiedCapacityJson: JSON.stringify([
        { capabilityType, amount: opts.capacityAmount, unit },
      ]),
      controlMode: 'default',
      verificationProfile: 'default',
      status: 'active',
    },
  })

  return {
    tenantId: tenant.id,
    networkId: network.id,
    networkVersionId: version.id,
    requesterMembershipId: membership.id,
    assetId: asset.id,
    resourceIdentityId: resourceIdentity.id,
    membershipId: resourceMembership.id,
    capacityResourceId: capResource.id,
    physicalCapacity: capResource.physicalCapacity,
    unit: capResource.unit,
    capabilityType,
  }
}

// ---------------------------------------------------------------------------
// Helper: resolve the capacity source SELECTED by a decision.
// ---------------------------------------------------------------------------

interface SelectedCapacitySource {
  selectedMembershipId: string
  resourceId: string
  assetId: string
  capacityResourceId: string
  physicalCapacity: number
  totalReserved: number
  remaining: number
}

/**
 * Walk the decision → selected resource → capacity source chain:
 *
 *   AllocationDecision.selectedMembershipId
 *     → NetworkResourceMembership
 *       → ResourceIdentity
 *         → metadataJson.assetId
 *           → CapacityResource (physical + sum of active reservations)
 *
 * This makes the test resilient against future scheduler changes: we assert
 * against whatever the scheduler actually selected, not the fixture directly.
 */
async function resolveSelectedCapacitySource(
  decisionId: string,
  networkId: string,
  capabilityType: string,
): Promise<SelectedCapacitySource> {
  const decision = await db.allocationDecision.findUnique({
    where: { id: decisionId },
  })
  if (!decision) throw new Error(`Decision ${decisionId} not found`)

  const selectedMembership = await db.networkResourceMembership.findUnique({
    where: { id: decision.selectedMembershipId },
  })
  if (!selectedMembership) {
    throw new Error(`Selected membership ${decision.selectedMembershipId} not found`)
  }

  const resource = await db.resourceIdentity.findUnique({
    where: { id: selectedMembership.resourceId },
  })
  if (!resource) {
    throw new Error(`ResourceIdentity ${selectedMembership.resourceId} not found`)
  }

  const metadata = JSON.parse(resource.metadataJson || '{}') as Record<string, unknown>
  const assetId = metadata.assetId as string | undefined
  if (!assetId) {
    throw new Error(
      `ResourceIdentity ${resource.id} has no assetId in metadata — not Asset-backed`,
    )
  }

  const capResource = await db.capacityResource.findUnique({
    where: {
      assetId_networkId_capabilityType: { assetId, networkId, capabilityType },
    },
  })
  if (!capResource) {
    throw new Error(
      `CapacityResource not found for asset ${assetId} / network ${networkId} / ${capabilityType}`,
    )
  }

  const reservations = await db.capacityReservation.findMany({
    where: { resourceId: capResource.id, status: 'active' },
    select: { reservedAmount: true },
  })
  const totalReserved = reservations.reduce(
    (sum, r) => sum + parseFloat(r.reservedAmount),
    0,
  )
  const physical = parseFloat(capResource.physicalCapacity)

  return {
    selectedMembershipId: decision.selectedMembershipId,
    resourceId: resource.id,
    assetId,
    capacityResourceId: capResource.id,
    physicalCapacity: physical,
    totalReserved,
    remaining: physical - totalReserved,
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describeOrSkip('Phase 12B Slice 2: PostgreSQL concurrency proof (isolated fixtures)', () => {
  // -------------------------------------------------------------------------
  // Test A: identical concurrent requests on an 8-GPU resource.
  // -------------------------------------------------------------------------
  it('Test A: 8-GPU resource + identical concurrent 8-GPU request → one durable allocation', async () => {
    // Isolated topology — exactly ONE 8-GPU candidate.
    const f = await createConcurrencyFixture({ label: 'A', capacityAmount: '8' })

    const input: SubmitNetworkRequestInput = {
      requesterMembershipId: f.requesterMembershipId,
      networkId: f.networkId,
      networkVersionId: f.networkVersionId,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      ],
      timeWindow: {
        start: new Date('2024-07-01T00:00:00Z'),
        end: new Date('2024-07-01T04:00:00Z'),
      },
      idempotencyKey: `conc-A-${f.networkId}`,
    }

    // Two concurrent calls with the SAME idempotency key + same payload.
    const results = await Promise.allSettled([
      submitNetworkRequest(input),
      submitNetworkRequest(input),
    ])

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<SubmitNetworkRequestResult> => r.status === 'fulfilled',
    )
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )

    // At least one must succeed.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    // If both fulfilled, they MUST converge on the same request + decision
    // (idempotent — same identity + same payload → same result).
    if (fulfilled.length === 2) {
      const r1 = fulfilled[0].value
      const r2 = fulfilled[1].value
      expect(r2.decision.decisionId).toBe(r1.decision.decisionId)
      expect(r2.request.requestId).toBe(r1.request.requestId)
    }

    const winner = fulfilled[0].value

    // --- Assert directly against PostgreSQL: exactly ONE NetworkRequest ---
    const requests = await db.networkRequest.findMany({
      where: { networkId: f.networkId },
    })
    expect(requests.length).toBe(1)
    expect(requests[0].id).toBe(winner.request.requestId)
    expect(requests[0].status).toBe('scheduled')

    // --- Assert: exactly ONE AllocationDecision ---
    const decisions = await db.allocationDecision.findMany({
      where: { requestId: winner.request.requestId },
    })
    expect(decisions.length).toBe(1)

    // --- Assert: the decision selected the SINGLE provisioned candidate ---
    expect(decisions[0].selectedMembershipId).toBe(f.membershipId)

    // --- Assert: exactly ONE AllocationReservation ---
    const allocReservations = await db.allocationReservation.findMany({
      where: { decisionId: decisions[0].id },
    })
    expect(allocReservations.length).toBe(1)
    expect(allocReservations[0].allocatedAmount).toBe('8')
    expect(allocReservations[0].capabilityType).toBe('compute')
    expect(allocReservations[0].unit).toBe('GPU')

    // --- Assert via the SELECTED resource chain (not the fixture directly) ---
    const source = await resolveSelectedCapacitySource(
      decisions[0].id,
      f.networkId,
      'compute',
    )
    // The selected resource IS the provisioned one (single candidate).
    expect(source.selectedMembershipId).toBe(f.membershipId)
    expect(source.assetId).toBe(f.assetId)
    expect(source.resourceId).toBe(f.resourceIdentityId)

    // 8 reserved, 0 remaining of 8 total.
    expect(source.totalReserved).toBe(8)
    expect(source.remaining).toBe(0)
    expect(source.physicalCapacity).toBe(8)

    // --- Assert: exactly ONE CapacityReservation row backing the allocation ---
    const capReservations = await db.capacityReservation.findMany({
      where: { resourceId: source.capacityResourceId, status: 'active' },
    })
    expect(capReservations.length).toBe(1)
    expect(parseFloat(capReservations[0].reservedAmount)).toBe(8)

    // If one was rejected, it must be a clean Error (not a crash).
    if (rejected.length === 1) {
      expect(rejected[0].reason).toBeInstanceOf(Error)
    }
  })

  // -------------------------------------------------------------------------
  // Test B: two DIFFERENT concurrent 8-GPU requests on a 10-GPU resource.
  //         Exactly one must win; the other must fail cleanly.
  // -------------------------------------------------------------------------
  it('Test B: 10-GPU resource + two different concurrent 8-GPU requests → one wins, one fails', async () => {
    // Isolated topology — exactly ONE 10-GPU candidate.
    const f = await createConcurrencyFixture({ label: 'B', capacityAmount: '10' })

    // Both requests target the SAME time window so the capacity service's
    // overlap arithmetic applies (8 + 8 = 16 > 10 → one must fail).
    const timeWindow = {
      start: new Date('2024-07-02T00:00:00Z'),
      end: new Date('2024-07-02T04:00:00Z'),
    }

    const inputA: SubmitNetworkRequestInput = {
      requesterMembershipId: f.requesterMembershipId,
      networkId: f.networkId,
      networkVersionId: f.networkVersionId,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      ],
      timeWindow,
      idempotencyKey: `conc-B-A-${f.networkId}`,
    }

    const inputB: SubmitNetworkRequestInput = {
      requesterMembershipId: f.requesterMembershipId,
      networkId: f.networkId,
      networkVersionId: f.networkVersionId,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      ],
      timeWindow,
      idempotencyKey: `conc-B-B-${f.networkId}`,
    }

    // Two concurrent calls with DIFFERENT idempotency keys.
    const results = await Promise.allSettled([
      submitNetworkRequest(inputA),
      submitNetworkRequest(inputB),
    ])

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<SubmitNetworkRequestResult> => r.status === 'fulfilled',
    )
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )

    // EXACTLY ONE must succeed (capacity = 10, each asks 8; 8+8=16 > 10).
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)

    const winner = fulfilled[0].value
    const loserError = rejected[0].reason

    // The winner has a valid allocation with exactly one reservation.
    expect(winner.decision).toBeDefined()
    expect(winner.reservations.length).toBe(1)
    expect(winner.reservations[0].allocatedAmount).toBe('8')
    expect(winner.reservations[0].capabilityType).toBe('compute')
    expect(winner.reservations[0].unit).toBe('GPU')

    // The loser gets a clean Error (InsufficientCapacityError or a Prisma
    // unique-constraint error from the rolled-back transaction).
    expect(loserError).toBeInstanceOf(Error)

    // --- Assert directly against PostgreSQL ---
    // Exactly ONE NetworkRequest persisted (the loser's was rolled back).
    const requests = await db.networkRequest.findMany({
      where: { networkId: f.networkId },
    })
    expect(requests.length).toBe(1)
    expect(requests[0].id).toBe(winner.request.requestId)

    // Exactly ONE AllocationDecision.
    const decisions = await db.allocationDecision.findMany({
      where: { networkId: f.networkId },
    })
    expect(decisions.length).toBe(1)
    expect(decisions[0].selectedMembershipId).toBe(f.membershipId)

    // Exactly ONE AllocationReservation.
    const allocReservations = await db.allocationReservation.findMany({
      where: { decisionId: decisions[0].id },
    })
    expect(allocReservations.length).toBe(1)
    expect(allocReservations[0].allocatedAmount).toBe('8')

    // --- Assert via the SELECTED resource chain ---
    const source = await resolveSelectedCapacitySource(
      decisions[0].id,
      f.networkId,
      'compute',
    )
    expect(source.selectedMembershipId).toBe(f.membershipId)
    expect(source.assetId).toBe(f.assetId)

    // Total reserved = 8, remaining = 2 (10 - 8). NEVER 16.
    expect(source.totalReserved).toBe(8)
    expect(source.remaining).toBe(2)
    expect(source.physicalCapacity).toBe(10)
    expect(source.totalReserved).not.toBe(16)

    // Exactly ONE active CapacityReservation row.
    const capReservations = await db.capacityReservation.findMany({
      where: { resourceId: source.capacityResourceId, status: 'active' },
    })
    expect(capReservations.length).toBe(1)
    expect(parseFloat(capReservations[0].reservedAmount)).toBe(8)
  })

  // -------------------------------------------------------------------------
  // Test C: two DIFFERENT concurrent 8-GPU requests on a 16-GPU resource.
  //         Both must succeed; 16 reserved, 0 remaining.
  // -------------------------------------------------------------------------
  it('Test C: 16-GPU resource + 8+8 concurrent → both succeed, 16 reserved, 0 remaining', async () => {
    // Isolated topology — exactly ONE 16-GPU candidate.
    const f = await createConcurrencyFixture({ label: 'C', capacityAmount: '16' })

    const timeWindow = {
      start: new Date('2024-07-03T00:00:00Z'),
      end: new Date('2024-07-03T04:00:00Z'),
    }

    const inputA: SubmitNetworkRequestInput = {
      requesterMembershipId: f.requesterMembershipId,
      networkId: f.networkId,
      networkVersionId: f.networkVersionId,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      ],
      timeWindow,
      idempotencyKey: `conc-C-A-${f.networkId}`,
    }

    const inputB: SubmitNetworkRequestInput = {
      requesterMembershipId: f.requesterMembershipId,
      networkId: f.networkId,
      networkVersionId: f.networkVersionId,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      ],
      timeWindow,
      idempotencyKey: `conc-C-B-${f.networkId}`,
    }

    // Two concurrent calls with DIFFERENT idempotency keys.
    const results = await Promise.allSettled([
      submitNetworkRequest(inputA),
      submitNetworkRequest(inputB),
    ])

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<SubmitNetworkRequestResult> => r.status === 'fulfilled',
    )
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )

    // BOTH must succeed (capacity = 16, each asks 8; 8+8=16 = 16).
    expect(fulfilled.length).toBe(2)
    expect(rejected.length).toBe(0)

    const r1 = fulfilled[0].value
    const r2 = fulfilled[1].value

    // Distinct decision IDs (different idempotency keys → different requests).
    expect(r2.decision.decisionId).not.toBe(r1.decision.decisionId)
    expect(r2.request.requestId).not.toBe(r1.request.requestId)

    // Both selected the single provisioned candidate.
    expect(r1.decision.selectedMembershipId).toBe(f.membershipId)
    expect(r2.decision.selectedMembershipId).toBe(f.membershipId)

    // Each has exactly one 8-GPU reservation.
    expect(r1.reservations.length).toBe(1)
    expect(r1.reservations[0].allocatedAmount).toBe('8')
    expect(r2.reservations.length).toBe(1)
    expect(r2.reservations[0].allocatedAmount).toBe('8')

    // --- Assert directly against PostgreSQL ---
    // Exactly TWO NetworkRequests persisted.
    const requests = await db.networkRequest.findMany({
      where: { networkId: f.networkId },
    })
    expect(requests.length).toBe(2)
    expect(requests.every((r) => r.status === 'scheduled')).toBe(true)

    // Exactly TWO AllocationDecisions.
    const decisions = await db.allocationDecision.findMany({
      where: { networkId: f.networkId },
    })
    expect(decisions.length).toBe(2)

    // Exactly TWO AllocationReservations (one per decision).
    const allocReservations = await db.allocationReservation.findMany({
      where: { decisionId: { in: decisions.map((d) => d.id) } },
    })
    expect(allocReservations.length).toBe(2)
    expect(
      allocReservations.every((r) => parseFloat(r.allocatedAmount) === 8),
    ).toBe(true)

    // --- Assert via the SELECTED resource chain ---
    // Both decisions selected the same single candidate → same capacity source.
    const source1 = await resolveSelectedCapacitySource(
      r1.decision.decisionId,
      f.networkId,
      'compute',
    )
    const source2 = await resolveSelectedCapacitySource(
      r2.decision.decisionId,
      f.networkId,
      'compute',
    )
    expect(source1.capacityResourceId).toBe(source2.capacityResourceId)
    expect(source1.assetId).toBe(f.assetId)

    // Total reserved = 16, remaining = 0 (16 - 16).
    expect(source1.totalReserved).toBe(16)
    expect(source1.remaining).toBe(0)
    expect(source1.physicalCapacity).toBe(16)

    // Exactly TWO active CapacityReservation rows (8 + 8 = 16).
    const capReservations = await db.capacityReservation.findMany({
      where: { resourceId: source1.capacityResourceId, status: 'active' },
    })
    expect(capReservations.length).toBe(2)
    const sum = capReservations.reduce(
      (s, r) => s + parseFloat(r.reservedAmount),
      0,
    )
    expect(sum).toBe(16)
  })
})
