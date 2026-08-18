// =============================================================================
// Capacity Service — PLATFORM-LEVEL primitive (generic, 4-layer model).
//
// Capacity is a RESOURCE. Reservations, commitments, and usage are
// TRANSACTIONS against that resource.
//
//   CapacityResource (verified physical capacity, generic unit)
//       ↓
//   CapacityReservation (operator commits capacity for a window)
//       ↓
//   CapacityCommitment (a dispatch/job commits some of the reserved capacity)
//       ↓
//   CapacityUsage (actual usage — SEPARATE dimension from capacity)
//
// GENERIC: works for ALL verticals:
//   VPP:        10 kW → 8 kW reserved → 6 kW committed → 2.85 kWh used
//   Storage:    100 TB → 80 TB reserved → 50 TB committed → 45 TB used
//   Compute:    16 GPU → 12 GPU reserved → 6 GPU committed → 6 GPU-hours used
//   Wireless:   1 Gbps → 800 Mbps reserved → 500 Mbps committed → 350 Mbps used
//
// KEY INSIGHT: capacity (kW) and usage (kWh) are different dimensions.
// A commitment represents CAPACITY (kW). Usage represents ACTUAL CONSUMPTION
// (kWh, TB, GPU-hours). They are stored in separate models to prevent
// dimensional confusion.
// =============================================================================

import { db, type ExtendedTransactionClient } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { NotFoundError, ValidationError, InsufficientCapacityError } from '@/lib/domain/errors'

// ---------------------------------------------------------------------------
// CapacityResource — the verified physical capacity (stable lock target)
// ---------------------------------------------------------------------------

/**
 * Get-or-create the CapacityResource for an asset+capability.
 * The resource is created from AssetNetworkAssignment.verifiedQuantity + verifiedUnit.
 * GENERIC — not energy-specific.
 */
