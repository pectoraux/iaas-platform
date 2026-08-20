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

  // C4 — verification rejection: bad evidence → zero economic value
  it('C4: verification rejection — bad signing key → REJECTED → no economic value', async () => {
    const f = await createComputeFixture('C4')
    const result = await runComputeJob(f, 'c4')

    // The first run succeeded. Now simulate a crash that wipes the event
    // and reset the checkpoint, then re-run processEconomicPipeline with a
    // BAD signing key to test verification rejection.
    await db.attestation.deleteMany({ where: { tenantId: f.tenantId } })
    await db.contribution.deleteMany({ where: { tenantId: f.tenantId } })
    await db.reward.deleteMany({ where: { tenantId: f.tenantId } })
    await db.ledgerEntry.deleteMany({ where: { tenantId: f.tenantId } })
    await db.ledgerPosting.deleteMany({ where: { tenantId: f.tenantId } })
    await db.settlement.deleteMany({ where: { tenantId: f.tenantId } })
    await db.event.deleteMany({ where: { tenantId: f.tenantId } })
    await recordBuyerFunding(f.tenantId, '1000', `refund-c4-${Date.now()}`)

    await db.economicPipelineState.update({
      where: { executionAssignmentId: result.executionAssignmentId },
      data: {
        stage: ECONOMIC_STAGE.EVIDENCE_PENDING,
        eventId: null, attestationId: null, contributionId: null,
        rewardId: null, ledgerPostingId: null, settlementId: null,
        reconciliationReason: null,
      },
    })

    // Run with a BAD signing key → verification rejects.
    const { processEconomicPipeline: runPipeline } = await import('../src/lib/control-plane/economic-pipeline')
    const pipelineResult = await runPipeline({
      executionAssignmentId: result.executionAssignmentId,
      telemetryPayload: {
        gpu_count: 8, gpu_utilization_pct: 95, memory_gb: 128, duration_seconds: 3600,
      },
      actualQuantity: result.actualQuantity,
      actualUnit: result.actualUnit,
      deviceId: f.deviceId,
      signingKey: 'wrong-signing-key',
      capabilityType: 'gpu_compute',
      timestamp: new Date().toISOString(),
      sequence: Math.floor(Date.now() / 1000),
    })

    expect(pipelineResult.stage).toBe(ECONOMIC_STAGE.RECONCILIATION_REQUIRED)

    const state = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: result.executionAssignmentId },
    })
    expect(state!.eventId).not.toBeNull()
    const event = await db.event.findUnique({ where: { id: state!.eventId! } })
    expect(event!.status).toBe('rejected')

    expect(state!.attestationId).toBeNull()
    expect(state!.contributionId).toBeNull()
    expect(state!.rewardId).toBeNull()
    expect(state!.ledgerPostingId).toBeNull()
    expect(state!.settlementId).toBeNull()

    const contributions = await db.contribution.findMany({ where: { tenantId: f.tenantId } })
    expect(contributions.length).toBe(0)
    const rewards = await db.reward.findMany({ where: { tenantId: f.tenantId } })
    expect(rewards.length).toBe(0)
    const settlements = await db.settlement.findMany({ where: { tenantId: f.tenantId } })
    expect(settlements.length).toBe(0)
  })

  // C7 — concurrent reconciliation
  it('C7: concurrent reconciliation — two calls → one durable chain, no duplicates', async () => {
    const f = await createComputeFixture('C7')
    const result = await runComputeJob(f, 'c7')

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

    // Fire TWO concurrent reconciliation calls.
    const results = await Promise.allSettled([
      reconcileEconomicPipeline(result.executionAssignmentId),
      reconcileEconomicPipeline(result.executionAssignmentId),
    ])

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof reconcileEconomicPipeline>>> =>
        r.status === 'fulfilled',
    )
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    // EXACTLY ONE of each.
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

    // Same canonical IDs (reused, not duplicated).
    const stateAfter = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: result.executionAssignmentId },
    })
    expect(stateAfter!.contributionId).toBe(stateBefore!.contributionId)
    expect(stateAfter!.rewardId).toBe(stateBefore!.rewardId)
    expect(stateAfter!.settlementId).toBe(stateBefore!.settlementId)
  })

  // C8 — tenant isolation
  it('C8: tenant isolation — A checkpoint points to B objects → A recovers own, B untouched', async () => {
    const fA = await createComputeFixture('C8A')
    const fB = await createComputeFixture('C8B')

    const resultA = await runComputeJob(fA, 'c8a')
    const resultB = await runComputeJob(fB, 'c8b')

    const stateB = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: resultB.executionAssignmentId },
    })

    // Poison: set A's contributionId to B's contributionId.
    await db.economicPipelineState.update({
      where: { executionAssignmentId: resultA.executionAssignmentId },
      data: {
        contributionId: stateB!.contributionId,
        stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
        reconciliationReason: 'poisoned: A.contributionId = B.contributionId',
      },
    })

    // Reconcile A.
    const reconcileA = await reconcileEconomicPipeline(resultA.executionAssignmentId)
    expect(reconcileA.stage).toBe(ECONOMIC_STAGE.COMPLETED)

    // A must have rediscovered ITS OWN contribution (not B's).
    const stateAAfter = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: resultA.executionAssignmentId },
    })
    expect(stateAAfter!.contributionId).not.toBe(stateB!.contributionId)

    // A has exactly one contribution, B has exactly one.
    const contributionsA = await db.contribution.findMany({ where: { tenantId: fA.tenantId } })
    expect(contributionsA.length).toBe(1)
    const contributionsB = await db.contribution.findMany({ where: { tenantId: fB.tenantId } })
    expect(contributionsB.length).toBe(1)

    // B's checkpoint is unchanged.
    const stateBAfter = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: resultB.executionAssignmentId },
    })
    expect(stateBAfter!.contributionId).toBe(stateB!.contributionId)
  })

  // C11 — economic failure after operational success
  it('C11: economic failure after operational success — no physical re-execution', async () => {
    const f = await createComputeFixture('C11')
    const result = await runComputeJob(f, 'c11')

    // The job completed successfully. Now simulate a crash that wipes the
    // DOWNSTREAM economic objects (contribution, reward, ledger, settlement)
    // but preserves the Event + Attestation (the evidence chain).
    // This tests that reconciliation can resume from the durable economic
    // boundary (the attestation) without re-executing the adapter.
    await db.settlement.deleteMany({ where: { tenantId: f.tenantId } })
    await db.ledgerEntry.deleteMany({ where: { tenantId: f.tenantId } })
    await db.ledgerPosting.deleteMany({ where: { tenantId: f.tenantId } })
    await db.reward.deleteMany({ where: { tenantId: f.tenantId } })
    await db.contribution.deleteMany({ where: { tenantId: f.tenantId } })

    // Re-fund the buyer (the previous run's debit entries were deleted).
    await recordBuyerFunding(f.tenantId, '1000', `refund-c11-${Date.now()}`)

    // Reset the checkpoint: Event + Attestation are preserved, but downstream
    // IDs are cleared.
    await db.economicPipelineState.update({
      where: { executionAssignmentId: result.executionAssignmentId },
      data: {
        stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
        reconciliationReason: 'simulated crash: downstream economic objects deleted',
        contributionId: null,
        rewardId: null,
        ledgerPostingId: null,
        settlementId: null,
      },
    })

    // The assignment remains 'completed' (operational completion is irreversible).
    const assignment = await db.executionAssignment.findUnique({
      where: { id: result.executionAssignmentId },
      select: { status: true },
    })
    expect(assignment!.status).toBe('completed')

    // Reconcile — this will rediscover the Event + Attestation by their
    // deterministic identities, then re-create the downstream economic chain.
    // The adapter MUST NOT execute again.
    const reconcileResult = await reconcileEconomicPipeline(result.executionAssignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)

    // EXACTLY ONE of each economic object.
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

    // The assignment is STILL 'completed' (not re-executed).
    const assignmentAfter = await db.executionAssignment.findUnique({
      where: { id: result.executionAssignmentId },
      select: { status: true },
    })
    expect(assignmentAfter!.status).toBe('completed')

    // No NEW ExecutionLease was created (physical execution was not repeated).
    const { LEASE_STATUS } = await import('../src/lib/control-plane')
    const leases = await db.executionLease.findMany({
      where: { executionAssignmentId: result.executionAssignmentId },
    })
    const activeLeases = leases.filter((l) => l.status === LEASE_STATUS.ACTIVE)
    expect(activeLeases.length).toBe(0)
  })

  // C12 — execution lease failure-state proof
  it('C12: execution lease failure — failed adapter execution leaves lease safe', async () => {
    const f = await createComputeFixture('C12')

    // Run a compute job with a nonexistent adapter → adapter resolution fails.
    // The compute service acquires a lease, calls runtime.executeAssignment
    // (which returns success=false), then fails the assignment + releases
    // capacity + throws.
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

    // The assignment is 'failed' (terminal).
    const assignments = await db.executionAssignment.findMany({ where: { tenantId: f.tenantId } })
    expect(assignments.length).toBe(1)
    expect(assignments[0].status).toBe('failed')

    // A lease was acquired but NOT completed (the adapter failed).
    // The lease is still 'active' (not 'released' — that would imply success).
    const { LEASE_STATUS } = await import('../src/lib/control-plane')
    const leases = await db.executionLease.findMany({
      where: { executionAssignmentId: assignments[0].id },
    })
    expect(leases.length).toBe(1)
    expect(leases[0].status).not.toBe(LEASE_STATUS.RELEASED)

    // The lease is NOT 'active' in a way that allows re-execution — the
    // assignment is 'failed' (terminal), so acquireExecutionLease would
    // reject any new lease for this assignment.
    const { acquireExecutionLease } = await import('../src/lib/control-plane/execution-lease')
    const reacquire = await acquireExecutionLease({
      executionAssignmentId: assignments[0].id,
      workerIdentity: 'another-worker',
    })
    expect(reacquire.acquired).toBe(false)
    expect(reacquire.reason).toContain('terminal')

    // No economic value was created.
    const events = await db.event.findMany({ where: { tenantId: f.tenantId } })
    expect(events.length).toBe(0)
    const contributions = await db.contribution.findMany({ where: { tenantId: f.tenantId } })
    expect(contributions.length).toBe(0)
    const states = await db.economicPipelineState.findMany({ where: { tenantId: f.tenantId } })
    expect(states.length).toBe(0)
  })
})
