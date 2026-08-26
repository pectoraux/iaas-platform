/**
 * VPP-2D-4: Real DB integration tests for stale-worker fencing.
 *
 * These tests exercise the ACTUAL Prisma updateMany against the database,
 * proving that a stale worker (whose lease expired and was reclaimed by
 * another worker) cannot overwrite the newer worker's result.
 *
 * Commitment fencing test:
 *   A claims token X → lease expires → B reclaims token Y → B finalizes
 *   → A executes the real fenced UPDATE → count=0 → B's result remains
 *
 * Event fencing test:
 *   A claims token X → lease expires → B reclaims token Y → B marks processed
 *   → A executes the real fenced UPDATE → count=0 → event remains processed
 *
 * Run: bun test tests/vpp-2d-4-fencing-integration.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { randomUUID } from 'crypto'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { createOperator, createAsset, assignAssetToNetwork } from '../src/lib/services/registry.service'
import { recordBuyerFunding } from '../src/lib/services/ledger.service'

let tenantId: string
let networkId: string
let versionId: string

beforeAll(async () => {
  const tenant = await createTenant({ name: 'Fencing Integration', slug: `fence-${Date.now()}`, plan: 'growth' })
  tenantId = tenant.id

  const { network, version } = await instantiateTemplate(tenantId, 'energy-vpp')
  networkId = network.id
  versionId = version!.id

  await recordBuyerFunding(tenantId, 100000, `fence-funding-${Date.now()}`)
})

// ---------------------------------------------------------------------------
// Commitment fencing: stale evaluator cannot overwrite newer result
// ---------------------------------------------------------------------------

describe('VPP-2D-4 fencing: commitment stale-worker rejection (real DB)', () => {
  it('stale evaluator UPDATE affects 0 rows after lease reclaim', async () => {
    // Create a dispatch + portfolio commitment directly in the DB.
    const now = new Date()
    const start = new Date(now.getTime() + 3600000 * 200)
    const end = new Date(start.getTime() + 3600000 * 2)

    const program = await db.vppBuyerProgram.create({
      data: {
        tenantId,
        networkId,
        networkVersionId: versionId,
        name: `Fence Program ${Date.now()}`,
        rewardRuleId: (await db.rewardRule.findFirst({ where: { networkVersionId: versionId } }))!.id,
        dispatchWindowStart: '00:00',
        dispatchWindowEnd: '23:59',
        pricePerKwh: '0.12',
        minCapacityKw: '1',
      },
    })

    // WORK-006 (BASE-007): VppDispatch requires executionId (1:1 FK to Execution).
    // Create the Execution record first, then link it.
    const execution = await db.execution.create({
      data: {
        tenantId,
        networkId,
        networkVersionId: versionId,
        requestedQuantity: '100',
        requestedUnit: 'kW',
        startTime: start,
        endTime: end,
        status: 'dispatching',
        sourceType: 'vpp_dispatch',
        sourceId: `vpp-2d-4-${Date.now()}`,
      },
    })
    const dispatch = await db.vppDispatch.create({
      data: {
        tenantId,
        programId: program.id,
        executionId: execution.id,
        requestedKw: '100',
        requestedKwh: '200',
        startTime: start,
        endTime: end,
        status: 'dispatching',
      },
    })

    // Create the portfolio commitment in 'pending' status.
    const commitment = await db.vppPortfolioCommitment.create({
      data: {
        tenantId,
        dispatchId: dispatch.id,
        requestedKw: '100',
        requestedKwh: '200',
        confidenceLevel: '0.99',
        committedKw: '100',
        assignmentCount: 2,
      },
    })

    // Step 1: Evaluator A claims with token X.
    const claimA = randomUUID()
    const leaseA = new Date(Date.now() + 60000) // 60s lease
    await db.vppPortfolioCommitment.updateMany({
      where: { id: commitment.id, status: 'pending' },
      data: {
        status: 'evaluating',
        evaluationClaimedAt: now,
        evaluationLeaseExpiresAt: leaseA,
        evaluationClaimId: claimA,
      },
    })

    // Verify A's claim took.
    let current = await db.vppPortfolioCommitment.findUnique({ where: { id: commitment.id } })
    expect(current?.status).toBe('evaluating')
    expect(current?.evaluationClaimId).toBe(claimA)

    // Step 2: Lease expires (simulate by setting lease to the past).
    const expiredLease = new Date(Date.now() - 1000) // 1 second ago
    await db.vppPortfolioCommitment.update({
      where: { id: commitment.id },
      data: { evaluationLeaseExpiresAt: expiredLease },
    })

    // Step 3: Evaluator B reclaims with token Y (new lease + new token).
    const claimB = randomUUID()
    const leaseB = new Date(Date.now() + 60000)
    const reclaimed = await db.vppPortfolioCommitment.updateMany({
      where: {
        id: commitment.id,
        status: 'evaluating',
        evaluationLeaseExpiresAt: { lt: new Date() },
      },
      data: {
        evaluationClaimedAt: new Date(),
        evaluationLeaseExpiresAt: leaseB,
        evaluationClaimId: claimB,
      },
    })
    expect(reclaimed.count).toBe(1) // B successfully reclaimed

    // Verify B now owns the lease.
    current = await db.vppPortfolioCommitment.findUnique({ where: { id: commitment.id } })
    expect(current?.evaluationClaimId).toBe(claimB)

    // Step 4: B finalizes (writes the final result with fencing on claimB).
    const bFinalResult = await db.vppPortfolioCommitment.updateMany({
      where: {
        id: commitment.id,
        status: 'evaluating',
        evaluationClaimId: claimB, // B's fencing token
      },
      data: {
        status: 'fulfilled',
        deliveredKw: '95',
        deliveredKwh: '190',
        fulfillmentPct: '95',
        evaluatedAt: new Date(),
        evaluationClaimedAt: null,
        evaluationLeaseExpiresAt: null,
        evaluationClaimId: null,
      },
    })
    expect(bFinalResult.count).toBe(1) // B's write succeeded

    // Step 5: A wakes up and attempts its final write with claimA (stale token).
    const aStaleWrite = await db.vppPortfolioCommitment.updateMany({
      where: {
        id: commitment.id,
        status: 'evaluating',
        evaluationClaimId: claimA, // A's stale fencing token — no longer matches
      },
      data: {
        status: 'failed', // A would write a different result
        deliveredKw: '0',
        deliveredKwh: '0',
        fulfillmentPct: '0',
        evaluatedAt: new Date(),
        evaluationClaimedAt: null,
        evaluationLeaseExpiresAt: null,
        evaluationClaimId: null,
      },
    })

    // CRITICAL ASSERTION: A's stale write affects 0 rows.
    expect(aStaleWrite.count).toBe(0)

    // B's result remains authoritative.
    current = await db.vppPortfolioCommitment.findUnique({ where: { id: commitment.id } })
    expect(current?.status).toBe('fulfilled') // NOT 'failed' (A's stale write)
    expect(current?.deliveredKw).toBe('95') // B's result, not A's
    expect(current?.fulfillmentPct).toBe('95')
  })

  it('stale evaluator failure revert also fenced (0 rows after reclaim)', async () => {
    // Same test but for the failure-revert path: if A fails and tries to
    // revert evaluating→pending, but B already reclaimed, A's revert
    // must also affect 0 rows.
    const now = new Date()
    const start = new Date(now.getTime() + 3600000 * 220)
    const end = new Date(start.getTime() + 3600000 * 2)

    const program = await db.vppBuyerProgram.create({
      data: {
        tenantId,
        networkId,
        networkVersionId: versionId,
        name: `Fence Revert Program ${Date.now()}`,
        rewardRuleId: (await db.rewardRule.findFirst({ where: { networkVersionId: versionId } }))!.id,
        dispatchWindowStart: '00:00',
        dispatchWindowEnd: '23:59',
        pricePerKwh: '0.12',
        minCapacityKw: '1',
      },
    })

    // WORK-006 (BASE-007): VppDispatch requires executionId (1:1 FK to Execution).
    // Create the Execution record first, then link it.
    const execution = await db.execution.create({
      data: {
        tenantId,
        networkId,
        networkVersionId: versionId,
        requestedQuantity: '100',
        requestedUnit: 'kW',
        startTime: start,
        endTime: end,
        status: 'dispatching',
        sourceType: 'vpp_dispatch',
        sourceId: `vpp-2d-4-${Date.now()}`,
      },
    })
    const dispatch = await db.vppDispatch.create({
      data: {
        tenantId,
        programId: program.id,
        executionId: execution.id,
        requestedKw: '100',
        requestedKwh: '200',
        startTime: start,
        endTime: end,
        status: 'dispatching',
      },
    })

    const commitment = await db.vppPortfolioCommitment.create({
      data: {
        tenantId,
        dispatchId: dispatch.id,
        requestedKw: '100',
        requestedKwh: '200',
        confidenceLevel: '0.99',
        committedKw: '100',
        assignmentCount: 2,
      },
    })

    // A claims.
    const claimA = randomUUID()
    await db.vppPortfolioCommitment.updateMany({
      where: { id: commitment.id, status: 'pending' },
      data: {
        status: 'evaluating',
        evaluationClaimedAt: now,
        evaluationLeaseExpiresAt: new Date(Date.now() + 60000),
        evaluationClaimId: claimA,
      },
    })

    // Lease expires.
    await db.vppPortfolioCommitment.update({
      where: { id: commitment.id },
      data: { evaluationLeaseExpiresAt: new Date(Date.now() - 1000) },
    })

    // B reclaims.
    const claimB = randomUUID()
    await db.vppPortfolioCommitment.updateMany({
      where: { id: commitment.id, status: 'evaluating', evaluationLeaseExpiresAt: { lt: new Date() } },
      data: {
        evaluationClaimedAt: new Date(),
        evaluationLeaseExpiresAt: new Date(Date.now() + 60000),
        evaluationClaimId: claimB,
      },
    })

    // A attempts to revert (failure path) with stale token.
    const aStaleRevert = await db.vppPortfolioCommitment.updateMany({
      where: {
        id: commitment.id,
        status: 'evaluating',
        evaluationClaimId: claimA, // stale
      },
      data: {
        status: 'pending',
        evaluationClaimedAt: null,
        evaluationLeaseExpiresAt: null,
        evaluationClaimId: null,
      },
    })

    // A's stale revert affects 0 rows — B still owns the lease.
    expect(aStaleRevert.count).toBe(0)

    // B's claim is still active.
    const current = await db.vppPortfolioCommitment.findUnique({ where: { id: commitment.id } })
    expect(current?.status).toBe('evaluating')
    expect(current?.evaluationClaimId).toBe(claimB)
  })
})

// ---------------------------------------------------------------------------
// Event fencing: stale worker cannot mark event processed/dead_letter
// ---------------------------------------------------------------------------

describe('VPP-2D-4 fencing: DomainEvent stale-worker rejection (real DB)', () => {
  it('stale worker UPDATE affects 0 rows after event lease reclaim', async () => {
    // Create a retry event in 'pending' status.
    const event = await db.domainEvent.create({
      data: {
        tenantId,
        eventType: 'PortfolioEvaluationRetryRequested',
        aggregateId: 'test-commitment-fencing',
        version: 1,
        payloadJson: JSON.stringify({ dispatchId: 'test-dispatch', commitmentId: 'test-commitment' }),
        processed: false,
        processingStatus: 'pending',
      },
    })

    // Step 1: Worker A claims with token X.
    const claimA = randomUUID()
    const leaseA = new Date(Date.now() + 60000)
    await db.domainEvent.updateMany({
      where: { id: event.id, processingStatus: 'pending' },
      data: {
        processingStatus: 'processing',
        claimedAt: new Date(),
        leaseExpiresAt: leaseA,
        processingClaimId: claimA,
      },
    })

    // Verify A's claim.
    let current = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(current?.processingStatus).toBe('processing')
    expect(current?.processingClaimId).toBe(claimA)

    // Step 2: Lease expires.
    await db.domainEvent.update({
      where: { id: event.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    })

    // Step 3: Worker B reclaims with token Y.
    const claimB = randomUUID()
    const reclaimed = await db.domainEvent.updateMany({
      where: {
        id: event.id,
        processingStatus: 'processing',
        leaseExpiresAt: { lt: new Date() },
      },
      data: {
        claimedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60000),
        processingClaimId: claimB,
      },
    })
    expect(reclaimed.count).toBe(1) // B reclaimed

    // Verify B owns it.
    current = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(current?.processingClaimId).toBe(claimB)

    // Step 4: B marks the event as processed (with fencing on claimB).
    const bProcessed = await db.domainEvent.updateMany({
      where: {
        id: event.id,
        processingStatus: 'processing',
        processingClaimId: claimB, // B's fencing token
      },
      data: {
        processingStatus: 'processed',
        processed: true,
        claimedAt: null,
        leaseExpiresAt: null,
        processingClaimId: null,
      },
    })
    expect(bProcessed.count).toBe(1) // B's write succeeded

    // Step 5: A wakes up and attempts to mark processed (or dead_letter) with claimA.
    const aStaleWrite = await db.domainEvent.updateMany({
      where: {
        id: event.id,
        processingStatus: 'processing',
        processingClaimId: claimA, // A's stale token — no longer matches
      },
      data: {
        processingStatus: 'dead_letter', // A would dead-letter it
        processed: true,
        claimedAt: null,
        leaseExpiresAt: null,
        processingClaimId: null,
      },
    })

    // CRITICAL: A's stale write affects 0 rows.
    expect(aStaleWrite.count).toBe(0)

    // B's state remains authoritative.
    current = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(current?.processingStatus).toBe('processed') // NOT 'dead_letter'
    expect(current?.processed).toBe(true)
  })

  it('stale worker dead_letter attempt also fenced (0 rows after reclaim)', async () => {
    // Same test but for the dead_letter path: A tries to dead-letter,
    // but B already reclaimed and processed.
    const event = await db.domainEvent.create({
      data: {
        tenantId,
        eventType: 'PortfolioEvaluationRetryRequested',
        aggregateId: 'test-deadletter-fencing',
        version: 1,
        payloadJson: JSON.stringify({ dispatchId: 'test-dispatch-2', commitmentId: 'test-commitment-2' }),
        processed: false,
        processingStatus: 'pending',
      },
    })

    // A claims.
    const claimA = randomUUID()
    await db.domainEvent.updateMany({
      where: { id: event.id, processingStatus: 'pending' },
      data: {
        processingStatus: 'processing',
        claimedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60000),
        processingClaimId: claimA,
      },
    })

    // Lease expires.
    await db.domainEvent.update({
      where: { id: event.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    })

    // B reclaims.
    const claimB = randomUUID()
    await db.domainEvent.updateMany({
      where: { id: event.id, processingStatus: 'processing', leaseExpiresAt: { lt: new Date() } },
      data: {
        claimedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60000),
        processingClaimId: claimB,
      },
    })

    // A attempts dead_letter with stale token.
    const aStaleDeadLetter = await db.domainEvent.updateMany({
      where: {
        id: event.id,
        processingStatus: 'processing',
        processingClaimId: claimA, // stale
      },
      data: {
        processingStatus: 'dead_letter',
        processed: true,
        claimedAt: null,
        leaseExpiresAt: null,
        processingClaimId: null,
      },
    })

    // A's stale dead_letter affects 0 rows.
    expect(aStaleDeadLetter.count).toBe(0)

    // B still owns the event.
    const current = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(current?.processingStatus).toBe('processing')
    expect(current?.processingClaimId).toBe(claimB)
  })
})
