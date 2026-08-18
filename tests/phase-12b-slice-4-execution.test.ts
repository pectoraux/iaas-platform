/**
 * Phase 12B Slice 4: Actual Execution — Unit Tests
 *
 * Verifies the executeDecision() orchestrator crosses the RUNTIME-READY →
 * EXECUTING boundary:
 *
 *   ExecutionAssignment (assigned)
 *       ↓ beginAssignmentExecution
 *       ↓ runtime.executeAssignment()  ← adapter via AdapterRegistry
 *       ↓ recordAssignmentResults (actuals)
 *       ↓ completeAssignment
 *   ExecutionAssignment (completed) + parent Execution finalized
 *
 * And on adapter failure:
 *   releaseDecisionExecution (Slice 3 atomic path)
 *       → assignment=failed, commitment=released, reservation.remainingAmount restored
 *
 * Vertical-neutrality is statically checked: the orchestrator source must not
 * import any vertical service (vpp, compute, storage, wireless, etc.).
 *
 * Run: DATABASE_URL=postgresql://... bun test tests/phase-12b-slice-4-execution.test.ts --timeout 240000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import {
  submitNetworkRequest,
  commitDecisionToExecution,
  executeDecision,
  ExecutionFailedError,
  EXECUTION_SOURCE_TYPE,
} from '../src/lib/control-plane'
import { initializeBootstrap } from '../src/lib/bootstrap'

const databaseUrl = process.env.DATABASE_URL || ''
const isPostgres =
  databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')
const describeOrSkip = isPostgres ? describe : describe.skip

// ---------------------------------------------------------------------------
// Fixture: isolated network + compute resource + decision + committed execution
// ---------------------------------------------------------------------------

interface Slice4Fixture {
  tenantId: string
  networkId: string
  networkVersionId: string
  requesterMembershipId: string
  assetId: string
  membershipId: string
}

async function createSlice4Fixture(opts: {
  label: string
  capacityAmount: string
}): Promise<Slice4Fixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const labelLc = opts.label.toLowerCase()
  // Use gpu_compute capability (registered in the SimulatedComputeAdapter).
  const capabilityType = 'gpu_compute'
  const unit = 'GPU-hours'

  const tenant = await createTenant({
    name: `Phase 12B Slice 4 — ${opts.label}`,
    slug: `p12b-s4-${labelLc}-${stamp}`,
    plan: 'growth',
  })
  const instantiated = await instantiateTemplate(tenant.id, 'generic-resource-network', {
    name: `Slice 4 Net ${opts.label}`,
    slug: `net-s4-${labelLc}-${stamp}`,
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
      displayName: `op-s4-${labelLc}-${stamp}`, status: 'active',
    },
  })
  const asset = await db.asset.create({
    data: {
      tenantId: tenant.id, operatorId: operator.id,
      name: `asset-s4-${labelLc}-${stamp}`, assetType: 'compute_node', status: 'active',
    },
  })
  await db.assetNetworkAssignment.create({
    data: {
      tenantId: tenant.id, assetId: asset.id, networkId: network.id,
      capabilityType, status: 'active',
      verifiedQuantity: opts.capacityAmount, verifiedUnit: unit,
    },
  })
  const { ensureCapacityResource } = await import('../src/lib/services/capacity.service')
  await ensureCapacityResource(tenant.id, asset.id, network.id, capabilityType)

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
      capabilitiesJson: JSON.stringify([capabilityType]),
      verifiedCapacityJson: JSON.stringify([
        { capabilityType, amount: opts.capacityAmount, unit },
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

/**
 * Submit a request + commit it to execution. Returns the decisionId.
 */