export async function ensureCapacityResource(
  tenantId: string,
  assetId: string,
  networkId: string,
  capabilityType: string,
  tx?: ExtendedTransactionClient,
): Promise<{ id: string; physicalCapacity: string; unit: string }> {
  const client = tx ?? db

  const assignment = await client.assetNetworkAssignment.findFirst({
    where: { tenantId, assetId, networkId, capabilityType, status: 'active' },
  })
  if (!assignment) {
    throw new NotFoundError('asset_network_assignment', `${assetId}/${capabilityType}`)
  }
  if (!assignment.verifiedQuantity || !assignment.verifiedUnit) {
    throw new ValidationError(
      `Asset ${assetId} has no verified capacity for capability ${capabilityType}. ` +
      `Set verifiedQuantity + verifiedUnit on the network assignment first.`,
    )
  }

  const existing = await client.capacityResource.findUnique({
    where: { assetId_networkId_capabilityType: { assetId, networkId, capabilityType } },
  })
  if (existing) {
    if (existing.physicalCapacity !== assignment.verifiedQuantity || existing.unit !== assignment.verifiedUnit) {
      return client.capacityResource.update({
        where: { id: existing.id },
        data: { physicalCapacity: assignment.verifiedQuantity, unit: assignment.verifiedUnit },
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
      physicalCapacity: assignment.verifiedQuantity,
      unit: assignment.verifiedUnit,
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
  unit: string
  duplicate: boolean
}

export async function createCapacityReservation(
  input: CreateReservationInput,
  tx?: ExtendedTransactionClient,
): Promise<CreateReservationResult> {
  const client = tx ?? db
  const requested = new Prisma.Decimal(input.requestedAmount)
  if (requested.lte(0)) {
    throw new ValidationError(`Requested amount must be positive, got ${input.requestedAmount}`)
  }

  const resource = await ensureCapacityResource(
    input.tenantId, input.assetId, input.networkId, input.capabilityType, client,
  )
  const physical = new Prisma.Decimal(resource.physicalCapacity)

  if (requested.greaterThan(physical)) {
    throw new InsufficientCapacityError(
      `Requested ${requested.toString()} exceeds verified physical capacity ${physical.toString()} ${resource.unit}`,
    )
  }

  await client.$queryRaw`
    SELECT * FROM "CapacityResource"
    WHERE "assetId" = ${input.assetId}
      AND "networkId" = ${input.networkId}
      AND "capabilityType" = ${input.capabilityType}
    FOR UPDATE
  `

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
        unit: resource.unit,
        duplicate: true,
      }
    }
  }

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
    throw new InsufficientCapacityError(
      `Insufficient capacity: requested ${requested.toString()}, available ${available.toString()} ${resource.unit}`,
    )
  }

  const reservation = await client.capacityReservation.create({
    data: {
      tenantId: input.tenantId,
      resourceId: resource.id,
      reservedAmount: input.requestedAmount,
      remainingAmount: input.requestedAmount,
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
    unit: resource.unit,
    duplicate: false,
  }
}

// ---------------------------------------------------------------------------
// CapacityCommitment — commit some of a reservation's capacity
// ---------------------------------------------------------------------------

export interface CreateCommitmentInput {
  tenantId: string
  reservationId: string
  committedAmount: string
  unit: string // must match resource unit
  startTime: Date
  endTime: Date
  sourceType: string
  sourceId: string
}

export interface CreateCommitmentResult {
  commitmentId: string
  committedAmount: string
  unit: string
  remainingAfter: string
  duplicate: boolean
}

export async function createCapacityCommitment(
  input: CreateCommitmentInput,
  tx?: ExtendedTransactionClient,
): Promise<CreateCommitmentResult> {
  const client = tx ?? db
  const committed = new Prisma.Decimal(input.committedAmount)
  if (committed.lte(0)) {
    throw new ValidationError(`Committed amount must be positive, got ${input.committedAmount}`)
  }

  await client.$queryRaw`
    SELECT * FROM "CapacityReservation"
    WHERE id = ${input.reservationId}
    FOR UPDATE
  `

  const reservation = await client.capacityReservation.findUnique({
    where: { id: input.reservationId },
    include: { resource: true },
  })
  if (!reservation) {
    throw new NotFoundError('capacity_reservation', input.reservationId)
  }
  if (reservation.status !== 'active') {
    throw new ValidationError(`Reservation ${input.reservationId} is ${reservation.status}`)
  }

  // Unit check: commitment unit must match resource unit.
  if (input.unit !== reservation.resource.unit) {
    throw new ValidationError(
      `Unit mismatch: commitment unit '${input.unit}' != resource unit '${reservation.resource.unit}'`,
    )
  }

  const existing = await client.capacityCommitment.findFirst({
    where: { tenantId: input.tenantId, sourceType: input.sourceType, sourceId: input.sourceId },
  })
  if (existing) {
    return {
      commitmentId: existing.id,
      committedAmount: existing.committedAmount,
      unit: existing.unit,
      remainingAfter: new Prisma.Decimal(reservation.remainingAmount).toString(),
      duplicate: true,
    }
  }

  const remaining = new Prisma.Decimal(reservation.remainingAmount)
  if (committed.greaterThan(remaining)) {
    throw new InsufficientCapacityError(
      `Insufficient remaining capacity: requested ${committed.toString()} ${input.unit}, remaining ${remaining.toString()} ${input.unit}`,
    )
  }

  const newRemaining = remaining.minus(committed)
  const commitment = await client.capacityCommitment.create({
    data: {
      tenantId: input.tenantId,
      reservationId: input.reservationId,
      committedAmount: input.committedAmount,
      unit: input.unit,
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
    unit: commitment.unit,
    remainingAfter: newRemaining.toString(),
    duplicate: false,
  }
}

// ---------------------------------------------------------------------------
// CapacityUsage — actual usage (SEPARATE dimension from capacity)
// ---------------------------------------------------------------------------

export interface RecordUsageInput {
  tenantId: string
  commitmentId: string // Fix 1: use commitmentId directly (not sourceType/sourceId)
  // Usage quantity + unit (may differ from commitment unit).
  // e.g. commitment = 6 kW, usage = 2.85 kWh.
  quantity: string
  unit: string // kWh | TB | GPU-hours | ...
  startTime: Date
  endTime: Date
  sourceType?: string // optional metadata
  sourceId?: string   // optional metadata
  attestationId?: string
}

/**
 * Record actual usage for a commitment.
 *
 * Fix 1: takes commitmentId directly (not sourceType/sourceId) — eliminates
 *   multi-asset dispatch ambiguity where all assignments shared the same lookup.
 * Fix 4: ATOMIC + IDEMPOTENT — creates usage + marks commitment consumed in
 *   ONE transaction. The unique constraint on commitmentId prevents duplicate
 *   usage records. If called twice, returns the existing usage.
 *
 * Capacity (kW) and usage (kWh) are different physical dimensions.
 */
export async function recordUsage(input: RecordUsageInput): Promise<{ usageId: string; duplicate: boolean }> {
  // Idempotency: check for existing usage on this commitment.
  const existing = await db.capacityUsage.findUnique({
    where: { commitmentId: input.commitmentId },
  })
  if (existing) {
    return { usageId: existing.id, duplicate: true }
  }

  // Atomic: create usage + mark commitment consumed in ONE transaction.
  try {
    const result = await db.$transaction(async (tx) => {
      // Lock the commitment FOR UPDATE.
      await tx.$queryRaw`SELECT * FROM "CapacityCommitment" WHERE id = ${input.commitmentId} FOR UPDATE`

      const commitment = await tx.capacityCommitment.findUnique({
        where: { id: input.commitmentId },
      })
      if (!commitment) {
        throw new NotFoundError('capacity_commitment', input.commitmentId)
      }

      // Idempotency: double-check inside the lock.
      const existingUsage = await tx.capacityUsage.findUnique({
        where: { commitmentId: input.commitmentId },
      })
      if (existingUsage) {
        return { usageId: existingUsage.id, duplicate: true }
      }

      // Verify commitment is active (can't record usage on released/consumed).
      if (commitment.status !== 'active') {
        throw new ValidationError(
          `Cannot record usage for commitment ${input.commitmentId}: status is ${commitment.status}`,
        )
      }

      // Create the usage record.
      const usage = await tx.capacityUsage.create({
        data: {
          tenantId: input.tenantId,
          commitmentId: input.commitmentId,
          quantity: input.quantity,
          unit: input.unit,
          startTime: input.startTime,
          endTime: input.endTime,
          sourceType: input.sourceType ?? '',
          sourceId: input.sourceId ?? null,
          attestationId: input.attestationId ?? null,
        },
      })

      // Mark the commitment as consumed (terminal state).
      await tx.capacityCommitment.update({
        where: { id: input.commitmentId },
        data: { status: 'consumed', completedAt: new Date() },
      })

      return { usageId: usage.id, duplicate: false }
    }, { timeout: 30000 })

    return result
  } catch (err: any) {
    // If the unique constraint was violated (race), return the existing usage.
    if (err?.code === 'P2002') {
      const existing = await db.capacityUsage.findUnique({
        where: { commitmentId: input.commitmentId },
      })
      if (existing) {
        return { usageId: existing.id, duplicate: true }
      }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Release — return committed capacity to the reservation
// ---------------------------------------------------------------------------

/**
 * Release a commitment (dispatch cancelled/failed).
 * Returns the committed amount to the reservation's remaining.
 * This prevents stranded capacity on failed dispatches.
 *
 * CONCURRENCY-SAFE: locks the commitment FOR UPDATE inside the transaction,
 * then re-checks its status. This prevents two concurrent release calls from
 * both crediting the reservation's remaining amount.
 */
/**
 * Release a committed capacity: mark the commitment 'released' and return the
 * committed amount to the reservation's remaining.
 * This prevents stranded capacity on failed dispatches.
 *
 * CONCURRENCY-SAFE: locks the commitment FOR UPDATE inside the transaction,
 * then re-checks its status. This prevents two concurrent release calls from
 * both crediting the reservation's remaining amount.
 *
 * PHASE 12B SLICE 3 HARDENING: accepts an optional `tx` parameter. When
 * provided, the release steps run on the caller's transaction (NO inner
 * db.$transaction) — this enables atomic failure handling: the caller can
 * fail an ExecutionAssignment and release its commitment in ONE transaction,
 * eliminating the split-brain window where `assignment=failed` but
 * `commitment=active` could persist if the process crashed between two
 * separate transactions. When `tx` is omitted, the function manages its own
 * transaction (backward compatible with existing VPP/Compute callers).
 */
export async function releaseCommitment(
  tenantId: string,
  sourceType: string,
  sourceId: string,
  tx?: ExtendedTransactionClient,
): Promise<void> {
  // If a transaction client is provided, run the release steps directly on it
  // (atomic with the caller's transaction). Otherwise manage our own transaction.
  if (tx) {
    await releaseCommitmentInner(tx, tenantId, sourceType, sourceId)
    return
  }
  await db.$transaction(async (innerTx) => {
    await releaseCommitmentInner(innerTx, tenantId, sourceType, sourceId)
  })
}

/**
 * The inner release logic, parameterized by the client (tx or db).
 * Locks the commitment FOR UPDATE, re-checks status, locks the reservation
 * FOR UPDATE, restores remainingAmount, marks the commitment 'released'.
 *
 * PURE with respect to transaction management: it only uses the provided
 * client. The caller decides whether to wrap it in a transaction.
 */
async function releaseCommitmentInner(
  client: ExtendedTransactionClient,
  tenantId: string,
  sourceType: string,
  sourceId: string,
): Promise<void> {
  // Lock the commitment FOR UPDATE (concurrency-safe).
  const commitments = await client.$queryRaw<Array<{ id: string; status: string; reservationId: string; committedAmount: string }>>`
    SELECT * FROM "CapacityCommitment"
    WHERE "tenantId" = ${tenantId}
      AND "sourceType" = ${sourceType}
      AND "sourceId" = ${sourceId}
    FOR UPDATE
  `
  const commitment = commitments[0]
  if (!commitment) return
  // Re-check status inside the lock (another caller may have already released/consumed).
  if (commitment.status === 'released' || commitment.status === 'consumed') return

  // Lock the reservation FOR UPDATE.
  await client.$queryRaw`SELECT * FROM "CapacityReservation" WHERE id = ${commitment.reservationId} FOR UPDATE`

  const reservation = await client.capacityReservation.findUnique({ where: { id: commitment.reservationId } })
  if (!reservation) return

  const newRemaining = new Prisma.Decimal(reservation.remainingAmount).plus(commitment.committedAmount)
  await client.capacityReservation.update({
    where: { id: reservation.id },
    data: { remainingAmount: newRemaining.toString() },
  })

  await client.capacityCommitment.update({
    where: { id: commitment.id },
    data: { status: 'released' },
  })
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getAvailableCapacity(
  tenantId: string,
  assetId: string,
  networkId: string,
  capabilityType: string,
  startTime: Date,
  endTime: Date,
): Promise<{ physical: string; reserved: string; available: string; unit: string }> {
  const resource = await db.capacityResource.findUnique({
    where: { assetId_networkId_capabilityType: { assetId, networkId, capabilityType } },
  })
  if (!resource) {
    return { physical: '0', reserved: '0', available: '0', unit: '' }
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
    unit: resource.unit,
  }
}

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
