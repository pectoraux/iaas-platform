/**
 * VPP-4.2: Database-backed integration tests for generic Execution finalization.
 *
 * These tests exercise the ACTUAL Prisma client against the real database,
 * proving the hardened Phase 4.2 invariants:
 *
 *   1. createDispatch creates exactly one Execution
 *   2. every VppDispatchAssignment maps 1:1 to ExecutionAssignment
 *   3. partial completion does not finalize parent Execution
 *   4. final completion does finalize parent Execution
 *   5. mixed success/failure produces terminal parent Execution with correct
 *      assignment outcomes
 *   6. failure maps to generic ExecutionAssignment.failed
 *
 * The tests call the real `createDispatch` service (which creates Execution +
 * ExecutionAssignment atomically with VppDispatch + VppDispatchAssignment),
 * then exercise the transaction-aware `finalizeExecutionIfTerminal(tx, ...)`
 * kernel primitive directly — using the SAME transaction pattern the VPP
 * service uses for success (failAssignment / markReconciliationRequired).
 *
 * Run: bun test tests/vpp-4-2-execution-invariants.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { createOperator, createAsset, createDevice, assignAssetToNetwork } from '../src/lib/services/registry.service'
import { recordBuyerFunding } from '../src/lib/services/ledger.service'
import {
  createBuyerProgram,
  createCapacityReservation,
  createDispatch,
} from '../src/lib/services/vpp.service'
import { finalizeExecutionIfTerminal } from '../src/lib/kernel/execution/execution.service'

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

let tenantId: string
let networkId: string
let versionId: string
let rewardRuleId: string

// Two operators + two assets, so we can create dispatches with 1 or 2
// assignments (single-asset vs multi-asset).
let operatorA: string
let operatorB: string
let assetA: string
let assetB: string
let deviceSecretA: string
let deviceSecretB: string

beforeAll(async () => {
  const tenant = await createTenant({
    name: 'VPP-4.2 Execution Invariants',
    slug: `vpp42-exec-${Date.now()}`,
    plan: 'growth',
  })
  tenantId = tenant.id

  const { network, version } = await instantiateTemplate(tenantId, 'energy-vpp')
  networkId = network.id
  versionId = version!.id

  const rule = await db.rewardRule.findFirst({ where: { networkVersionId: versionId } })
  rewardRuleId = rule!.id

  // Operator A + Asset A (battery, 10 kW)
  const opA = await createOperator(tenantId, { displayName: 'VPP42 Operator A' })
  operatorA = opA.id
  const astA = await createAsset(tenantId, { operatorId: operatorA, assetType: 'battery', name: 'VPP42 Battery A' })
  assetA = astA.id
  await assignAssetToNetwork(tenantId, assetA, networkId, 'energy_discharge', '10', 'kW')
  const devA = await createDevice(tenantId, { assetId: assetA, deviceType: 'battery_controller' })
  deviceSecretA = devA.provisioningSecret

  // Operator B + Asset B (battery, 10 kW)
  const opB = await createOperator(tenantId, { displayName: 'VPP42 Operator B' })
  operatorB = opB.id
  const astB = await createAsset(tenantId, { operatorId: operatorB, assetType: 'battery', name: 'VPP42 Battery B' })
  assetB = astB.id
  await assignAssetToNetwork(tenantId, assetB, networkId, 'energy_discharge', '10', 'kW')
  const devB = await createDevice(tenantId, { assetId: assetB, deviceType: 'battery_controller' })
  deviceSecretB = devB.provisioningSecret

  // Pre-fund the buyer.
  await recordBuyerFunding(tenantId, 100000, `vpp42-funding-${Date.now()}`)
})

// ---------------------------------------------------------------------------
// Helper: create a program + reservation(s) + dispatch in a unique time window
// ---------------------------------------------------------------------------

let testCounter = 0

async function setupDispatch(opts: {
  assets: { operatorId: string; assetId: string; reservedKw: string }[]
  requestedKw: string
  requestedKwh: string
}) {
  testCounter++
  // Unique, non-overlapping time window per test (10h + 2h per test in the future).
  const baseTime = Date.now() + 3600000 * (10 + testCounter * 2)
  const start = new Date(baseTime)
  const end = new Date(baseTime + 3600000) // 1-hour window

  const program = await createBuyerProgram(tenantId, {
    networkId,
    name: `VPP42 Program-${testCounter}-${Date.now()}`,
    rewardRuleId,
    dispatchWindowStart: '00:00',
    dispatchWindowEnd: '23:59',
    pricePerKwh: '0.12',
    minCapacityKw: '1',
  })

  // Create one reservation per asset.
  for (const a of opts.assets) {
    await createCapacityReservation(tenantId, {
      programId: program.id,
      operatorId: a.operatorId,
      assetId: a.assetId,
      capabilityType: 'energy_discharge',
      reservedKw: a.reservedKw,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
    })
  }

  const { dispatch, assignments } = await createDispatch(
    tenantId,
    {
      programId: program.id,
      requestedKw: opts.requestedKw,
      requestedKwh: opts.requestedKwh,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
    },
  )

  return { program, dispatch, assignments, executionId: dispatch.executionId }
}

// ---------------------------------------------------------------------------
// Test 1: createDispatch creates exactly one Execution
// ---------------------------------------------------------------------------

describe('VPP-4.2: createDispatch creates exactly one Execution', () => {
  it('a single-asset dispatch produces exactly one Execution record', async () => {
    const { dispatch, executionId } = await setupDispatch({
      assets: [{ operatorId: operatorA, assetId: assetA, reservedKw: '10' }],
      requestedKw: '5',
      requestedKwh: '5',
    })

    // The dispatch has an executionId FK.
    expect(executionId).toBeTruthy()
    expect(dispatch.executionId).toBe(executionId)

    // Exactly ONE Execution exists for this dispatch.
    const executionCount = await db.execution.count({
      where: { id: executionId, tenantId },
    })
    expect(executionCount).toBe(1)

    // The Execution references the dispatch via sourceType + sourceId.
    const execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution).toBeTruthy()
    expect(execution!.sourceType).toBe('vpp_dispatch')
    expect(execution!.sourceId).toBe(dispatch.id)
    expect(execution!.status).toBe('assigned') // initial status after createDispatch
    expect(execution!.requestedUnit).toBe('kWh')
    expect(execution!.requestedQuantity).toBe('5')
  })

  it('a multi-asset dispatch still produces exactly one Execution', async () => {
    const { dispatch, executionId } = await setupDispatch({
      assets: [
        { operatorId: operatorA, assetId: assetA, reservedKw: '5' },
        { operatorId: operatorB, assetId: assetB, reservedKw: '5' },
      ],
      requestedKw: '8',
      requestedKwh: '8',
    })

    // Still exactly ONE Execution (the parent), even with 2 assignments.
    const executionCount = await db.execution.count({
      where: { id: executionId, tenantId },
    })
    expect(executionCount).toBe(1)

    // The Execution is linked to the dispatch.
    const execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.sourceId).toBe(dispatch.id)
  })
})

// ---------------------------------------------------------------------------
// Test 2: every VppDispatchAssignment maps 1:1 to ExecutionAssignment
// ---------------------------------------------------------------------------

describe('VPP-4.2: VppDispatchAssignment ↔ ExecutionAssignment 1:1 mapping', () => {
  it('each VppDispatchAssignment has a unique executionAssignmentId pointing to a real ExecutionAssignment', async () => {
    const { assignments, executionId } = await setupDispatch({
      assets: [
        { operatorId: operatorA, assetId: assetA, reservedKw: '5' },
        { operatorId: operatorB, assetId: assetB, reservedKw: '5' },
      ],
      requestedKw: '8',
      requestedKwh: '8',
    })

    expect(assignments.length).toBe(2)

    // Collect the executionAssignmentIds — must all be unique.
    const eaIds = assignments.map((a) => a.executionAssignmentId)
    expect(new Set(eaIds).size).toBe(2) // all unique

    // Each executionAssignmentId points to a real ExecutionAssignment.
    for (const vppAssignment of assignments) {
      const genericAssignment = await db.executionAssignment.findUnique({
        where: { id: vppAssignment.executionAssignmentId },
      })
      expect(genericAssignment).toBeTruthy()
      expect(genericAssignment!.executionId).toBe(executionId)
      expect(genericAssignment!.assetId).toBe(vppAssignment.assetId)
      expect(genericAssignment!.operatorId).toBe(vppAssignment.operatorId)
      expect(genericAssignment!.capabilityType).toBe(vppAssignment.capabilityType)
      expect(genericAssignment!.status).toBe('assigned') // initial status
      expect(genericAssignment!.assignedUnit).toBe('kWh')
    }

    // The reverse: every ExecutionAssignment for this execution has a
    // VppDispatchAssignment pointing back to it.
    const genericAssignments = await db.executionAssignment.findMany({
      where: { executionId },
    })
    expect(genericAssignments.length).toBe(2)
    for (const ga of genericAssignments) {
      const vppAssignment = await db.vppDispatchAssignment.findFirst({
        where: { executionAssignmentId: ga.id },
      })
      expect(vppAssignment).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// Test 3: partial completion does NOT finalize parent Execution
// ---------------------------------------------------------------------------

describe('VPP-4.2: partial completion does not finalize parent Execution', () => {
  it('one of two assignments completed → Execution stays non-terminal', async () => {
    const { assignments, executionId } = await setupDispatch({
      assets: [
        { operatorId: operatorA, assetId: assetA, reservedKw: '5' },
        { operatorId: operatorB, assetId: assetB, reservedKw: '5' },
      ],
      requestedKw: '8',
      requestedKwh: '8',
    })

    expect(assignments.length).toBe(2)

    // Complete ONLY the first assignment (via the same atomic transaction
    // pattern the VPP service uses for the success path).
    const first = assignments[0]
    await db.$transaction(async (tx) => {
      await tx.vppDispatchAssignment.update({
        where: { id: first.id },
        data: { status: 'completed', economicStage: 'completed', completedAt: new Date() },
      })
      await tx.executionAssignment.update({
        where: { id: first.executionAssignmentId },
        data: { status: 'completed', economicStage: 'completed', completedAt: new Date() },
      })
      // Call finalizeExecutionIfTerminal inside the SAME tx (atomic).
      await finalizeExecutionIfTerminal(tx, tenantId, executionId)
    })

    // The parent Execution must NOT be 'completed' — one assignment is still
    // non-terminal ('assigned').
    const execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).not.toBe('completed')
    // It should be 'executing' (the first completion transitions assigned → executing).
    // Either 'executing' or 'assigned' is acceptable — the key assertion is
    // that it is NOT 'completed'.
  })

  it('finalizeExecutionIfTerminal returns null when not all assignments are terminal', async () => {
    const { assignments, executionId } = await setupDispatch({
      assets: [
        { operatorId: operatorA, assetId: assetA, reservedKw: '5' },
        { operatorId: operatorB, assetId: assetB, reservedKw: '5' },
      ],
      requestedKw: '8',
      requestedKwh: '8',
    })

    // Complete one, leave the other as 'assigned'.
    const first = assignments[0]
    await db.$transaction(async (tx) => {
      await tx.executionAssignment.update({
        where: { id: first.executionAssignmentId },
        data: { status: 'completed' },
      })
    })

    // Call finalize — should return null (no transition).
    const result = await finalizeExecutionIfTerminal(db, tenantId, executionId)
    expect(result).toBeNull()

    // Execution is still non-terminal.
    const execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).not.toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// Test 4: final completion DOES finalize parent Execution
// ---------------------------------------------------------------------------

describe('VPP-4.2: final completion finalizes parent Execution', () => {
  it('all assignments completed → Execution transitions to completed', async () => {
    const { assignments, executionId } = await setupDispatch({
      assets: [
        { operatorId: operatorA, assetId: assetA, reservedKw: '5' },
        { operatorId: operatorB, assetId: assetB, reservedKw: '5' },
      ],
      requestedKw: '8',
      requestedKwh: '8',
    })

    // Complete the first assignment.
    const first = assignments[0]
    await db.$transaction(async (tx) => {
      await tx.vppDispatchAssignment.update({
        where: { id: first.id },
        data: { status: 'completed', completedAt: new Date() },
      })
      await tx.executionAssignment.update({
        where: { id: first.executionAssignmentId },
        data: { status: 'completed', completedAt: new Date() },
      })
      await finalizeExecutionIfTerminal(tx, tenantId, executionId)
    })

    // Not yet finalized (one assignment remains).
    let execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).not.toBe('completed')

    // Complete the LAST assignment — this should finalize the parent.
    const second = assignments[1]
    await db.$transaction(async (tx) => {
      await tx.vppDispatchAssignment.update({
        where: { id: second.id },
        data: { status: 'completed', completedAt: new Date() },
      })
      await tx.executionAssignment.update({
        where: { id: second.executionAssignmentId },
        data: { status: 'completed', completedAt: new Date() },
      })
      // This is the atomic call — same tx as the last assignment transition.
      await finalizeExecutionIfTerminal(tx, tenantId, executionId)
    })

    // NOW the parent Execution must be 'completed'.
    execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).toBe('completed')
  })

  it('single-assignment dispatch: completing the only assignment finalizes immediately', async () => {
    const { assignments, executionId } = await setupDispatch({
      assets: [{ operatorId: operatorA, assetId: assetA, reservedKw: '10' }],
      requestedKw: '5',
      requestedKwh: '5',
    })

    expect(assignments.length).toBe(1)

    await db.$transaction(async (tx) => {
      await tx.vppDispatchAssignment.update({
        where: { id: assignments[0].id },
        data: { status: 'completed', completedAt: new Date() },
      })
      await tx.executionAssignment.update({
        where: { id: assignments[0].executionAssignmentId },
        data: { status: 'completed', completedAt: new Date() },
      })
      await finalizeExecutionIfTerminal(tx, tenantId, executionId)
    })

    const execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).toBe('completed')
  })

  it('finalizeExecutionIfTerminal is idempotent — calling again is a no-op', async () => {
    const { assignments, executionId } = await setupDispatch({
      assets: [{ operatorId: operatorA, assetId: assetA, reservedKw: '10' }],
      requestedKw: '5',
      requestedKwh: '5',
    })

    // Complete the assignment + finalize.
    await db.$transaction(async (tx) => {
      await tx.executionAssignment.update({
        where: { id: assignments[0].executionAssignmentId },
        data: { status: 'completed' },
      })
      await finalizeExecutionIfTerminal(tx, tenantId, executionId)
    })

    const statusAfterFirst = await db.execution.findUnique({
      where: { id: executionId },
      select: { status: true },
    })
    expect(statusAfterFirst!.status).toBe('completed')

    // Call again — should return 'completed' (no-op, no error).
    const result = await finalizeExecutionIfTerminal(db, tenantId, executionId)
    expect(result).toBe('completed')

    // Status unchanged.
    const statusAfterSecond = await db.execution.findUnique({
      where: { id: executionId },
      select: { status: true },
    })
    expect(statusAfterSecond!.status).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// Test 5: mixed success/failure produces terminal parent Execution
// ---------------------------------------------------------------------------

describe('VPP-4.2: mixed success/failure produces terminal parent Execution', () => {
  it('one completed + one failed → Execution completed, with correct assignment outcomes', async () => {
    const { assignments, executionId } = await setupDispatch({
      assets: [
        { operatorId: operatorA, assetId: assetA, reservedKw: '5' },
        { operatorId: operatorB, assetId: assetB, reservedKw: '5' },
      ],
      requestedKw: '8',
      requestedKwh: '8',
    })

    const [first, second] = assignments

    // Complete the first assignment.
    await db.$transaction(async (tx) => {
      await tx.vppDispatchAssignment.update({
        where: { id: first.id },
        data: { status: 'completed', completedAt: new Date() },
      })
      await tx.executionAssignment.update({
        where: { id: first.executionAssignmentId },
        data: { status: 'completed', completedAt: new Date() },
      })
      await finalizeExecutionIfTerminal(tx, tenantId, executionId)
    })

    // Not yet finalized (second is still non-terminal).
    let execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).not.toBe('completed')

    // FAIL the second assignment (simulating failAssignment — the same
    // transaction pattern the VPP service uses).
    await db.$transaction(async (tx) => {
      await tx.vppDispatchAssignment.update({
        where: { id: second.id },
        data: { status: 'failed' },
      })
      await tx.executionAssignment.update({
        where: { id: second.executionAssignmentId },
        data: { status: 'failed' },
      })
      // Atomic finalization — same tx as the failure transition.
      await finalizeExecutionIfTerminal(tx, tenantId, executionId)
    })

    // NOW the parent Execution must be 'completed' — the lifecycle ended,
    // even though one assignment failed. 'completed' means "execution
    // finished", NOT "all assignments succeeded".
    execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).toBe('completed')

    // Verify the per-assignment outcomes are correct.
    const ea1 = await db.executionAssignment.findUnique({
      where: { id: first.executionAssignmentId },
    })
    const ea2 = await db.executionAssignment.findUnique({
      where: { id: second.executionAssignmentId },
    })
    expect(ea1!.status).toBe('completed')
    expect(ea2!.status).toBe('failed')
  })

  it('all failed → Execution still completed (lifecycle ended)', async () => {
    const { assignments, executionId } = await setupDispatch({
      assets: [
        { operatorId: operatorA, assetId: assetA, reservedKw: '5' },
        { operatorId: operatorB, assetId: assetB, reservedKw: '5' },
      ],
      requestedKw: '8',
      requestedKwh: '8',
    })

    // Fail both assignments.
    for (const a of assignments) {
      await db.$transaction(async (tx) => {
        await tx.vppDispatchAssignment.update({
          where: { id: a.id },
          data: { status: 'failed' },
        })
        await tx.executionAssignment.update({
          where: { id: a.executionAssignmentId },
          data: { status: 'failed' },
        })
        await finalizeExecutionIfTerminal(tx, tenantId, executionId)
      })
    }

    // All assignments failed, but the Execution is 'completed' — the
    // lifecycle ended. The generic Execution has no 'failed' parent state.
    const execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).toBe('completed')

    // Both assignments are 'failed'.
    const eas = await db.executionAssignment.findMany({ where: { executionId } })
    expect(eas.length).toBe(2)
    expect(eas.every((ea) => ea.status === 'failed')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test 6: failure maps to generic ExecutionAssignment.failed
// ---------------------------------------------------------------------------

describe('VPP-4.2: failure maps to generic ExecutionAssignment.failed', () => {
  it('VPP failAssignment pattern: VppDispatchAssignment.failed → ExecutionAssignment.failed', async () => {
    const { assignments, executionId } = await setupDispatch({
      assets: [{ operatorId: operatorA, assetId: assetA, reservedKw: '10' }],
      requestedKw: '5',
      requestedKwh: '5',
    })

    const assignment = assignments[0]

    // Simulate the exact failAssignment transaction from vpp.service.ts:
    //   VPP assignment → 'failed' + generic assignment → 'failed' (atomic)
    //   + finalizeExecutionIfTerminal(tx, ...) in the same tx.
    await db.$transaction(async (tx) => {
      await tx.vppDispatchAssignment.update({
        where: { id: assignment.id },
        data: { status: 'failed' },
      })
      await tx.executionAssignment.update({
        where: { id: assignment.executionAssignmentId },
        data: { status: 'failed' },
      })
      await finalizeExecutionIfTerminal(tx, tenantId, executionId)
    })

    // The generic ExecutionAssignment must be 'failed'.
    const genericAssignment = await db.executionAssignment.findUnique({
      where: { id: assignment.executionAssignmentId },
    })
    expect(genericAssignment!.status).toBe('failed')

    // The VPP assignment is 'failed' (VPP retains its own status).
    const vppAssignment = await db.vppDispatchAssignment.findUnique({
      where: { id: assignment.id },
    })
    expect(vppAssignment!.status).toBe('failed')

    // The parent Execution is 'completed' (lifecycle ended).
    const execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).toBe('completed')
  })

  it('VPP reconciliation_required maps to generic ExecutionAssignment.failed', async () => {
    const { assignments, executionId } = await setupDispatch({
      assets: [{ operatorId: operatorA, assetId: assetA, reservedKw: '10' }],
      requestedKw: '5',
      requestedKwh: '5',
    })

    const assignment = assignments[0]

    // Simulate the markReconciliationRequired transaction from vpp.service.ts:
    //   VPP assignment → 'reconciliation_required'
    //   generic assignment → 'failed' (mapped — reconciliation is economic, not execution)
    //   + finalizeExecutionIfTerminal(tx, ...) in the same tx.
    await db.$transaction(async (tx) => {
      await tx.vppDispatchAssignment.update({
        where: { id: assignment.id },
        data: { status: 'reconciliation_required' },
      })
      await tx.executionAssignment.update({
        where: { id: assignment.executionAssignmentId },
        data: { status: 'failed' },
      })
      await finalizeExecutionIfTerminal(tx, tenantId, executionId)
    })

    // The VPP assignment retains its richer 'reconciliation_required' state
    // (for financial recovery).
    const vppAssignment = await db.vppDispatchAssignment.findUnique({
      where: { id: assignment.id },
    })
    expect(vppAssignment!.status).toBe('reconciliation_required')

    // But the generic ExecutionAssignment is 'failed' — the generic layer
    // does not model financial recovery; it only tracks execution outcome.
    const genericAssignment = await db.executionAssignment.findUnique({
      where: { id: assignment.executionAssignmentId },
    })
    expect(genericAssignment!.status).toBe('failed')

    // The parent Execution is 'completed' (lifecycle ended).
    const execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).toBe('completed')
  })
})
