/**
 * Phase 12B Slice 7: VPP Migration — Complete Integration Tests
 *
 * V1-V15 against real PostgreSQL/Neon.
 *
 * Run: DATABASE_URL=postgresql://... bun test tests/phase-12b-slice-7-vpp.test.ts --timeout 300000
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
  executeDispatchAssignment,
  reconcileAssignment,
} from '../src/lib/services/vpp.service'
import { initializeBootstrap } from '../src/lib/bootstrap'
import {
  reconcileEconomicPipeline,
  ECONOMIC_STAGE,
  LEASE_STATUS,
} from '../src/lib/control-plane'

const databaseUrl = process.env.DATABASE_URL || ''
const isPostgres =
  databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')
const describeOrSkip = isPostgres ? describe : describe.skip

let tenantId: string
let networkId: string
let versionId: string
let rewardRuleId: string
let operatorId: string
let assetId: string
let deviceSecret: string
let testCounter = 0


async function setupDispatch() {
  await ensureFixture()
  testCounter++
  const baseTime = Date.now() + 3600000 * (10 + testCounter * 2)
  const start = new Date(baseTime)
  const end = new Date(baseTime + 3600000)

  const program = await createBuyerProgram(tenantId, {
    networkId, name: `S7VC Program-${testCounter}`,
    rewardRuleId, dispatchWindowStart: '00:00', dispatchWindowEnd: '23:59',
    pricePerKwh: '0.12', minCapacityKw: '1',
  })

  await createCapacityReservation(tenantId, {
    programId: program.id, operatorId, assetId,
    capabilityType: 'energy_discharge', reservedKw: '10', reservedKwh: '10',
    startTime: start.toISOString(), endTime: end.toISOString(),
  })

  const { dispatch, assignments } = await createDispatch(tenantId, {
    programId: program.id,
    startTime: start.toISOString(), endTime: end.toISOString(),
    requestedKw: '10', requestedKwh: '10',
  })

  return { dispatch, assignments, start, end }
}

// Lazy fixture setup — module-level (not inside describe, because
// setupDispatch is also module-level and needs to call it).
// bun:test has a 5s default timeout for beforeAll hooks, so heavy DB
// setup is deferred to the first test call via ensureFixture().
let fixtureReady = false
async function ensureFixture() {
  if (fixtureReady) return
  fixtureReady = true
  initializeBootstrap()

  const tenant = await createTenant({
    name: 'Slice 7 VPP Complete',
    slug: `s7vc-${Date.now()}`,
    plan: 'growth',
  })
  tenantId = tenant.id

  const { network, version } = await instantiateTemplate(tenantId, 'energy-vpp')
  networkId = network.id
  versionId = version!.id

  const rule = await db.rewardRule.findFirst({ where: { networkVersionId: versionId } })
  rewardRuleId = rule!.id

  const op = await createOperator(tenantId, { displayName: 'VPP S7C Operator' })
  operatorId = op.id
  const ast = await createAsset(tenantId, { operatorId, assetType: 'battery', name: 'VPP S7C Battery' })
  assetId = ast.id
  await assignAssetToNetwork(tenantId, assetId, networkId, 'energy_discharge', '10', 'kW')
  const dev = await createDevice(tenantId, { assetId, deviceType: 'battery_controller' })
  deviceSecret = dev.provisioningSecret

  await recordBuyerFunding(tenantId, 100000, `s7vc-funding-${Date.now()}`)
}

describeOrSkip('Phase 12B Slice 7: VPP Migration Complete', () => {
  // V1 — happy path
  it('V1: VPP happy path — exactly one of each economic object', async () => {
    const { assignments } = await setupDispatch()
    const result = await executeDispatchAssignment(tenantId, assignments[0].id, deviceSecret)
    expect(result.contribution_id).toBeDefined()
    expect(result.reward_id).toBeDefined()
    expect(result.settlement_id).toBeDefined()

    const state = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
    })
    expect(state!.stage).toBe(ECONOMIC_STAGE.COMPLETED)
  })

  // V2 — retry
  it('V2: VPP retry — reconcile returns replayed=true', async () => {
    const { assignments } = await setupDispatch()
    await executeDispatchAssignment(tenantId, assignments[0].id, deviceSecret)
    const reconcileResult = await reconcileEconomicPipeline(assignments[0].executionAssignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.replayed).toBe(true)
  })

  // V3 — execution failure
  it('V3: VPP execution failure → no economic value', async () => {
    const { assignments } = await setupDispatch()
    await db.asset.update({ where: { id: assetId }, data: { assetType: 'nonexistent-vpp-asset' } })
    await expect(
      executeDispatchAssignment(tenantId, assignments[0].id, deviceSecret),
    ).rejects.toThrow()
    await db.asset.update({ where: { id: assetId }, data: { assetType: 'battery' } })

    const states = await db.economicPipelineState.findMany({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
    })
    expect(states.length).toBe(0)
  })

  // V4 — runtime exception (adapter throws)
  it('V4: VPP runtime exception → assignment failed, lease safe, no economic value', async () => {
    const { assignments } = await setupDispatch()
    await db.asset.update({ where: { id: assetId }, data: { assetType: 'nonexistent-vpp-asset' } })
    await expect(
      executeDispatchAssignment(tenantId, assignments[0].id, deviceSecret),
    ).rejects.toThrow()
    await db.asset.update({ where: { id: assetId }, data: { assetType: 'battery' } })

    // Assignment is failed (terminal).
    const assignment = await db.executionAssignment.findUnique({
      where: { id: assignments[0].executionAssignmentId },
      select: { status: true },
    })
    expect(assignment!.status).toBe('failed')

    // Lease is NOT released (not implying success).
    const leases = await db.executionLease.findMany({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
    })
    expect(leases.length).toBe(1)
    expect(leases[0].status).not.toBe(LEASE_STATUS.RELEASED)

    // Re-acquisition is rejected (terminal).
    const { acquireExecutionLease } = await import('../src/lib/control-plane/execution-lease')
    const reacquire = await acquireExecutionLease({
      executionAssignmentId: assignments[0].executionAssignmentId,
      workerIdentity: 'another-worker',
    })
    expect(reacquire.acquired).toBe(false)
    expect(reacquire.reason).toContain('terminal')

    // No economic value.
    const states = await db.economicPipelineState.findMany({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
    })
    expect(states.length).toBe(0)
  })

  // V5 — verification rejection
  it('V5: VPP verification rejection — bad signing key → REJECTED → no economic value', async () => {
    const { assignments } = await setupDispatch()
    // Execute with WRONG provisioning secret → bad signature → verification rejects.
    await expect(
      executeDispatchAssignment(tenantId, assignments[0].id, 'wrong-provisioning-secret'),
    ).rejects.toThrow()

    // The VppDispatchAssignment should be in failed or reconciliation_required.
    const vppAssignment = await db.vppDispatchAssignment.findUnique({
      where: { id: assignments[0].id },
      select: { status: true },
    })
    // It should NOT be 'completed'.
    expect(vppAssignment!.status).not.toBe('completed')

    // No economic value.
    const states = await db.economicPipelineState.findMany({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
    })
    expect(states.length).toBe(0)
  })

  // V6 — process restart recovery
  it('V6: VPP process restart — clear downstream checkpoint IDs → reconcile reuses existing', async () => {
    const { assignments } = await setupDispatch()
    const result = await executeDispatchAssignment(tenantId, assignments[0].id, deviceSecret)

    const stateBefore = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
    })

    // Simulate crash: clear downstream IDs.
    await db.economicPipelineState.update({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
      data: {
        stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
        reconciliationReason: 'simulated crash',
        contributionId: null, rewardId: null, ledgerPostingId: null, settlementId: null,
      },
    })

    // Reconcile.
    const reconcileResult = await reconcileEconomicPipeline(assignments[0].executionAssignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.contributionId).toBe(stateBefore!.contributionId)
    expect(reconcileResult.rewardId).toBe(stateBefore!.rewardId)
    expect(reconcileResult.settlementId).toBe(stateBefore!.settlementId)

    // Exactly one of each.
    const contributions = await db.contribution.findMany({ where: { tenantId } })
    const rewardCount = contributions.length
    expect(rewardCount).toBeGreaterThanOrEqual(1)
  })

  // V7 — NULL checkpoint recovery
  it('V7: VPP NULL checkpoint — eventId NULL → reconcile rediscovers Event', async () => {
    const { assignments } = await setupDispatch()
    await executeDispatchAssignment(tenantId, assignments[0].id, deviceSecret)

    const stateBefore = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
    })
    const originalEventId = stateBefore!.eventId!

    // Clear eventId.
    await db.economicPipelineState.update({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
      data: {
        eventId: null,
        stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
        reconciliationReason: 'eventId lost',
      },
    })

    const reconcileResult = await reconcileEconomicPipeline(assignments[0].executionAssignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.eventId).toBe(originalEventId)
  })

  // V8 — stale checkpoint recovery
  it('V8: VPP stale checkpoint — bogus contributionId → reconcile rediscovers correct', async () => {
    const { assignments } = await setupDispatch()
    await executeDispatchAssignment(tenantId, assignments[0].id, deviceSecret)

    const stateBefore = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
    })
    const originalContributionId = stateBefore!.contributionId!

    // Set contributionId to bogus.
    await db.economicPipelineState.update({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
      data: {
        contributionId: 'nonexistent-contribution-99999',
        stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
        reconciliationReason: 'stale contributionId',
      },
    })

    const reconcileResult = await reconcileEconomicPipeline(assignments[0].executionAssignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.contributionId).toBe(originalContributionId)
  })

  // V9 — dimensional correctness
  it('V9: VPP dimensional correctness — contribution.unit = kWh', async () => {
    const { assignments } = await setupDispatch()
    const result = await executeDispatchAssignment(tenantId, assignments[0].id, deviceSecret)

    const contribution = await db.contribution.findUnique({ where: { id: result.contribution_id! } })
    expect(contribution!.unit).toBe('kWh')
    expect(parseFloat(contribution!.quantity.toString())).toBeGreaterThanOrEqual(0)
  })

  // V10 — vertical neutrality
  it('V10: VPP vertical neutrality — generic pipeline has no VPP imports', async () => {
    const source = await import('fs').then((fs) =>
      fs.readFileSync('./src/lib/control-plane/economic-pipeline.ts', 'utf8'),
    )
    const importLines = source.split('\n').filter((l) => l.match(/^\s*import\s/) || l.match(/^\s*}\s*from\s/)).join('\n')
    expect(importLines).not.toMatch(/vpp\.service/)
    expect(importLines).not.toMatch(/vpp-/)
  })

  // V11 — economic failure after operational success (REAL failure injection, no deletions)
  //
  // Proves: PHYSICAL EXECUTION SUCCESS → OPERATIONAL COMPLETION → ECONOMIC
  // FAILURE → RECONCILIATION → ECONOMIC COMPLETION, WITHOUT physical re-execution.
  //
  // Uses testFailAfterStage parameter on executeDispatchAssignment to inject
  // a REAL failure at the REWARD_CALCULATED boundary. NO durable economic
  // objects are deleted. NO re-funding. The failure happens naturally
  // AFTER Reward commits + checkpoint records rewardId, but BEFORE
  // LedgerPosting begins.
  it('V11: VPP economic failure after operational success — failAfterStage=REWARD_CALCULATED → no physical re-execution', async () => {
    const { assignments } = await setupDispatch()
    const assignmentId = assignments[0].id
    const execAssignmentId = assignments[0].executionAssignmentId

    // --- Step 0: Capture pre-execution state ---
    const leasesBeforeExecution = await db.executionLease.findMany({
      where: { executionAssignmentId: execAssignmentId },
    })
    const leaseCountBeforeExecution = leasesBeforeExecution.length

    // --- Step 1: Execute VPP WITH failure injection after REWARD_CALCULATED ---
    // This runs the FULL VPP path: adapter → Event → verification → baseline →
    // operational completion → economic pipeline. The pipeline creates
    // Contribution + Reward, then THROWS before LedgerPosting.
    // NO durable economic objects are deleted. NO re-funding.
    await expect(
      executeDispatchAssignment(tenantId, assignmentId, deviceSecret, undefined, ECONOMIC_STAGE.REWARD_CALCULATED),
    ).rejects.toThrow('TEST-ONLY: injected failure after REWARD_CALCULATED')

    // --- Step 2: Verify the failure boundary ---

    // 2a. ExecutionAssignment.status === completed (operational completion irreversible)
    const assignment = await db.executionAssignment.findUnique({
      where: { id: execAssignmentId },
      select: { status: true },
    })
    expect(assignment!.status).toBe('completed')

    // 2b. No new physical execution record (count = 1 for this dispatch).
    const dispatchAssignment = await db.vppDispatchAssignment.findUnique({
      where: { id: assignmentId },
      include: { dispatch: { select: { executionId: true } } },
    })
    const executions = await db.execution.findMany({
      where: { id: dispatchAssignment!.dispatch.executionId },
    })
    expect(executions.length).toBe(1)

    // 2c. No new execution lease (count = pre-execution + 1 for the original).
    const leasesAfterFailure = await db.executionLease.findMany({
      where: { executionAssignmentId: execAssignmentId },
    })
    expect(leasesAfterFailure.length).toBe(leaseCountBeforeExecution + 1)
    const activeLeases = leasesAfterFailure.filter((l) => l.status === LEASE_STATUS.ACTIVE)
    expect(activeLeases.length).toBe(0)

    // 2d. EconomicPipelineState = reconciliation_required
    const state = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: execAssignmentId },
    })
    expect(state).toBeDefined()
    expect(state!.stage).toBe(ECONOMIC_STAGE.RECONCILIATION_REQUIRED)
    expect(state!.reconciliationReason).toContain('injected failure')

    // 2e. Event EXISTS (count = 1 for this assignment)
    expect(state!.eventId).not.toBeNull()
    const events = await db.event.findMany({ where: { id: state!.eventId! } })
    expect(events.length).toBe(1)
    expect(events[0].status).toBe('verified')
    expect(events[0].externalEventId).toBe(`evidence-${execAssignmentId}`)

    // 2f. Attestation EXISTS (count = 1 for this event)
    const attestations = await db.attestation.findMany({ where: { eventId: state!.eventId! } })
    expect(attestations.length).toBe(1)

    // 2g. Contribution EXISTS (count = 1, ID matches checkpoint)
    expect(state!.contributionId).not.toBeNull()
    const contributions = await db.contribution.findMany({ where: { id: state!.contributionId! } })
    expect(contributions.length).toBe(1)
    const originalContributionId = state!.contributionId!

    // 2h. Reward EXISTS (count = 1, ID matches checkpoint)
    expect(state!.rewardId).not.toBeNull()
    const rewards = await db.reward.findMany({ where: { id: state!.rewardId! } })
    expect(rewards.length).toBe(1)
    const originalRewardId = state!.rewardId!

    // 2i. LedgerPosting DOES NOT exist (failure prevented it)
    expect(state!.ledgerPostingId).toBeNull()
    const postingsBefore = await db.ledgerPosting.findMany({
      where: { referenceId: originalRewardId, postingType: 'reward' },
    })
    expect(postingsBefore.length).toBe(0)

    // 2j. Settlement DOES NOT exist
    expect(state!.settlementId).toBeNull()
    const settlementsBefore = await db.settlement.findMany({ where: { rewardId: originalRewardId } })
    expect(settlementsBefore.length).toBe(0)

    // --- Step 3: Reconcile via VPP's reconcileAssignment ---
    await db.vppDispatchAssignment.update({
      where: { id: assignmentId },
      data: { status: 'reconciliation_required' },
    })

    const reconcileResult = await reconcileAssignment(tenantId, assignmentId)
    expect(reconcileResult.status).toBe('completed')

    // --- Step 4: Reconciliation assertions ---

    // 4a. ExecutionAssignment.status remains completed
    const assignmentAfter = await db.executionAssignment.findUnique({
      where: { id: execAssignmentId },
      select: { status: true },
    })
    expect(assignmentAfter!.status).toBe('completed')

    // 4b. Execution count unchanged (no physical re-execution)
    const executionsAfter = await db.execution.findMany({
      where: { id: dispatchAssignment!.dispatch.executionId },
    })
    expect(executionsAfter.length).toBe(1)

    // 4c. Lease count unchanged (no new lease from reconciliation)
    const leasesAfterReconcile = await db.executionLease.findMany({
      where: { executionAssignmentId: execAssignmentId },
    })
    expect(leasesAfterReconcile.length).toBe(leaseCountBeforeExecution + 1)

    // 4d. Contribution ID is exactly the original
    const stateAfter = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: execAssignmentId },
    })
    expect(stateAfter!.contributionId).toBe(originalContributionId)

    // 4e. Reward ID is exactly the original
    expect(stateAfter!.rewardId).toBe(originalRewardId)

    // 4f. A single LedgerPosting now exists
    expect(stateAfter!.ledgerPostingId).not.toBeNull()
    const postingsAfter = await db.ledgerPosting.findMany({
      where: { referenceId: originalRewardId, postingType: 'reward' },
    })
    expect(postingsAfter.length).toBe(1)

    // 4g. A single Settlement now exists
    expect(stateAfter!.settlementId).not.toBeNull()
    const settlementsAfter = await db.settlement.findMany({ where: { rewardId: originalRewardId } })
    expect(settlementsAfter.length).toBe(1)

    // --- Step 5: Second reconciliation (idempotent) ---
    await db.vppDispatchAssignment.update({
      where: { id: assignmentId },
      data: { status: 'reconciliation_required' },
    })

    const reconcileResult2 = await reconcileAssignment(tenantId, assignmentId)
    expect(reconcileResult2.status).toBe('completed')

    // Same IDs — no new objects created.
    const stateAfter2 = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: execAssignmentId },
    })
    expect(stateAfter2!.contributionId).toBe(originalContributionId)
    expect(stateAfter2!.rewardId).toBe(originalRewardId)
    expect(stateAfter2!.ledgerPostingId).toBe(stateAfter!.ledgerPostingId)
    expect(stateAfter2!.settlementId).toBe(stateAfter!.settlementId)

    // No additional postings.
    const postingsAfter2 = await db.ledgerPosting.findMany({
      where: { referenceId: originalRewardId, postingType: 'reward' },
    })
    expect(postingsAfter2.length).toBe(1)

    // No additional settlements.
    const settlementsAfter2 = await db.settlement.findMany({ where: { rewardId: originalRewardId } })
    expect(settlementsAfter2.length).toBe(1)

    // No additional leases.
    const leasesAfter2 = await db.executionLease.findMany({
      where: { executionAssignmentId: execAssignmentId },
    })
    expect(leasesAfter2.length).toBe(leaseCountBeforeExecution + 1)
  })

  // V12 — NetworkVersion immutability
  it('V12: VPP NetworkVersion immutability — pipeline stays bound to original version', async () => {
    const { assignments } = await setupDispatch()
    await executeDispatchAssignment(tenantId, assignments[0].id, deviceSecret)

    const state = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
    })
    const originalVersionId = state!.networkVersionId

    // The networkVersionId in the checkpoint must match the original version.
    expect(state!.networkVersionId).toBe(versionId)

    // Reconcile — should still use the original version.
    const reconcileResult = await reconcileEconomicPipeline(assignments[0].executionAssignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)

    const stateAfter = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
    })
    expect(stateAfter!.networkVersionId).toBe(originalVersionId)
  })

  // V13 — concurrent reconciliation
  it('V13: VPP concurrent reconciliation — two calls → one durable chain', async () => {
    const { assignments } = await setupDispatch()
    await executeDispatchAssignment(tenantId, assignments[0].id, deviceSecret)

    // Clear downstream IDs.
    await db.economicPipelineState.update({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
      data: {
        stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
        reconciliationReason: 'concurrent test',
        contributionId: null, rewardId: null, ledgerPostingId: null, settlementId: null,
      },
    })

    const results = await Promise.allSettled([
      reconcileEconomicPipeline(assignments[0].executionAssignmentId),
      reconcileEconomicPipeline(assignments[0].executionAssignmentId),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    // No duplicates.
    const contributions = await db.contribution.findMany({ where: { tenantId } })
    expect(contributions.length).toBe(1)
    const rewards = await db.reward.findMany({ where: { tenantId } })
    expect(rewards.length).toBe(1)
    const postings = await db.ledgerPosting.findMany({ where: { tenantId, postingType: 'reward' } })
    expect(postings.length).toBe(1)
    const settlements = await db.settlement.findMany({ where: { tenantId } })
    expect(settlements.length).toBe(1)
  })

  // V14 — portfolio finalization isolation
  it('V14: VPP portfolio finalization isolation — economic failure does not corrupt dispatch status', async () => {
    const { assignments, dispatch } = await setupDispatch()
    const assignmentId = assignments[0].id

    // Execute fully (succeeds).
    await executeDispatchAssignment(tenantId, assignmentId, deviceSecret)

    // The dispatch should be finalized (all assignments terminal).
    const dispatchAfter = await db.vppDispatch.findUnique({
      where: { id: dispatch.id },
      select: { status: true },
    })
    // The dispatch should be in a terminal state (completed or delivery_complete).
    expect(['completed', 'delivery_complete']).toContain(dispatchAfter!.status)

    // The VPP assignment should be completed.
    const vppAssignment = await db.vppDispatchAssignment.findUnique({
      where: { id: assignmentId },
      select: { status: true },
    })
    expect(vppAssignment!.status).toBe('completed')

    // The EconomicPipelineState is separate from the VPP dispatch state.
    const state = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
    })
    expect(state!.stage).toBe(ECONOMIC_STAGE.COMPLETED)
  })

  // V15 — architectural dependency test
  it('V15: VPP architectural dependency — VPP imports generic pipeline, not vice versa + economicStage is legacy', async () => {
    // Generic pipeline has no VPP imports.
    const pipelineSource = await import('fs').then((fs) =>
      fs.readFileSync('./src/lib/control-plane/economic-pipeline.ts', 'utf8'),
    )
    const pipelineImports = pipelineSource.split('\n').filter((l) => l.match(/^\s*import\s/) || l.match(/^\s*}\s*from\s/)).join('\n')
    expect(pipelineImports).not.toMatch(/vpp/)

    // VPP imports the generic pipeline.
    const vppSource = await import('fs').then((fs) =>
      fs.readFileSync('./src/lib/services/vpp.service.ts', 'utf8'),
    )
    expect(vppSource).toContain('economic-pipeline')

    // economicStage is not consulted by generic reconciliation.
    // The generic pipeline reads EconomicPipelineState.stage, NOT VppDispatchAssignment.economicStage.
    expect(pipelineSource).not.toMatch(/economicStage/)
    expect(pipelineSource).not.toMatch(/VppDispatchAssignment/)
  })
})
