// =============================================================================
// Domain event bus (outbox pattern).
//
// The transport is pluggable. For the MVP we use an in-process outbox table
// (DomainEvent) processed synchronously by the worker. The interface is
// designed so Redis/BullMQ or Kafka/Redpanda can replace the transport without
// changing domain logic — only the `dispatch`/`consume` adapters change.
// =============================================================================

import { db } from '@/lib/db'
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

/** Append a domain event to the outbox. */
export async function emit<T>(event: Omit<DomainEventPayload<T>, 'event_id' | 'occurred_at'>) {
  const evt: DomainEventPayload<T> = {
    ...event,
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
  }
  await db.domainEvent.create({
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
