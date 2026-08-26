// =============================================================================
// Contribution service.
//
// Rule 2: Proof is not contribution.
// A Contribution is the generalized economic work object — "this counts as X
// units of economically valid work". Deterministic + idempotent.
//
// The contribution quantity is derived SERVER-SIDE from linked attestations
// (and the capability definition), never from client-supplied economic values.
// =============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { emit, DomainEventTypes } from '@/lib/domain/events'
import { getPublishedConfiguration } from './network.service'
import { getCapabilityForVersion } from './registry.service'

export interface CreateContributionInput {
  attestationIds: string[]
  capabilityId?: string
  // Optional explicit window; defaults derived from attestation events.
  startTime?: string
  endTime?: string
  // Task 1: DERIVED CONTRIBUTION — a vertical-specific calculation can specify
  // the exact quantity+unit to use for the contribution, overriding the default
  // "sum of attestation quantities" behavior.
  //
  // This is critical for the VPP: the attestation stores the raw telemetry
  // value (e.g. power_kw = 4.8 kW), but the contribution must represent the
  // VERIFIED PERFORMANCE (e.g. 9.8 kWh delivered = actual - baseline).
  //
  // Without this, the generic contribution engine would use the first
  // attestation field (power_kw) as the quantity, producing a kW value
  // labeled as kWh — dimensionally wrong.
  derivedQuantity?: string // decimal as string
  derivedUnit?: string
}

export interface ContributionResult {
  id: string
  quantity: string // decimal as string (was number before task 3)
  unit: string
  status: string
  attestation_ids: string[]
  duplicate: boolean
}

/**
 * Create a contribution from one or more verified attestations.
 *
 * Idempotent: keyed by (tenantId, idempotencyKey). Replays return the same
 * contribution id and quantity — no duplicate economic consequences.
 */
export async function createContribution(
  tenantId: string,
  input: CreateContributionInput,
  idempotencyKey: string,
  actorId?: string,
): Promise<ContributionResult> {
  if (!input.attestationIds.length) throw new ValidationError('At least one attestation is required')

  // Idempotency: existing contribution for this key?
  const existing = await db.contribution.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
  })
  if (existing) {
    return {
      id: existing.id,
      // WORK-006 (BASE-007): Prisma Decimal → string (ContributionResult.quantity is string).
      quantity: existing.quantity.toString(),
      unit: existing.unit,
      status: existing.status,
      attestation_ids: JSON.parse(existing.attestationIdsJson),
      duplicate: true,
    }
  }

  // Load + scope attestations to tenant.
  const attestations = await db.attestation.findMany({
    where: { id: { in: input.attestationIds }, tenantId },
    include: { event: true },
  })
  if (attestations.length !== input.attestationIds.length) {
    throw new NotFoundError('attestation', 'one or more attestations not found in tenant scope')
  }

  // All attestations must belong to the same network version (config consistency).
  const networkVersionId = attestations[0].event.networkVersionId
  const allSameVersion = attestations.every((a) => a.event.networkVersionId === networkVersionId)
  if (!allSameVersion) throw new ValidationError('All attestations must reference the same network version')

  // Issue 1: resolve capability from the event's explicit capabilityType —
  // NO fallback to configuration.capabilities[0].
  const firstAtt = attestations[0]
  const configuration = await getPublishedConfiguration(networkVersionId)
  const capType = firstAtt.event.capabilityType
  if (!capType) {
    throw new ValidationError('Cannot create contribution from event without explicit capabilityType')
  }
  const capability = input.capabilityId
    ? await db.capability.findFirst({ where: { id: input.capabilityId, tenantId } }).then((c) => c ?? null)
    : await getCapabilityForVersion(tenantId, networkVersionId, capType)
  if (!capability) throw new NotFoundError('capability', capType)

  // Find the specific capability config for policyVersion.
  const specificCapConfig = configuration.capabilities.find((c) => c.type === capType)

  // Derive operator + asset from the first attestation's event.
  const firstEvent = firstAtt.event
  const asset = await db.asset.findFirst({ where: { id: firstEvent.assetId, tenantId } })
  if (!asset) throw new NotFoundError('asset', firstEvent.assetId)

  // Task 1: DERIVED CONTRIBUTION.
  // If the caller provides a derivedQuantity (e.g. VPP performance_kwh),
  // use it instead of summing attestation quantities. This lets verticals
  // specify the exact verified quantity (actual - baseline, verified bytes
  // delivered, GPU-hours consumed, etc.) rather than being forced to use
  // the first attestation field.
  let quantity: Prisma.Decimal
  let unit: string
  if (input.derivedQuantity !== undefined && input.derivedUnit !== undefined) {
    quantity = new Prisma.Decimal(input.derivedQuantity)
    unit = input.derivedUnit
  } else {
    // Default: sum of attestation quantities (generic behavior).
    quantity = attestations.reduce((sum, a) => sum.plus(a.quantity), new Prisma.Decimal(0))
    unit = capability.unit
  }

  // Derive time window from attestations.
  const occurredTimes = attestations.map((a) => a.event.occurredAt.getTime()).sort((a, b) => a - b)
  const startTime = input.startTime ? new Date(input.startTime) : new Date(occurredTimes[0])
  const endTime = input.endTime ? new Date(input.endTime) : new Date(occurredTimes[occurredTimes.length - 1])

  // Task 1: atomic contribution creation + outbox emit.
  const contribution = await db.$transaction(async (tx) => {
    const created = await tx.contribution.create({
      data: {
        tenantId,
        networkVersionId,
        operatorId: asset.operatorId,
        assetId: asset.id,
        capabilityId: capability.id,
        quantity,
        unit,
        startTime,
        endTime,
        attestationIdsJson: JSON.stringify(input.attestationIds),
        status: 'created',
        policyVersion: specificCapConfig?.schema_version ?? 1,
        idempotencyKey,
      },
    })

    await emit(
      {
        event_type: DomainEventTypes.ContributionCreated,
        aggregate_id: created.id,
        tenant_id: tenantId,
        version: 1,
        payload: { quantity: quantity.toString(), unit, operatorId: asset.operatorId, attestationIds: input.attestationIds },
      },
      tx,
    )

    return created
  })

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.ContributionCreated,
    resourceType: 'contribution',
    resourceId: contribution.id,
    metadata: { quantity: quantity.toString(), unit, operatorId: asset.operatorId, assetId: asset.id, attestationIds: input.attestationIds, networkVersionId, capabilityType: capType },
  })

  return {
    id: contribution.id,
    quantity: quantity.toString(),
    unit,
    status: contribution.status,
    attestation_ids: input.attestationIds,
    duplicate: false,
  }
}

export async function listContributions(tenantId: string) {
  return db.contribution.findMany({
    where: { tenantId },
    include: { operator: true, asset: true, capability: true, networkVersion: true, rewards: true },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getContribution(tenantId: string, id: string) {
  const c = await db.contribution.findFirst({
    where: { id, tenantId },
    include: { operator: true, asset: true, capability: true, networkVersion: true, rewards: true },
  })
  if (!c) throw new NotFoundError('contribution', id)
  return c
}
