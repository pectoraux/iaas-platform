// =============================================================================
// Attestation service.
//
// Rule 1: Telemetry is not proof.
// An Attestation is a verified claim about an event. Multiple attestations per
// event are supported. Verification is NOT collapsed into a boolean.
// =============================================================================

import { db } from '@/lib/db'
import { NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { emit, DomainEventTypes } from '@/lib/domain/events'
import { VERIFIER_VERSION, type VersionConfiguration } from './verification.service'

export interface CreateAttestationInput {
  eventId: string
  claimType?: string
  quantity?: number
  unit?: string
}

/**
 * Auto-create an attestation from a verified event. Derives quantity/unit from
 * the event payload + capability definition. This is the canonical
 * "this happened" claim.
 *
 * The claim is derived SERVER-SIDE from the verified payload — never from
 * client-supplied economic values.
 */
export async function createAttestationForEvent(
  tenantId: string,
  eventId: string,
  configuration: VersionConfiguration,
  actorId?: string,
) {
  const event = await db.event.findFirst({ where: { id: eventId, tenantId }, include: { verification: true } })
  if (!event) throw new NotFoundError('event', eventId)
  if (!event.verification || event.verification.overallStatus !== 'verified') {
    throw new ValidationError('Cannot attest an unverified event')
  }

  // Derive the claim quantity from the payload. The capability definition
  // tells us which field is the "measured" quantity.
  const payload = JSON.parse(event.payloadJson) as Record<string, number>
  const cap = configuration.capabilities[0]
  const unit = cap?.unit ?? 'unit'
  // Heuristic: prefer the first numeric field that matches a capability field.
  let quantity = 0
  if (cap) {
    const fieldNames = Object.keys(cap.fields)
    const measuredField = fieldNames.find((f) => payload[f] != null) ?? fieldNames[0]
    quantity = typeof payload[measuredField] === 'number' ? payload[measuredField] : 0
  } else {
    const firstNum = Object.values(payload).find((v) => typeof v === 'number')
    quantity = (firstNum as number) ?? 0
  }

  const claimType = `valid_${event.eventType}`

  const attestation = await db.attestation.create({
    data: {
      tenantId,
      eventId,
      claimType,
      quantity,
      unit,
      status: 'verified',
      verificationPolicyVersion: event.verification.policyVersion,
      verifierVersion: event.verification.verifierVersion,
    },
  })

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.AttestationCreated,
    resourceType: 'attestation',
    resourceId: attestation.id,
    metadata: { eventId, claimType, quantity, unit },
  })
  await emit({
    event_type: DomainEventTypes.AttestationCreated,
    aggregate_id: attestation.id,
    tenant_id: tenantId,
    version: 1,
    payload: { eventId, claimType, quantity, unit },
  })

  return attestation
}

export async function listAttestations(tenantId: string) {
  return db.attestation.findMany({
    where: { tenantId },
    include: { event: true },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getAttestation(tenantId: string, id: string) {
  const a = await db.attestation.findFirst({ where: { id, tenantId }, include: { event: true } })
  if (!a) throw new NotFoundError('attestation', id)
  return a
}

export { VERIFIER_VERSION }
