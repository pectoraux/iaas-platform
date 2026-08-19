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
  recoverStuckAssignments,
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

  // -------------------------------------------------------------------------
  // Mixed-success: A succeeds + B fails → A retained, B released, no cross-contamination
  // -------------------------------------------------------------------------
  it('Mixed-success: completed assignment A is NOT released when assignment B fails (targeted release)', async () => {
    // Provision ONE resource with TWO capabilities (gpu_compute + cpu_compute)
    // so the scheduler produces ONE decision with TWO assignments.
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const tenant = await createTenant({
      name: 'Phase 12B Slice 4 — Mixed',
      slug: `p12b-s4-mixed-${stamp}`,
      plan: 'growth',
    })
    const instantiated = await instantiateTemplate(tenant.id, 'generic-resource-network', {
      name: `Slice 4 Mixed Net`,
      slug: `net-s4-mixed-${stamp}`,
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
        displayName: `op-mixed-${stamp}`, status: 'active',
      },
    })
    const asset = await db.asset.create({
      data: {
        tenantId: tenant.id, operatorId: operator.id,
        name: `asset-mixed-${stamp}`, assetType: 'compute_node', status: 'active',
      },
    })
    // TWO capabilities on the SAME asset (scheduler requires one resource to
    // offer all requested capabilities).
    await db.assetNetworkAssignment.create({
      data: {
        tenantId: tenant.id, assetId: asset.id, networkId: network.id,
        capabilityType: 'gpu_compute', status: 'active',
        verifiedQuantity: '8', verifiedUnit: 'GPU-hours',
      },
    })
    await db.assetNetworkAssignment.create({
      data: {
        tenantId: tenant.id, assetId: asset.id, networkId: network.id,
        capabilityType: 'cpu_compute', status: 'active',
        verifiedQuantity: '32', verifiedUnit: 'CPU-hours',
      },
    })
    const { ensureCapacityResource } = await import('../src/lib/services/capacity.service')
    await ensureCapacityResource(tenant.id, asset.id, network.id, 'gpu_compute')
    await ensureCapacityResource(tenant.id, asset.id, network.id, 'cpu_compute')

    const resourceIdentity = await db.resourceIdentity.create({
      data: {
        resourceKind: 'compute', status: 'active',
        metadataJson: JSON.stringify({ assetId: asset.id }),
      },
    })
    await db.networkResourceMembership.create({
      data: {
        resourceId: resourceIdentity.id, networkId: network.id,
        participantMembershipId: membership.id,
        capabilitiesJson: JSON.stringify(['gpu_compute', 'cpu_compute']),
        verifiedCapacityJson: JSON.stringify([
          { capabilityType: 'gpu_compute', amount: '8', unit: 'GPU-hours' },
          { capabilityType: 'cpu_compute', amount: '32', unit: 'CPU-hours' },
        ]),
        controlMode: 'default', verificationProfile: 'default', status: 'active',
      },
    })

    // Submit a request for BOTH capabilities → one decision, two assignments.
    const submitResult = await submitNetworkRequest({
      requesterMembershipId: membership.id,
      networkId: network.id,
      networkVersionId: version.id,
      capabilityRequirements: [
        { capabilityType: 'gpu_compute', amount: '8', unit: 'GPU-hours' },
        { capabilityType: 'cpu_compute', amount: '32', unit: 'CPU-hours' },
      ],
      timeWindow: {
        start: new Date('2024-09-02T00:00:00Z'),
        end: new Date('2024-09-02T04:00:00Z'),
      },
      idempotencyKey: `s4-mixed-${network.id}`,
    })
    const decisionId = submitResult.decision.decisionId
    const commitResult = await commitDecisionToExecution(decisionId)
    expect(commitResult.assignments.length).toBe(2)

    // Identify which assignment is A (gpu_compute) vs B (cpu_compute).
    const assignmentA = commitResult.assignments.find((a) => a.capabilityType === 'gpu_compute')!
    const assignmentB = commitResult.assignments.find((a) => a.capabilityType === 'cpu_compute')!
    const commitmentA = assignmentA.commitmentId
    const commitmentB = assignmentB.commitmentId
    const reservationA = assignmentA.reservationId
    const reservationB = assignmentB.reservationId

    // Capture reservation remainingAmounts before (both decremented by commitment creation).
    const resABefore = await db.capacityReservation.findUnique({ where: { id: reservationA } })
    const resBBefore = await db.capacityReservation.findUnique({ where: { id: reservationB } })
    const remainingABefore = parseFloat(resABefore!.remainingAmount)
    const remainingBBefore = parseFloat(resBBefore!.remainingAmount)

    // Simulate mixed-success:
    //   Assignment A (gpu_compute) → SUCCESS → completed (via runtime.completeAssignment)
    //   Assignment B (cpu_compute) → FAILURE → needs release
    //
    // We complete A manually via the runtime (operational completion), then
    // call releaseFailedAssignments([assignmentB]) — the targeted release.
    // This tests the fix: A's commitment must NOT be released.
    const { resolveRuntime } = await import('../src/lib/kernel/runtime')
    const runtime = resolveRuntime('infrastructure')
    await db.$transaction(async (tx) => {
      await runtime.completeAssignment(tx, tenant.id, assignmentA.assignmentId, commitResult.executionId)
    })

    // Verify A is completed.
    const assignABefore = await db.executionAssignment.findUnique({ where: { id: assignmentA.assignmentId } })
    expect(assignABefore!.status).toBe('completed')

    // Now release ONLY assignment B (the failed one).
    const { releaseFailedAssignments } = await import('../src/lib/control-plane')
    await releaseFailedAssignments(decisionId, [assignmentB.assignmentId], 'cpu_compute adapter failure')

    // --- Assert A: completed + commitment RETAINED + reservation NOT restored ---
    const assignA = await db.executionAssignment.findUnique({ where: { id: assignmentA.assignmentId } })
    expect(assignA!.status).toBe('completed') // still completed — NOT failed

    const commitA = await db.capacityCommitment.findUnique({ where: { id: commitmentA } })
    // A's commitment must NOT be released — it completed successfully.
    expect(commitA!.status).not.toBe('released')
    // A's reservation must NOT be restored — the capacity was legitimately used.
    const resAAfter = await db.capacityReservation.findUnique({ where: { id: reservationA } })
    expect(parseFloat(resAAfter!.remainingAmount)).toBe(remainingABefore) // unchanged

    // --- Assert B: failed + commitment released + reservation restored ---
    const assignB = await db.executionAssignment.findUnique({ where: { id: assignmentB.assignmentId } })
    expect(assignB!.status).toBe('failed')

    const commitB = await db.capacityCommitment.findUnique({ where: { id: commitmentB } })
    expect(commitB!.status).toBe('released')

    const resBAfter = await db.capacityReservation.findUnique({ where: { id: reservationB } })
    // B's reservation IS restored (the released amount was added back).
    expect(parseFloat(resBAfter!.remainingAmount)).toBeGreaterThan(remainingBBefore)

    // --- THE MIXED-SUCCESS INVARIANT: no completed assignment has a released commitment ---
    const completedButReleased = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "ExecutionAssignment" ea
      JOIN "CapacityCommitment" cc ON ea."capacityCommitmentId" = cc.id
      JOIN "AllocationReservation" ar ON cc."allocationReservationId" = ar.id
      WHERE ar."decisionId" = ${decisionId}
        AND ea.status = 'completed'
        AND cc.status = 'released'
    `
    expect(Number(completedButReleased[0].count)).toBe(0)

    // --- Inverse: the failed assignment DOES have a released commitment ---
    const failedAndReleased = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "ExecutionAssignment" ea
      JOIN "CapacityCommitment" cc ON ea."capacityCommitmentId" = cc.id
      JOIN "AllocationReservation" ar ON cc."allocationReservationId" = ar.id
      WHERE ar."decisionId" = ${decisionId}
        AND ea.status = 'failed'
        AND cc.status = 'released'
    `
    expect(Number(failedAndReleased[0].count)).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Stuck-state recovery: a stuck 'executing' assignment is recovered + not re-executed on retry
  // (NOT a crash proof — see EXECUTION_LEASE_MS docblock. This tests the
  // database-level idempotency guard, NOT physical fencing.)
  // -------------------------------------------------------------------------
  it('Stuck-state recovery: a stuck "executing" assignment is recovered + not re-executed on retry (database-level idempotency)', async () => {
    const f = await createSlice4Fixture({ label: 'Crash', capacityAmount: '8' })
    const { decisionId, executionId, assignmentId } = await submitAndCommit(f, {
      amount: '8',
      idempotencyKey: `s4-crash-${f.networkId}`,
    })

    // Simulate a crash: manually transition the assignment to 'executing'
    // (as if beginAssignmentExecution ran but the process died before
    // recordAssignmentResults/completeAssignment).
    await db.executionAssignment.update({
      where: { id: assignmentId },
      data: { status: 'executing' },
    })
    await db.execution.update({
      where: { id: executionId },
      data: { status: 'executing' },
    })

    // Simulate the assignment having been created long ago (older than the lease).
    // We use a lease of 0ms so recovery picks it up immediately.
    const recovered = await recoverStuckAssignments(decisionId, { leaseMs: 0 })
    expect(recovered.length).toBe(1)
    expect(recovered[0].assignmentId).toBe(assignmentId)
    expect(recovered[0].recovered).toBe(true)

    // After recovery: the assignment is 'failed' (not 'executing').
    const assignment = await db.executionAssignment.findUnique({ where: { id: assignmentId } })
    expect(assignment!.status).toBe('failed')

    // Its commitment is released + reservation restored (releaseFailedAssignments ran).
    // Query the commitment directly via the assignment's capacityCommitmentId FK.
    const commitmentId = assignment!.capacityCommitmentId
    expect(commitmentId).not.toBeNull()
    const commit = await db.capacityCommitment.findUnique({ where: { id: commitmentId! } })
    expect(commit!.status).toBe('released')

    // --- THE CRASH/RETRY CONTRACT: a retry of executeDecision does NOT re-execute ---
    // executeDecision skips already-terminal assignments. The recovered assignment
    // is now 'failed' (terminal), so executeDecision returns it as-is without
    // calling runtime.executeAssignment again.
    const result = await executeDecision(decisionId)
    // The result includes the recovered (failed) assignment — NOT re-executed.
    const recoveredInResult = result.assignments.find((a) => a.assignmentId === assignmentId)
    expect(recoveredInResult).toBeDefined()
    expect(recoveredInResult!.status).toBe('failed')
    // No NEW assignment was created (still exactly one assignment for this execution).
    const assignments = await db.executionAssignment.findMany({ where: { executionId } })
    expect(assignments.length).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Completed-assignment protection: releaseFailedAssignments must NOT release
  // a completed assignment's commitment (Slice 4.1 hardening regression)
  // -------------------------------------------------------------------------
  it('Completed-assignment protection: releaseFailedAssignments([completedId]) leaves the commitment + reservation untouched', async () => {
    const f = await createSlice4Fixture({ label: 'Protect', capacityAmount: '8' })
    const { decisionId, executionId, assignmentId, commitmentId, reservationId } = await submitAndCommit(f, {
      amount: '8',
      idempotencyKey: `s4-protect-${f.networkId}`,
    })

    // Capture the commitment + reservation state BEFORE.
    const commitmentBefore = await db.capacityCommitment.findUnique({ where: { id: commitmentId } })
    const reservationBefore = await db.capacityReservation.findUnique({ where: { id: reservationId } })
    const commitmentStatusBefore = commitmentBefore!.status
    const reservationRemainingBefore = parseFloat(reservationBefore!.remainingAmount)

    // Mark the assignment as 'completed' via the runtime (operational completion).
    // This is the state that must be PROTECTED from releaseFailedAssignments.
    const { resolveRuntime } = await import('../src/lib/kernel/runtime')
    const runtime = resolveRuntime('infrastructure')
    await db.$transaction(async (tx) => {
      await runtime.completeAssignment(tx, f.tenantId, assignmentId, executionId)
    })

    // Verify the assignment is now completed.
    const completed = await db.executionAssignment.findUnique({ where: { id: assignmentId } })
    expect(completed!.status).toBe('completed')

    // ATTEMPT TO RELEASE A COMPLETED ASSIGNMENT — this must be a NO-OP for the
    // commitment + reservation. The Slice 4.1 hardening inspects the
    // assignment's status inside the transaction and skips releaseCommitment
    // entirely for 'completed' assignments.
    const { releaseFailedAssignments } = await import('../src/lib/control-plane')
    await releaseFailedAssignments(decisionId, [assignmentId], 'attempt to release a completed assignment (must be rejected)')

    // THE REGRESSION ASSERTION: the commitment is UNCHANGED (not released).
    const commitmentAfter = await db.capacityCommitment.findUnique({ where: { id: commitmentId } })
    expect(commitmentAfter!.status).toBe(commitmentStatusBefore)
    expect(commitmentAfter!.status).not.toBe('released')

    // THE REGRESSION ASSERTION: the reservation is UNCHANGED (not restored).
    const reservationAfter = await db.capacityReservation.findUnique({ where: { id: reservationId } })
    expect(parseFloat(reservationAfter!.remainingAmount)).toBe(reservationRemainingBefore)

    // The assignment is still 'completed' (not failed).
    const stillCompleted = await db.executionAssignment.findUnique({ where: { id: assignmentId } })
    expect(stillCompleted!.status).toBe('completed')
  })

  // -------------------------------------------------------------------------
  // Concurrency-safe completed-assignment protection (Slice 4.2):
  // a concurrent completeAssignment must NOT be able to slip in between the
  // status read and the releaseCommitment call. The FOR UPDATE lock makes the
  // release conditional on the locked state.
  // -------------------------------------------------------------------------
  it('Concurrency-safe: a concurrent completeAssignment racing releaseFailedAssignments cannot release the completed commitment', async () => {
    const f = await createSlice4Fixture({ label: 'Race', capacityAmount: '8' })
    const { decisionId, executionId, assignmentId, commitmentId, reservationId } = await submitAndCommit(f, {
      amount: '8',
      idempotencyKey: `s4-race-${f.networkId}`,
    })

    // Capture state before.
    const reservationBefore = await db.capacityReservation.findUnique({ where: { id: reservationId } })
    const reservationRemainingBefore = parseFloat(reservationBefore!.remainingAmount)

    // Fire BOTH concurrently:
    //   - Tx A: releaseFailedAssignments([assignmentId])
    //   - Tx B: runtime.completeAssignment(assignmentId)
    //
    // The FOR UPDATE lock in releaseFailedAssignments serializes the two:
    //   - If releaseFailedAssignments acquires the lock first, it sees status
    //     'assigned', fails + releases. Then completeAssignment runs but the
    //     CAS in completeAssignment (status='assigned'/'executing') may no-op
    //     because the assignment is now 'failed'. The commitment is released
    //     (legitimate — the release won the race).
    //   - If completeAssignment acquires the row first (via its UPDATE), it
    //     sets status='completed' + commits. Then releaseFailedAssignments
    //     acquires the FOR UPDATE lock, sees status='completed', and SKIPS the
    //     releaseCommitment call. The commitment is NOT released.
    //
    // Either way, the INVARIANT holds: an assignment that ends up 'completed'
    // NEVER has a 'released' commitment.
    const { resolveRuntime } = await import('../src/lib/kernel/runtime')
    const runtime = resolveRuntime('infrastructure')
    const { releaseFailedAssignments } = await import('../src/lib/control-plane')

    const results = await Promise.allSettled([
      // Tx A: attempt to release (may legitimately succeed if it wins the race).
      releaseFailedAssignments(decisionId, [assignmentId], 'concurrent release attempt'),
      // Tx B: attempt to complete.
      db.$transaction(async (tx) => {
        await runtime.completeAssignment(tx, f.tenantId, assignmentId, executionId)
      }),
    ])

    // Both should settle (neither should throw an uncaught error).
    for (const r of results) {
      if (r.status === 'rejected') {
        // A rejection is acceptable only if it's a benign CAS no-op error
        // (e.g., completeAssignment on an already-failed assignment). We
        // don't assert on the error type — we assert on the INVARIANT below.
      }
    }

    // --- THE CONCURRENCY INVARIANT: regardless of who won the race ---
    const assignment = await db.executionAssignment.findUnique({ where: { id: assignmentId } })
    const commitment = await db.capacityCommitment.findUnique({ where: { id: commitmentId } })

    // If the assignment ended up 'completed', its commitment must NOT be released.
    if (assignment!.status === 'completed') {
      expect(commitment!.status).not.toBe('released')
      // The reservation must NOT be restored.
      const reservationAfter = await db.capacityReservation.findUnique({ where: { id: reservationId } })
      expect(parseFloat(reservationAfter!.remainingAmount)).toBe(reservationRemainingBefore)
    }

    // If the assignment ended up 'failed' (release won the race), its
    // commitment MUST be released (the release is legitimate).
    if (assignment!.status === 'failed') {
      expect(commitment!.status).toBe('released')
      // The reservation IS restored.
      const reservationAfter = await db.capacityReservation.findUnique({ where: { id: reservationId } })
      expect(parseFloat(reservationAfter!.remainingAmount)).toBeGreaterThan(reservationRemainingBefore)
    }

    // THE ABSOLUTE INVARIANT (the real test): a completed assignment NEVER has
    // a released commitment. Query the DB directly for the forbidden state.
    const forbidden = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "ExecutionAssignment" ea
      JOIN "CapacityCommitment" cc ON ea."capacityCommitmentId" = cc.id
      WHERE ea.id = ${assignmentId}
        AND ea.status = 'completed'
        AND cc.status = 'released'
    `
    expect(Number(forbidden[0].count)).toBe(0)
  })
})
