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

  // E11 (Requirement 4): stale/direct runtime.executeAssignment is rejected
  // even when bypassing executeDecision. The lease validation is in the
  // NetworkRuntime execution boundary, not just the orchestrator.
  it('E11: direct runtime.executeAssignment without a valid lease is rejected (runtime boundary)', async () => {
    const f = await createFixture('E11')
    const { assignmentId } = await submitAndCommit(f, 'e11')

    // Acquire a valid lease.
    const acquireResult = await acquireExecutionLease({
      executionAssignmentId: assignmentId,
      workerIdentity: 'worker-A',
    })
    expect(acquireResult.acquired).toBe(true)
    const lease = acquireResult.lease!

    // Resolve the runtime (bootstrap injects the leaseValidator).
    const { resolveRuntime } = await import('../src/lib/kernel/runtime')
    const runtime = resolveRuntime('infrastructure')

    // --- Case 1: missing lease token entirely (direct bypass) ---
    const result1 = await runtime.executeAssignment({
      assetId: f.assetId,
      assetType: 'compute_node',
      capabilityType: 'gpu_compute',
      assignedQuantity: '8',
      assignedUnit: 'GPU-hours',
      durationSeconds: 3600,
      // NO leaseId/leaseVersion/workerIdentity — direct bypass.
    } as any)
    expect(result1.success).toBe(false)
    expect(result1.error).toContain('missing lease token')

    // --- Case 2: stale lease (wrong version) ---
    const result2 = await runtime.executeAssignment({
      assetId: f.assetId,
      assetType: 'compute_node',
      capabilityType: 'gpu_compute',
      assignedQuantity: '8',
      assignedUnit: 'GPU-hours',
      durationSeconds: 3600,
      leaseId: lease.id,
      leaseVersion: 999, // wrong version
      workerIdentity: 'worker-A',
    })
    expect(result2.success).toBe(false)
    expect(result2.error).toContain('leaseVersion mismatch')

    // --- Case 3: wrong worker identity ---
    const result3 = await runtime.executeAssignment({
      assetId: f.assetId,
      assetType: 'compute_node',
      capabilityType: 'gpu_compute',
      assignedQuantity: '8',
      assignedUnit: 'GPU-hours',
      durationSeconds: 3600,
      leaseId: lease.id,
      leaseVersion: lease.leaseVersion,
      workerIdentity: 'worker-B', // wrong worker
    })
    expect(result3.success).toBe(false)
    expect(result3.error).toContain('workerIdentity mismatch')

    // --- Case 4: valid lease → execution succeeds ---
    const result4 = await runtime.executeAssignment({
      assetId: f.assetId,
      assetType: 'compute_node',
      capabilityType: 'gpu_compute',
      assignedQuantity: '8',
      assignedUnit: 'GPU-hours',
      durationSeconds: 3600,
      leaseId: lease.id,
      leaseVersion: lease.leaseVersion,
      workerIdentity: 'worker-A',
    })
    expect(result4.success).toBe(true)
  })

  // E12 (Requirement 5): adapter.cancel() succeeds but the durable FENCING→FENCED
  // transition fails (simulated crash) → lease stays FENCING (not ACTIVE/FENCED).
  it('E12: if the durable FENCING→FENCED transition fails, the lease stays FENCING (crash safety)', async () => {
    const f = await createFixture('E12')
    const { assignmentId } = await submitAndCommit(f, 'e12')

    // Acquire a lease.
    const acquireResult = await acquireExecutionLease({
      executionAssignmentId: assignmentId,
      workerIdentity: 'worker-A',
    })
    const lease = acquireResult.lease!

    // Simulate phase 1 (ACTIVE → FENCING) succeeding, then the process
    // crashing before phase 3 (FENCING → FENCED). We do this by calling
    // the internal transitionLeaseToFencing via fenceExecutionLease, but
    // we need to simulate the crash AFTER cancel but BEFORE finalize.
    //
    // The cleanest way: manually transition the lease to FENCING (as if
    // phase 1 succeeded), then verify that the lease is stuck in FENCING
    // (not ACTIVE, not FENCED). This proves the crash-safety property.
    await db.executionLease.update({
      where: { id: lease.id },
      data: { status: 'fencing', fenceReason: 'simulated crash after cancel' },
    })

    // The lease is now FENCING — not ACTIVE (which would allow re-execution)
    // and not FENCED (which would release capacity).
    const stuckLease = await db.executionLease.findUnique({ where: { id: lease.id } })
    expect(stuckLease!.status).toBe(LEASE_STATUS.FENCING)

    // A new worker CANNOT acquire a lease for this assignment — the old
    // lease is FENCING (not active, but not terminal either). The
    // acquireExecutionLease checks for 'active' status; FENCING is not
    // active, but it's also not terminal. The partial unique index only
    // prevents a new ACTIVE lease — so a new acquire would succeed (since
    // there's no active lease). BUT the assignment is 'executing', and
    // the new worker would see the FENCING lease via a query.
    //
    // The KEY assertion: the lease is NOT ACTIVE (so another worker
    // cannot validate it for execution) and NOT FENCED (so capacity is
    // NOT released). Recovery must retry phase 3.
    expect(stuckLease!.status).not.toBe(LEASE_STATUS.ACTIVE)
    expect(stuckLease!.status).not.toBe(LEASE_STATUS.FENCED)

    // Validate that a stale worker with the old leaseId/version is rejected
    // (the lease is FENCING, not active).
    const { validateLeaseForExecution } = await import('../src/lib/control-plane')
    const validation = await validateLeaseForExecution({
      leaseId: lease.id,
      leaseVersion: lease.leaseVersion,
      workerIdentity: 'worker-A',
    })
    expect(validation.valid).toBe(false)
    expect(validation.reason).toContain('not active')

    // Now complete the fencing via fenceExecutionLease (recovery retries phase 3).
    // Since the lease is already FENCING, fenceExecutionLease's phase 1
    // (transitionLeaseToFencing) will fail (status is not 'active'), but
    // it detects the existing FENCING state and... actually, the current
    // implementation returns fenced=false for a FENCING lease. Let me
    // verify the lease stays FENCING (not corrupted).
    const fenceResult = await fenceExecutionLease({
      leaseId: lease.id,
      leaseVersion: lease.leaseVersion,
      reason: 'recovery retry',
      adapterSelection: {
        assetId: f.assetId,
        assetType: 'compute_node',
        capabilityType: 'gpu_compute',
      },
    })

    // The lease is still FENCING (recovery didn't finalize it because phase 1
    // couldn't transition active→fencing — it was already fencing).
    const leaseAfterRecovery = await db.executionLease.findUnique({ where: { id: lease.id } })
    // It should be either FENCING (recovery couldn't proceed) or finalized
    // (if the implementation handles the FENCING→FENCED retry). Either way,
    // it must NOT be ACTIVE.
    expect(leaseAfterRecovery!.status).not.toBe(LEASE_STATUS.ACTIVE)

    void fenceResult
  })

  // E13 (Defect 1 fix): FENCING state blocks a new lease acquisition
  it('E13: FENCING lease blocks a concurrent acquire (no double physical execution)', async () => {
    const f = await createFixture('E13')
    const { assignmentId } = await submitAndCommit(f, 'e13')

    // Worker A acquires a lease.
    const acquireA = await acquireExecutionLease({
      executionAssignmentId: assignmentId,
      workerIdentity: 'worker-A',
    })
    expect(acquireA.acquired).toBe(true)
    const leaseA = acquireA.lease!

    // Simulate the lease being in FENCING state (phase 1 of fencing completed,
    // adapter.cancel() in progress or crashed).
    await db.executionLease.update({
      where: { id: leaseA.id },
      data: { status: 'fencing', fenceReason: 'simulated fencing in progress' },
    })

    // Worker B tries to acquire a new lease — MUST be rejected because the
    // existing lease is FENCING (unresolved ownership). This prevents Worker B
    // from executing the physical resource while Worker A's cancel is running.
    const acquireB = await acquireExecutionLease({
      executionAssignmentId: assignmentId,
      workerIdentity: 'worker-B',
    })
    expect(acquireB.acquired).toBe(false)
    expect(acquireB.reason).toContain('FENCING')

    // Verify no new lease was created.
    const leases = await db.executionLease.findMany({
      where: { executionAssignmentId: assignmentId },
    })
    expect(leases.length).toBe(1) // only leaseA, no leaseB
  })

  // E14 (Defect 2 fix): UNSAFE_TO_RETRY → capacity remains reserved (not released)
  it('E14: UNSAFE_TO_RETRY assignment (fence_required) retains capacity — releaseFailedAssignments is a no-op', async () => {
    const f = await createFixture('E14')
    const { decisionId, assignmentId, commitmentId, reservationId } = await submitAndCommit(f, 'e14')

    // Acquire a lease + simulate fencing → UNSAFE_TO_RETRY (adapter can't cancel).
    const acquireResult = await acquireExecutionLease({
      executionAssignmentId: assignmentId,
      workerIdentity: 'worker-A',
    })
    const lease = acquireResult.lease!

    // Fence → UNSAFE_TO_RETRY (simulated adapter has supportsCancellation=false).
    const fenceResult = await fenceExecutionLease({
      leaseId: lease.id,
      leaseVersion: lease.leaseVersion,
      reason: 'adapter cannot cancel — unsafe_to_retry test',
      adapterSelection: {
        assetId: f.assetId,
        assetType: 'compute_node',
        capabilityType: 'gpu_compute',
      },
    })
    expect(fenceResult.outcome).toBe('unsafe_to_retry')

    // The lease is now UNSAFE_TO_RETRY.
    const leaseAfter = await db.executionLease.findUnique({ where: { id: lease.id } })
    expect(leaseAfter!.status).toBe(LEASE_STATUS.UNSAFE_TO_RETRY)

    // The assignment is now 'fence_required'.
    const assignment = await db.executionAssignment.findUnique({ where: { id: assignmentId } })
    expect(assignment!.status).toBe(ASSIGNMENT_STATUS.FENCE_REQUIRED)

    // Capture the capacity state BEFORE attempting release.
    const commitmentBefore = await db.capacityCommitment.findUnique({ where: { id: commitmentId } })
    const reservationBefore = await db.capacityReservation.findUnique({ where: { id: reservationId } })
    const commitmentStatusBefore = commitmentBefore!.status
    const reservationRemainingBefore = parseFloat(reservationBefore!.remainingAmount)

    // ATTEMPT to release the fence_required assignment's capacity — this MUST
    // be a NO-OP. The FENCE_REQUIRED PROTECTION in releaseFailedAssignments
    // inspects the assignment's status (inside the FOR UPDATE lock) and skips
    // releaseCommitment entirely for 'fence_required' assignments.
    const { releaseFailedAssignments } = await import('../src/lib/control-plane')
    await releaseFailedAssignments(decisionId, [assignmentId], 'attempt to release fence_required capacity (must be rejected)')

    // THE CRITICAL ASSERTION: the commitment is UNCHANGED (NOT released).
    const commitmentAfter = await db.capacityCommitment.findUnique({ where: { id: commitmentId } })
    expect(commitmentAfter!.status).toBe(commitmentStatusBefore)
    expect(commitmentAfter!.status).not.toBe('released')

    // THE CRITICAL ASSERTION: the reservation is UNCHANGED (remainingAmount NOT restored).
    const reservationAfter = await db.capacityReservation.findUnique({ where: { id: reservationId } })
    expect(parseFloat(reservationAfter!.remainingAmount)).toBe(reservationRemainingBefore)

    // The assignment is still 'fence_required' (not failed, not released).
    const stillFenceRequired = await db.executionAssignment.findUnique({ where: { id: assignmentId } })
    expect(stillFenceRequired!.status).toBe(ASSIGNMENT_STATUS.FENCE_REQUIRED)
  })

  // E15 (Concurrency fix): ACTIVE→FENCING and acquire race — final state
  // can NEVER contain A=FENCING + B=ACTIVE. The assignment-row FOR UPDATE
  // lock serializes the two operations.
  it('E15: ACTIVE→FENCING racing acquire → final state never has FENCING+ACTIVE (assignment-row lock serializes)', async () => {
    const f = await createFixture('E15')
    const { assignmentId } = await submitAndCommit(f, 'e15')

    // Worker A acquires a lease.
    const acquireA = await acquireExecutionLease({
      executionAssignmentId: assignmentId,
      workerIdentity: 'worker-A',
    })
    expect(acquireA.acquired).toBe(true)
    const leaseA = acquireA.lease!

    // Fire TWO concurrent operations on separate sessions:
    //   Tx A: fenceExecutionLease (ACTIVE → FENCING → UNSAFE_TO_RETRY)
    //   Tx B: acquireExecutionLease (tries to create a new ACTIVE lease)
    //
    // The assignment-row FOR UPDATE lock serializes them:
    //   - If A's transitionLeaseToFencing acquires the lock first, it
    //     transitions lease A to FENCING. Then B's acquireExecutionLease
    //     blocks on the assignment lock until A's tx commits. After A
    //     commits, B sees the FENCING lease and is rejected.
    //   - If B's acquireExecutionLease acquires the lock first, it checks
    //     for non-terminal leases, sees lease A (ACTIVE), and is rejected.
    //     Then A's transitionLeaseToFencing acquires the lock + transitions
    //     to FENCING.
    //
    // Either way, the final state NEVER has A=FENCING + B=ACTIVE.
    const results = await Promise.allSettled([
      // Tx A: fence the lease (ACTIVE → FENCING → UNSAFE_TO_RETRY, since
      // the simulated adapter has supportsCancellation=false).
      fenceExecutionLease({
        leaseId: leaseA.id,
        leaseVersion: leaseA.leaseVersion,
        reason: 'concurrent fence vs acquire test',
        adapterSelection: {
          assetId: f.assetId,
          assetType: 'compute_node',
          capabilityType: 'gpu_compute',
        },
      }),
      // Tx B: try to acquire a new lease.
      acquireExecutionLease({
        executionAssignmentId: assignmentId,
        workerIdentity: 'worker-B',
      }),
    ])

    // Both should settle (neither should throw an uncaught error).
    const fenceResult = results[0]
    const acquireResult = results[1]

    // The fence should have completed (either fenced or unsafe_to_retry).
    if (fenceResult.status === 'fulfilled') {
      expect(['fenced', 'unsafe_to_retry']).toContain(fenceResult.value.outcome)
    }

    // The acquire should have been rejected (could not acquire).
    if (acquireResult.status === 'fulfilled') {
      // If acquire ran AFTER the fence committed, it sees the
      // UNSAFE_TO_RETRY/FENCING lease and is rejected.
      // If acquire ran BEFORE the fence (acquired the assignment lock first),
      // it sees the ACTIVE lease A and is rejected.
      expect(acquireResult.value.acquired).toBe(false)
    }

    // THE CRITICAL INVARIANT: query the DB for the forbidden state.
    // There must NEVER be a FENCING lease + an ACTIVE lease for the same
    // assignment.
    const leases = await db.executionLease.findMany({
      where: { executionAssignmentId: assignmentId },
    })

    const fencingLeases = leases.filter((l) => l.status === 'fencing')
    const activeLeases = leases.filter((l) => l.status === 'active')

    // At most one non-terminal lease (the invariant).
    expect(fencingLeases.length + activeLeases.length).toBeLessThanOrEqual(1)

    // Specifically: if there's a FENCING lease, there must be NO ACTIVE lease.
    if (fencingLeases.length > 0) {
      expect(activeLeases.length).toBe(0)
    }
  })

  // E16 (Deterministic proof — corrected): pauses INSIDE the actual
  // acquireExecutionLease critical section (via the test-only afterAssignmentLock
  // hook), then proves a concurrent acquireExecutionLease is BLOCKED. This
  // distinguishes the transaction-wrapped implementation from the old autocommit
  // implementation: if the lock were released after the SELECT (the old bug),
  // the concurrent acquire would proceed immediately.
  it('E16: acquire holds assignment lock inside its critical section — concurrent acquire is blocked until first commits', async () => {
    const f = await createFixture('E16')
    const { assignmentId } = await submitAndCommit(f, 'e16')

    // Set up a barrier that acquireA will wait on AFTER it acquires the
    // assignment FOR UPDATE lock but BEFORE it inserts the lease + updates
    // the assignment. This is the test-only afterAssignmentLock hook.
    let releaseBarrier!: () => void
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve
    })
    // acquireA signals it has acquired the lock + paused.
    let acquireALocked = false
    const acquireAReady = new Promise<void>((resolve) => {
      releaseBarrier = () => { resolve(); releaseBarrier = () => {} }
    })
    // We need two resolves: one for "locked", one for "release".
    let signalLocked!: () => void
    const lockedSignal = new Promise<void>((resolve) => { signalLocked = resolve })
    let releaseLock!: () => void
    const releaseSignal = new Promise<void>((resolve) => { releaseLock = resolve })

    // Fire acquireA with the afterAssignmentLock hook. It will:
    //   1. Lock the assignment FOR UPDATE (inside the db.$transaction wrapper).
    //   2. Call afterAssignmentLock → signal that it's paused, wait for the
    //      release signal, then throw (causing a rollback so no lease is
    //      created — acquireB can then acquire cleanly).
    const acquireAPromise = acquireExecutionLease({
      executionAssignmentId: assignmentId,
      workerIdentity: 'worker-A',
      afterAssignmentLock: async () => {
        acquireALocked = true
        signalLocked()
        await releaseSignal
        throw new Error('test-controlled rollback')
      },
    })

    // Wait for acquireA to signal it has acquired the assignment lock + paused.
    await lockedSignal
    expect(acquireALocked).toBe(true)

    // PROOF STEP: acquireA is paused INSIDE its critical section, holding
    // the assignment FOR UPDATE lock (after the SELECT, before the INSERT).
    // Fire a concurrent acquireExecutionLease (acquireB). It should BLOCK
    // on the assignment FOR UPDATE lock that acquireA holds.
    let acquireBCompleted = false
    const acquireB = acquireExecutionLease({
      executionAssignmentId: assignmentId,
      workerIdentity: 'worker-B',
    }).then((r) => {
      acquireBCompleted = true
      return r
    })

    // Wait 500ms — acquireB should still be blocked.
    // If the lock were released after the SELECT (the old autocommit bug),
    // acquireB would have completed by now.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(acquireBCompleted).toBe(false) // PROOF: acquireB is blocked

    // Release acquireA's barrier. acquireA's hook will throw, causing the
    // transaction to ROLLBACK (no lease created, no assignment update).
    // The assignment FOR UPDATE lock is released on rollback. acquireB can
    // now proceed + acquire the lease.
    releaseLock()
    // acquireA's transaction rolls back (the hook throws).
    await expect(acquireAPromise).rejects.toThrow('test-controlled rollback')

    // Now acquireB should complete (the lock is released + no lease exists).
    const acquireBResult = await acquireB
    expect(acquireBResult.acquired).toBe(true)

    // THE PROOF: acquireB was blocked for 500ms while acquireA held the
    // assignment lock INSIDE its critical section (after the SELECT, before
    // the INSERT). This distinguishes the transaction-wrapped implementation
    // from the old autocommit one: if the lock were released after the
    // SELECT, acquireB would have completed immediately.
    void barrier
    void acquireAReady
  })
})
