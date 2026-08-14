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

const LEASE_DURATION_MINUTES = 5
const BATCH_SIZE = 50

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
  // Raw SQL: atomically transition queued/expired-lease events to 'processing'
  // with a lease. FOR UPDATE SKIP LOCKED ensures no two workers claim the same row.
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

/**
 * Process 'created' settlements: call the payment provider + finalize ledger.
 * Returns the number of settlements processed.
 */
export async function processSettlementOutbox(tenantId?: string): Promise<{ processed: number; completed: number; failed: number }> {
  // Task 2: atomically claim settlements.
  const claimedIds = await claimSettlements(tenantId)
  if (claimedIds.length === 0) {
    return { processed: 0, completed: 0, failed: 0 }
  }

  const settlements = await db.settlement.findMany({
    where: { id: { in: claimedIds } },
    include: { reward: { include: { contribution: true, operator: true } } },
  })

  let completed = 0
  let failed = 0

  for (const settlement of settlements) {
    try {
      await db.settlement.update({ where: { id: settlement.id }, data: { status: 'submitted' } })

      const payout = await paymentsService.create_payout({
        idempotency_key: settlement.idempotencyKey!,
        recipient_ref: settlement.operatorId,
        amount: settlement.amount.toString(), // PRECISION: string, not JS number
        currency: settlement.currency,
        reference: `reward:${settlement.rewardId}`,
      })

      if (payout.status === 'completed') {
        // Issue 4: atomic settlement completion — status update + reward update
        // + settlement debit posting + outbox emit all in ONE transaction.
        // If any part fails, the entire completion rolls back.
        await db.$transaction(async (tx) => {
          // Post the settlement debit (balanced double-entry).
          const payableAccount = await ensureOperatorAccount(settlement.tenantId, settlement.operatorId, settlement.currency, 'liability')
          const cashAccount = await ensurePlatformAccount(settlement.tenantId, settlement.currency, 'asset')
          const debitKey = `${settlement.idempotencyKey}:settlement_debit`

          // Idempotency check for the posting.
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

          // Update settlement status.
          await tx.settlement.update({
            where: { id: settlement.id },
            data: { status: 'completed', providerPayoutId: payout.provider_payout_id },
          })

          // Update reward status.
          await tx.reward.update({ where: { id: settlement.rewardId }, data: { status: 'settled' } })

          // Emit outbox in the same transaction.
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
        completed++
      } else {
        await db.settlement.update({
          where: { id: settlement.id },
          data: {
            status: payout.status as 'processing' | 'submitted',
            providerPayoutId: payout.provider_payout_id,
          },
        })
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown error'
      await db.settlement.update({
        where: { id: settlement.id },
        data: { status: 'failed', failureReason: reason },
      })
      await appendAudit({
        tenantId: settlement.tenantId,
        eventType: 'settlement.failed',
        resourceType: 'settlement',
        resourceId: settlement.id,
        metadata: { reason },
      })
      failed++
    }
  }

  return { processed: settlements.length, completed, failed }
}

/**
 * Process a single specific settlement by reward ID.
 * Used by reconciliation to target a specific assignment's settlement
 * rather than processing the entire tenant's settlement outbox.
 */
export async function processSettlementForReward(tenantId: string, rewardId: string): Promise<{ completed: boolean; settlementId: string | null }> {
  const settlement = await db.settlement.findUnique({
    where: { rewardId },
    include: { reward: { include: { contribution: true, operator: true } } },
  })
  if (!settlement) return { completed: false, settlementId: null }
  if (settlement.status === 'completed') return { completed: true, settlementId: settlement.id }
  if (settlement.tenantId !== tenantId) return { completed: false, settlementId: settlement.id }

  try {
    // Claim atomically: only created/failed/retrying are directly claimable.
    // A 'processing' settlement is NOT claimable — another worker is actively
    // talking to the payment provider. Reclaiming it would cause a double-payout.
    // (A lease-expiry mechanism could reclaim stale 'processing' settlements,
    // but for the MVP we simply skip them.)
    const claimable = ['created', 'failed', 'retrying']
    if (!claimable.includes(settlement.status)) {
      // submitted/processing — another worker may be handling it. Check if completed.
      const current = await db.settlement.findUnique({ where: { id: settlement.id } })
      return { completed: current?.status === 'completed', settlementId: settlement.id }
    }

    const claimed = await db.settlement.updateMany({
      where: { id: settlement.id, status: { in: claimable } },
      data: { status: 'submitted' },
    })
    if (claimed.count === 0) {
      const current = await db.settlement.findUnique({ where: { id: settlement.id } })
      return { completed: current?.status === 'completed', settlementId: settlement.id }
    }

    const payout = await paymentsService.create_payout({
      idempotency_key: settlement.idempotencyKey!,
      recipient_ref: settlement.operatorId,
      amount: settlement.amount.toString(),
      currency: settlement.currency,
      reference: `reward:${settlement.rewardId}`,
    })

    if (payout.status === 'completed') {
      await db.$transaction(async (tx) => {
        const payableAccount = await ensureOperatorAccount(settlement.tenantId, settlement.operatorId, settlement.currency, 'liability')
        const cashAccount = await ensurePlatformAccount(settlement.tenantId, settlement.currency, 'asset')
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
      await db.settlement.update({
        where: { id: settlement.id },
        data: { status: payout.status as 'processing' | 'submitted', providerPayoutId: payout.provider_payout_id },
      })
      return { completed: false, settlementId: settlement.id }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Unknown error'
    await db.settlement.update({
      where: { id: settlement.id },
      data: { status: 'failed', failureReason: reason },
    })
    return { completed: false, settlementId: settlement.id }
  }
}

export { ensureOperatorAccount, computeBalance }
