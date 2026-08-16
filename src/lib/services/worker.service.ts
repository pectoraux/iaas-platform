// =============================================================================
// Worker service — processes the outbox asynchronously (tasks 2, 8, 10).
//
// Task 2: ATOMIC CLAIMING. Workers use `FOR UPDATE SKIP LOCKED` to atomically
// claim events/settlements. Two workers can NEVER process the same object.
// Each claim gets a lease (5 min); if the worker crashes, the lease expires
// and another worker can reclaim.
//
// Two queues:
//   1. Event outbox: queued → claiming → (verify) → verified | rejected
//   2. Settlement outbox: created → claiming → (pay) → completed | failed
// =============================================================================

import { db } from '@/lib/db'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { emit, DomainEventTypes, markProcessed } from '@/lib/domain/events'
import { runVerification, type VerificationContext } from './verification.service'
import { getPublishedConfiguration, getNetworkVersionRecord } from './network.service'
import { createAttestationForEvent } from './attestation.service'
import { paymentsService } from './payments.service'
import { ensureOperatorAccount, ensurePlatformAccount, postBalancedPosting, computeBalance } from './ledger.service'
import { Prisma } from '@prisma/client'
import { supportsRowLocking } from '@/lib/kernel/db/provider'

const LEASE_DURATION_MINUTES = 5
const BATCH_SIZE = 50

/**
 * Compute the lease expiry timestamp (now + LEASE_DURATION_MINUTES).
 * Centralised so both the postgres and sqlite claiming paths agree.
 */
function computeLeaseExpiry(): Date {
  return new Date(Date.now() + LEASE_DURATION_MINUTES * 60_000)
}

// ---------------------------------------------------------------------------
// Event outbox worker (tasks 2, 10)
// ---------------------------------------------------------------------------

/**
 * Atomically claim queued events using FOR UPDATE SKIP LOCKED (task 2).
 * Two concurrent workers will NEVER claim the same event.
 *
 * Also reclaims stale 'processing' events whose lease has expired (crash recovery).
 */
async function claimEvents(tenantId?: string): Promise<string[]> {
  if (supportsRowLocking()) {
    // PostgreSQL: atomic UPDATE ... FOR UPDATE SKIP LOCKED ... RETURNING.
    const tenantFilter = tenantId ? Prisma.sql`AND "tenantId" = ${tenantId}` : Prisma.empty
    const result = await db.$queryRaw<Array<{ id: string }>>`
      UPDATE "Event"
      SET status = 'processing',
          "claimedAt" = NOW(),
          "leaseExpiresAt" = NOW() + INTERVAL '${Prisma.raw(String(LEASE_DURATION_MINUTES))} minutes'
      WHERE id IN (
        SELECT id FROM "Event"
        WHERE (status = 'queued'
               OR (status = 'processing' AND "leaseExpiresAt" < NOW()))
              ${tenantFilter}
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `
    return result.map((r) => r.id)
  }

  // SQLite fallback: find eligible events, then atomically claim each via
  // updateMany CAS (status + lease check). A transaction serializes the
  // find + claim so two concurrent workers cannot claim the same row.
  return db.$transaction(async (tx) => {
    const eligible = await tx.event.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        OR: [
          { status: 'queued' },
          { status: 'processing', leaseExpiresAt: { lt: new Date() } },
        ],
      },
      select: { id: true, status: true, leaseExpiresAt: true },
      take: BATCH_SIZE,
    })
    const now = new Date()
    const lease = computeLeaseExpiry()
    const claimed: string[] = []
    for (const ev of eligible) {
      // CAS: only claim if still in the expected pre-claim state.
      const cas = await tx.event.updateMany({
        where: {
          id: ev.id,
          OR: [
            { status: 'queued' },
            { status: 'processing', leaseExpiresAt: { lt: now } },
          ],
        },
        data: {
          status: 'processing',
          claimedAt: now,
          leaseExpiresAt: lease,
        },
      })
      if (cas.count > 0) claimed.push(ev.id)
    }
    return claimed
  })
}

/**
 * Process queued events: run verification + create attestations.
 * Returns the number of events processed.
 */
