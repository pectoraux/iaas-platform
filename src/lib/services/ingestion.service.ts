// =============================================================================
// Ingestion service — ASYNC + ATOMIC OUTBOX (tasks 1, 4, 10).
//
// POST /v1/ingest/events
//   - device authentication (resolve credential)
//   - tenant resolution (session)
//   - network membership resolution (task 4: explicit capability binding)
//   - timestamp validation
//   - sequence/replay protection (unique constraint on externalEventId)
//   - enqueue for ASYNCHRONOUS verification via outbox
//
// Task 1: the Event row + DomainEvent outbox row are created in the SAME
// database transaction. If either fails, both roll back — no orphaned events,
// no missing outbox rows.
//
// Task 4: the event's `capabilityType` is resolved from the asset's network
// assignment at ingest time. Verification validates against this specific
// capability's schema, NOT capabilities[0].
// =============================================================================

import { db } from '@/lib/db'
import { ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { emit, DomainEventTypes } from '@/lib/domain/events'
import { resolveDeviceCredential, resolveAssetNetworkAssignment } from './registry.service'
import { getNetworkVersion } from './network.service'
import { canonicalEventMessage } from '@/lib/domain/crypto'

export interface IngestEventInput {
  device_id: string
  event_id: string
  timestamp: string
  event_type: string
  sequence?: number
  payload: Record<string, unknown>
  signature?: string
  network_version_id?: string
  capability_type?: string // issue 3: required when asset has multiple capabilities per network
}

export interface IngestResult {
  event_id: string
  external_event_id: string
  status: 'queued' | 'verified' | 'rejected'
  duplicate: boolean
  message: string
}

/**
 * Ingest a signed device event. Idempotent on (tenantId, event_id).
 *
 * The event is persisted with status='queued' and a domain event is emitted to
 * the outbox — both in the SAME transaction (task 1). Verification runs
 * asynchronously in the worker.
 */
export async function ingestEvent(
  tenantId: string,
  input: IngestEventInput,
  actorId?: string,
): Promise<IngestResult> {
  // ---- Basic validation ----
  if (!input.device_id) throw new ValidationError('device_id is required')
  if (!input.event_id) throw new ValidationError('event_id is required')
  if (!input.timestamp) throw new ValidationError('timestamp is required')
  if (!input.event_type) throw new ValidationError('event_type is required')
  const occurredAt = new Date(input.timestamp)
  if (Number.isNaN(occurredAt.getTime())) throw new ValidationError('Invalid timestamp')

  // ---- Device authentication + tenant scoping ----
  const device = await resolveDeviceCredential(tenantId, input.device_id)
  const asset = device.asset

  // ---- Network membership + capability resolution (issues 1, 3) ----
  // Resolve the network assignment + capability type for this asset.
  // Issue 1: capabilityType is REQUIRED — an event without an explicit
  // capability binding must fail, not silently fall back to capabilities[0].
  // Issue 3: an asset can have multiple capabilities per network; the caller
  // must specify capability_type when there's ambiguity.
  let networkVersionId: string | null = null
  let capabilityType: string | null = null

  if (input.network_version_id) {
    const version = await getNetworkVersion(tenantId, input.network_version_id)
    const assignment = await resolveAssetNetworkAssignment(
      tenantId, asset.id, version.networkId, input.capability_type,
    )
    networkVersionId = input.network_version_id
    capabilityType = assignment.capabilityType
  } else {
    const assignment = await resolveAssetNetworkAssignment(
      tenantId, asset.id, undefined, input.capability_type,
    )
    const network = await db.networkDefinition.findFirst({
      where: { id: assignment.networkId, tenantId, currentVersionId: { not: null } },
    })
    networkVersionId = network?.currentVersionId ?? null
    capabilityType = assignment.capabilityType
  }
  if (!networkVersionId) throw new ValidationError('Could not resolve a published network version for this asset')
  // Issue 1: capabilityType must never be null. Reject if missing.
  if (!capabilityType) {
    throw new ValidationError('Could not resolve capability type for this asset. Ensure the asset has an active network assignment with a capability.')
  }

  // ---- Replay/idempotency at ingest layer ----
  const existing = await db.event.findUnique({
    where: { tenantId_externalEventId: { tenantId, externalEventId: input.event_id } },
  })
  if (existing) {
    return {
      event_id: existing.id,
      external_event_id: existing.externalEventId!,
      status: existing.status as IngestResult['status'],
      duplicate: true,
      message: `Event already ingested (status: ${existing.status})`,
    }
  }

  // ---- ATOMIC: persist event + emit outbox in the SAME transaction (task 1) ----
  const event = await db.$transaction(async (tx) => {
    const created = await tx.event.create({
      data: {
        tenantId,
        networkVersionId,
        assetId: asset.id,
        deviceId: device.id,
        capabilityType, // task 4: explicit capability binding
        externalEventId: input.event_id,
        eventType: input.event_type,
        occurredAt,
        receivedAt: new Date(),
        sequence: input.sequence ?? null,
        payloadJson: JSON.stringify(input.payload ?? {}),
        schemaVersion: 1,
        status: 'queued',
        signature: input.signature ?? null,
      },
    })

    // Emit the outbox event IN THE SAME TRANSACTION (task 1).
    // If the transaction commits, both the event + outbox row are persisted.
    // If it rolls back, neither is — no orphaned events, no missing outbox rows.
    await emit(
      {
        event_type: DomainEventTypes.DeviceEventAccepted,
        aggregate_id: created.id,
        tenant_id: tenantId,
        version: 1,
        payload: { externalEventId: input.event_id, deviceId: device.id, capabilityType },
      },
      tx, // pass the transaction client
    )

    return created
  })

  // Audit is best-effort (outside the transaction — it's a side effect, not
  // part of the atomic operation).
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.EventReceived,
    resourceType: 'event',
    resourceId: event.id,
    metadata: { externalEventId: input.event_id, deviceId: device.id, eventType: input.event_type, capabilityType },
  })

  return {
    event_id: event.id,
    external_event_id: event.externalEventId!,
    status: 'queued',
    duplicate: false,
    message: 'Event queued for async verification. Poll GET /v1/events/:id for status.',
  }
}

/** Build a canonical message + sign it client-side (helper for tests/UI). */
export function buildCanonicalMessage(input: {
  device_id: string
  event_id: string
  timestamp: string
  event_type: string
  sequence?: number
  payload: unknown
}): string {
  return canonicalEventMessage(input)
}
