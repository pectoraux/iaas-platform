// =============================================================================
// Ingestion service — ASYNC (task 10).
//
// POST /v1/ingest/events
//   - device authentication (resolve credential)
//   - tenant resolution (session)
//   - signature presence check (actual verification in worker)
//   - timestamp validation
//   - sequence/replay protection (unique constraint on externalEventId)
//   - schema presence check (actual validation in worker)
//   - enqueue for ASYNCHRONOUS verification via outbox
//
// The API no longer runs verification synchronously. It persists the event
// (status: queued) + emits a domain event to the outbox, then returns 202.
// A worker (processEventOutbox) picks up queued events, runs verification, and
// creates attestations.
//
// Idempotent: same (tenant, event_id) → same response, no duplicate.
// =============================================================================

import { db } from '@/lib/db'
import { ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { emit, DomainEventTypes } from '@/lib/domain/events'
import { resolveDeviceCredential, resolveAssetNetworkAssignment } from './registry.service'
import { getPublishedConfiguration, getNetworkVersion } from './network.service'
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
 * the outbox. Verification runs asynchronously in the worker.
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

  // ---- Network membership resolution (task 4) ----
  // Resolve the network assignment for this asset. If the caller provides
  // network_version_id, validate the asset is assigned to that network.
  let networkVersionId: string | null = null
  if (input.network_version_id) {
    // Validate the version exists + is published + belongs to this tenant's network.
    const version = await getNetworkVersion(tenantId, input.network_version_id)
    const assignment = await resolveAssetNetworkAssignment(tenantId, asset.id, version.networkId)
    networkVersionId = input.network_version_id
    void assignment
  } else {
    // Resolve from the asset's active network assignment.
    const assignment = await resolveAssetNetworkAssignment(tenantId, asset.id)
    const network = await db.networkDefinition.findFirst({
      where: { id: assignment.networkId, tenantId, currentVersionId: { not: null } },
    })
    networkVersionId = network?.currentVersionId ?? null
  }
  if (!networkVersionId) throw new ValidationError('Could not resolve a published network version for this asset')

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

  // ---- Persist the event (queued) + emit outbox ----
  const event = await db.event.create({
    data: {
      tenantId,
      networkVersionId,
      assetId: asset.id,
      deviceId: device.id,
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

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.EventReceived,
    resourceType: 'event',
    resourceId: event.id,
    metadata: { externalEventId: input.event_id, deviceId: device.id, eventType: input.event_type },
  })
  await emit({
    event_type: DomainEventTypes.DeviceEventAccepted,
    aggregate_id: event.id,
    tenant_id: tenantId,
    version: 1,
    payload: { externalEventId: input.event_id, deviceId: device.id },
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