export async function processEventOutbox(tenantId?: string): Promise<{ processed: number; verified: number; rejected: number }> {
  // Task 2: atomically claim events.
  const claimedIds = await claimEvents(tenantId)
  if (claimedIds.length === 0) {
    return { processed: 0, verified: 0, rejected: 0 }
  }

  const events = await db.event.findMany({
    where: { id: { in: claimedIds } },
    include: { device: { include: { credential: true } }, networkVersion: true },
  })

  let verified = 0
  let rejected = 0

  for (const event of events) {
    try {
      const configuration = await getPublishedConfiguration(event.networkVersionId)
      const versionRecord = await getNetworkVersionRecord(event.networkVersionId)

      // Issue 1: use the event's EXPLICIT capabilityType — NO fallback to
      // capabilities[0]. An event without capabilityType is malformed and
      // must be rejected, not silently assigned the first capability.
      const capabilityType = event.capabilityType
      if (!capabilityType) {
        // Mark as failed — this event was ingested before the fix or is malformed.
        await db.event.update({ where: { id: event.id }, data: { status: 'failed' } })
        await appendAudit({
          tenantId: event.tenantId,
          eventType: 'verification.completed',
          resourceType: 'event',
          resourceId: event.id,
          metadata: { error: 'Event has no explicit capabilityType — rejected as malformed' },
        })
        rejected++
        continue
      }
      const specificCapability = configuration.capabilities.find((c) => c.type === capabilityType)
      if (!specificCapability) {
        // The event's capabilityType doesn't match any capability in the network config.
        await db.event.update({ where: { id: event.id }, data: { status: 'rejected' } })
        await db.verificationResult.create({
          data: {
            tenantId: event.tenantId,
            eventId: event.id,
            policyVersion: versionRecord.version,
            verifierVersion: '1.1.0',
            checksJson: JSON.stringify([{ name: 'capability_resolution', status: 'fail', detail: `capabilityType ${capabilityType} not found in network configuration` }]),
            overallStatus: 'rejected',
            risk: 1,
            confidence: 0,
          },
        })
        rejected++
        continue
      }

      const ctx: VerificationContext = {
        tenantId: event.tenantId,
        event: {
          id: event.id,
          deviceId: event.deviceId,
          externalEventId: event.externalEventId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          sequence: event.sequence,
          payloadJson: event.payloadJson,
          signature: event.signature,
        },
        device: {
          id: event.deviceId!,
          credential: event.device?.credential
            ? { verificationKey: event.device.credential.verificationKey, status: event.device.credential.status }
            : null,
        },
        configuration: {
          ...configuration,
          // Override capabilities with ONLY the specific one — verification
          // validates against this asset's assigned capability, not the first.
          capabilities: specificCapability ? [specificCapability] : configuration.capabilities,
        },
        networkVersion: { id: event.networkVersionId, version: versionRecord.version },
        raw: {
          device_id: event.deviceId!,
          event_id: event.externalEventId!,
          timestamp: event.occurredAt.toISOString(),
          event_type: event.eventType,
          sequence: event.sequence ?? undefined,
          payload: JSON.parse(event.payloadJson),
          signature: event.signature ?? undefined,
        },
      }

      const verification = await runVerification(ctx)

      // ATOMIC (task 1): create verification result + update event status +
      // emit outbox — all in the same transaction.
      await db.$transaction(async (tx) => {
        await tx.verificationResult.create({
          data: {
            tenantId: event.tenantId,
            eventId: event.id,
            policyVersion: verification.policy_version,
            verifierVersion: verification.verifier_version,
            checksJson: JSON.stringify(verification.checks),
            overallStatus: verification.overall_status,
            risk: verification.risk,
            confidence: verification.confidence,
          },
        })

        const status = verification.overall_status === 'verified' ? 'verified' : 'rejected'
        await tx.event.update({ where: { id: event.id }, data: { status } })

        await emit(
          {
            event_type: DomainEventTypes.VerificationCompleted,
            aggregate_id: event.id,
            tenant_id: event.tenantId,
            version: 1,
            payload: { overall_status: verification.overall_status, confidence: verification.confidence },
          },
          tx,
        )
      })

      // Audit + attestation (outside the transaction — best-effort side effects).
      await appendAudit({
        tenantId: event.tenantId,
        eventType: AuditEvents.VerificationCompleted,
        resourceType: 'event',
        resourceId: event.id,
        metadata: { overall_status: verification.overall_status, checks: verification.checks.length },
      })

      if (verification.overall_status === 'verified') {
        await createAttestationForEvent(event.tenantId, event.id, configuration, capabilityType)
        verified++
      } else {
        rejected++
      }
    } catch (err) {
      console.error(`[worker] event ${event.id} failed:`, err)
      await db.event.update({ where: { id: event.id }, data: { status: 'failed' } })
      rejected++
    }
  }

  // Mark the domain events as processed.
  const unprocessed = await db.domainEvent.findMany({
    where: { processed: false, eventType: DomainEventTypes.DeviceEventAccepted, ...(tenantId ? { tenantId } : {}) },
    take: BATCH_SIZE,
  })
  for (const evt of unprocessed) {
    await markProcessed(evt.id)
  }

  return { processed: events.length, verified, rejected }
}

