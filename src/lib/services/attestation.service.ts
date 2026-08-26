// =============================================================================
// Attestation service.
//
// Rule 1: Telemetry is not proof.
// An Attestation is a verified claim about an event. Multiple attestations per
// event are supported. Verification is NOT collapsed into a boolean.
//
// Task 4: the attestation uses the event's explicit `capabilityType` to
// resolve the specific capability (not capabilities[0]). The quantity is
// derived from the specific capability's first defined field.
//
// Task 3: quantity is stored as Decimal.
// =============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { emit, DomainEventTypes } from '@/lib/domain/events'
// WORK-006 (BASE-007): VersionConfiguration is defined in network.service and
// imported (but not re-exported) by verification.service. Import directly from
// the defining module to avoid the TS2459 "not exported" error.
import { VERIFIER_VERSION } from './verification.service'
import type { VersionConfiguration } from './network.service'

export interface CreateAttestationInput {
  eventId: string
  claimType?: string
  quantity?: number
  unit?: string
}

/**
 * Auto-create an attestation from a verified event. Derives quantity/unit from
 * the event payload + the event's specific capability definition.
 *
 * Task 4: uses `capabilityType` from the event to find the specific capability,
 * NOT capabilities[0]. This ensures a multi-capability asset (e.g. a battery
 * with energy_discharge + frequency_response) is attested against the correct
 * capability schema.
 *
 * The claim is derived SERVER-SIDE from the verified payload — never from
 * client-supplied economic values.
 */
export async function createAttestationForEvent(
  tenantId: string,
  eventId: string,
  configuration: VersionConfiguration,
  capabilityType?: string | null,
  actorId?: string,
) {
  const event = await db.event.findFirst({ where: { id: eventId, tenantId }, include: { verification: true } })
  if (!event) throw new NotFoundError('event', eventId)
  if (!event.verification || event.verification.overallStatus !== 'verified') {
    throw new ValidationError('Cannot attest an unverified event')
  }

  // Issue 1: resolve the SPECIFIC capability for this event — NO fallback.
  // The event MUST have an explicit capabilityType (enforced at ingest).
  const resolvedCapType = capabilityType ?? event.capabilityType
  if (!resolvedCapType) {
    throw new ValidationError('Cannot attest event without explicit capabilityType')
  }
  const cap = configuration.capabilities.find((c) => c.type === resolvedCapType)
  if (!cap) {
    throw new ValidationError(`Capability ${resolvedCapType} not found in network configuration`)
  }
  const unit = cap?.unit ?? 'unit'

  // Derive the claim quantity from the payload using the specific capability's fields.
  const payload = JSON.parse(event.payloadJson) as Record<string, unknown>
  let quantity = new Prisma.Decimal(0)
  if (cap) {
    const fieldNames = Object.keys(cap.fields)
    const measuredField = fieldNames.find((f) => payload[f] != null) ?? fieldNames[0]
    if (measuredField && typeof payload[measuredField] === 'number') {
      quantity = new Prisma.Decimal(payload[measuredField] as number)
    }
  } else {
    const firstNum = Object.values(payload).find((v) => typeof v === 'number')
    if (firstNum != null) quantity = new Prisma.Decimal(firstNum as number)
  }

  const claimType = `valid_${event.eventType}`

  const attestation = await db.$transaction(async (tx) => {
    const created = await tx.attestation.create({
      data: {
        tenantId,
        eventId,
        claimType,
        quantity,
        unit,
        status: 'verified',
        verificationPolicyVersion: event.verification!.policyVersion,
        verifierVersion: event.verification!.verifierVersion,
      },
    })

    // ATOMIC (task 1): emit outbox in the same transaction.
    await emit(
      {
        event_type: DomainEventTypes.AttestationCreated,
        aggregate_id: created.id,
        tenant_id: tenantId,
        version: 1,
        payload: { eventId, claimType, quantity: quantity.toString(), unit },
      },
      tx,
    )

    return created
  })

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.AttestationCreated,
    resourceType: 'attestation',
    resourceId: attestation.id,
    metadata: { eventId, claimType, quantity: quantity.toString(), unit, capabilityType: resolvedCapType },
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
