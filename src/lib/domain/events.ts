// =============================================================================
// Domain event bus (outbox pattern).
//
// Task 1 (atomic outbox): `emit` MUST be called inside the same database
// transaction as the main operation. This guarantees that if the main operation
// commits, the outbox row also commits — no orphaned events, no missing events.
//
// The transport is pluggable. For the MVP we use an in-process outbox table
// (DomainEvent) processed by the worker. The interface is designed so Redis/
// BullMQ or Kafka/Redpanda can replace the transport without changing domain
// logic — only the `dispatch`/`consume` adapters change.
// =============================================================================

import { db, type ExtendedPrismaClient, type ExtendedTransactionClient } from '@/lib/db'
import { randomUUID } from 'crypto'

export const DomainEventTypes = {
  DeviceEventAccepted: 'DeviceEventAccepted',
  VerificationCompleted: 'VerificationCompleted',
  AttestationCreated: 'AttestationCreated',
  ContributionCreated: 'ContributionCreated',
  RewardCalculated: 'RewardCalculated',
  LedgerEntryPosted: 'LedgerEntryPosted',
  SettlementRequested: 'SettlementRequested',
  SettlementCompleted: 'SettlementCompleted',
} as const

export type DomainEventType = (typeof DomainEventTypes)[keyof typeof DomainEventTypes]

export interface DomainEventPayload<T = Record<string, unknown>> {
  event_id: string
  event_type: DomainEventType | string
  aggregate_id: string
  tenant_id: string
  occurred_at: string
  version: number
  payload: T
}

/**
 * Append a domain event to the outbox.
 *
 * CRITICAL (task 1): pass a `tx` (transaction client) when calling this inside
 * a db.$transaction. This ensures the outbox row is committed atomically with
 * the main operation. If the transaction rolls back, the outbox row is also
 * rolled back — no orphaned events.
 */
export async function emit<T>(
  event: Omit<DomainEventPayload<T>, 'event_id' | 'occurred_at'>,
  tx?: ExtendedTransactionClient,
): Promise<DomainEventPayload<T>> {
  const client = tx ?? db
  const evt: DomainEventPayload<T> = {
    ...event,
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
  }
  await client.domainEvent.create({
    data: {
      tenantId: evt.tenant_id,
      eventType: evt.event_type,
      aggregateId: evt.aggregate_id,
      version: evt.version,
      payloadJson: JSON.stringify(evt.payload),
      processed: false,
    },
  })
  return evt
}

/** Mark an outbox event as processed. */
export async function markProcessed(id: string) {
  await db.domainEvent.update({ where: { id }, data: { processed: true } })
}