// ---------------------------------------------------------------------------
// Settlement outbox worker (tasks 2, 8)
// ---------------------------------------------------------------------------

/**
 * Atomically claim 'created' settlements using FOR UPDATE SKIP LOCKED (task 2).
 */
async function claimSettlements(tenantId?: string): Promise<string[]> {
  if (supportsRowLocking()) {
    const tenantFilter = tenantId ? Prisma.sql`AND "tenantId" = ${tenantId}` : Prisma.empty
    const result = await db.$queryRaw<Array<{ id: string }>>`
      UPDATE "Settlement"
      SET status = 'claiming',
          "claimedAt" = NOW(),
          "leaseExpiresAt" = NOW() + INTERVAL '${Prisma.raw(String(LEASE_DURATION_MINUTES))} minutes'
      WHERE id IN (
        SELECT id FROM "Settlement"
        WHERE (status = 'created'
               OR (status = 'claiming' AND "leaseExpiresAt" < NOW()))
              ${tenantFilter}
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `
    return result.map((r) => r.id)
  }

  // SQLite fallback: find + CAS claim (same pattern as claimEvents).
  return db.$transaction(async (tx) => {
    const eligible = await tx.settlement.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        OR: [
          { status: 'created' },
          { status: 'claiming', leaseExpiresAt: { lt: new Date() } },
        ],
      },
      select: { id: true, status: true, leaseExpiresAt: true },
      take: BATCH_SIZE,
    })
    const now = new Date()
    const lease = computeLeaseExpiry()
    const claimed: string[] = []
    for (const st of eligible) {
      const cas = await tx.settlement.updateMany({
        where: {
          id: st.id,
          OR: [
            { status: 'created' },
            { status: 'claiming', leaseExpiresAt: { lt: now } },
          ],
        },
        data: {
          status: 'claiming',
          claimedAt: now,
          leaseExpiresAt: lease,
        },
      })
      if (cas.count > 0) claimed.push(st.id)
    }
    return claimed
  })
}

/**
 * Process 'created' settlements by delegating to the canonical
 * processSettlementForReward(). This is the batch entry point — it finds
 * eligible settlements and processes each through the same lease-safe,
 * targeted settlement engine used by the VPP execution path.
 */
export async function processSettlementOutbox(tenantId?: string): Promise<{ processed: number; completed: number; failed: number }> {
  // Find settlements that need processing (created/failed/retrying or expired lease).
  const eligible = await db.settlement.findMany({
    where: {
      ...(tenantId ? { tenantId } : {}),
      OR: [
        { status: { in: ['created', 'failed', 'retrying'] } },
        { status: { in: ['submitted', 'processing'] }, leaseExpiresAt: { lt: new Date() } },
      ],
    },
    select: { rewardId: true, tenantId: true },
    take: BATCH_SIZE,
  })

  let completed = 0
  let failed = 0

  for (const { rewardId, tenantId: stTenantId } of eligible) {
    const result = await processSettlementForReward(stTenantId, rewardId)
    if (result.completed) {
      completed++
    } else {
      failed++
    }
  }

  return { processed: eligible.length, completed, failed }
}

/**
 * Process a single specific settlement by reward ID.
 * Used by reconciliation to target a specific assignment's settlement
 * rather than processing the entire tenant's settlement outbox.
 *
 * LEASE-BASED CLAIMING:
 * - Claims created/failed/retrying settlements atomically with a lease.
 * - A submitted/processing settlement with a LIVE lease is NOT reclaimable.
 * - A submitted/processing settlement with an EXPIRED lease IS reclaimable
 *   (worker crashed before completing the provider call).
 * - This prevents both double-payouts AND permanent underpayments.
 */
