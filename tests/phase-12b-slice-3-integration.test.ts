/**
 * Phase 12B Slice 3: Execution Orchestrator — PostgreSQL Integration Tests
 *
 * Covers acceptance gates 7, 8, 10, 12 against real Neon PostgreSQL:
 *
 *   7. Allocation → Commitment → Execution is atomic (rollback on failure).
 *   8. Retry is idempotent; no duplicate execution or commitment.
 *  10. Execution failure releases committed capacity correctly.
 *  12. Real PostgreSQL integration proves concurrency + rollback + retry.
 *
 * Gate 10 (the critical one): after commitDecisionToExecution creates the
 * durable records, releaseDecisionExecution must:
 *   - fail all ExecutionAssignments (status → 'failed')
 *   - release all CapacityCommitments (status → 'released')
 *   - restore the CapacityReservations' remainingAmount
 * This is the operational failure path — NOT a rollback of the creation tx.
 *
 * Run: DATABASE_URL=postgresql://... bun test tests/phase-12b-slice-3-integration.test.ts --timeout 180000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import {
  submitNetworkRequest,
  commitDecisionToExecution,
  releaseDecisionExecution,
  EXECUTION_SOURCE_TYPE,
  COMMITMENT_SOURCE_TYPE,
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
// Fixture (same pattern as the unit test, kept self-contained)
// ---------------------------------------------------------------------------

async function createFixture(opts: {
  label: string
  capacityAmount: string
}) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const labelLc = opts.label.toLowerCase()

  const tenant = await createTenant({
    name: `Phase 12B Slice 3 Int — ${opts.label}`,
    slug: `p12b-s3i-${labelLc}-${stamp}`,
    plan: 'growth',
  })
  const instantiated = await instantiateTemplate(
    tenant.id,
    'generic-resource-network', {
    name: `Slice 3 Int Net ${opts.label}`,
    slug: `net-s3i-${labelLc}-${stamp}`,
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
      displayName: `op-s3i-${labelLc}-${stamp}`, status: 'active',
    },
  })
  const asset = await db.asset.create({
    data: {
      tenantId: tenant.id, operatorId: operator.id,
      name: `asset-s3i-${labelLc}-${stamp}`, assetType: 'compute_node', status: 'active',
    },
  })
  await db.assetNetworkAssignment.create({
    data: {
      tenantId: tenant.id, assetId: asset.id, networkId: network.id,
      capabilityType: 'compute', status: 'active',
      verifiedQuantity: opts.capacityAmount, verifiedUnit: 'GPU',
    },
  })
  const { ensureCapacityResource } = await import('../src/lib/services/capacity.service')
  await ensureCapacityResource(tenant.id, asset.id, network.id, 'compute')

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
      capabilitiesJson: JSON.stringify(['compute']),
      verifiedCapacityJson: JSON.stringify([
        { capabilityType: 'compute', amount: opts.capacityAmount, unit: 'GPU' },
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

// ===========================================================================
// Tests
// ===========================================================================

describeOrSkip('Phase 12B Slice 3: Execution Orchestrator (PostgreSQL integration)', () => {
  // -------------------------------------------------------------------------
  // Gate 10: execution failure releases committed capacity correctly
  // -------------------------------------------------------------------------
  it('Gate 10: releaseDecisionExecution fails assignments + releases commitments + restores reservation remaining', async () => {
    const f = await createFixture({ label: 'G10', capacityAmount: '8' })

    const submitResult = await submitNetworkRequest({
      requesterMembershipId: f.requesterMembershipId,
      networkId: f.networkId,
      networkVersionId: f.networkVersionId,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      ],
      timeWindow: {
        start: new Date('2024-08-10T00:00:00Z'),
        end: new Date('2024-08-10T04:00:00Z'),
      },
      idempotencyKey: `s3i-g10-${f.networkId}`,
    })
    const decisionId = submitResult.decision.decisionId

    // Commit to execution.
    const commitResult = await commitDecisionToExecution(decisionId)
    const executionId = commitResult.executionId
    const assignmentId = commitResult.assignments[0].assignmentId
    const commitmentId = commitResult.assignments[0].commitmentId
    const reservationId = commitResult.assignments[0].reservationId

    // Before release: the reservation's remainingAmount was decremented by 8.
    const reservationBefore = await db.capacityReservation.findUnique({
      where: { id: reservationId },
    })
    expect(reservationBefore!.status).toBe('active')
    // The commitment is active.
    const commitmentBefore = await db.capacityCommitment.findUnique({
      where: { id: commitmentId },
    })
    expect(commitmentBefore!.status).toBe('active')
    // The assignment is 'assigned'.
    const assignmentBefore = await db.executionAssignment.findUnique({
      where: { id: assignmentId },
    })
    expect(assignmentBefore!.status).toBe('assigned')

    // Release (simulating execution failure).
    await releaseDecisionExecution(decisionId, 'simulated adapter failure')

    // After release: the assignment is 'failed'.
    const assignmentAfter = await db.executionAssignment.findUnique({
      where: { id: assignmentId },
    })
    expect(assignmentAfter!.status).toBe('failed')

    // The commitment is 'released'.
    const commitmentAfter = await db.capacityCommitment.findUnique({
      where: { id: commitmentId },
    })
    expect(commitmentAfter!.status).toBe('released')

    // The reservation's remainingAmount was RESTORED (the released amount
    // was added back). The physical capacity is 8; the reservation was for 8;
    // before release remaining was 0 (8 reserved - 8 committed); after release
    // remaining should be back to 8.
    const reservationAfter = await db.capacityReservation.findUnique({
      where: { id: reservationId },
    })
    const remainingAfter = parseFloat(reservationAfter!.remainingAmount)
    const reservedAmount = parseFloat(reservationAfter!.reservedAmount)
    expect(remainingAfter).toBe(reservedAmount) // fully restored
    expect(remainingAfter).toBe(8)

    // The parent Execution is finalized (completed) because all assignments
    // are terminal (failed is terminal).
    const execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).toBe('completed')

    // Idempotency: releasing again is a no-op (releaseCommitment checks status
    // inside its FOR UPDATE lock; failAssignment CAS on status != 'completed').
    await releaseDecisionExecution(decisionId, 'duplicate release attempt')
    const commitmentReRele = await db.capacityCommitment.findUnique({
      where: { id: commitmentId },
    })
    expect(commitmentReRele!.status).toBe('released') // still released, not double-counted
    const reservationReRele = await db.capacityReservation.findUnique({
      where: { id: reservationId },
    })
    expect(parseFloat(reservationReRele!.remainingAmount)).toBe(8) // not double-restored
  })

  // -------------------------------------------------------------------------
  // Gate 12: concurrency — two decisions committing concurrently don't corrupt
  // -------------------------------------------------------------------------
  it('Gate 12: two concurrent commitDecisionToExecution calls on DIFFERENT decisions produce distinct, non-corrupt executions', async () => {
    // Two separate fixtures (isolated networks) so the scheduler picks each
    // resource cleanly.
    const [f1, f2] = await Promise.all([
      createFixture({ label: 'G12-A', capacityAmount: '8' }),
      createFixture({ label: 'G12-B', capacityAmount: '8' }),
    ])

    // Submit two requests (on separate networks) + commit concurrently.
    const [s1, s2] = await Promise.all([
      submitNetworkRequest({
        requesterMembershipId: f1.requesterMembershipId,
        networkId: f1.networkId,
        networkVersionId: f1.networkVersionId,
        capabilityRequirements: [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }],
        timeWindow: {
          start: new Date('2024-08-12T00:00:00Z'),
          end: new Date('2024-08-12T04:00:00Z'),
        },
        idempotencyKey: `s3i-g12-a-${f1.networkId}`,
      }),
      submitNetworkRequest({
        requesterMembershipId: f2.requesterMembershipId,
        networkId: f2.networkId,
        networkVersionId: f2.networkVersionId,
        capabilityRequirements: [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }],
        timeWindow: {
          start: new Date('2024-08-12T00:00:00Z'),
          end: new Date('2024-08-12T04:00:00Z'),
        },
        idempotencyKey: `s3i-g12-b-${f2.networkId}`,
      }),
    ])

    const [r1, r2] = await Promise.all([
      commitDecisionToExecution(s1.decision.decisionId),
      commitDecisionToExecution(s2.decision.decisionId),
    ])

    // Distinct executions, distinct assignments, distinct commitments.
    expect(r1.executionId).not.toBe(r2.executionId)
    expect(r1.assignments[0].assignmentId).not.toBe(r2.assignments[0].assignmentId)
    expect(r1.assignments[0].commitmentId).not.toBe(r2.assignments[0].commitmentId)

    // Each network has exactly ONE execution.
    const e1 = await db.execution.findMany({
      where: { sourceType: EXECUTION_SOURCE_TYPE, sourceId: s1.decision.decisionId },
    })
    const e2 = await db.execution.findMany({
      where: { sourceType: EXECUTION_SOURCE_TYPE, sourceId: s2.decision.decisionId },
    })
    expect(e1.length).toBe(1)
    expect(e2.length).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Gate 7 + 8: retry after a failure produces clean records (idempotent)
  // -------------------------------------------------------------------------
  it('Gate 7+8: a failed first commit (resource sabotaged) + fixed retry produces exactly one clean execution', async () => {
    const f = await createFixture({ label: 'G7-8', capacityAmount: '8' })

    const submitResult = await submitNetworkRequest({
      requesterMembershipId: f.requesterMembershipId,
      networkId: f.networkId,
      networkVersionId: f.networkVersionId,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }],
      timeWindow: {
        start: new Date('2024-08-13T00:00:00Z'),
        end: new Date('2024-08-13T04:00:00Z'),
      },
      idempotencyKey: `s3i-g78-${f.networkId}`,
    })
    const decisionId = submitResult.decision.decisionId

    // First attempt: sabotage the resource's metadata (remove the assetId
    // mapping) so resolveExecutionBinding throws "no assetId in metadata".
    // This is reversible — we restore the metadata for the retry.
    const membership = await db.networkResourceMembership.findUnique({
      where: { id: f.membershipId },
    })
    const resourceId = membership!.resourceId
    const originalMetadata = JSON.stringify({ assetId: f.assetId })

    await db.resourceIdentity.update({
      where: { id: resourceId },
      data: { metadataJson: '{}' },
    })

    await expect(commitDecisionToExecution(decisionId)).rejects.toThrow()

    // No execution created.
    let executions = await db.execution.findMany({
      where: { sourceType: EXECUTION_SOURCE_TYPE, sourceId: decisionId },
    })
    expect(executions.length).toBe(0)

    // Fix the resource metadata + retry.
    await db.resourceIdentity.update({
      where: { id: resourceId },
      data: { metadataJson: originalMetadata },
    })
    const result = await commitDecisionToExecution(decisionId)
    expect(result.replayed).toBe(false)

    // Exactly one execution now.
    executions = await db.execution.findMany({
      where: { sourceType: EXECUTION_SOURCE_TYPE, sourceId: decisionId },
    })
    expect(executions.length).toBe(1)

    // The decision is consumed + request fulfilled.
    const decision = await db.allocationDecision.findUnique({ where: { id: decisionId } })
    expect(decision!.status).toBe('consumed')
  })
})
