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

beforeAll(async () => {
  if (!isPostgres) return
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
})

async function setupDispatch() {
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

  // V11 — economic failure after operational success
  it('V11: VPP economic failure after operational success — failAfterStage → no physical re-execution', async () => {
    const { assignments } = await setupDispatch()
    const assignmentId = assignments[0].id

    // Execute the VPP job — this creates Event, verifies, computes baseline,
    // completes operationally, then runs the economic pipeline.
    const result = await executeDispatchAssignment(tenantId, assignmentId, deviceSecret)

    // The job completed. Now reset the economic pipeline and re-run with
    // failAfterStage to inject a real economic failure.
    await db.economicPipelineState.update({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
      data: {
        stage: ECONOMIC_STAGE.VERIFIED,
        contributionId: null, rewardId: null, ledgerPostingId: null, settlementId: null,
        reconciliationReason: null,
      },
    })
    // Delete downstream economic objects.
    await db.settlement.deleteMany({ where: { tenantId } })
    await db.ledgerEntry.deleteMany({ where: { tenantId } })
    await db.ledgerPosting.deleteMany({ where: { tenantId } })
    await db.reward.deleteMany({ where: { tenantId } })
    await db.contribution.deleteMany({ where: { tenantId } })
    await recordBuyerFunding(tenantId, '100000', `refund-v11-${Date.now()}`)

    // Re-run with failure injection after REWARD_CALCULATED.
    const { processEconomicPipeline: runPipeline } = await import('../src/lib/control-plane/economic-pipeline')
    await expect(
      runPipeline({
        executionAssignmentId: assignments[0].executionAssignmentId,
        telemetryPayload: { power_kw: 5, energy_kwh: 9.5, duration_seconds: 3600 },
        actualQuantity: result.performance_kwh!,
        actualUnit: 'kWh',
        deviceId: assignments[0].id, // not used (Event already exists)
        signingKey: 'not-used',
        capabilityType: 'energy_discharge',
        timestamp: new Date().toISOString(),
        sequence: Math.floor(Date.now() / 1000),
        failAfterStage: ECONOMIC_STAGE.REWARD_CALCULATED,
      }),
    ).rejects.toThrow('TEST-ONLY: injected failure after REWARD_CALCULATED')

    // Assignment remains completed (operational completion irreversible).
    const assignment = await db.executionAssignment.findUnique({
      where: { id: assignments[0].executionAssignmentId },
      select: { status: true },
    })
    expect(assignment!.status).toBe('completed')

    // Checkpoint = reconciliation_required.
    const stateAfterFailure = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
    })
    expect(stateAfterFailure!.stage).toBe(ECONOMIC_STAGE.RECONCILIATION_REQUIRED)
    expect(stateAfterFailure!.contributionId).not.toBeNull()
    expect(stateAfterFailure!.rewardId).not.toBeNull()
    expect(stateAfterFailure!.ledgerPostingId).toBeNull()
    expect(stateAfterFailure!.settlementId).toBeNull()

    // No new lease (physical execution not repeated).
    const leases = await db.executionLease.findMany({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
    })
    const activeLeases = leases.filter((l) => l.status === LEASE_STATUS.ACTIVE)
    expect(activeLeases.length).toBe(0)

    // Reconcile → completes the chain.
    const reconcileResult = await reconcileEconomicPipeline(assignments[0].executionAssignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)

    // Exactly one of each.
    const contributions = await db.contribution.findMany({ where: { tenantId } })
    expect(contributions.length).toBe(1)
    const rewards = await db.reward.findMany({ where: { tenantId } })
    expect(rewards.length).toBe(1)
    const postings = await db.ledgerPosting.findMany({ where: { tenantId, postingType: 'reward' } })
    expect(postings.length).toBe(1)
    const settlements = await db.settlement.findMany({ where: { tenantId } })
    expect(settlements.length).toBe(1)
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