export async function processSettlementForReward(tenantId: string, rewardId: string): Promise<{ completed: boolean; settlementId: string | null }> {
  const settlement = await db.settlement.findUnique({
    where: { rewardId },
    include: { reward: { include: { contribution: true, operator: true } } },
  })
  if (!settlement) return { completed: false, settlementId: null }
  if (settlement.status === 'completed') return { completed: true, settlementId: settlement.id }
  if (settlement.tenantId !== tenantId) return { completed: false, settlementId: settlement.id }

  const LEASE_DURATION_MS = 60_000 // 60 seconds — enough for a provider call

  try {
    // Determine if this settlement is claimable.
    const claimable = ['created', 'failed', 'retrying']
    const leaseExpired = settlement.leaseExpiresAt && settlement.leaseExpiresAt < new Date()

    if (!claimable.includes(settlement.status) && !leaseExpired) {
      // submitted/processing with a live lease — another worker is handling it.
      return { completed: false, settlementId: settlement.id }
    }

    // Atomic claim with lease.
    // If the status is claimable OR the lease has expired, we can claim.
    const claimCondition = claimable.includes(settlement.status)
      ? { id: settlement.id, status: { in: claimable } }
      : { id: settlement.id, status: { in: ['submitted', 'processing'] }, leaseExpiresAt: { lt: new Date() } }

    const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS)
    const claimed = await db.settlement.updateMany({
      where: claimCondition,
      data: { status: 'submitted', claimedAt: new Date(), leaseExpiresAt },
    })
    if (claimed.count === 0) {
      // Another worker just claimed it, or it was completed.
      const current = await db.settlement.findUnique({ where: { id: settlement.id } })
      return { completed: current?.status === 'completed', settlementId: settlement.id }
    }

    // We own the lease. Call the payment provider.
    const payout = await paymentsService.create_payout({
      idempotency_key: settlement.idempotencyKey!,
      recipient_ref: settlement.operatorId,
      amount: settlement.amount.toString(),
      currency: settlement.currency,
      reference: `reward:${settlement.rewardId}`,
    })

    if (payout.status === 'completed') {
      await db.$transaction(async (tx) => {
        // Pass tx to ensure accounts are created within the transaction.
        const payableAccount = await ensureOperatorAccount(settlement.tenantId, settlement.operatorId, settlement.currency, 'liability', tx)
        const cashAccount = await ensurePlatformAccount(settlement.tenantId, settlement.currency, 'asset', tx)
        const debitKey = `${settlement.idempotencyKey}:settlement_debit`

        const existingPosting = await tx.ledgerPosting.findUnique({
          where: { tenantId_idempotencyKey: { tenantId: settlement.tenantId, idempotencyKey: debitKey } },
        })
        if (!existingPosting) {
          const post = await tx.ledgerPosting.create({
            data: {
              tenantId: settlement.tenantId,
              postingType: 'settlement',
              referenceType: 'settlement',
              referenceId: settlement.id,
              idempotencyKey: debitKey,
            },
          })
          await tx.ledgerEntry.create({
            data: {
              tenantId: settlement.tenantId, postingId: post.id, accountId: payableAccount.id,
              amount: new Prisma.Decimal(settlement.amount).negated(),
              currency: settlement.currency, entryType: 'settlement_debit',
            },
          })
          await tx.ledgerEntry.create({
            data: {
              tenantId: settlement.tenantId, postingId: post.id, accountId: cashAccount.id,
              amount: new Prisma.Decimal(settlement.amount),
              currency: settlement.currency, entryType: 'settlement_credit',
            },
          })
        }

        await tx.settlement.update({
          where: { id: settlement.id },
          data: { status: 'completed', providerPayoutId: payout.provider_payout_id },
        })
        await tx.reward.update({ where: { id: settlement.rewardId }, data: { status: 'settled' } })
        await emit(
          {
            event_type: DomainEventTypes.SettlementCompleted,
            aggregate_id: settlement.id,
            tenant_id: settlement.tenantId,
            version: 1,
            payload: { rewardId: settlement.rewardId, amount: settlement.amount.toString() },
          },
          tx,
        )
      })

      await appendAudit({
        tenantId: settlement.tenantId,
        eventType: AuditEvents.SettlementCompleted,
        resourceType: 'settlement',
        resourceId: settlement.id,
        metadata: { rewardId: settlement.rewardId, amount: settlement.amount.toString() },
      })
      return { completed: true, settlementId: settlement.id }
    } else {
      // Provider returned non-completed (processing/submitted).
      // Keep the lease active — the provider is still processing.
      // The lease will expire if this worker crashes, allowing recovery.
      await db.settlement.update({
        where: { id: settlement.id },
        data: { status: payout.status as 'processing' | 'submitted', providerPayoutId: payout.provider_payout_id },
      })
      return { completed: false, settlementId: settlement.id }
    }
  } catch (err) {
    // Provider call failed (exception). Clear the lease and mark as failed
    // so it can be reclaimed by another worker or reconciliation.
    const reason = err instanceof Error ? err.message : 'Unknown error'
    await db.settlement.update({
      where: { id: settlement.id },
      data: { status: 'failed', failureReason: reason, leaseExpiresAt: new Date() },
    })
    return { completed: false, settlementId: settlement.id }
  }
}

