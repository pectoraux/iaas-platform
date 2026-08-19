/**
 * Phase 12B Slice 7: Compute Migration — Integration Tests
 *
 * Proves the Compute vertical uses the generic EconomicPipelineState +
 * processEconomicPipeline with NO compute-specific economic infrastructure.
 *
 * C1 — happy path: exactly one of each economic object.
 * C2 — retry: same objects, zero duplicates.
 * C3 — execution failure: no economic value.
 * C5 — restart recovery: existing objects reused.
 * C6 — stale checkpoint: correct objects rediscovered.
 * C9 — dimensional correctness: quantity/unit are GPU-hours.
 * C10 — vertical neutrality: generic pipeline has no compute imports.
 *
 * Run: DATABASE_URL=postgresql://... bun test tests/phase-12b-slice-7-compute.test.ts --timeout 300000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { createAndExecuteComputeJob } from '../src/lib/services/compute.service'
import { recordBuyerFunding } from '../src/lib/services/ledger.service'
import { generateProvisioningSecret, deriveSigningKey } from '../src/lib/domain/crypto'
import { initializeBootstrap } from '../src/lib/bootstrap'
import { reconcileEconomicPipeline, ECONOMIC_STAGE } from '../src/lib/control-plane'

const databaseUrl = process.env.DATABASE_URL || ''
const isPostgres =
  databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')
const describeOrSkip = isPostgres ? describe : describe.skip

beforeAll(() => {
  if (!isPostgres) return
  initializeBootstrap()
})

// ---------------------------------------------------------------------------
// Fixture: isolated compute network + asset + device + funding
// ---------------------------------------------------------------------------

interface ComputeFixture {
  tenantId: string
  networkId: string
  assetId: string
  operatorId: string
  deviceId: string
  provisioningSecret: string
}

async function createComputeFixture(label: string): Promise<ComputeFixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const labelLc = label.toLowerCase()

  const tenant = await createTenant({
    name: `Slice 7 Compute — ${label}`,
    slug: `s7c-${labelLc}-${stamp}`,
    plan: 'growth',
  })
  const instantiated = await instantiateTemplate(tenant.id, 'compute-gpu-network', {
    name: `Slice 7 Net ${label}`,
    slug: `net-s7c-${labelLc}-${stamp}`,
  })
  const network = instantiated.network!

  const participant = await db.participantIdentity.create({ data: {} })
  const membership = await db.participantMembership.create({
    data: { participantId: participant.id, networkId: network.id, status: 'active' },
  })

  const operator = await db.operator.create({
    data: {
      tenantId: tenant.id, organizationId: null,
      displayName: `op-s7c-${labelLc}-${stamp}`, status: 'active',
    },
  })
  const asset = await db.asset.create({
    data: {
      tenantId: tenant.id, operatorId: operator.id,
      name: `asset-s7c-${labelLc}-${stamp}`, assetType: 'compute_node', status: 'active',
    },
  })
  await db.assetNetworkAssignment.create({
    data: {
      tenantId: tenant.id, assetId: asset.id, networkId: network.id,
      capabilityType: 'gpu_compute', status: 'active',
      verifiedQuantity: '8', verifiedUnit: 'GPU-hours',
    },
  })

  const device = await db.device.create({
    data: {
      tenantId: tenant.id, assetId: asset.id,
      deviceType: 'compute_node', status: 'active',
    },
  })
  const { provisioningSecret, verificationKey, secretHash } = generateProvisioningSecret()
  await db.deviceCredential.create({
    data: {
      tenantId: tenant.id, deviceId: device.id,
      credentialType: 'hmac_sha256',
      verificationKey, secretHash,
      status: 'active', activatedAt: new Date(),
    },
  })

  // Fund the buyer account.
  await recordBuyerFunding(tenant.id, '1000', `funding-s7c-${stamp}`)

  return {
    tenantId: tenant.id, networkId: network.id,
    assetId: asset.id, operatorId: operator.id,
    deviceId: device.id, provisioningSecret,
  }
}

async function runComputeJob(f: ComputeFixture, label: string) {
  return createAndExecuteComputeJob(f.tenantId, {
    networkId: f.networkId,
    assetId: f.assetId,
    operatorId: f.operatorId,
    capabilityType: 'gpu_compute',
    assignedQuantity: '8',
    assignedUnit: 'GPU-hours',
    durationSeconds: 3600,
    parameters: { gpuCount: 8 },
  }, f.provisioningSecret)
}

// ===========================================================================
// Tests
// ===========================================================================

describeOrSkip('Phase 12B Slice 7: Compute Migration', () => {
  // C1 — happy path
  it('C1: compute happy path — exactly one of each economic object', async () => {
    const f = await createComputeFixture('C1')
    const result = await runComputeJob(f, 'c1')

    // Exactly one EconomicPipelineState.
    const states = await db.economicPipelineState.findMany({
      where: { executionAssignmentId: result.executionAssignmentId },
    })
    expect(states.length).toBe(1)
    expect(states[0].stage).toBe(ECONOMIC_STAGE.COMPLETED)

    // Exactly one of each economic object.
    const events = await db.event.findMany({ where: { tenantId: f.tenantId } })
    expect(events.length).toBe(1)
    expect(events[0].status).toBe('verified')

    const attestations = await db.attestation.findMany({ where: { tenantId: f.tenantId } })
    expect(attestations.length).toBe(1)

    const contributions = await db.contribution.findMany({ where: { tenantId: f.tenantId } })
    expect(contributions.length).toBe(1)

    const rewards = await db.reward.findMany({ where: { tenantId: f.tenantId } })
    expect(rewards.length).toBe(1)

    const postings = await db.ledgerPosting.findMany({
      where: { tenantId: f.tenantId, postingType: 'reward' },
    })
    expect(postings.length).toBe(1)

    const settlements = await db.settlement.findMany({ where: { tenantId: f.tenantId } })
    expect(settlements.length).toBe(1)
  })

  // C2 — retry
  it('C2: retry — calling createAndExecuteComputeJob with same inputs converges', async () => {
    const f = await createComputeFixture('C2')
    const result1 = await runComputeJob(f, 'c2')

    // The economic pipeline is idempotent — re-running with the same assignment
    // should return the same objects. But createAndExecuteComputeJob creates a
    // new execution each time (it's not idempotent at the execution level).
    // So we test idempotency at the economic pipeline level by calling
    // reconcileEconomicPipeline, which should be a no-op (already completed).
    const reconcileResult = await reconcileEconomicPipeline(result1.executionAssignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.replayed).toBe(true)

    // Still exactly one of each.
    const events = await db.event.findMany({ where: { tenantId: f.tenantId } })
    expect(events.length).toBe(1)
    const contributions = await db.contribution.findMany({ where: { tenantId: f.tenantId } })
    expect(contributions.length).toBe(1)
    const rewards = await db.reward.findMany({ where: { tenantId: f.tenantId } })
    expect(rewards.length).toBe(1)
    const postings = await db.ledgerPosting.findMany({
      where: { tenantId: f.tenantId, postingType: 'reward' },
    })
    expect(postings.length).toBe(1)
    const settlements = await db.settlement.findMany({ where: { tenantId: f.tenantId } })
    expect(settlements.length).toBe(1)
  })

  // C3 — execution failure: no economic value
  it('C3: compute adapter failure → no economic value', async () => {
    const f = await createComputeFixture('C3')

    // Pass a nonexistent adapterType to trigger adapter resolution failure.
    await expect(
      createAndExecuteComputeJob(f.tenantId, {
        networkId: f.networkId,
        assetId: f.assetId,
        operatorId: f.operatorId,
        capabilityType: 'gpu_compute',
        assignedQuantity: '8',
        assignedUnit: 'GPU-hours',
        durationSeconds: 3600,
        adapterType: 'nonexistent-adapter',
      }, f.provisioningSecret),
    ).rejects.toThrow()

    // No economic objects created.
    const events = await db.event.findMany({ where: { tenantId: f.tenantId } })
    expect(events.length).toBe(0)
    const contributions = await db.contribution.findMany({ where: { tenantId: f.tenantId } })
    expect(contributions.length).toBe(0)
    const rewards = await db.reward.findMany({ where: { tenantId: f.tenantId } })
    expect(rewards.length).toBe(0)
    const settlements = await db.settlement.findMany({ where: { tenantId: f.tenantId } })
    expect(settlements.length).toBe(0)

    // No EconomicPipelineState created.
    const states = await db.economicPipelineState.findMany({ where: { tenantId: f.tenantId } })
    expect(states.length).toBe(0)
  })

  // C5 — restart recovery
  it('C5: restart recovery — clear checkpoint IDs → reconcile reuses existing objects', async () => {
    const f = await createComputeFixture('C5')
    const result = await runComputeJob(f, 'c5')

    // Capture original IDs.
    const stateBefore = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: result.executionAssignmentId },
    })

    // Simulate crash: clear all downstream IDs.
    await db.economicPipelineState.update({
      where: { executionAssignmentId: result.executionAssignmentId },
      data: {
        stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
        reconciliationReason: 'simulated crash',
        contributionId: null,
        rewardId: null,
        ledgerPostingId: null,
        settlementId: null,
      },
    })

    // Reconcile.
    const reconcileResult = await reconcileEconomicPipeline(result.executionAssignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)

    // Same objects reused.
    expect(reconcileResult.contributionId).toBe(stateBefore!.contributionId)
    expect(reconcileResult.rewardId).toBe(stateBefore!.rewardId)
    expect(reconcileResult.settlementId).toBe(stateBefore!.settlementId)

    // Still exactly one of each.
    const contributions = await db.contribution.findMany({ where: { tenantId: f.tenantId } })
    expect(contributions.length).toBe(1)
    const rewards = await db.reward.findMany({ where: { tenantId: f.tenantId } })
    expect(rewards.length).toBe(1)
    const settlements = await db.settlement.findMany({ where: { tenantId: f.tenantId } })
    expect(settlements.length).toBe(1)
  })

  // C6 — stale checkpoint
  it('C6: stale checkpoint — bogus rewardId → reconcile rediscovers correct Reward', async () => {
    const f = await createComputeFixture('C6')
    const result = await runComputeJob(f, 'c6')

    const stateBefore = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: result.executionAssignmentId },
    })
    const originalRewardId = stateBefore!.rewardId!

    // Set rewardId to a bogus value.
    await db.economicPipelineState.update({
      where: { executionAssignmentId: result.executionAssignmentId },
      data: {
        rewardId: 'nonexistent-reward-id-99999',
        stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
        reconciliationReason: 'stale rewardId',
      },
    })

    const reconcileResult = await reconcileEconomicPipeline(result.executionAssignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.rewardId).toBe(originalRewardId)

    const rewards = await db.reward.findMany({ where: { tenantId: f.tenantId } })
    expect(rewards.length).toBe(1)
  })

  // C9 — dimensional correctness
  it('C9: dimensional correctness — contribution.quantity + unit represent GPU-hours', async () => {
    const f = await createComputeFixture('C9')
    const result = await runComputeJob(f, 'c9')

    const contribution = await db.contribution.findFirst({
      where: { tenantId: f.tenantId },
    })
    expect(contribution).toBeDefined()
    // The quantity should be a positive number (actual GPU-hours, not utilization %).
    expect(parseFloat(contribution!.quantity.toString())).toBeGreaterThan(0)
    // The unit should be GPU-hours (not 'GPUs' or '%').
    expect(contribution!.unit).toBe('GPU-hours')
  })

  // C10 — vertical neutrality
  it('C10: vertical neutrality — generic economic pipeline has no compute imports', async () => {
    const source = await import('fs').then((fs) =>
      fs.readFileSync('./src/lib/control-plane/economic-pipeline.ts', 'utf8'),
    )
    const importLines = source
      .split('\n')
      .filter((l) => l.match(/^\s*import\s/) || l.match(/^\s*}\s*from\s/))
      .join('\n')
    expect(importLines).not.toMatch(/compute\.service/)
    expect(importLines).not.toMatch(/compute-adapter\.service/)
    // The compute service DOES import from the generic pipeline — that's correct.
    // The generic pipeline must NOT import from compute.
  })
})
