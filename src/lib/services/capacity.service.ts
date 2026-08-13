// =============================================================================
// Capacity Allocation Service — PLATFORM-LEVEL primitive.
//
// Extracted from the VPP because capacity allocation is needed across ALL
// verticals:
//   VPP:        10 kW → Event A: 6 kW → Event B: 4 kW → 0 available
//   Storage:    100 TB → Project A: 70 TB → 30 TB available
//   Compute:    16 GPU-hours → Project A: 6 → Project B: 5 → 5 available
//   Wireless:   1 Gbps → Network A: 400 Mbps → Network B: 300 Mbps → 300 available
//
// This service enforces the invariant: the sum of active allocations for
// overlapping time windows CANNOT exceed the asset's verified physical capacity.
//
// Concurrency-safe: uses SELECT FOR UPDATE on the CapacityAllocation rows
// for the asset+capability+time-window to prevent two concurrent allocations
// from both passing the capacity check.
// =============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { NotFoundError, ValidationError, ConflictError } from '@/lib/domain/errors'

export interface AllocateCapacityInput {
  tenantId: string
  assetId: string
  networkId: string
  capabilityType: string
  physicalCapacity: string // the verified max capacity of the asset
  requestedAmount: string  // how much to allocate
  startTime: Date
  endTime: Date
  sourceType: string       // vpp_reservation | vpp_dispatch | ...
  sourceId?: string
}

export interface AllocateCapacityResult {
  allocationId: string
  physicalCapacity: string
  allocatedAmount: string
  availableCapacity: string // remaining after this allocation
  duplicate: boolean
}

/**
 * Allocate capacity for an asset's capability in a time window.
 *
 * CONCURRENCY-SAFE (task 4): uses SELECT FOR UPDATE on existing overlapping
 * allocations. Two concurrent allocations for the same asset+capability+window
 * cannot both pass the capacity check.
 *
 * Invariant: SUM(active allocations overlapping [startTime, endTime]) <= physicalCapacity
 */
export async function allocateCapacity(input: AllocateCapacityInput): Promise<AllocateCapacityResult> {
  const physical = new Prisma.Decimal(input.physicalCapacity)
  const requested = new Prisma.Decimal(input.requestedAmount)

  if (physical.lte(0)) {
    throw new ValidationError(`Physical capacity must be positive, got ${input.physicalCapacity}`)
  }
  if (requested.lte(0)) {
    throw new ValidationError(`Requested amount must be positive, got ${input.requestedAmount}`)
  }
  if (requested.greaterThan(physical)) {
    throw new ValidationError(
      `Requested ${requested.toString()} exceeds physical capacity ${physical.toString()}`,
    )
  }

  // Idempotency: if an allocation with the same sourceType+sourceId exists, return it.
  if (input.sourceId) {
    const existing = await db.capacityAllocation.findFirst({
      where: { tenantId: input.tenantId, sourceType: input.sourceType, sourceId: input.sourceId, status: 'active' },
    })
    if (existing) {
      return {
        allocationId: existing.id,
        physicalCapacity: existing.physicalCapacity,
        allocatedAmount: existing.allocatedAmount,
        availableCapacity: physical.minus(existing.allocatedAmount).toString(),
        duplicate: true,
      }
    }
  }

  // CONCURRENCY-SAFE: lock all overlapping allocations for this asset+capability.
  // This prevents two concurrent allocations from both reading the same
  // available capacity and over-committing.
  return await db.$transaction(async (tx) => {
    // Lock overlapping active allocations.
    await tx.$queryRaw`
      SELECT * FROM "CapacityAllocation"
      WHERE "assetId" = ${input.assetId}
        AND "capabilityType" = ${input.capabilityType}
        AND status = 'active'
        AND "startTime" < ${input.endTime}
        AND "endTime" > ${input.startTime}
      FOR UPDATE
    `

    // Compute currently allocated (overlapping).
    const overlapping = await tx.capacityAllocation.findMany({
      where: {
        tenantId: input.tenantId,
        assetId: input.assetId,
        capabilityType: input.capabilityType,
        status: 'active',
        startTime: { lt: input.endTime },
        endTime: { gt: input.startTime },
      },
    })
    const alreadyAllocated = overlapping.reduce(
      (sum, a) => sum.plus(new Prisma.Decimal(a.allocatedAmount)),
      new Prisma.Decimal(0),
    )
    const available = physical.minus(alreadyAllocated)

    if (requested.greaterThan(available)) {
      throw new ValidationError(
        `Insufficient capacity: requested ${requested.toString()}, available ${available.toString()} (physical ${physical.toString()}, already allocated ${alreadyAllocated.toString()})`,
      )
    }

    // Create the allocation.
    const allocation = await tx.capacityAllocation.create({
      data: {
        tenantId: input.tenantId,
        assetId: input.assetId,
        networkId: input.networkId,
        capabilityType: input.capabilityType,
        physicalCapacity: input.physicalCapacity,
        allocatedAmount: input.requestedAmount,
        startTime: input.startTime,
        endTime: input.endTime,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        status: 'active',
      },
    })

    return {
      allocationId: allocation.id,
      physicalCapacity: allocation.physicalCapacity,
      allocatedAmount: allocation.allocatedAmount,
      availableCapacity: available.minus(requested).toString(),
      duplicate: false,
    }
  })
}

/**
 * Release a capacity allocation (e.g. when a dispatch is cancelled).
 */
export async function releaseCapacity(tenantId: string, allocationId: string): Promise<void> {
  await db.capacityAllocation.updateMany({
    where: { id: allocationId, tenantId },
    data: { status: 'released' },
  })
}

/**
 * Release all allocations for a given source (e.g. when a dispatch is cancelled).
 */
export async function releaseCapacityBySource(tenantId: string, sourceType: string, sourceId: string): Promise<void> {
  await db.capacityAllocation.updateMany({
    where: { tenantId, sourceType, sourceId, status: 'active' },
    data: { status: 'released' },
  })
}

/**
 * Get the available capacity for an asset+capability in a time window.
 * Used for validation before creating reservations/dispatches.
 */
export async function getAvailableCapacity(
  tenantId: string,
  assetId: string,
  capabilityType: string,
  startTime: Date,
  endTime: Date,
): Promise<{ physical: string; allocated: string; available: string }> {
  // Find the physical capacity from existing allocations (or return 0 if none).
  const allocations = await db.capacityAllocation.findMany({
    where: { tenantId, assetId, capabilityType, status: 'active' },
  })
  if (allocations.length === 0) {
    return { physical: '0', allocated: '0', available: '0' }
  }
  const physical = new Prisma.Decimal(allocations[0].physicalCapacity)

  const overlapping = allocations.filter(
    (a) => a.startTime < endTime && a.endTime > startTime,
  )
  const allocated = overlapping.reduce(
    (sum, a) => sum.plus(new Prisma.Decimal(a.allocatedAmount)),
    new Prisma.Decimal(0),
  )
  const available = physical.minus(allocated)

  return {
    physical: physical.toString(),
    allocated: allocated.toString(),
    available: available.toString(),
  }
}
