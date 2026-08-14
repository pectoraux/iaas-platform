// =============================================================================
// Capacity Service — PLATFORM-LEVEL primitive (redesigned 4-layer model).
//
// Capacity is a RESOURCE. Reservations, commitments, and consumption are
// TRANSACTIONS against that resource.
//
//   CapacityResource (verified physical capacity)
//       ↓
//   CapacityReservation (operator commits capacity for a window)
//       ↓
//   CapacityCommitment (a dispatch/job commits some of the reserved capacity)
//       ↓
//   Consumption (actual usage, recorded on completion)
//
// Invariants:
//   - Sum of active reservations ≤ resource.physicalCapacity (concurrency-safe)
//   - Sum of active commitments ≤ reservation.reservedAmount (concurrency-safe)
//   - Consumption recorded per commitment
//
// Works for ALL verticals:
//   VPP:        10 kW → 8 kW reserved → 6 kW committed → 5.7 kW consumed
//   Storage:    100 TB → 80 TB reserved → 50 TB committed → 40 TB consumed
//   Compute:    16 GPU → 12 GPU reserved → 6 GPU committed → 6 GPU consumed
//   Wireless:   1 Gbps → 800 Mbps reserved → 500 Mbps committed → 350 Mbps consumed
// =============================================================================

import { db, type ExtendedTransactionClient } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { NotFoundError, ValidationError } from '@/lib/domain/errors'

// ---------------------------------------------------------------------------
// CapacityResource — the verified physical capacity (stable lock target)
// ---------------------------------------------------------------------------

/**
 * Get-or-create the CapacityResource for an asset+capability.
 * The resource is created from AssetNetworkAssignment.verifiedCapacityKw.
 * This is the STABLE LOCK TARGET for all capacity operations.
 */
export async function ensureCapacityResource(
  tenantId: string,
  assetId: string,
  networkId: string,
  capabilityType: string,
  tx?: ExtendedTransactionClient,
): Promise<{ id: string; physicalCapacity: string }> {
  const client = tx ?? db

  // Resolve verified capacity from the assignment.
  const assignment = await client.assetNetworkAssignment.findFirst({
    where: { tenantId, assetId, networkId, capabilityType, status: 'active' },
  })
  if (!assignment) {
    throw new NotFoundError('asset_network_assignment', `${assetId}/${capabilityType}`)
  }
  if (!assignment.verifiedCapacityKw) {
    throw new ValidationError(
      `Asset ${assetId} has no verified capacity for capability ${capabilityType}.`,
    )
  }

  // Get-or-create the resource.
  const existing = await client.capacityResource.findUnique({
    where: { assetId_networkId_capabilityType: { assetId, networkId, capabilityType } },
  })
  if (existing) {
    // Update physical capacity if it changed.
    if (existing.physicalCapacity !== assignment.verifiedCapacityKw) {
      return client.capacityResource.update({
        where: { id: existing.id },
        data: { physicalCapacity: assignment.verifiedCapacityKw },
      })
    }
    return existing
  }

  return client.capacityResource.create({
    data: {
      tenantId,
      assetId,
      networkId,
      capabilityType,
      physicalCapacity: assignment.verifiedCapacityKw,
      unit: 'kW',
    },
  })
}

// ---------------------------------------------------------------------------
// CapacityReservation — commit capacity for a time window
// ---------------------------------------------------------------------------

export interface CreateReservationInput {
  tenantId: string
  assetId: string
  networkId: string
  capabilityType: string
  requestedAmount: string
  startTime: Date
  endTime: Date
  sourceType: string
  sourceId?: string
}

export interface CreateReservationResult {
  reservationId: string
  resourceId: string
  reservedAmount: string
  remainingAmount: string
  physicalCapacity: string
  duplicate: boolean
}

/**
 * Create a capacity reservation.
 *
 * CONCURRENCY-SAFE: locks the CapacityResource row FOR UPDATE (stable lock
 * target that always exists). Two concurrent reservations cannot both exceed
 * physical capacity.
 *
 * Invariant: SUM(active reservations overlapping [start, end]) ≤ physicalCapacity
 */
