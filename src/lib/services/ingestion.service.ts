// =============================================================================
// Ingestion service.
//
// POST /v1/ingest/events
//   - device authentication (resolve credential)
//   - tenant resolution (header)
//   - signature validation (verification check, but auth happens here)
//   - timestamp validation
//   - sequence/replay protection (unique constraint on externalEventId)
//   - schema validation
//   - sanity checks
//   - enqueue for async verification (here: process synchronously in-process,
//     but structured so a real worker can pick it up)
//
// Idempotent: same (tenant, event_id) → same response, no duplicate.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { emit, DomainEventTypes } from '@/lib/domain/events'
import { resolveDeviceCredential } from './registry.service'
import { getPublishedConfiguration } from './network.service'
import { runVerification, type VerificationContext } from './verification.service'
import { createAttestationForEvent } from './attestation.service'
import { canonicalEventMessage } from '@/lib/domain/crypto'

export interface IngestEventInput {
  device_id: string
  event_id: string
  timestamp: string
  event_type: string
  sequence?: number
  payload: Record<string, unknown>
  signature?: string
  // Optional explicit scoping (not trusted by default; resolved via header).
  network_version_id?: string
  asset_id?: string
}

export interface IngestResult {
  event_id: string
  external_event_id: string
  status: 'verified' | 'rejected' | 'pending'
  verification: {
    overall_status: string
    checks: Array<{ name: string; status: string; detail?: string }>
    confidence: number
    risk: number
  } | null
  attestation_id: string | null
  duplicate: boolean
}

/**
 * Ingest a signed device event. Idempotent on (tenantId, event_id).
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
  // CRITICAL: device is resolved by id AND scoped to tenant. A device from
  // tenant A cannot ingest under tenant B.
  const device = await resolveDeviceCredential(tenantId, input.device_id)
  const asset = device.asset
  let networkVersionId: string | null = input.network_version_id ?? null
  if (!networkVersionId) {
    networkVersionId = await resolveNetworkVersionForAsset(tenantId, asset.id)
  }
  if (!networkVersionId) throw new ValidationError('Could not resolve network version for event')

  // ---- Replay/idempotency at ingest layer ----
  // (tenantId, externalEventId) is unique. If it exists, this is a replay.
  const existing = await db.event.findUnique({
    where: { tenantId_externalEventId: { tenantId, externalEventId: input.event_id } },
    include: { verification: true, attestations: true },
  })
  if (existing) {
    return {
      event_id: existing.id,
      external_event_id: existing.externalEventId!,
      status: existing.status as IngestResult['status'],
      verification: existing.verification
        ? {
            overall_status: existing.verification.overallStatus,
            checks: JSON.parse(existing.verification.checksJson),
            confidence: existing.verification.confidence,
            risk: existing.verification.risk,
          }
        : null,
      attestation_id: existing.attestations[0]?.id ?? null,
      duplicate: true,
    }
  }

  // ---- Configuration (versioned, immutable) ----
  const configuration = await getPublishedConfiguration(networkVersionId)

  // ---- Persist the event (pending) ----
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
      status: 'pending',
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

  // ---- Async verification (here: processed in-process, structured for a real worker) ----
  const ctx: VerificationContext = {
    tenantId,
    event: {
      id: event.id,
      deviceId: device.id,
      externalEventId: event.externalEventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      sequence: event.sequence,
      payloadJson: event.payloadJson,
      signature: event.signature,
    },
    device: {
      id: device.id,
      credential: device.credential ? { publicKey: device.credential.publicKey, status: device.credential.status } : null,
    },
    configuration,
    raw: {
      device_id: input.device_id,
      event_id: input.event_id,
      timestamp: input.timestamp,
      event_type: input.event_type,
      sequence: input.sequence,
      payload: input.payload,
      signature: input.signature,
    },
  }

  const verification = await runVerification(ctx)

  await db.verificationResult.create({
    data: {
      tenantId,
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
    tenantId,
    actorId,
    eventType: AuditEvents.VerificationCompleted,
    resourceType: 'event',
    resourceId: event.id,
    metadata: { overall_status: verification.overall_status, checks: verification.checks.length },
  })
  await emit({
    event_type: DomainEventTypes.VerificationCompleted,
    aggregate_id: event.id,
    tenant_id: tenantId,
    version: 1,
    payload: { overall_status: verification.overall_status, confidence: verification.confidence },
  })

  // ---- If verified, auto-create an attestation (Rule: telemetry→proof) ----
  let attestationId: string | null = null
  if (verification.overall_status === 'verified') {
    const attestation = await createAttestationForEvent(tenantId, event.id, configuration, actorId)
    attestationId = attestation.id
  }

  return {
    event_id: event.id,
    external_event_id: event.externalEventId!,
    status,
    verification: {
      overall_status: verification.overall_status,
      checks: verification.checks,
      confidence: verification.confidence,
      risk: verification.risk,
    },
    attestation_id: attestationId,
    duplicate: false,
  }
}

/** Resolve the current published network version for an asset's network. */
async function resolveNetworkVersionForAsset(tenantId: string, _assetId: string): Promise<string | null> {
  // For the MVP, assets are not bound to a specific network at creation; we
  // pick the tenant's most recently published network version. This keeps the
  // generic loop simple. Production would bind asset→network explicitly.
  const net = await db.networkDefinition.findFirst({
    where: { tenantId, status: 'active', currentVersionId: { not: null } },
    orderBy: { updatedAt: 'desc' },
  })
  return net?.currentVersionId ?? null
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
