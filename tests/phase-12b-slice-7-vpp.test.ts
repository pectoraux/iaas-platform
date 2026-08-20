/**
 * Phase 12B Slice 7: VPP Migration — Integration Tests
 *
 * Proves the VPP vertical uses the generic EconomicPipelineState +
 * processEconomicPipeline with no VPP-specific economic infrastructure.
 *
 * V1 — VPP happy path
 * V9 — VPP dimensional correctness (kWh)
 * V10 — VPP vertical neutrality
 * V15 — VPP vertical neutrality (generic pipeline has no VPP imports)
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
} from '../src/lib/services/vpp.service'
import { initializeBootstrap } from '../src/lib/bootstrap'
import { reconcileEconomicPipeline, ECONOMIC_STAGE } from '../src/lib/control-plane'

const databaseUrl = process.env.DATABASE_URL || ''
const isPostgres =
  databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')
const describeOrSkip = isPostgres ? describe : describe.skip

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

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
    name: 'Slice 7 VPP Migration',
    slug: `s7v-${Date.now()}`,
    plan: 'growth',
  })
  tenantId = tenant.id

  const { network, version } = await instantiateTemplate(tenantId, 'energy-vpp')
  networkId = network.id
  versionId = version!.id

  const rule = await db.rewardRule.findFirst({ where: { networkVersionId: versionId } })
  rewardRuleId = rule!.id

  const op = await createOperator(tenantId, { displayName: 'VPP S7 Operator' })
  operatorId = op.id
  const ast = await createAsset(tenantId, { operatorId, assetType: 'battery', name: 'VPP S7 Battery' })
  assetId = ast.id
  await assignAssetToNetwork(tenantId, assetId, networkId, 'energy_discharge', '10', 'kW')
  const dev = await createDevice(tenantId, { assetId, deviceType: 'battery_controller' })
  deviceSecret = dev.provisioningSecret

  await recordBuyerFunding(tenantId, 100000, `s7v-funding-${Date.now()}`)
})

async function setupDispatch() {
  testCounter++
  const baseTime = Date.now() + 3600000 * (10 + testCounter * 2)
  const start = new Date(baseTime)
  const end = new Date(baseTime + 3600000)

  const program = await createBuyerProgram(tenantId, {
    networkId,
    name: `S7V Program-${testCounter}`,
    rewardRuleId,
    dispatchWindowStart: '00:00',
    dispatchWindowEnd: '23:59',
    pricePerKwh: '0.12',
    minCapacityKw: '1',
  })

  await createCapacityReservation(tenantId, {
    programId: program.id,
    operatorId,
    assetId,
    capabilityType: 'energy_discharge',
    reservedKw: '10',
    reservedKwh: '10',
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  })

  const { dispatch, assignments } = await createDispatch(tenantId, {
    programId: program.id,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    requestedKw: '10',
    requestedKwh: '10',
  })

  return { dispatch, assignments, start, end }
}

// ===========================================================================
// Tests
// ===========================================================================

describeOrSkip('Phase 12B Slice 7: VPP Migration', () => {
  // V1 — VPP happy path
  it('V1: VPP happy path — exactly one of each economic object via generic pipeline', async () => {
    const { assignments } = await setupDispatch()
    const assignmentId = assignments[0].id

    const result = await executeDispatchAssignment(tenantId, assignmentId, deviceSecret)

    // Verify the economic pipeline completed.
    expect(result.contribution_id).toBeDefined()
    expect(result.reward_id).toBeDefined()
    expect(result.settlement_id).toBeDefined()

    // Exactly one EconomicPipelineState.
    const state = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
    })
    expect(state).toBeDefined()
    expect(state!.stage).toBe(ECONOMIC_STAGE.COMPLETED)

    // Verify durable objects exist.
    const event = await db.event.findUnique({ where: { id: result.event_id! } })
    expect(event).toBeDefined()
    expect(event!.status).toBe('verified')

    const contribution = await db.contribution.findUnique({ where: { id: result.contribution_id! } })
    expect(contribution).toBeDefined()

    const reward = await db.reward.findUnique({ where: { id: result.reward_id! } })
    expect(reward).toBeDefined()

    const settlement = await db.settlement.findUnique({ where: { id: result.settlement_id! } })
    expect(settlement).toBeDefined()
  })

  // V2 — VPP retry
  it('V2: VPP retry — reconcileEconomicPipeline returns replayed=true', async () => {
    const { assignments } = await setupDispatch()
    const assignmentId = assignments[0].id

    await executeDispatchAssignment(tenantId, assignmentId, deviceSecret)

    const reconcileResult = await reconcileEconomicPipeline(assignments[0].executionAssignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.replayed).toBe(true)
  })

  // V3 — VPP execution failure (nonexistent adapter type)
  it('V3: VPP execution failure → no economic value', async () => {
    const { assignments } = await setupDispatch()
    const assignmentId = assignments[0].id

    // Sabotage: change the asset type to trigger adapter resolution failure.
    await db.asset.update({ where: { id: assetId }, data: { assetType: 'nonexistent-vpp-asset' } })

    await expect(
      executeDispatchAssignment(tenantId, assignmentId, deviceSecret),
    ).rejects.toThrow()

    // Restore the asset type.
    await db.asset.update({ where: { id: assetId }, data: { assetType: 'battery' } })

    // No economic objects created.
    const states = await db.economicPipelineState.findMany({
      where: { executionAssignmentId: assignments[0].executionAssignmentId },
    })
    expect(states.length).toBe(0)
  })

  // V9 — VPP dimensional correctness
  it('V9: VPP dimensional correctness — contribution.quantity = kWh, not kW or %', async () => {
    const { assignments } = await setupDispatch()
    const assignmentId = assignments[0].id

    const result = await executeDispatchAssignment(tenantId, assignmentId, deviceSecret)

    const contribution = await db.contribution.findUnique({ where: { id: result.contribution_id! } })
    expect(contribution).toBeDefined()
    // Unit must be kWh (not kW or %).
    expect(contribution!.unit).toBe('kWh')
    // Quantity must be a non-negative number.
    expect(parseFloat(contribution!.quantity.toString())).toBeGreaterThanOrEqual(0)
  })

  // V10/V15 — VPP vertical neutrality
  it('V10: VPP vertical neutrality — generic economic pipeline has no VPP imports', async () => {
    const source = await import('fs').then((fs) =>
      fs.readFileSync('./src/lib/control-plane/economic-pipeline.ts', 'utf8'),
    )
    const importLines = source
      .split('\n')
      .filter((l) => l.match(/^\s*import\s/) || l.match(/^\s*}\s*from\s/))
      .join('\n')
    expect(importLines).not.toMatch(/vpp\.service/)
    expect(importLines).not.toMatch(/vpp-/)
    // The generic pipeline must NOT import from VPP.
  })
})