export { ensureOperatorAccount, computeBalance }

// ---------------------------------------------------------------------------
// VPP-2D-4: Portfolio evaluation retry worker
// ---------------------------------------------------------------------------

/**
 * Process portfolio evaluation retry events from the outbox.
 *
 * This is the PRIMARY retry mechanism. It consumes actual DomainEvent rows
 * of type PortfolioEvaluationRetryRequested — NOT a broad database sweep.
 *
 * For each event:
 *   1. Claim the event (atomic updateMany: processed=false → true, scoped
 *      by event ID — NOT a bulk tenant-wide update).
 *   2. Read the payload (commitmentId, dispatchId, tenantId).
 *   3. Evaluate THAT specific commitment.
 *   4. If successful, the event stays marked processed.
 *   5. If evaluation fails again, revert the event to unprocessed (so the
 *      next worker run retries) and emit a new retry event.
 *
 * Two workers must never process the same retry event concurrently. The
 * atomic claim (processed=false → true by event ID) ensures this.
 */
export async function processPortfolioEvaluationRetries(
  tenantId?: string,
): Promise<{ processed: number; completed: number; failed: number }> {
  const EVENT_LEASE_MS = 60000 // 60 seconds — same as commitment evaluation lease
  const now = new Date()
  const { randomUUID } = await import('crypto')

  // Find claimable events: pending OR (processing with expired lease).
  const events = await db.domainEvent.findMany({
    where: {
      eventType: 'PortfolioEvaluationRetryRequested',
      ...(tenantId ? { tenantId } : {}),
      OR: [
        { processingStatus: 'pending' },
        {
          processingStatus: 'processing',
          leaseExpiresAt: { lt: now },
        },
      ],
    },
    select: { id: true, tenantId: true, payloadJson: true, processingStatus: true },
    take: BATCH_SIZE,
  })

  let completed = 0
  let failed = 0

  for (const event of events) {
    const leaseExpiry = new Date(Date.now() + EVENT_LEASE_MS)
    const eventClaimId = randomUUID() // fencing token

    // Claim this specific event (atomic CAS: pending→processing OR
    // processing(expired)→processing(new lease + new fencing token)).
    const claimed = await db.domainEvent.updateMany({
      where: {
        id: event.id,
        OR: [
          { processingStatus: 'pending' },
          { processingStatus: 'processing', leaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        processingStatus: 'processing',
        claimedAt: now,
        leaseExpiresAt: leaseExpiry,
        processingClaimId: eventClaimId,
      },
    })

    if (claimed.count === 0) {
      // Another worker already claimed this event. Skip.
      continue
    }

    // Parse the event payload to get the commitment + dispatch IDs.
    let payload: { commitmentId?: string; dispatchId?: string }
    try {
      payload = JSON.parse(event.payloadJson) as { commitmentId?: string; dispatchId?: string }
    } catch {
      // Malformed JSON — mark as dead_letter with fencing. Clear lease fields.
      await db.domainEvent.updateMany({
        where: { id: event.id, processingStatus: 'processing', processingClaimId: eventClaimId },
        data: {
          processingStatus: 'dead_letter',
          processed: true,
          claimedAt: null,
          leaseExpiresAt: null,
          processingClaimId: null,
        },
      }).catch(() => {})
      failed++
      continue
    }

    if (!payload.dispatchId) {
      // Malformed event — mark as dead_letter with fencing. Clear lease fields.
      await db.domainEvent.updateMany({
        where: { id: event.id, processingStatus: 'processing', processingClaimId: eventClaimId },
        data: {
          processingStatus: 'dead_letter',
          processed: true,
          claimedAt: null,
          leaseExpiresAt: null,
          processingClaimId: null,
        },
      }).catch(() => {})
      failed++
      continue
    }

    try {
      const { evaluatePortfolioCommitment } = await import('./portfolio-commitment.service')
      const result = await evaluatePortfolioCommitment(event.tenantId, payload.dispatchId)

      if (result.evaluationOutcome === 'final' || result.evaluationOutcome === 'already_final') {
        // Success — mark processed with fencing. Clear lease fields.
        await db.domainEvent.updateMany({
          where: { id: event.id, processingStatus: 'processing', processingClaimId: eventClaimId },
          data: {
            processingStatus: 'processed',
            processed: true,
            claimedAt: null,
            leaseExpiresAt: null,
            processingClaimId: null,
          },
        }).catch(() => {})
        completed++
      } else {
        // Still pending or evaluating — consumed but not final. Clear lease fields.
        await db.domainEvent.updateMany({
          where: { id: event.id, processingStatus: 'processing', processingClaimId: eventClaimId },
          data: {
            processingStatus: 'processed',
            processed: true,
            claimedAt: null,
            leaseExpiresAt: null,
            processingClaimId: null,
          },
        }).catch(() => {})
        failed++
      }
    } catch {
      // Evaluation failed again. Mark processed with fencing. Clear lease fields.
      await db.domainEvent.updateMany({
        where: { id: event.id, processingStatus: 'processing', processingClaimId: eventClaimId },
        data: {
          processingStatus: 'processed',
          processed: true,
          claimedAt: null,
          leaseExpiresAt: null,
          processingClaimId: null,
        },
      }).catch(() => {})
      failed++
    }
  }

  return { processed: events.length, completed, failed }
}

/**
 * Fallback safety-net sweep: find commitments stuck in 'pending' or
 * 'evaluating' (with expired lease) with all assignments terminal,
 * and retry evaluation.
 *
 * LEASE-AWARE: Only reclaims 'evaluating' commitments whose lease has
 * expired. Does NOT reclaim active evaluations.
 *
 * This is SEPARATE from processPortfolioEvaluationRetries (which consumes
 * outbox events). This sweep handles edge cases:
 *   - The original evaluator crashed before emitting a retry event.
 *   - The outbox event was lost (DB corruption, operational error).
 *   - The commitment is stuck in 'evaluating' (crashed evaluator, expired lease).
 *
 * This should be called periodically (e.g., every few minutes) as a
 * repair mechanism, not as the primary retry path.
 */
export async function recoverStuckPortfolioEvaluations(
  tenantId?: string,
): Promise<{ recovered: number; completed: number; failed: number }> {
  const now = new Date()

  // Find commitments that need evaluation:
  //   - status='pending' with all-terminal assignments (never evaluated)
  //   - status='evaluating' with expired lease (crashed evaluator)
  const stuckCommitments = await db.vppPortfolioCommitment.findMany({
    where: {
      ...(tenantId ? { tenantId } : {}),
      dispatch: {
        assignments: {
          every: {
            status: { in: ['completed', 'failed', 'reconciliation_required'] },
          },
        },
      },
      OR: [
        { status: 'pending' },
        {
          status: 'evaluating',
          evaluationLeaseExpiresAt: { lt: now },
        },
      ],
    },
    select: { id: true, dispatchId: true, tenantId: true, status: true },
    take: BATCH_SIZE,
  })

  let completed = 0
  let failed = 0

  for (const { id, dispatchId, tenantId: ctTenantId, status } of stuckCommitments) {
    // If the commitment is stuck in 'evaluating' with an expired lease,
    // revert to 'pending' first so the evaluation CAS can claim it.
    if (status === 'evaluating') {
      const reverted = await db.vppPortfolioCommitment.updateMany({
        where: {
          id,
          status: 'evaluating',
          evaluationLeaseExpiresAt: { lt: now },
        },
        data: {
          status: 'pending',
          evaluationClaimedAt: null,
          evaluationLeaseExpiresAt: null,
        },
      }).catch(() => ({ count: 0 }))

      if (reverted.count === 0) {
        // Another reclaimer won or the lease was renewed. Skip.
        failed++
        continue
      }
    }

    try {
      const { evaluatePortfolioCommitment } = await import('./portfolio-commitment.service')
      const result = await evaluatePortfolioCommitment(ctTenantId, dispatchId)
      if (result.evaluationOutcome === 'final' || result.evaluationOutcome === 'already_final') {
        completed++
      } else {
        failed++
      }
    } catch {
      // Evaluation failed again — evaluatePortfolioCommitment has already
      // emitted a new retry event. The next worker run will handle it.
      failed++
    }
  }

  return { recovered: stuckCommitments.length, completed, failed }
}