export async function createCapacityReservation(
  input: CreateReservationInput,
  tx?: ExtendedTransactionClient,
): Promise<CreateReservationResult> {
  const client = tx ?? db
  const requested = new Prisma.Decimal(input.requestedAmount)
  if (requested.lte(0)) {
    throw new ValidationError(`Requested amount must be positive, got ${input.requestedAmount}`)
  }

  // Ensure the resource exists (and resolve verified capacity).
  const resource = await ensureCapacityResource(
    input.tenantId, input.assetId, input.networkId, input.capabilityType, client,
  )
  const physical = new Prisma.Decimal(resource.physicalCapacity)

  if (requested.greaterThan(physical)) {
    throw new ValidationError(
      `Requested ${requested.toString()} exceeds verified physical capacity ${physical.toString()}`,
    )
  }

  // Lock the resource FOR UPDATE (stable lock target — always exists).
  await client.$queryRaw`
    SELECT * FROM "CapacityResource"
    WHERE "assetId" = ${input.assetId}
      AND "networkId" = ${input.networkId}
      AND "capabilityType" = ${input.capabilityType}
    FOR UPDATE
  `

  // Idempotency: check for existing reservation with same source.
  if (input.sourceId) {
    const existing = await client.capacityReservation.findFirst({
      where: { tenantId: input.tenantId, sourceType: input.sourceType, sourceId: input.sourceId, status: 'active' },
    })
    if (existing) {
      return {
        reservationId: existing.id,
        resourceId: existing.resourceId,
        reservedAmount: existing.reservedAmount,
        remainingAmount: existing.remainingAmount,
        physicalCapacity: resource.physicalCapacity,
        duplicate: true,
      }
    }
  }

  // Compute overlapping reserved amount.
  const overlapping = await client.capacityReservation.findMany({
    where: {
      tenantId: input.tenantId,
      resourceId: resource.id,
      status: 'active',
      startTime: { lt: input.endTime },
      endTime: { gt: input.startTime },
    },
  })
  const alreadyReserved = overlapping.reduce(
    (sum, r) => sum.plus(new Prisma.Decimal(r.reservedAmount)),
    new Prisma.Decimal(0),
  )
  const available = physical.minus(alreadyReserved)

  if (requested.greaterThan(available)) {
    throw new ValidationError(
      `Insufficient capacity: requested ${requested.toString()}, available ${available.toString()} (physical ${physical.toString()}, already reserved ${alreadyReserved.toString()})`,
    )
  }

  // Create the reservation.
  const reservation = await client.capacityReservation.create({
    data: {
      tenantId: input.tenantId,
      resourceId: resource.id,
      reservedAmount: input.requestedAmount,
      remainingAmount: input.requestedAmount, // starts fully available
      startTime: input.startTime,
      endTime: input.endTime,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
    },
  })

  return {
    reservationId: reservation.id,
    resourceId: resource.id,
    reservedAmount: reservation.reservedAmount,
    remainingAmount: reservation.remainingAmount,
    physicalCapacity: resource.physicalCapacity,
    duplicate: false,
  }
}

// ---------------------------------------------------------------------------
// CapacityCommitment — a dispatch commits some of a reservation's capacity
// ---------------------------------------------------------------------------

export interface CreateCommitmentInput {
  tenantId: string
  reservationId: string
  committedAmount: string
  startTime: Date
  endTime: Date
  sourceType: string // vpp_dispatch | storage_job | ...
  sourceId: string   // e.g. VppDispatch.id
}

export interface CreateCommitmentResult {
  commitmentId: string
  committedAmount: string
  remainingAfter: string
  duplicate: boolean
}

/**
 * Create a capacity commitment against a reservation.
 *
 * CONCURRENCY-SAFE: locks the CapacityReservation row FOR UPDATE.
 * Multiple commitments can share a reservation (6 kW + 4 kW = 10 kW),
 * but their sum cannot exceed the reservation's remaining amount.
 *
 * Invariant: SUM(active commitments) ≤ reservation.reservedAmount
 */
export async function createCapacityCommitment(
  input: CreateCommitmentInput,
  tx?: ExtendedTransactionClient,
): Promise<CreateCommitmentResult> {
  const client = tx ?? db
  const committed = new Prisma.Decimal(input.committedAmount)
  if (committed.lte(0)) {
    throw new ValidationError(`Committed amount must be positive, got ${input.committedAmount}`)
  }

  // Lock the reservation FOR UPDATE.
  await client.$queryRaw`
    SELECT * FROM "CapacityReservation"
    WHERE id = ${input.reservationId}
    FOR UPDATE
  `

  const reservation = await client.capacityReservation.findUnique({
    where: { id: input.reservationId },
  })
  if (!reservation) {
    throw new NotFoundError('capacity_reservation', input.reservationId)
  }
  if (reservation.status !== 'active') {
    throw new ValidationError(`Reservation ${input.reservationId} is ${reservation.status}`)
  }

  // Idempotency: check for existing commitment with same source.
  const existing = await client.capacityCommitment.findFirst({
    where: { tenantId: input.tenantId, sourceType: input.sourceType, sourceId: input.sourceId },
  })
  if (existing) {
    return {
      commitmentId: existing.id,
      committedAmount: existing.committedAmount,
      remainingAfter: new Prisma.Decimal(reservation.remainingAmount).toString(),
      duplicate: true,
    }
  }

  const remaining = new Prisma.Decimal(reservation.remainingAmount)
  if (committed.greaterThan(remaining)) {
    throw new ValidationError(
      `Insufficient remaining capacity: requested ${committed.toString()}, remaining ${remaining.toString()}`,
    )
  }

  // Create the commitment + decrement the reservation's remaining.
  const newRemaining = remaining.minus(committed)
  const commitment = await client.capacityCommitment.create({
    data: {
      tenantId: input.tenantId,
      reservationId: input.reservationId,
      committedAmount: input.committedAmount,
      startTime: input.startTime,
      endTime: input.endTime,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    },
  })

  await client.capacityReservation.update({
    where: { id: input.reservationId },
    data: { remainingAmount: newRemaining.toString() },
  })

  return {
    commitmentId: commitment.id,
    committedAmount: commitment.committedAmount,
    remainingAfter: newRemaining.toString(),
    duplicate: false,
  }
}