async function submitAndCommit(
  f: Slice4Fixture,
  opts: { amount: string; idempotencyKey: string },
): Promise<{ decisionId: string; executionId: string; assignmentId: string; commitmentId: string; reservationId: string }> {
  const submitResult = await submitNetworkRequest({
    requesterMembershipId: f.requesterMembershipId,
    networkId: f.networkId,
    networkVersionId: f.networkVersionId,
    capabilityRequirements: [
      { capabilityType: 'gpu_compute', amount: opts.amount, unit: 'GPU-hours' },
    ],
    timeWindow: {
      start: new Date('2024-09-01T00:00:00Z'),
      end: new Date('2024-09-01T04:00:00Z'),
    },
    idempotencyKey: opts.idempotencyKey,
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

beforeAll(() => {
  if (!isPostgres) return
  initializeBootstrap()
})

// ===========================================================================
// Tests
// ===========================================================================

describeOrSkip('Phase 12B Slice 4: Actual Execution (executeDecision)', () => {
  // -------------------------------------------------------------------------
  // Happy path: successful adapter execution → assignment completed + parent finalized
  // -------------------------------------------------------------------------
  it('Happy path: executeDecision completes the assignment + finalizes the parent Execution', async () => {
    const f = await createSlice4Fixture({ label: 'Happy', capacityAmount: '8' })
    const { decisionId, executionId, assignmentId } = await submitAndCommit(f, {
      amount: '8',
      idempotencyKey: `s4-happy-${f.networkId}`,
    })

    // Before execution: assignment=assigned, execution=assigned.
    const assignmentBefore = await db.executionAssignment.findUnique({ where: { id: assignmentId } })
    expect(assignmentBefore!.status).toBe('assigned')

    // Execute.
    const result = await executeDecision(decisionId)

    expect(result.decisionId).toBe(decisionId)
    expect(result.executionId).toBe(executionId)
    expect(result.runtimeKind).toBe('infrastructure')
    expect(result.assignments.length).toBe(1)
    expect(result.assignments[0].status).toBe('completed')
    expect(result.assignments[0].assignmentId).toBe(assignmentId)
    // Actuals recorded.
    expect(result.assignments[0].actualQuantity).toBeDefined()
    expect(result.assignments[0].actualUnit).toBe('GPU-hours')
    expect(result.executionStatus).toBe('completed')

    // The assignment is 'completed' in the DB.
    const assignment = await db.executionAssignment.findUnique({ where: { id: assignmentId } })
    expect(assignment!.status).toBe('completed')
    expect(assignment!.actualQuantity).toBeDefined()
    expect(assignment!.actualUnit).toBe('GPU-hours')

    // The parent Execution is 'completed' (finalizeExecutionIfTerminal ran).
    const execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).toBe('completed')
  })

  // -------------------------------------------------------------------------
  // Failure path: adapter failure → assignment failed + commitment released + capacity restored
  // -------------------------------------------------------------------------
  it('Failure path: adapter failure → ExecutionFailedError + atomic capacity release (no split-brain)', async () => {
    const f = await createSlice4Fixture({ label: 'Fail', capacityAmount: '8' })
    const { decisionId, assignmentId, commitmentId, reservationId } = await submitAndCommit(f, {
      amount: '8',
      idempotencyKey: `s4-fail-${f.networkId}`,
    })

    // Before execution: reservation.remainingAmount was decremented by 8.
    const reservationBefore = await db.capacityReservation.findUnique({ where: { id: reservationId } })
    const reservedBefore = parseFloat(reservationBefore!.reservedAmount) // 8
    const remainingBefore = parseFloat(reservationBefore!.remainingAmount) // 0 (8 reserved - 8 committed)

    // Sabotage: delete the asset's devices so the adapter cannot resolve a
    // device credential — but actually, the adapter doesn't need a device for
    // executeAssignment (it's the telemetry signing that needs it). So we need
    // a different sabotage. We'll use an assetType that has NO registered
    // adapter — the AdapterRegistry will throw "no adapter" → executeAssignment
    // throws → failure path.
    //
    // Change the asset's assetType to an unregistered type.
    await db.asset.update({
      where: { id: f.assetId },
      data: { assetType: 'nonexistent_asset_type' },
    })

    // Execute — should throw ExecutionFailedError.
    await expect(executeDecision(decisionId)).rejects.toThrow(ExecutionFailedError)

    // After failure: the assignment is 'failed'.
    const assignment = await db.executionAssignment.findUnique({ where: { id: assignmentId } })
    expect(assignment!.status).toBe('failed')

    // The commitment is 'released' (NOT active — the atomic release path ran).
    const commitment = await db.capacityCommitment.findUnique({ where: { id: commitmentId } })
    expect(commitment!.status).toBe('released')

    // The reservation's remainingAmount was RESTORED (the committed amount was
    // added back). Before: 0 remaining. After: should be back to 8.
    const reservation = await db.capacityReservation.findUnique({ where: { id: reservationId } })
    expect(parseFloat(reservation!.remainingAmount)).toBe(reservedBefore) // restored to 8

    // THE ATOMICITY PROOF (Slice 3 invariant, re-verified under Slice 4 failure):
    // No split-brain state — assignment=failed + commitment=active is impossible.
    const splitBrain = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "ExecutionAssignment" ea
      JOIN "CapacityCommitment" cc ON ea."capacityCommitmentId" = cc.id
      JOIN "AllocationReservation" ar ON cc."allocationReservationId" = ar.id
      WHERE ar."decisionId" = ${decisionId}
        AND ea.status = 'failed'
        AND cc.status = 'active'
    `
    expect(Number(splitBrain[0].count)).toBe(0)

    // The parent Execution is 'completed' (all assignments terminal).
    const execution = await db.execution.findUnique({
      where: {
        sourceType_sourceId: { sourceType: EXECUTION_SOURCE_TYPE, sourceId: decisionId },
      },
    })
    expect(execution!.status).toBe('completed')

    void reservedBefore
    void remainingBefore
  })

  // -------------------------------------------------------------------------
  // Idempotent re-execution: executing an already-completed decision is a no-op
  // -------------------------------------------------------------------------
  it('Idempotency: re-executing a completed decision returns the existing results (no duplicate execution)', async () => {
    const f = await createSlice4Fixture({ label: 'Idem', capacityAmount: '8' })
    const { decisionId, assignmentId } = await submitAndCommit(f, {
      amount: '8',
      idempotencyKey: `s4-idem-${f.networkId}`,
    })

    // First execution.
    const result1 = await executeDecision(decisionId)
    expect(result1.assignments[0].status).toBe('completed')

    // Second execution — should return the same results (no duplicate).
    const result2 = await executeDecision(decisionId)
    expect(result2.assignments.length).toBe(1)
    expect(result2.assignments[0].assignmentId).toBe(assignmentId)
    expect(result2.assignments[0].status).toBe('completed')
    expect(result2.assignments[0].actualQuantity).toBe(result1.assignments[0].actualQuantity)

    // Still exactly ONE assignment (no duplicate created).
    const executions = await db.execution.findMany({
      where: { sourceType: EXECUTION_SOURCE_TYPE, sourceId: decisionId },
    })
    expect(executions.length).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Vertical-neutrality: the orchestrator does NOT import any vertical service
  // -------------------------------------------------------------------------
  it('Vertical-neutrality: executeDecision source does not import any vertical (vpp, compute, storage, wireless)', async () => {
    const source = await import('fs').then((fs) =>
      fs.readFileSync('./src/lib/control-plane/execution-orchestrator.ts', 'utf8'),
    )
    // Check import lines only (not comments).
    const importLines = source
      .split('\n')
      .filter((l) => l.match(/^\s*import\s/) || l.match(/^\s*}\s*from\s/))
      .join('\n')
    // Must NOT import vertical-specific services.
    expect(importLines).not.toMatch(/vpp\.service/)
    expect(importLines).not.toMatch(/compute\.service/)
    expect(importLines).not.toMatch(/compute-adapter\.service/)
    expect(importLines).not.toMatch(/storage\.service/)
    expect(importLines).not.toMatch(/wireless\.service/)
    // Must NOT import InfrastructureRuntime/ProtocolRuntime/HybridRuntime directly.
    expect(importLines).not.toMatch(/InfrastructureRuntime/)
    expect(importLines).not.toMatch(/ProtocolRuntime/)
    expect(importLines).not.toMatch(/HybridRuntime/)
    // MUST import resolveRuntime (the indirection).
    expect(source).toContain('resolveRuntime')
    expect(source).toContain('runtime.executeAssignment')
  })
})
