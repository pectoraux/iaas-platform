// =============================================================================
// Worker service — processes the outbox asynchronously (tasks 8, 10).
//
// Two queues:
//   1. Event outbox: picks up 'queued' events, runs verification, creates
//      attestations. (task 10)
//   2. Settlement outbox: picks up 'created' settlements, calls the payment
//      provider, finalizes the ledger. (task 8)
//
// In production this would be a BullMQ worker consuming Redis. For the MVP +
// Vercel serverless, the worker is triggered by:
//   - The client calling /api/internal/worker/process (after ingestion)
//   - A cron job (Vercel Cron)
//
// The worker functions are idempotent — if called multiple times, they skip
// already-processed items.
// =============================================================================

import { db } from '@/lib/db'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { emit, DomainEventTypes, markProcessed } from '@/lib/domain/events'
import { runVerification, type VerificationContext } from './verification.service'
import { getPublishedConfiguration, getNetworkVersionRecord } from './network.service'
import { createAttestationForEvent } from './attestation.service'
import { paymentsService } from './payments.service'
import { ensureOperatorAccount, postBalancedPosting } from './ledger.service'

// ---------------------------------------------------------------------------
// Event outbox worker (task 10)
// ---------------------------------------------------------------------------

/**
 * Process queued events: run verification + create attestations.
 * Returns the number of events processed.
 */
export async function processEventOutbox(tenantId?: string): Promise<{ processed: number; verified: number; rejected: number }> {
  const events = await db.event.findMany({
    where: { status: 'queued', ...(tenantId ? { tenantId } : {}) },
    take: 50,
    orderBy: { receivedAt: 'asc' },
    include: { device: { include: { credential: true } }, networkVersion: true },
  })

  let verified = 0
  let rejected = 0

  for (const event of events) {
    try {
      const configuration = await getPublishedConfiguration(event.networkVersionId)
      const versionRecord = await getNetworkVersionRecord(event.networkVersionId)

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
        configuration,
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

      await db.verificationResult.create({
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
      await db.event.update({ where: { id: event.id }, data: { status } })

      await appendAudit({
        tenantId: event.tenantId,
        eventType: AuditEvents.VerificationCompleted,
        resourceType: 'event',
        resourceId: event.id,
        metadata: { overall_status: verification.overall_status, checks: verification.checks.length },
      })
      await emit({
        event_type: DomainEventTypes.VerificationCompleted,
        aggregate_id: event.id,
        tenant_id: event.tenantId,
        version: 1,
        payload: { overall_status: verification.overall_status, confidence: verification.confidence },
      })

      if (verification.overall_status === 'verified') {
        await createAttestationForEvent(event.tenantId, event.id, configuration)
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
    take: 50,
  })
  for (const evt of unprocessed) {
    await markProcessed(evt.id)
  }

  return { processed: events.length, verified, rejected }
}

// ---------------------------------------------------------------------------
// Settlement outbox worker (task 8)
// ---------------------------------------------------------------------------

/**
 * Process 'created' settlements: call the payment provider + finalize ledger.
 * Returns the number of settlements processed.
 *
 * The settlement was already created (in CREATED state) by the API. This worker:
 *   1. Marks it SUBMITTED
 *   2. Calls the payment provider
 *   3. If completed: posts the settlement debit (balanced) + marks COMPLETED
 *   4. If failed: marks FAILED with reason
 */
export async function processSettlementOutbox(tenantId?: string): Promise<{ processed: number; completed: number; failed: number }> {
  const settlements = await db.settlement.findMany({
    where: { status: 'created', ...(tenantId ? { tenantId } : {}) },
    take: 50,
    orderBy: { createdAt: 'asc' },
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
        amount: settlement.amount,
        currency: settlement.currency,
        reference: `reward:${settlement.rewardId}`,
      })

      if (payout.status === 'completed') {
        // Post the balanced settlement debit (task 7: double-entry).
        // Debit operator_payable, Credit cash. Sum = 0.
        await postSettlementDebit(settlement)

        await db.settlement.update({
          where: { id: settlement.id },
          data: {
            status: 'completed',
            providerPayoutId: payout.provider_payout_id,
          },
        })
        await db.reward.update({ where: { id: settlement.rewardId }, data: { status: 'settled' } })

        await appendAudit({
          tenantId: settlement.tenantId,
          eventType: AuditEvents.SettlementCompleted,
          resourceType: 'settlement',
          resourceId: settlement.id,
          metadata: { rewardId: settlement.rewardId, amount: settlement.amount },
        })
        await emit({
          event_type: DomainEventTypes.SettlementCompleted,
          aggregate_id: settlement.id,
          tenant_id: settlement.tenantId,
          version: 1,
          payload: { rewardId: settlement.rewardId, amount: settlement.amount },
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
 * Post the settlement debit as a balanced double-entry posting (task 7).
 *   operator_payable (liability): -amount  (debit: reduces what we owe)
 *   cash (asset):                 +amount  (credit: reduces our cash)
 *   Sum = 0 ✓
 */
async function postSettlementDebit(settlement: { tenantId: string; operatorId: string; amount: number; currency: string; rewardId: string; id: string; idempotencyKey: string | null }) {
  const payableAccount = await ensureOperatorAccount(settlement.tenantId, settlement.operatorId, settlement.currency, 'liability')
  const cashAccount = await ensurePlatformAccount(settlement.tenantId, settlement.currency, 'asset')

  const idemKey = `${settlement.idempotencyKey}:settlement_debit`
  await postBalancedPosting({
    tenantId: settlement.tenantId,
    idempotencyKey: idemKey,
    postingType: 'settlement',
    referenceType: 'settlement',
    referenceId: settlement.id,
    entries: [
      {
        accountId: payableAccount.id,
        amount: -settlement.amount, // debit: reduces liability
        entryType: 'settlement_debit',
      },
      {
        accountId: cashAccount.id,
        amount: settlement.amount, // credit: reduces cash
        entryType: 'settlement_credit',
      },
    ],
  })
}

// Re-export for seed script
export { ensureOperatorAccount }
import { ensurePlatformAccount } from './ledger.service'