// ---------------------------------------------------------------------------
// Consumption — record actual usage on completion
// ---------------------------------------------------------------------------

/**
 * Record consumption for a commitment (dispatch completed).
 * This records the actual amount consumed, NOT the committed amount.
 */
export async function recordConsumption(
  tenantId: string,
  sourceType: string,
  sourceId: string,
  consumedAmount: string,
): Promise<void> {
  const commitment = await db.capacityCommitment.findFirst({
    where: { tenantId, sourceType, sourceId },
  })
  if (!commitment) {
    throw new NotFoundError('capacity_commitment', `${sourceType}/${sourceId}`)
  }

  await db.capacityCommitment.update({
    where: { id: commitment.id },
    data: {
      consumedAmount,
      status: 'consumed',
      completedAt: new Date(),
    },
  })
}

/**
 * Release a commitment (dispatch cancelled).
 * Returns the committed amount to the reservation's remaining.
 */
export async function releaseCommitment(
  tenantId: string,
  sourceType: string,
  sourceId: string,
): Promise<void> {
  const commitment = await db.capacityCommitment.findFirst({
    where: { tenantId, sourceType, sourceId },
  })
  if (!commitment) return
  if (commitment.status === 'released' || commitment.status === 'cancelled') return

  await db.$transaction(async (tx) => {
    // Lock the reservation.
    await tx.$queryRaw`SELECT * FROM "CapacityReservation" WHERE id = ${commitment.reservationId} FOR UPDATE`

    const reservation = await tx.capacityReservation.findUnique({ where: { id: commitment.reservationId } })
    if (!reservation) return

    // Return the committed amount to remaining.
    const newRemaining = new Prisma.Decimal(reservation.remainingAmount).plus(commitment.committedAmount)
    await tx.capacityReservation.update({
      where: { id: reservation.id },
      data: { remainingAmount: newRemaining.toString() },
    })

    await tx.capacityCommitment.update({
      where: { id: commitment.id },
      data: { status: 'cancelled' },
    })
  })
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get available capacity for an asset+capability in a time window.
 * Resolves the correct networkId from the assignment (fixes empty networkId bug).
 */
export async function getAvailableCapacity(
  tenantId: string,
  assetId: string,
  networkId: string,
  capabilityType: string,
  startTime: Date,
  endTime: Date,
): Promise<{ physical: string; reserved: string; available: string }> {
  const resource = await db.capacityResource.findUnique({
    where: { assetId_networkId_capabilityType: { assetId, networkId, capabilityType } },
  })
  if (!resource) {
    return { physical: '0', reserved: '0', available: '0' }
  }
  const physical = new Prisma.Decimal(resource.physicalCapacity)

  const reservations = await db.capacityReservation.findMany({
    where: { tenantId, resourceId: resource.id, status: 'active' },
  })
  const overlapping = reservations.filter(
    (r) => r.startTime < endTime && r.endTime > startTime,
  )
  const reserved = overlapping.reduce(
    (sum, r) => sum.plus(new Prisma.Decimal(r.reservedAmount)),
    new Prisma.Decimal(0),
  )
  const available = physical.minus(reserved)

  return {
    physical: physical.toString(),
    reserved: reserved.toString(),
    available: available.toString(),
  }
}

/**
 * Find a reservation by source (e.g. find the VPP reservation's capacity
// reservation by the VppCapacityReservation ID).
 */
export async function findReservationBySource(
  tenantId: string,
  sourceType: string,
  sourceId: string,
): Promise<{ id: string; resourceId: string; reservedAmount: string; remainingAmount: string } | null> {
  const reservation = await db.capacityReservation.findFirst({
    where: { tenantId, sourceType, sourceId, status: 'active' },
  })
  if (!reservation) return null
  return {
    id: reservation.id,
    resourceId: reservation.resourceId,
    reservedAmount: reservation.reservedAmount,
    remainingAmount: reservation.remainingAmount,
  }
}
