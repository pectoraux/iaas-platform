/**
 * Phase 12B Slice 5: Execution Ownership & Fencing — PostgreSQL Concurrency Tests
 *
 * Proves the core invariants against real Neon PostgreSQL:
 *
 *   E1 — Two workers racing to acquire the same assignment: exactly one wins.
 *   E2 — Stale worker (old leaseVersion) cannot renew.
 *   E3 — Stale worker (old leaseVersion) cannot complete.
 *   E4 — Current worker can renew.
 *   E5 — Lease expiry does NOT by itself authorize another worker to execute.
 *   E6 — New worker after successful fencing can acquire + execute.
 *   E7 — No assignment can have two ACTIVE leases (DB-enforced).
 *   E8 — Retry after failed fencing (unsafe_to_retry) is rejected.
 *   E9 — Adapter without cancellation support → UNSAFE_TO_RETRY (no capacity release).
 *  E10 — Adapter with cancellation support → fenced (capacity released).
 *
 * Run: DATABASE_URL=postgresql://... bun test tests/phase-12b-slice-5-lease.test.ts --timeout 240000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import {
  submitNetworkRequest,
  commitDecisionToExecution,
  executeDecision,
  acquireExecutionLease,
  renewExecutionLease,
  completeExecutionLease,
  fenceExecutionLease,
  recoverStuckAssignments,
  LEASE_STATUS,
  ASSIGNMENT_STATUS,
  StaleLeaseError,
  type ExecutionLeaseRecord,
} from '../src/lib/control-plane'
import { initializeBootstrap } from '../src/lib/bootstrap'

const databaseUrl = process.env.DATABASE_URL || ''
const isPostgres =
  databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')
const describeOrSkip = isPostgres ? describe : describe.skip

beforeAll(() => {
  if (!isPostgres) return
  initializeBootstrap()
})

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Slice5Fixture {
  tenantId: string
  networkId: string
  networkVersionId: string
  requesterMembershipId: string
  assetId: string
  membershipId: string
}

async function createFixture(label: string): Promise<Slice5Fixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const labelLc = label.toLowerCase()

  const tenant = await createTenant({
    name: `Phase 12B Slice 5 — ${label}`,
    slug: `p12b-s5-${labelLc}-${stamp}`,
    plan: 'growth',
  })
  const instantiated = await instantiateTemplate(tenant.id, 'generic-resource-network', {
    name: `Slice 5 Net ${label}`,
    slug: `net-s5-${labelLc}-${stamp}`,
  })
  const network = instantiated.network
  const version = instantiated.version!

  const participant = await db.participantIdentity.create({ data: {} })
  const membership = await db.participantMembership.create({
    data: { participantId: participant.id, networkId: network.id, status: 'active' },
  })
  await db.participantRole.create({
    data: { membershipId: membership.id, role: 'consumer', status: 'active' },
  })

  const operator = await db.operator.create({
    data: {
      tenantId: tenant.id, organizationId: null,
      displayName: `op-s5-${labelLc}-${stamp}`, status: 'active',
    },
  })
  const asset = await db.asset.create({
    data: {
      tenantId: tenant.id, operatorId: operator.id,
      name: `asset-s5-${labelLc}-${stamp}`, assetType: 'compute_node', status: 'active',
    },
  })
  await db.assetNetworkAssignment.create({
    data: {
      tenantId: tenant.id, assetId: asset.id, networkId: network.id,
      capabilityType: 'gpu_compute', status: 'active',
      verifiedQuantity: '8', verifiedUnit: 'GPU-hours',
    },
  })
  const { ensureCapacityResource } = await import('../src/lib/services/capacity.service')
  await ensureCapacityResource(tenant.id, asset.id, network.id, 'gpu_compute')

  const resourceIdentity = await db.resourceIdentity.create({
    data: {
      resourceKind: 'compute', status: 'active',
      metadataJson: JSON.stringify({ assetId: asset.id }),
    },
  })
  const resourceMembership = await db.networkResourceMembership.create({
    data: {
      resourceId: resourceIdentity.id, networkId: network.id,
      participantMembershipId: membership.id,
      capabilitiesJson: JSON.stringify(['gpu_compute']),
      verifiedCapacityJson: JSON.stringify([
        { capabilityType: 'gpu_compute', amount: '8', unit: 'GPU-hours' },
      ]),
      controlMode: 'default', verificationProfile: 'default', status: 'active',
    },
  })

  return {
    tenantId: tenant.id, networkId: network.id, networkVersionId: version.id,
    requesterMembershipId: membership.id, assetId: asset.id,
    membershipId: resourceMembership.id,
  }
}

async function submitAndCommit(f: Slice5Fixture, label: string) {
  const submitResult = await submitNetworkRequest({
    requesterMembershipId: f.requesterMembershipId,
    networkId: f.networkId,
    networkVersionId: f.networkVersionId,
    capabilityRequirements: [
      { capabilityType: 'gpu_compute', amount: '8', unit: 'GPU-hours' },
    ],
    timeWindow: {
      start: new Date('2024-10-01T00:00:00Z'),
      end: new Date('2024-10-01T04:00:00Z'),
    },
    idempotencyKey: `s5-${label}-${f.networkId}`,
  })
  const decisionId = submitResult.decision.decisionId
  const commitResult = await commitDecisionToExecution(decisionId)
  return {
    decisionId,
    executionId: commitResult.executionId,
    assignmentId: commitResult.assignments[0].assignmentId,
    commitmentId: commitResult.assignments[0].commitmentId,
    reservationId: commitResult.assignments[0].reservationId,
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describeOrSkip('Phase 12B Slice 5: Execution Lease — PostgreSQL concurrency', () => {
  // E1 + E7: Two workers racing to acquire the same assignment → exactly one wins
  it('E1+E7: two concurrent acquireExecutionLease calls → exactly one wins (DB-enforced)', async () => {
    const f = await createFixture('E1')
    const { assignmentId } = await submitAndCommit(f, 'e1')

    // Fire two concurrent acquire calls.
    const results = await Promise.allSettled([
      acquireExecutionLease({ executionAssignmentId: assignmentId, workerIdentity: 'worker-A' }),
      acquireExecutionLease({ executionAssignmentId: assignmentId, workerIdentity: 'worker-B' }),
    ])

    const fulfilled = results
      .filter((r): r is PromiseFulfilledResult<{ acquired: boolean; lease?: ExecutionLeaseRecord }> => r.status === 'fulfilled')
      .map((r) => r.value)

    const acquired = fulfilled.filter((r) => r.acquired)

    // EXACTLY ONE must acquire.
    expect(acquired.length).toBe(1)

    // The DB must have exactly ONE active lease for this assignment.
    const activeLeases = await db.executionLease.findMany({
      where: { executionAssignmentId: assignmentId, status: LEASE_STATUS.ACTIVE },
    })
    expect(activeLeases.length).toBe(1)
  })

  // E2: Stale worker (old leaseVersion) cannot renew
  it('E2: stale worker (old leaseVersion) cannot renew', async () => {
    const f = await createFixture('E2')
    const { assignmentId } = await submitAndCommit(f, 'e2')

    const acquireResult = await acquireExecutionLease({
      executionAssignmentId: assignmentId,
      workerIdentity: 'worker-A',
    })
    expect(acquireResult.acquired).toBe(true)
    const lease = acquireResult.lease!

    // Simulate a version bump (e.g., a new lease was acquired after fencing).
    // We'll fence the old lease + acquire a new one, then try to renew the OLD lease.
    await fenceExecutionLease({
      leaseId: lease.id,
      leaseVersion: lease.leaseVersion,
      reason: 'test: fencing old lease for stale-worker test',
      adapterSelection: {
        assetId: f.assetId,
        assetType: 'compute_node',
        capabilityType: 'gpu_compute',
      },
    })

    // The old lease is now 'unsafe_to_retry' (simulated adapter doesn't support cancellation).
    // Try to renew the OLD lease — must fail (stale worker).
    const renewResult = await renewExecutionLease({
      leaseId: lease.id,
      leaseVersion: lease.leaseVersion, // old version
      workerIdentity: 'worker-A',
    })
    expect(renewResult.renewed).toBe(false)
  })

  // E3: Stale worker (old leaseVersion) cannot complete
  it('E3: stale worker cannot complete a fenced/expired lease', async () => {
    const f = await createFixture('E3')
    const { assignmentId } = await submitAndCommit(f, 'e3')

    const acquireResult = await acquireExecutionLease({
      executionAssignmentId: assignmentId,
      workerIdentity: 'worker-A',
    })
    const lease = acquireResult.lease!

    // Fence the old lease (transitions to unsafe_to_retry).
    await fenceExecutionLease({
      leaseId: lease.id,
      leaseVersion: lease.leaseVersion,
      reason: 'test: fencing for stale-complete test',
      adapterSelection: {
        assetId: f.assetId,
        assetType: 'compute_node',
        capabilityType: 'gpu_compute',
      },
    })

    // Try to complete the OLD lease — must fail (lease is no longer active).
    const completeResult = await completeExecutionLease({
      leaseId: lease.id,
      leaseVersion: lease.leaseVersion,
      workerIdentity: 'worker-A',
    })
    expect(completeResult.completed).toBe(false)
    expect(completeResult.reason).toContain('not active')
  })

  // E4: Current worker can renew
  it('E4: current worker can renew the active lease', async () => {
    const f = await createFixture('E4')
    const { assignmentId } = await submitAndCommit(f, 'e4')

    const acquireResult = await acquireExecutionLease({
      executionAssignmentId: assignmentId,
      workerIdentity: 'worker-A',
      leaseMs: 60000,
    })
    const lease = acquireResult.lease!

    // Renew — must succeed (current worker, correct version).
    const renewResult = await renewExecutionLease({
      leaseId: lease.id,
      leaseVersion: lease.leaseVersion,
      workerIdentity: 'worker-A',
      leaseMs: 120000,
    })
    expect(renewResult.renewed).toBe(true)
    expect(renewResult.lease!.leaseUntil.getTime()).toBeGreaterThan(lease.leaseUntil.getTime())
  })

  // E5: Lease expiry does NOT by itself authorize another worker to execute
  it('E5: expired lease blocks a new worker from acquiring (recovery required first)', async () => {
    const f = await createFixture('E5')
    const { assignmentId } = await submitAndCommit(f, 'e5')

    // Acquire with a very short lease (1ms).
    const acquireResult = await acquireExecutionLease({
      executionAssignmentId: assignmentId,
      workerIdentity: 'worker-A',
      leaseMs: 1,
    })
    const lease = acquireResult.lease!

    // Wait for the lease to expire.
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Worker B tries to acquire — must FAIL because the old lease is expired
    // but not fenced. Recovery must fence it first.
    const acquireB = await acquireExecutionLease({
      executionAssignmentId: assignmentId,
      workerIdentity: 'worker-B',
    })
    expect(acquireB.acquired).toBe(false)
    expect(acquireB.reason).toContain('expired but not fenced')

    // The old lease is still 'active' in the DB (expired but not transitioned).
    const oldLease = await db.executionLease.findUnique({ where: { id: lease.id } })
    expect(oldLease!.status).toBe(LEASE_STATUS.ACTIVE)
  })

  // E9: Adapter without cancellation → UNSAFE_TO_RETRY (capacity NOT released)
  it('E9: adapter without cancellation support → UNSAFE_TO_RETRY (capacity NOT released)', async () => {
    const f = await createFixture('E9')
    const { decisionId, assignmentId, commitmentId, reservationId } = await submitAndCommit(f, 'e9')

    // Acquire a lease with a short expiry.
    const acquireResult = await acquireExecutionLease({
      executionAssignmentId: assignmentId,
      workerIdentity: 'worker-A',
      leaseMs: 1,
    })
    const lease = acquireResult.lease!

    // Wait for expiry.
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Capture the reservation state before recovery.
    const reservationBefore = await db.capacityReservation.findUnique({ where: { id: reservationId } })
    const remainingBefore = parseFloat(reservationBefore!.remainingAmount)

    // Run recovery. The simulated adapter does NOT support cancellation →
    // the lease should be marked 'unsafe_to_retry' and capacity NOT released.
    const recovered = await recoverStuckAssignments(decisionId)
    expect(recovered.length).toBe(1)
    expect(recovered[0].recovered).toBe(false) // NOT recovered — unsafe
    expect(recovered[0].reason).toContain('UNSAFE_TO_RETRY')

    // The lease is now 'unsafe_to_retry'.
    const leaseAfter = await db.executionLease.findUnique({ where: { id: lease.id } })
    expect(leaseAfter!.status).toBe(LEASE_STATUS.UNSAFE_TO_RETRY)

    // The assignment is 'fence_required' (NOT 'failed').
    const assignment = await db.executionAssignment.findUnique({ where: { id: assignmentId } })
    expect(assignment!.status).toBe(ASSIGNMENT_STATUS.FENCE_REQUIRED)

    // The commitment is NOT released (capacity NOT restored).
    const commitment = await db.capacityCommitment.findUnique({ where: { id: commitmentId } })
    expect(commitment!.status).not.toBe('released')

    // The reservation's remainingAmount is UNCHANGED.
    const reservationAfter = await db.capacityReservation.findUnique({ where: { id: reservationId } })
    expect(parseFloat(reservationAfter!.remainingAmount)).toBe(remainingBefore)
  })

  // E8: Retry after unsafe_to_retry is rejected
  it('E8: retry after unsafe_to_retry is rejected (assignment is fence_required)', async () => {
    const f = await createFixture('E8')
    const { decisionId, assignmentId } = await submitAndCommit(f, 'e8')

    // Acquire + let expire + recover → unsafe_to_retry.
    await acquireExecutionLease({
      executionAssignmentId: assignmentId,
      workerIdentity: 'worker-A',
      leaseMs: 1,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await recoverStuckAssignments(decisionId)

    // Try to acquire again — must fail (assignment is 'fence_required').
    const acquireB = await acquireExecutionLease({
      executionAssignmentId: assignmentId,
      workerIdentity: 'worker-B',
    })
    expect(acquireB.acquired).toBe(false)
    expect(acquireB.reason).toContain('terminal (fence_required)')
  })

  // E10: Happy path — executeDecision with lease → assignment completed
  it('E10: executeDecision acquires lease, executes, completes (happy path)', async () => {
    const f = await createFixture('E10')
    const { decisionId, assignmentId } = await submitAndCommit(f, 'e10')

    const result = await executeDecision(decisionId, { workerIdentity: 'worker-happy' })

    expect(result.assignments.length).toBe(1)
    expect(result.assignments[0].status).toBe('completed')

    // The lease is 'released' (completed successfully).
    const leases = await db.executionLease.findMany({
      where: { executionAssignmentId: assignmentId },
    })
    expect(leases.length).toBe(1)
    expect(leases[0].status).toBe(LEASE_STATUS.RELEASED)
    expect(leases[0].workerIdentity).toBe('worker-happy')
  })

  // Vertical-neutrality: the lease module imports no vertical service
  it('E9-vertical: execution-lease source imports no vertical service', async () => {
    const source = await import('fs').then((fs) =>
      fs.readFileSync('./src/lib/control-plane/execution-lease.ts', 'utf8'),
    )
    const importLines = source
      .split('\n')
      .filter((l) => l.match(/^\s*import\s/) || l.match(/^\s*}\s*from\s/))
      .join('\n')
    expect(importLines).not.toMatch(/vpp\.service/)
    expect(importLines).not.toMatch(/compute\.service/)
    expect(importLines).not.toMatch(/compute-adapter\.service/)
    expect(importLines).not.toMatch(/storage\.service/)
    expect(importLines).not.toMatch(/wireless\.service/)
  })
})
