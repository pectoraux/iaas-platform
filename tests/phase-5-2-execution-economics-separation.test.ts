/**
 * Phase 5.2: Execution/Economics Separation — DB-backed Integration Tests
 *
 * These tests prove the critical Phase 5.2 invariant:
 *
 *   Generic Execution completion is OPERATIONAL, not ECONOMIC.
 *
 *   physical execution → telemetry → verification → baseline
 *       → runtime.completeAssignment()  ← generic Execution completed HERE
 *       → contribution → reward → ledger → settlement  ← economic, AFTER
 *
 *   If settlement fails, the generic assignment STAYS completed.
 *   Only the VPP layer enters reconciliation_required.
 *
 * Acceptance gate (from the audit):
 *   1. Successful physical execution can complete Execution before settlement.
 *   2. Parent Execution becomes completed when all operational assignments are terminal.
 *   3. Reward/ledger/settlement can continue after generic Execution is completed.
 *   4. Settlement failure does NOT change a successfully executed generic assignment to failed.
 *   5. VPP retains reconciliation_required exclusively as an economic state.
 *   6. Integration tests cover:
 *      - execution success + settlement success
 *      - execution success + settlement failure
 *      - execution failure before usage
 *
 * These tests use the InfrastructureRuntime directly (not the full VPP stack)
 * to prove the runtime contract. The full VPP end-to-end path is tested by
 * the existing vpp-invariants.test.ts suite.
 *
 * Run: bun test tests/phase-5-2-execution-economics-separation.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { resolveRuntime } from '../src/lib/kernel/runtime'
import { InfrastructureRuntime } from '../src/lib/kernel/runtime/infrastructure-runtime'

let tenantId: string
let networkId: string

beforeAll(async () => {
  const tenant = await createTenant({
    name: 'Phase 5.2 Exec/Econ Separation',
    slug: `p52-ee-${Date.now()}`,
    plan: 'growth',
  })
  tenantId = tenant.id

  const { network } = await instantiateTemplate(tenantId, 'energy-vpp')
  networkId = network.id
})

// ---------------------------------------------------------------------------
// Helper: create a generic Execution + N assignments via the runtime
// ---------------------------------------------------------------------------

let testCounter = 0

async function setupExecution(numAssignments: number) {
  testCounter++
  const baseTime = Date.now() + 3600000 * (10 + testCounter * 2)
  const start = new Date(baseTime)
  const end = new Date(baseTime + 3600000)

  const runtime = resolveRuntime('infrastructure')
  expect(runtime).toBeInstanceOf(InfrastructureRuntime)

  // Create a generic Execution.
  const execution = await runtime.createExecution(db, {
    tenantId,
    networkId,
    requestedQuantity: '10',
    requestedUnit: 'kWh',
    startTime: start,
    endTime: end,
    sourceType: 'test_execution',
    sourceId: `test-${testCounter}-${Date.now()}`,
  })

  // Create N assignments. We need real asset/operator IDs for the FKs.
  // Reuse the first operator + asset from the network.
  const operator = await db.operator.findFirst({ where: { tenantId } })
  const asset = await db.asset.findFirst({ where: { tenantId } })
  if (!operator || !asset) throw new Error('Test setup requires at least one operator + asset')

  const assignments: { id: string }[] = []
  for (let i = 0; i < numAssignments; i++) {
    const assignment = await runtime.createExecutionAssignment(db, {
      tenantId,
      executionId: execution.id,
      assetId: asset.id,
      operatorId: operator.id,
      capabilityType: 'energy_discharge',
      assignedQuantity: '5',
      assignedUnit: 'kWh',
    })
    assignments.push(assignment)
  }

  return { executionId: execution.id, assignments, runtime }
}

// ---------------------------------------------------------------------------
// Test 1: Successful operational execution completes Execution before settlement
// ---------------------------------------------------------------------------

describe('Phase 5.2: operational completion before economics', () => {
  it('completeAssignment finalizes the generic Execution BEFORE any economic step', async () => {
    const { executionId, assignments, runtime } = await setupExecution(1)

    // Record operational results (actuals, verified quantity, event).
    await db.$transaction(async (tx) => {
      await runtime.recordAssignmentResults(tx, assignments[0].id, {
        actualQuantity: '4.5',
        actualUnit: 'kWh',
        verifiedQuantity: '3.2',
        verifiedUnit: 'kWh',
        eventId: 'test-event-1',
      })
      // Complete the assignment (operational completion).
      await runtime.completeAssignment(tx, tenantId, assignments[0].id, executionId)
    })

    // The generic Execution MUST be 'completed' — no economic steps have run.
    const execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).toBe('completed')

    // The assignment MUST be 'completed'.
    const assignment = await db.executionAssignment.findUnique({ where: { id: assignments[0].id } })
    expect(assignment!.status).toBe('completed')
    expect(assignment!.actualQuantity).toBe('4.5')
    expect(assignment!.verifiedQuantity).toBe('3.2')

    // No contributionId is set yet — it's linked later via linkContribution.
    expect(assignment!.contributionId).toBeNull()
  })

  it('parent Execution becomes completed when all operational assignments are terminal', async () => {
    const { executionId, assignments, runtime } = await setupExecution(2)

    // Complete the first assignment.
    await db.$transaction(async (tx) => {
      await runtime.completeAssignment(tx, tenantId, assignments[0].id, executionId)
    })

    // Parent is NOT completed yet — one assignment remains.
    let execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).not.toBe('completed')

    // Complete the second assignment.
    await db.$transaction(async (tx) => {
      await runtime.completeAssignment(tx, tenantId, assignments[1].id, executionId)
    })

    // NOW the parent is completed — all assignments are terminal.
    execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// Test 2: linkContribution works AFTER operational completion
// ---------------------------------------------------------------------------

describe('Phase 5.2: economic link after operational completion', () => {
  it('linkContribution sets contributionId on an already-completed assignment', async () => {
    const { executionId, assignments, runtime } = await setupExecution(1)

    // Operational completion.
    await db.$transaction(async (tx) => {
      await runtime.recordAssignmentResults(tx, assignments[0].id, {
        actualQuantity: '4.5',
        actualUnit: 'kWh',
        verifiedQuantity: '3.2',
        verifiedUnit: 'kWh',
      })
      await runtime.completeAssignment(tx, tenantId, assignments[0].id, executionId)
    })

    // The assignment is completed, contributionId is null.
    let assignment = await db.executionAssignment.findUnique({ where: { id: assignments[0].id } })
    expect(assignment!.status).toBe('completed')
    expect(assignment!.contributionId).toBeNull()

    // Simulate the vertical creating a contribution and linking it.
    const fakeContributionId = `contrib-${Date.now()}`
    await db.$transaction(async (tx) => {
      await runtime.linkContribution(tx, assignments[0].id, fakeContributionId)
    })

    // The contributionId is now set — the assignment is still completed.
    assignment = await db.executionAssignment.findUnique({ where: { id: assignments[0].id } })
    expect(assignment!.status).toBe('completed') // unchanged
    expect(assignment!.contributionId).toBe(fakeContributionId)
  })
})

// ---------------------------------------------------------------------------
// Test 3: Settlement failure does NOT change a completed assignment to failed
// ---------------------------------------------------------------------------

describe('Phase 5.2: settlement failure does not fail completed assignment', () => {
  it('failAssignment is a no-op on an already-completed assignment (CAS guard)', async () => {
    const { executionId, assignments, runtime } = await setupExecution(1)

    // Operational completion.
    await db.$transaction(async (tx) => {
      await runtime.completeAssignment(tx, tenantId, assignments[0].id, executionId)
    })

    // Verify it's completed.
    let assignment = await db.executionAssignment.findUnique({ where: { id: assignments[0].id } })
    expect(assignment!.status).toBe('completed')

    // Simulate a settlement failure: the vertical calls failAssignment
    // (which it shouldn't, but the CAS must defend against it).
    await db.$transaction(async (tx) => {
      await runtime.failAssignment(tx, tenantId, assignments[0].id, executionId)
    })

    // The assignment MUST STAY 'completed' — the CAS prevented the overwrite.
    assignment = await db.executionAssignment.findUnique({ where: { id: assignments[0].id } })
    expect(assignment!.status).toBe('completed') // NOT 'failed'

    // The parent Execution must also stay 'completed'.
    const execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).toBe('completed')
  })

  it('failAssignment works on a non-completed assignment (pre-usage failure)', async () => {
    const { executionId, assignments, runtime } = await setupExecution(1)

    // Do NOT complete the assignment first — simulate a pre-usage failure.
    await db.$transaction(async (tx) => {
      await runtime.failAssignment(tx, tenantId, assignments[0].id, executionId)
    })

    // The assignment IS 'failed' — it was never completed.
    const assignment = await db.executionAssignment.findUnique({ where: { id: assignments[0].id } })
    expect(assignment!.status).toBe('failed')

    // The parent Execution is 'completed' (lifecycle ended, with failure).
    const execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// Test 4: Mixed operational outcomes — completed + failed
// ---------------------------------------------------------------------------

describe('Phase 5.2: mixed operational outcomes', () => {
  it('one completed + one failed → parent completed, correct per-assignment outcomes', async () => {
    const { executionId, assignments, runtime } = await setupExecution(2)

    // Complete the first.
    await db.$transaction(async (tx) => {
      await runtime.completeAssignment(tx, tenantId, assignments[0].id, executionId)
    })

    // Fail the second (pre-usage failure — never completed).
    await db.$transaction(async (tx) => {
      await runtime.failAssignment(tx, tenantId, assignments[1].id, executionId)
    })

    // Parent is 'completed' (all assignments terminal).
    const execution = await db.execution.findUnique({ where: { id: executionId } })
    expect(execution!.status).toBe('completed')

    // Per-assignment outcomes are correct.
    const ea1 = await db.executionAssignment.findUnique({ where: { id: assignments[0].id } })
    const ea2 = await db.executionAssignment.findUnique({ where: { id: assignments[1].id } })
    expect(ea1!.status).toBe('completed')
    expect(ea2!.status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// Test 5: The execution/economics boundary is structurally enforced
// ---------------------------------------------------------------------------

describe('Phase 5.2: structural enforcement', () => {
  it('a completed assignment cannot be transitioned to any other status by the runtime', async () => {
    const { executionId, assignments, runtime } = await setupExecution(1)

    // Complete the assignment.
    await db.$transaction(async (tx) => {
      await runtime.completeAssignment(tx, tenantId, assignments[0].id, executionId)
    })

    // Attempt to fail it (simulating a settlement failure).
    await db.$transaction(async (tx) => {
      await runtime.failAssignment(tx, tenantId, assignments[0].id, executionId)
    })

    // Attempt to complete it again (idempotent — should be a no-op).
    await db.$transaction(async (tx) => {
      await runtime.completeAssignment(tx, tenantId, assignments[0].id, executionId)
    })

    // The assignment is STILL 'completed' — operational completion is irreversible.
    const assignment = await db.executionAssignment.findUnique({ where: { id: assignments[0].id } })
    expect(assignment!.status).toBe('completed')
    expect(assignment!.completedAt).toBeTruthy()
  })
})
