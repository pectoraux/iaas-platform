/**
 * Phase 12B Slice 3: Execution Orchestrator — Unit Tests
 *
 * Covers acceptance gates 1-9 + 11 against real PostgreSQL (Neon):
 *
 *   1. Every AllocationReservation can become a CapacityCommitment.
 *   2. Every committed allocation creates exactly one generic Execution.
 *   3. Every committed resource creates exactly one ExecutionAssignment.
 *   4. ExecutionAssignment.capacityCommitmentId points to the exact commitment.
 *   5. NetworkVersion.runtimeKind selects the NetworkRuntime.
 *   6. Control plane never imports InfrastructureRuntime/ProtocolRuntime directly.
 *   7. Allocation → Commitment → Execution is atomic.
 *   8. Retry is idempotent; no duplicate execution or commitment.
 *   9. Multi-capability allocations create distinct commitments/assignments.
 *  11. Existing VPP + Compute runtime tests remain green.
 *
 * Gate 10 (execution-failure release) + gate 12 (concurrency) are in the
 * integration test file (phase-12b-slice-3-integration.test.ts).
 *
 * Run: DATABASE_URL=postgresql://... bun test tests/phase-12b-slice-3-orchestrator.test.ts --timeout 180000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { submitNetworkRequest, commitDecisionToExecution } from '../src/lib/control-plane'
import { initializeBootstrap } from '../src/lib/bootstrap'
import {
  EXECUTION_SOURCE_TYPE,
  COMMITMENT_SOURCE_TYPE,
  type CommitDecisionToExecutionResult,
} from '../src/lib/control-plane'

const databaseUrl = process.env.DATABASE_URL || ''
const isPostgres =
  databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')
const describeOrSkip = isPostgres ? describe : describe.skip

// ---------------------------------------------------------------------------
// Fixture: an isolated network + resource + decision for one test.
// ---------------------------------------------------------------------------

interface Slice3Fixture {
  tenantId: string
  networkId: string
  networkVersionId: string
  requesterMembershipId: string
  assetId: string
  resourceIdentityId: string
  membershipId: string
}

async function createSlice3Fixture(opts: {
  label: string
  capabilityType: string
  unit: string
  capacityAmount: string
}): Promise<Slice3Fixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const labelLc = opts.label.toLowerCase()

  const tenant = await createTenant({
    name: `Phase 12B Slice 3 — ${opts.label}`,
    slug: `p12b-s3-${labelLc}-${stamp}`,
    plan: 'growth',
  })

  const instantiated = await instantiateTemplate(
    tenant.id,
    'generic-resource-network',
    {
      name: `Slice 3 Net ${opts.label}`,
      slug: `net-s3-${labelLc}-${stamp}`,
    },
  )
  const network = instantiated.network
  const version = instantiated.version!
  // generic-resource-network defaults to runtimeKind='infrastructure' — the
  // only runtime kind the Slice 3 orchestrator supports (protocol throws).

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

  const operator = await db.operator.create({
    data: {
      tenantId: tenant.id,
      organizationId: null,
      displayName: `op-s3-${labelLc}-${stamp}`,
      status: 'active',
    },
  })
  const asset = await db.asset.create({
    data: {
      tenantId: tenant.id,
      operatorId: operator.id,
      name: `asset-s3-${labelLc}-${stamp}`,
      assetType: 'compute_node',
      status: 'active',
    },
  })
  await db.assetNetworkAssignment.create({
    data: {
      tenantId: tenant.id,
      assetId: asset.id,
      networkId: network.id,
      capabilityType: opts.capabilityType,
      status: 'active',
      verifiedQuantity: opts.capacityAmount,
      verifiedUnit: opts.unit,
    },
  })

  const { ensureCapacityResource } = await import('../src/lib/services/capacity.service')
  await ensureCapacityResource(tenant.id, asset.id, network.id, opts.capabilityType)

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
      capabilitiesJson: JSON.stringify([opts.capabilityType]),
      verifiedCapacityJson: JSON.stringify([
        { capabilityType: opts.capabilityType, amount: opts.capacityAmount, unit: opts.unit },
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
  }
}

// ---------------------------------------------------------------------------
// Bootstrap must be initialized before any runtime resolution.
// ---------------------------------------------------------------------------

beforeAll(() => {
  if (!isPostgres) return
  initializeBootstrap()
})

// ===========================================================================
// Tests
// ===========================================================================

describeOrSkip('Phase 12B Slice 3: Execution Orchestrator (unit)', () => {
  // -------------------------------------------------------------------------
  // Gates 1-4: single-capability decision → commitment + execution + assignment
  // -------------------------------------------------------------------------
  it('Gates 1-4: single-capability decision creates one commitment, one execution, one assignment (linked)', async () => {
    const f = await createSlice3Fixture({
      label: 'G1-4',
      capabilityType: 'compute',
      unit: 'GPU',
      capacityAmount: '8',
    })

    // Submit a request → get a decision (Slice 2).
    const submitResult = await submitNetworkRequest({
      requesterMembershipId: f.requesterMembershipId,
      networkId: f.networkId,
      networkVersionId: f.networkVersionId,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      ],
      timeWindow: {
        start: new Date('2024-08-01T00:00:00Z'),
        end: new Date('2024-08-01T04:00:00Z'),
      },
      idempotencyKey: `s3-g1-${f.networkId}`,
    })

    const decisionId = submitResult.decision.decisionId

    // Commit the decision to execution (Slice 3).
    const result: CommitDecisionToExecutionResult = await commitDecisionToExecution(decisionId)

    // Gate 2: exactly one Execution per decision.
    expect(result.executionId).toBeDefined()
    expect(result.replayed).toBe(false)

    const executions = await db.execution.findMany({
      where: { sourceType: EXECUTION_SOURCE_TYPE, sourceId: decisionId },
    })
    expect(executions.length).toBe(1)
    expect(executions[0].id).toBe(result.executionId)
    expect(executions[0].networkVersionId).toBe(f.networkVersionId)

    // Gate 1: every AllocationReservation became a CapacityCommitment.
    expect(result.assignments.length).toBe(1)
    const allocReservations = await db.allocationReservation.findMany({
      where: { decisionId },
      include: { capacityCommitments: true },
    })
    expect(allocReservations.length).toBe(1)
    expect(allocReservations[0].capacityCommitments.length).toBe(1)
    expect(allocReservations[0].capacityCommitments[0].id).toBe(result.assignments[0].commitmentId)

    // The explicit FK (allocationReservationId) is set.
    expect(allocReservations[0].capacityCommitments[0].allocationReservationId).toBe(
      allocReservations[0].id,
    )

    // Gate 3: one ExecutionAssignment per committed resource.
    const assignments = await db.executionAssignment.findMany({
      where: { executionId: result.executionId },
    })
    expect(assignments.length).toBe(1)
    expect(assignments[0].id).toBe(result.assignments[0].assignmentId)

    // Gate 4: ExecutionAssignment.capacityCommitmentId points to the exact commitment.
    expect(assignments[0].capacityCommitmentId).toBe(result.assignments[0].commitmentId)

    // The assignment is linked to the correct asset (via the provider boundary).
    expect(assignments[0].assetId).toBe(f.assetId)

    // The decision is marked consumed + request fulfilled.
    const decision = await db.allocationDecision.findUnique({ where: { id: decisionId } })
    expect(decision!.status).toBe('consumed')
    const request = await db.networkRequest.findUnique({
      where: { id: submitResult.request.requestId },
    })
    expect(request!.status).toBe('fulfilled')
  })

  // -------------------------------------------------------------------------
  // Gate 9: multi-capability allocation creates distinct commitments/assignments
  // -------------------------------------------------------------------------
  it('Gate 9: multi-capability allocation (GPU + cores) creates distinct commitments + assignments, sharing one Execution', async () => {
    // Provision a resource with TWO capabilities: GPU + cores.
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const tenant = await createTenant({
      name: 'Phase 12B Slice 3 — G9 Multi',
      slug: `p12b-s3-g9-${stamp}`,
      plan: 'growth',
    })
    const instantiated = await instantiateTemplate(
    tenant.id,
    'generic-resource-network', {
      name: `Slice 3 Net G9`,
      slug: `net-s3-g9-${stamp}`,
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
        tenantId: tenant.id,
        organizationId: null,
        displayName: `op-s3-g9-${stamp}`,
        status: 'active',
      },
    })
    const asset = await db.asset.create({
      data: {
        tenantId: tenant.id,
        operatorId: operator.id,
        name: `asset-s3-g9-${stamp}`,
        assetType: 'compute_node',
        status: 'active',
      },
    })
    // Two DISTINCT capabilityTypes on the same asset (CapacityResource is
    // keyed by (assetId, networkId, capabilityType), so the two capabilities
    // must differ by capabilityType, not just unit).
    await db.assetNetworkAssignment.create({
      data: {
        tenantId: tenant.id, assetId: asset.id, networkId: network.id,
        capabilityType: 'compute', status: 'active',
        verifiedQuantity: '8', verifiedUnit: 'GPU',
      },
    })
    await db.assetNetworkAssignment.create({
      data: {
        tenantId: tenant.id, assetId: asset.id, networkId: network.id,
        capabilityType: 'memory', status: 'active',
        verifiedQuantity: '32', verifiedUnit: 'GB',
      },
    })
    const { ensureCapacityResource } = await import('../src/lib/services/capacity.service')
    await ensureCapacityResource(tenant.id, asset.id, network.id, 'compute')
    await ensureCapacityResource(tenant.id, asset.id, network.id, 'memory')

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
        capabilitiesJson: JSON.stringify(['compute', 'memory']),
        verifiedCapacityJson: JSON.stringify([
          { capabilityType: 'compute', amount: '8', unit: 'GPU' },
          { capabilityType: 'memory', amount: '32', unit: 'GB' },
        ]),
        controlMode: 'default',
        verificationProfile: 'default',
        status: 'active',
      },
    })

    // Submit a request for BOTH compute (GPU) + memory (GB).
    const submitResult = await submitNetworkRequest({
      requesterMembershipId: membership.id,
      networkId: network.id,
      networkVersionId: version.id,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
        { capabilityType: 'memory', amount: '32', unit: 'GB' },
      ],
      timeWindow: {
        start: new Date('2024-08-02T00:00:00Z'),
        end: new Date('2024-08-02T04:00:00Z'),
      },
      idempotencyKey: `s3-g9-${network.id}`,
    })

    const decisionId = submitResult.decision.decisionId
    const result = await commitDecisionToExecution(decisionId)

    // Gate 2: ONE Execution (shared across capabilities).
    expect(result.assignments.length).toBe(2)
    const executions = await db.execution.findMany({
      where: { sourceType: EXECUTION_SOURCE_TYPE, sourceId: decisionId },
    })
    expect(executions.length).toBe(1)

    // Gate 9: TWO distinct commitments + TWO distinct assignments.
    const commitments = await db.capacityCommitment.findMany({
      where: { allocationReservationId: { not: null } },
      include: { allocationReservation: true },
    })
    const decisionCommitments = commitments.filter(
      (c) => c.allocationReservation!.decisionId === decisionId,
    )
    expect(decisionCommitments.length).toBe(2)
    // Distinct capabilityType+unit (compute/GPU vs memory/GB).
    const caps = decisionCommitments.map((c) => `${c.unit}`).sort()
    expect(caps).toEqual(['GB', 'GPU'])

    const assignments = await db.executionAssignment.findMany({
      where: { executionId: result.executionId },
    })
    expect(assignments.length).toBe(2)
    // Each assignment links to a distinct commitment.
    const commitmentIds = assignments.map((a) => a.capacityCommitmentId).sort()
    const distinctCommitmentIds = [...new Set(commitmentIds)]
    expect(distinctCommitmentIds.length).toBe(2)

    // Both assignments point to the same asset (same resource, two capabilities).
    expect(new Set(assignments.map((a) => a.assetId)).size).toBe(1)
    expect(assignments[0].assetId).toBe(asset.id)
  })

  // -------------------------------------------------------------------------
  // Gate 8: retry is idempotent — no duplicate execution or commitment
  // -------------------------------------------------------------------------
  it('Gate 8: retry after successful creation returns the same objects (no duplicates)', async () => {
    const f = await createSlice3Fixture({
      label: 'G8',
      capabilityType: 'compute',
      unit: 'GPU',
      capacityAmount: '8',
    })

    const submitResult = await submitNetworkRequest({
      requesterMembershipId: f.requesterMembershipId,
      networkId: f.networkId,
      networkVersionId: f.networkVersionId,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      ],
      timeWindow: {
        start: new Date('2024-08-03T00:00:00Z'),
        end: new Date('2024-08-03T04:00:00Z'),
      },
      idempotencyKey: `s3-g8-${f.networkId}`,
    })

    const decisionId = submitResult.decision.decisionId

    // First commit.
    const result1 = await commitDecisionToExecution(decisionId)
    expect(result1.replayed).toBe(false)

    // Retry — must return the SAME objects, replayed=true.
    const result2 = await commitDecisionToExecution(decisionId)
    expect(result2.replayed).toBe(true)
    expect(result2.executionId).toBe(result1.executionId)
    expect(result2.assignments.length).toBe(result1.assignments.length)
    expect(result2.assignments[0].assignmentId).toBe(result1.assignments[0].assignmentId)
    expect(result2.assignments[0].commitmentId).toBe(result1.assignments[0].commitmentId)

    // DB-level: still exactly ONE Execution, ONE commitment, ONE assignment.
    const executions = await db.execution.findMany({
      where: { sourceType: EXECUTION_SOURCE_TYPE, sourceId: decisionId },
    })
    expect(executions.length).toBe(1)

    const commitments = await db.capacityCommitment.findMany({
      where: { sourceType: COMMITMENT_SOURCE_TYPE, sourceId: `${decisionId}:${result1.assignments[0].allocationReservationId}` },
    })
    expect(commitments.length).toBe(1)

    const assignments = await db.executionAssignment.findMany({
      where: { executionId: result1.executionId },
    })
    expect(assignments.length).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Gates 5, 6: runtimeKind selects the runtime; control plane doesn't import
  //              InfrastructureRuntime/ProtocolRuntime directly.
  // -------------------------------------------------------------------------
  it('Gate 5: runtimeKind is read from the NetworkVersion and drives execution creation', async () => {
    const f = await createSlice3Fixture({
      label: 'G5',
      capabilityType: 'compute',
      unit: 'GPU',
      capacityAmount: '8',
    })

    // The instantiated version's runtimeKind should be 'infrastructure'.
    const nv = await db.networkVersion.findUnique({ where: { id: f.networkVersionId } })
    expect(nv!.runtimeKind).toBe('infrastructure')

    const submitResult = await submitNetworkRequest({
      requesterMembershipId: f.requesterMembershipId,
      networkId: f.networkId,
      networkVersionId: f.networkVersionId,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      ],
      timeWindow: {
        start: new Date('2024-08-04T00:00:00Z'),
        end: new Date('2024-08-04T04:00:00Z'),
      },
      idempotencyKey: `s3-g5-${f.networkId}`,
    })

    const result = await commitDecisionToExecution(submitResult.decision.decisionId)
    // The result carries the resolved runtimeKind (proving the runtime was
    // resolved via the registry, not imported directly).
    expect(result.runtimeKind).toBe('infrastructure')

    // Gate 6 (static): verify the orchestrator module does NOT IMPORT
    // InfrastructureRuntime/ProtocolRuntime/HybridRuntime directly. We check
    // for import statements (not comment text — the comments mention these
    // names when explaining the architectural rule).
    const orchestratorSource = await import('fs').then((fs) =>
      fs.readFileSync('./src/lib/control-plane/execution-orchestrator.ts', 'utf8'),
    )
    // The only kernel import should be the runtime barrel (resolveRuntime etc).
    const importLines = orchestratorSource
      .split('\n')
      .filter((l) => l.match(/^\s*import\s/) || l.match(/^\s*}\s*from\s/))
      .join('\n')
    expect(importLines).not.toMatch(/InfrastructureRuntime/)
    expect(importLines).not.toMatch(/ProtocolRuntime/)
    expect(importLines).not.toMatch(/HybridRuntime/)
    expect(orchestratorSource).toContain('resolveRuntime')
  })

  // -------------------------------------------------------------------------
  // Protocol runtimeKind → rejected (out of scope for Slice 3)
  // -------------------------------------------------------------------------
  it('Protocol runtimeKind is rejected with a clear error', async () => {
    const f = await createSlice3Fixture({
      label: 'Proto',
      capabilityType: 'compute',
      unit: 'GPU',
      capacityAmount: '8',
    })

    // Override the NetworkVersion's runtimeKind to 'protocol'.
    await db.networkVersion.update({
      where: { id: f.networkVersionId },
      data: { runtimeKind: 'protocol' },
    })

    const submitResult = await submitNetworkRequest({
      requesterMembershipId: f.requesterMembershipId,
      networkId: f.networkId,
      networkVersionId: f.networkVersionId,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      ],
      timeWindow: {
        start: new Date('2024-08-05T00:00:00Z'),
        end: new Date('2024-08-05T04:00:00Z'),
      },
      idempotencyKey: `s3-proto-${f.networkId}`,
    })

    await expect(
      commitDecisionToExecution(submitResult.decision.decisionId),
    ).rejects.toThrow(/Protocol runtime execution is not supported/)
  })

  // -------------------------------------------------------------------------
  // Gate 7: atomicity — a missing resource (deleted between submit + commit)
  //         causes the whole transaction to roll back (no partial records).
  // -------------------------------------------------------------------------
  it('Gate 7: if the selected resource is missing, the transaction rolls back (no partial commitment/execution)', async () => {
    const f = await createSlice3Fixture({
      label: 'G7',
      capabilityType: 'compute',
      unit: 'GPU',
      capacityAmount: '8',
    })

    const submitResult = await submitNetworkRequest({
      requesterMembershipId: f.requesterMembershipId,
      networkId: f.networkId,
      networkVersionId: f.networkVersionId,
      capabilityRequirements: [
        { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      ],
      timeWindow: {
        start: new Date('2024-08-06T00:00:00Z'),
        end: new Date('2024-08-06T04:00:00Z'),
      },
      idempotencyKey: `s3-g7-${f.networkId}`,
    })

    const decisionId = submitResult.decision.decisionId

    // Sabotage: delete the ResourceIdentity. This cascades to the
    // NetworkResourceMembership (FK onDelete: Cascade), so the orchestrator's
    // membership lookup returns null → throws "not found" inside the
    // transaction. The transaction must roll back — no Execution, no
    // CapacityCommitment, no ExecutionAssignment should persist.
    await db.resourceIdentity.delete({ where: { id: f.resourceIdentityId } })

    await expect(commitDecisionToExecution(decisionId)).rejects.toThrow()

    // No Execution should have been created.
    const executions = await db.execution.findMany({
      where: { sourceType: EXECUTION_SOURCE_TYPE, sourceId: decisionId },
    })
    expect(executions.length).toBe(0)

    // No CapacityCommitment with this decision's sourceId pattern.
    const commitments = await db.capacityCommitment.findMany({
      where: { sourceType: COMMITMENT_SOURCE_TYPE },
    })
    const decisionCommitments = commitments.filter((c) =>
      c.sourceId?.startsWith(`${decisionId}:`),
    )
    expect(decisionCommitments.length).toBe(0)

    // The decision should NOT be marked consumed (the tx rolled back).
    const decision = await db.allocationDecision.findUnique({ where: { id: decisionId } })
    expect(decision!.status).toBe('active')
  })
})
