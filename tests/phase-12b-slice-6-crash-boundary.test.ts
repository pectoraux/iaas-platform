/**
 * Phase 12B Slice 6: Durable Reconciliation — Crash-Boundary Tests
 *
 * Proves that for every economic stage, when a durable object is committed
 * but the checkpoint forgot its ID (simulating a process crash after the
 * object's transaction committed but before the checkpoint write),
 * reconciliation:
 *   - discovers the existing durable object by its deterministic identity
 *   - reuses it (does NOT create a duplicate)
 *   - continues exactly once from the next missing stage
 *
 * R1 — Event checkpoint loss
 * R2 — Attestation checkpoint loss
 * R3 — Contribution checkpoint loss
 * R4 — Reward checkpoint loss
 * R5 — LedgerPosting checkpoint loss
 * R6 — Settlement checkpoint loss
 * R7 — Concurrent reconciliation (two callers → one durable chain)
 *
 * Run: DATABASE_URL=postgresql://... bun test tests/phase-12b-slice-6-crash-boundary.test.ts --timeout 300000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import {
  submitNetworkRequest,
  commitDecisionToExecution,
  executeDecision,
  initEconomicPipeline,
  processEconomicPipeline,
  reconcileEconomicPipeline,
  ECONOMIC_STAGE,
} from '../src/lib/control-plane'
import { initializeBootstrap } from '../src/lib/bootstrap'
import { generateProvisioningSecret, deriveSigningKey } from '../src/lib/domain/crypto'

const databaseUrl = process.env.DATABASE_URL || ''
const isPostgres =
  databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')
const describeOrSkip = isPostgres ? describe : describe.skip

beforeAll(() => {
  if (!isPostgres) return
  initializeBootstrap()
})

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface CrashFixture {
  tenantId: string
  networkId: string
  networkVersionId: string
  requesterMembershipId: string
  assetId: string
  deviceId: string
  signingKey: string
  assignmentId: string
  actualQuantity: string
  actualUnit: string
}

async function createAndExecute(label: string): Promise<CrashFixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const labelLc = label.toLowerCase()

  const tenant = await createTenant({
    name: `Slice 6 Crash — ${label}`,
    slug: `s6c-${labelLc}-${stamp}`,
    plan: 'growth',
  })
  const instantiated = await instantiateTemplate(tenant.id, 'compute-gpu-network', {
    name: `Crash Net ${label}`,
    slug: `net-s6c-${labelLc}-${stamp}`,
  })
  const network = instantiated.network!
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
      displayName: `op-s6c-${labelLc}-${stamp}`, status: 'active',
    },
  })
  const asset = await db.asset.create({
    data: {
      tenantId: tenant.id, operatorId: operator.id,
      name: `asset-s6c-${labelLc}-${stamp}`, assetType: 'compute_node', status: 'active',
    },
  })
  await db.assetNetworkAssignment.create({
    data: {
      tenantId: tenant.id, assetId: asset.id, networkId: network.id,
      capabilityType: 'gpu_compute', status: 'active',
      verifiedQuantity: '8', verifiedUnit: 'GPU-hours',
    },
  })
  const { ensureCapacityResource } = await import('../src/lib/services/capacity.service')
  await ensureCapacityResource(tenant.id, asset.id, network.id, 'gpu_compute')

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

  const { recordBuyerFunding } = await import('../src/lib/services/ledger.service')
  await recordBuyerFunding(tenant.id, '1000', `funding-${stamp}`)

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
      capabilitiesJson: JSON.stringify(['gpu_compute']),
      verifiedCapacityJson: JSON.stringify([
        { capabilityType: 'gpu_compute', amount: '8', unit: 'GPU-hours' },
      ]),
      controlMode: 'default', verificationProfile: 'default', status: 'active',
    },
  })

  const signingKey = deriveSigningKey(provisioningSecret)

  const submitResult = await submitNetworkRequest({
    requesterMembershipId: membership.id,
    networkId: network.id,
    networkVersionId: version.id,
    capabilityRequirements: [{ capabilityType: 'gpu_compute', amount: '8', unit: 'GPU-hours' }],
    timeWindow: {
      start: new Date('2024-12-01T00:00:00Z'),
      end: new Date('2024-12-01T04:00:00Z'),
    },
    idempotencyKey: `s6c-${label}-${network.id}`,
  })
  const commitResult = await commitDecisionToExecution(submitResult.decision.decisionId)
  const execResult = await executeDecision(submitResult.decision.decisionId, { workerIdentity: `s6c-${label}` })

  return {
    tenantId: tenant.id, networkId: network.id, networkVersionId: version.id,
    requesterMembershipId: membership.id, assetId: asset.id,
    deviceId: device.id, signingKey,
    assignmentId: commitResult.assignments[0].assignmentId,
    actualQuantity: execResult.assignments[0].actualQuantity!,
    actualUnit: execResult.assignments[0].actualUnit!,
  }
}

async function runFullPipeline(f: CrashFixture) {
  await initEconomicPipeline({
    executionAssignmentId: f.assignmentId,
    tenantId: f.tenantId,
    networkVersionId: f.networkVersionId,
    networkId: f.networkId,
  })
  return processEconomicPipeline({
    executionAssignmentId: f.assignmentId,
    telemetryPayload: {
      gpu_count: 8, gpu_utilization_pct: 95, memory_gb: 128, duration_seconds: 3600,
    },
    actualQuantity: f.actualQuantity, actualUnit: f.actualUnit,
    deviceId: f.deviceId, signingKey: f.signingKey,
    capabilityType: 'gpu_compute',
    timestamp: new Date().toISOString(),
    sequence: Math.floor(Date.now() / 1000),
  })
}

// Helper: clear a single checkpoint ID, simulating a crash after the durable
// object's transaction committed but before the checkpoint write.
async function clearCheckpointId(f: CrashFixture, field: string) {
  await db.economicPipelineState.update({
    where: { executionAssignmentId: f.assignmentId },
    data: {
      [field]: null,
      stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
      reconciliationReason: `simulated crash: ${field} checkpoint write lost`,
    },
  })
}

// ===========================================================================
// Tests
// ===========================================================================

describeOrSkip('Phase 12B Slice 6: Durable Reconciliation — Crash-Boundary', () => {
  // R1 — Event checkpoint loss
  it('R1: Event committed + checkpoint eventId NULL → reconcile reuses existing Event', async () => {
    const f = await createAndExecute('R1')
    const result = await runFullPipeline(f)
    expect(result.stage).toBe(ECONOMIC_STAGE.COMPLETED)

    // Capture the original event ID.
    const stateBefore = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: f.assignmentId },
    })
    const originalEventId = stateBefore!.eventId!

    // Simulate crash: clear eventId from checkpoint.
    await clearCheckpointId(f, 'eventId')

    // Reconcile.
    const reconcileResult = await reconcileEconomicPipeline(f.assignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)

    // The SAME event was reused (not re-ingested).
    expect(reconcileResult.eventId).toBe(originalEventId)

    // Exactly one event in the DB.
    const events = await db.event.findMany({ where: { tenantId: f.tenantId } })
    expect(events.length).toBe(1)
  })

  // R2 — Attestation checkpoint loss
  it('R2: Attestation committed + checkpoint attestationId NULL → reconcile reuses existing Attestation', async () => {
    const f = await createAndExecute('R2')
    const result = await runFullPipeline(f)
    expect(result.stage).toBe(ECONOMIC_STAGE.COMPLETED)

    const stateBefore = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: f.assignmentId },
    })
    const originalAttestationId = stateBefore!.attestationId!

    // Simulate crash: clear attestationId from checkpoint (keep eventId).
    await clearCheckpointId(f, 'attestationId')

    // Reconcile.
    const reconcileResult = await reconcileEconomicPipeline(f.assignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.attestationId).toBe(originalAttestationId)

    // Exactly one attestation.
    const attestations = await db.attestation.findMany({ where: { tenantId: f.tenantId } })
    expect(attestations.length).toBe(1)
  })

  // R3 — Contribution checkpoint loss
  it('R3: Contribution committed + checkpoint contributionId NULL → reconcile reuses existing Contribution', async () => {
    const f = await createAndExecute('R3')
    const result = await runFullPipeline(f)
    expect(result.stage).toBe(ECONOMIC_STAGE.COMPLETED)

    const stateBefore = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: f.assignmentId },
    })
    const originalContributionId = stateBefore!.contributionId!

    await clearCheckpointId(f, 'contributionId')

    const reconcileResult = await reconcileEconomicPipeline(f.assignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.contributionId).toBe(originalContributionId)

    const contributions = await db.contribution.findMany({ where: { tenantId: f.tenantId } })
    expect(contributions.length).toBe(1)
  })

  // R4 — Reward checkpoint loss
  it('R4: Reward committed + checkpoint rewardId NULL → reconcile reuses existing Reward, no duplicate ledger', async () => {
    const f = await createAndExecute('R4')
    const result = await runFullPipeline(f)
    expect(result.stage).toBe(ECONOMIC_STAGE.COMPLETED)

    const stateBefore = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: f.assignmentId },
    })
    const originalRewardId = stateBefore!.rewardId!

    await clearCheckpointId(f, 'rewardId')

    const reconcileResult = await reconcileEconomicPipeline(f.assignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.rewardId).toBe(originalRewardId)

    const rewards = await db.reward.findMany({ where: { tenantId: f.tenantId } })
    expect(rewards.length).toBe(1)

    // No duplicate ledger posting (buyer balance not consumed twice).
    const postings = await db.ledgerPosting.findMany({
      where: { tenantId: f.tenantId, postingType: 'reward' },
    })
    expect(postings.length).toBe(1)
  })

  // R5 — LedgerPosting checkpoint loss
  it('R5: LedgerPosting committed + checkpoint ledgerPostingId NULL → reconcile reuses existing posting, no double debit', async () => {
    const f = await createAndExecute('R5')
    const result = await runFullPipeline(f)
    expect(result.stage).toBe(ECONOMIC_STAGE.COMPLETED)

    const stateBefore = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: f.assignmentId },
    })
    const originalPostingId = stateBefore!.ledgerPostingId!

    await clearCheckpointId(f, 'ledgerPostingId')

    const reconcileResult = await reconcileEconomicPipeline(f.assignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.ledgerPostingId).toBe(originalPostingId)

    // No duplicate reward postings (buyer balance changes exactly once).
    const postings = await db.ledgerPosting.findMany({
      where: { tenantId: f.tenantId, postingType: 'reward' },
    })
    expect(postings.length).toBe(1)
  })

  // R6 — Settlement checkpoint loss
  it('R6: Settlement committed + checkpoint settlementId NULL → reconcile reuses existing Settlement, no double payout', async () => {
    const f = await createAndExecute('R6')
    const result = await runFullPipeline(f)
    expect(result.stage).toBe(ECONOMIC_STAGE.COMPLETED)

    const stateBefore = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: f.assignmentId },
    })
    const originalSettlementId = stateBefore!.settlementId!

    await clearCheckpointId(f, 'settlementId')

    const reconcileResult = await reconcileEconomicPipeline(f.assignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.settlementId).toBe(originalSettlementId)

    const settlements = await db.settlement.findMany({ where: { tenantId: f.tenantId } })
    expect(settlements.length).toBe(1)
  })

  // R7 — Concurrent reconciliation: two callers → one durable chain
  it('R7: two concurrent reconcileEconomicPipeline calls → exactly one economic outcome (no duplicates)', async () => {
    const f = await createAndExecute('R7')
    const result = await runFullPipeline(f)
    expect(result.stage).toBe(ECONOMIC_STAGE.COMPLETED)

    // Capture all original IDs.
    const stateBefore = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: f.assignmentId },
    })

    // Simulate crash: clear ALL downstream IDs.
    await db.economicPipelineState.update({
      where: { executionAssignmentId: f.assignmentId },
      data: {
        stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
        reconciliationReason: 'simulated crash: all downstream IDs lost',
        contributionId: null,
        rewardId: null,
        ledgerPostingId: null,
        settlementId: null,
      },
    })

    // Fire TWO concurrent reconciliation calls.
    const results = await Promise.allSettled([
      reconcileEconomicPipeline(f.assignmentId),
      reconcileEconomicPipeline(f.assignmentId),
    ])

    // At least one should succeed (both may succeed — converging on the same chain).
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof reconcileEconomicPipeline>>> =>
        r.status === 'fulfilled',
    )
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    // EXACTLY ONE of each durable object — no duplicates, no double debit.
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

    // The event was NOT re-ingested.
    const events = await db.event.findMany({ where: { tenantId: f.tenantId } })
    expect(events.length).toBe(1)

    // The contribution/reward/settlement IDs match the originals (reused, not duplicated).
    const stateAfter = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: f.assignmentId },
    })
    expect(stateAfter!.contributionId).toBe(stateBefore!.contributionId)
    expect(stateAfter!.rewardId).toBe(stateBefore!.rewardId)
    expect(stateAfter!.settlementId).toBe(stateBefore!.settlementId)
  })

  // Helper: set a checkpoint ID to a stale/bogus value.
  async function setStaleCheckpointId(f: CrashFixture, field: string, bogusId: string) {
    await db.economicPipelineState.update({
      where: { executionAssignmentId: f.assignmentId },
      data: {
        [field]: bogusId,
        stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
        reconciliationReason: `simulated stale ID: ${field} = ${bogusId}`,
      },
    })
  }

  // R8 — stale Event ID
  it('R8: stale eventId → reconcile rediscovers correct Event', async () => {
    const f = await createAndExecute('R8')
    const result = await runFullPipeline(f)
    expect(result.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    const stateBefore = await db.economicPipelineState.findUnique({ where: { executionAssignmentId: f.assignmentId } })
    const originalEventId = stateBefore!.eventId!

    // Set eventId to a bogus/deleted ID.
    await setStaleCheckpointId(f, 'eventId', 'nonexistent-event-id-12345')

    const reconcileResult = await reconcileEconomicPipeline(f.assignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.eventId).toBe(originalEventId)

    const events = await db.event.findMany({ where: { tenantId: f.tenantId } })
    expect(events.length).toBe(1)
  })

  // R9 — stale Attestation ID
  it('R9: stale attestationId → reconcile rediscovers correct Attestation', async () => {
    const f = await createAndExecute('R9')
    const result = await runFullPipeline(f)
    expect(result.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    const stateBefore = await db.economicPipelineState.findUnique({ where: { executionAssignmentId: f.assignmentId } })
    const originalAttestationId = stateBefore!.attestationId!

    await setStaleCheckpointId(f, 'attestationId', 'nonexistent-attestation-id-12345')

    const reconcileResult = await reconcileEconomicPipeline(f.assignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.attestationId).toBe(originalAttestationId)

    const attestations = await db.attestation.findMany({ where: { tenantId: f.tenantId } })
    expect(attestations.length).toBe(1)
  })

  // R10 — stale Contribution ID
  it('R10: stale contributionId → reconcile rediscovers correct Contribution', async () => {
    const f = await createAndExecute('R10')
    const result = await runFullPipeline(f)
    expect(result.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    const stateBefore = await db.economicPipelineState.findUnique({ where: { executionAssignmentId: f.assignmentId } })
    const originalContributionId = stateBefore!.contributionId!

    await setStaleCheckpointId(f, 'contributionId', 'nonexistent-contribution-id-12345')

    const reconcileResult = await reconcileEconomicPipeline(f.assignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.contributionId).toBe(originalContributionId)

    const contributions = await db.contribution.findMany({ where: { tenantId: f.tenantId } })
    expect(contributions.length).toBe(1)
  })

  // R11 — stale Reward ID
  it('R11: stale rewardId → reconcile rediscovers correct Reward, no duplicate ledger', async () => {
    const f = await createAndExecute('R11')
    const result = await runFullPipeline(f)
    expect(result.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    const stateBefore = await db.economicPipelineState.findUnique({ where: { executionAssignmentId: f.assignmentId } })
    const originalRewardId = stateBefore!.rewardId!

    await setStaleCheckpointId(f, 'rewardId', 'nonexistent-reward-id-12345')

    const reconcileResult = await reconcileEconomicPipeline(f.assignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.rewardId).toBe(originalRewardId)

    const rewards = await db.reward.findMany({ where: { tenantId: f.tenantId } })
    expect(rewards.length).toBe(1)
    const postings = await db.ledgerPosting.findMany({ where: { tenantId: f.tenantId, postingType: 'reward' } })
    expect(postings.length).toBe(1)
  })

  // R12 — stale LedgerPosting ID
  it('R12: stale ledgerPostingId → reconcile rediscovers correct posting, no double debit', async () => {
    const f = await createAndExecute('R12')
    const result = await runFullPipeline(f)
    expect(result.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    const stateBefore = await db.economicPipelineState.findUnique({ where: { executionAssignmentId: f.assignmentId } })
    const originalPostingId = stateBefore!.ledgerPostingId!

    await setStaleCheckpointId(f, 'ledgerPostingId', 'nonexistent-posting-id-12345')

    const reconcileResult = await reconcileEconomicPipeline(f.assignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.ledgerPostingId).toBe(originalPostingId)

    const postings = await db.ledgerPosting.findMany({ where: { tenantId: f.tenantId, postingType: 'reward' } })
    expect(postings.length).toBe(1)
  })

  // R13 — stale Settlement ID
  it('R13: stale settlementId → reconcile rediscovers correct Settlement, no double payout', async () => {
    const f = await createAndExecute('R13')
    const result = await runFullPipeline(f)
    expect(result.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    const stateBefore = await db.economicPipelineState.findUnique({ where: { executionAssignmentId: f.assignmentId } })
    const originalSettlementId = stateBefore!.settlementId!

    await setStaleCheckpointId(f, 'settlementId', 'nonexistent-settlement-id-12345')

    const reconcileResult = await reconcileEconomicPipeline(f.assignmentId)
    expect(reconcileResult.stage).toBe(ECONOMIC_STAGE.COMPLETED)
    expect(reconcileResult.settlementId).toBe(originalSettlementId)

    const settlements = await db.settlement.findMany({ where: { tenantId: f.tenantId } })
    expect(settlements.length).toBe(1)
  })

  // R14 — cross-assignment poisoning: A.contributionId = B.contributionId
  it('R14: cross-assignment poisoning — A.contributionId = B.contributionId → A rediscovers own Contribution, B unchanged', async () => {
    const fA = await createAndExecute('R14A')
    const fB = await createAndExecute('R14B')

    // Run full pipelines for both A and B.
    await runFullPipeline(fA)
    await runFullPipeline(fB)

    const stateA = await db.economicPipelineState.findUnique({ where: { executionAssignmentId: fA.assignmentId } })
    const stateB = await db.economicPipelineState.findUnique({ where: { executionAssignmentId: fB.assignmentId } })
    const originalAContributionId = stateA!.contributionId!
    const originalBContributionId = stateB!.contributionId!

    // Poison: set A's contributionId to B's contributionId.
    await db.economicPipelineState.update({
      where: { executionAssignmentId: fA.assignmentId },
      data: {
        contributionId: originalBContributionId,
        stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
        reconciliationReason: 'poisoned: A.contributionId = B.contributionId',
      },
    })

    // Reconcile A.
    const reconcileA = await reconcileEconomicPipeline(fA.assignmentId)
    expect(reconcileA.stage).toBe(ECONOMIC_STAGE.COMPLETED)

    // A must have rediscovered ITS OWN contribution (not B's).
    const stateAAfter = await db.economicPipelineState.findUnique({ where: { executionAssignmentId: fA.assignmentId } })
    expect(stateAAfter!.contributionId).toBe(originalAContributionId)
    expect(stateAAfter!.contributionId).not.toBe(originalBContributionId)

    // B's checkpoint must be unchanged.
    const stateBAfter = await db.economicPipelineState.findUnique({ where: { executionAssignmentId: fB.assignmentId } })
    expect(stateBAfter!.contributionId).toBe(originalBContributionId)

    // No duplicate contributions (A has 1, B has 1, total = 2 across both tenants).
    const contributionsA = await db.contribution.findMany({ where: { tenantId: fA.tenantId } })
    expect(contributionsA.length).toBe(1)
    const contributionsB = await db.contribution.findMany({ where: { tenantId: fB.tenantId } })
    expect(contributionsB.length).toBe(1)
  })
})
