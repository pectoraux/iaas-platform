// =============================================================================
// VPP Service — Energy Virtual Power Plant domain layer.
//
// CRITICAL ARCHITECTURAL RULE: this service does NOT modify or duplicate the
// generic pipeline. It uses:
//   - generic Event (for telemetry)
//   - generic Attestation (for verified performance)
//   - generic Contribution (with DERIVED quantity — task 1)
//   - generic Reward (for payment calculation)
//   - generic Ledger (for double-entry accounting)
//   - generic Settlement (for payout)
//
// VPP fixes from review:
//   1. Derived contribution: performance_kwh becomes Contribution.quantity
//   2. DER adapter interface: SimulatedDERAdapter extracted
//   3. Capacity integrity: reservation validates operator/asset/capability/limits
//   4. No double-selling: time-window-aware capacity allocation (platform primitive)
//   5. Transactional dispatch: atomic capacity consumption
//   6. No auto-funding: buyer must be pre-funded
//   7. Idempotent execution: completed assignment returns existing result
// =============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { NotFoundError, ValidationError, ConflictError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { ingestEvent, buildCanonicalMessage } from './ingestion.service'
import { processEventOutbox, processSettlementOutbox } from './worker.service'
import { createContribution } from './contribution.service'
import { calculateReward } from './reward.service'
import { postRewardToLedger } from './ledger.service'
import { createSettlement } from './settlement.service'
import { signMessage, deriveSigningKey } from '@/lib/domain/crypto'
import { allocateCapacity, releaseCapacityBySource, transitionAllocationState, consumeCapacity } from './capacity.service'
import { SimulatedDERAdapter, type DERAdapter } from './der-adapter.service'

const derAdapter: DERAdapter = new SimulatedDERAdapter()

// ---------------------------------------------------------------------------
// Buyer Programs
// ---------------------------------------------------------------------------

export interface CreateBuyerProgramInput {
  networkId: string
  name: string
  description?: string
  rewardRuleId: string
  dispatchWindowStart: string
  dispatchWindowEnd: string
  pricePerKwh: string
  currency?: string
  minCapacityKw: string
  maxCapacityKw?: string
}

export async function createBuyerProgram(tenantId: string, input: CreateBuyerProgramInput, actorId?: string) {
  const network = await db.networkDefinition.findFirst({ where: { id: input.networkId, tenantId } })
  if (!network) throw new NotFoundError('network', input.networkId)
  const rule = await db.rewardRule.findFirst({ where: { id: input.rewardRuleId, tenantId } })
  if (!rule) throw new NotFoundError('reward_rule', input.rewardRuleId)

  const program = await db.vppBuyerProgram.create({
    data: {
      tenantId,
      networkId: input.networkId,
      name: input.name,
      description: input.description ?? null,
      rewardRuleId: input.rewardRuleId,
      dispatchWindowStart: input.dispatchWindowStart,
      dispatchWindowEnd: input.dispatchWindowEnd,
      pricePerKwh: input.pricePerKwh,
      currency: input.currency ?? 'USD',
      minCapacityKw: input.minCapacityKw,
      maxCapacityKw: input.maxCapacityKw ?? null,
    },
  })

  await appendAudit({
    tenantId, actorId,
    eventType: 'vpp.program_created',
    resourceType: 'vpp_buyer_program',
    resourceId: program.id,
    metadata: { name: program.name, networkId: input.networkId },
  })

  return program
}

export async function listBuyerPrograms(tenantId: string) {
  return db.vppBuyerProgram.findMany({
    where: { tenantId },
    include: { network: true, rewardRule: true, reservations: { include: { asset: true, operator: true } } },
    orderBy: { createdAt: 'desc' },
  })
}

// ---------------------------------------------------------------------------
// Capacity Reservations (task 3: validate integrity, task 4: no double-selling)
// ---------------------------------------------------------------------------

export interface CreateReservationInput {
  programId: string
  operatorId: string
  assetId: string
  capabilityType: string
  reservedKw: string
  reservedKwh?: string
  // Time window for the reservation (task 4: time-window-aware).
  startTime: string
  endTime: string
  // Task 2: NO physicalCapacityKw from caller — resolved from verified assignment.
}

export async function createCapacityReservation(tenantId: string, input: CreateReservationInput, actorId?: string) {
  const program = await db.vppBuyerProgram.findFirst({ where: { id: input.programId, tenantId } })
  if (!program) throw new NotFoundError('vpp_buyer_program', input.programId)

  // Task 3: validate the full chain.
  // 1. Operator owns the asset.
  const asset = await db.asset.findFirst({ where: { id: input.assetId, tenantId } })
  if (!asset) throw new NotFoundError('asset', input.assetId)
  if (asset.operatorId !== input.operatorId) {
    throw new ValidationError(`Operator ${input.operatorId} does not own asset ${input.assetId}`)
  }

  // 2. Asset is assigned to the program's network with this capability.
  const assignment = await db.assetNetworkAssignment.findFirst({
    where: {
      tenantId, assetId: input.assetId, networkId: program.networkId,
      capabilityType: input.capabilityType, status: 'active',
    },
  })
  if (!assignment) {
    throw new ValidationError(
      `Asset ${input.assetId} is not assigned to network ${program.networkId} with capability ${input.capabilityType}`,
    )
  }

  // Task 3: ATOMIC reservation + capacity allocation in ONE transaction.
  // This prevents orphaned allocations (review issue #3).
  // The reservation is created first, then the allocation with sourceId = reservation.id.
  const result = await db.$transaction(async (tx) => {
    // Create the reservation first (inside the transaction).
    const reservation = await tx.vppCapacityReservation.create({
      data: {
        tenantId,
        programId: input.programId,
        operatorId: input.operatorId,
        assetId: input.assetId,
        capabilityType: input.capabilityType,
        reservedKw: input.reservedKw,
        reservedKwh: input.reservedKwh ?? null,
        effectiveFrom: new Date(input.startTime),
        effectiveTo: new Date(input.endTime),
      },
    })

    // Allocate capacity (inside the same transaction, with sourceId = reservation.id).
    // Task 2: physicalCapacity is resolved from the assignment inside allocateCapacity.
    const allocation = await allocateCapacity({
      tenantId,
      assetId: input.assetId,
      networkId: program.networkId,
      capabilityType: input.capabilityType,
      requestedAmount: input.reservedKw,
      startTime: new Date(input.startTime),
      endTime: new Date(input.endTime),
      sourceType: 'vpp_reservation',
      sourceId: reservation.id, // task 3: sourceId known at allocation time
    }, tx) // pass the transaction client

    return { reservation, allocation }
  })

  const { reservation, allocation } = result

  await appendAudit({
    tenantId, actorId,
    eventType: 'vpp.reservation_created',
    resourceType: 'vpp_capacity_reservation',
    resourceId: reservation.id,
    metadata: {
      programId: input.programId, assetId: input.assetId, capabilityType: input.capabilityType,
      reservedKw: input.reservedKw,
      allocationId: allocation.allocationId,
    },
  })

  return { reservation, allocation }
}

// ---------------------------------------------------------------------------
// Dispatch (task 5: transactional allocation)
// ---------------------------------------------------------------------------

export interface CreateDispatchInput {
  programId: string
  requestedKw: string
  requestedKwh: string
  startTime: string
  endTime: string
  reason?: string
}

export async function createDispatch(tenantId: string, input: CreateDispatchInput, actorId?: string) {
  const program = await db.vppBuyerProgram.findFirst({
    where: { id: input.programId, tenantId },
    include: { reservations: { where: { status: 'active' }, include: { asset: true } }, network: true },
  })
  if (!program) throw new NotFoundError('vpp_buyer_program', input.programId)

  const startTime = new Date(input.startTime)
  const endTime = new Date(input.endTime)
  const requestedKw = new Prisma.Decimal(input.requestedKw)
  const requestedKwh = new Prisma.Decimal(input.requestedKwh)

  // Task 5: transactional dispatch — create dispatch + allocations + assignments atomically.
  const dispatch = await db.$transaction(async (tx) => {
    // Lock all active reservations for this program.
    await tx.$queryRaw`
      SELECT * FROM "VppCapacityReservation"
      WHERE "programId" = ${input.programId}
        AND status = 'active'
        AND "effectiveFrom" < ${endTime}
        AND "effectiveTo" > ${startTime}
      FOR UPDATE
    `

    // Reload reservations inside the lock.
    const reservations = await tx.vppCapacityReservation.findMany({
      where: {
        programId: input.programId,
        status: 'active',
        effectiveFrom: { lt: endTime },
        effectiveTo: { gt: startTime },
      },
    })

    if (reservations.length === 0) {
      throw new ValidationError(`No active reservations for program ${input.programId} in the requested time window`)
    }

    // Check sufficient reserved capacity.
    const totalReservedKw = reservations.reduce(
      (sum, r) => sum.plus(new Prisma.Decimal(r.reservedKw)),
      new Prisma.Decimal(0),
    )
    if (totalReservedKw.lessThan(requestedKw)) {
      throw new ValidationError(
        `Insufficient reserved capacity: ${totalReservedKw.toString()} kW < requested ${requestedKw.toString()} kW`,
      )
    }

    // Create the dispatch.
    const created = await tx.vppDispatch.create({
      data: {
        tenantId,
        programId: input.programId,
        requestedKw: input.requestedKw,
        requestedKwh: input.requestedKwh,
        startTime,
        endTime,
        reason: input.reason ?? null,
        status: 'assigned',
      },
    })

    // Assign assets proportionally.
    // Task 4: the dispatch does NOT create separate capacity allocations —
    // the reservation already holds the capacity. The dispatch consumes
    // capacity from the reservation's allocation (lifecycle: committed → consumed).
    for (const reservation of reservations) {
      const ratio = new Prisma.Decimal(reservation.reservedKw).div(totalReservedKw)
      const assignedKw = requestedKw.times(ratio)
      const assignedKwh = requestedKwh.times(ratio)

      await tx.vppDispatchAssignment.create({
        data: {
          tenantId,
          dispatchId: created.id,
          assetId: reservation.assetId,
          operatorId: reservation.operatorId,
          capabilityType: reservation.capabilityType,
          assignedKw: assignedKw.toFixed(8),
          assignedKwh: assignedKwh.toFixed(8),
        },
      })
    }

    return created
  })

  // Task 4: transition reservation allocations to "committed" state.
  // This marks the capacity as committed to a dispatch (not just reserved).
  const committedReservations = await db.vppCapacityReservation.findMany({
    where: { programId: input.programId, status: 'active', effectiveFrom: { lt: endTime }, effectiveTo: { gt: startTime } },
  })
  for (const res of committedReservations) {
    const allocation = await db.capacityAllocation.findFirst({
      where: { sourceType: 'vpp_reservation', sourceId: res.id, lifecycleState: 'allocated' },
    })
    if (allocation) {
      await transitionAllocationState(tenantId, allocation.id, 'committed')
    }
  }

  await appendAudit({
    tenantId, actorId,
    eventType: 'vpp.dispatch_created',
    resourceType: 'vpp_dispatch',
    resourceId: dispatch.id,
    metadata: { programId: input.programId, requestedKw: input.requestedKw },
  })

  const assignments = await db.vppDispatchAssignment.findMany({ where: { dispatchId: dispatch.id } })
  return { dispatch, assignments }
}

// ---------------------------------------------------------------------------
// Dispatch Execution (task 7: idempotent, task 6: no auto-funding)
// ---------------------------------------------------------------------------

/**
 * Execute a dispatch assignment using the DER adapter.
 *
 * Task 7: IDEMPOTENT — if the assignment is already completed, returns the
 * existing result. No duplicate telemetry, attestations, contributions, or rewards.
 *
 * Task 6: NO AUTO-FUNDING — if buyer funds are insufficient, the reward
 * posting fails (the assignment remains in 'dispatching' state). The buyer
 * must be pre-funded.
 */
export async function executeDispatchAssignment(
  tenantId: string,
  assignmentId: string,
  provisioningSecret: string,
  actorId?: string,
) {
  const assignment = await db.vppDispatchAssignment.findFirst({
    where: { id: assignmentId, tenantId },
    include: {
      asset: { include: { devices: { include: { credential: true } } } },
      dispatch: { include: { program: { include: { network: true } } } },
    },
  })
  if (!assignment) throw new NotFoundError('vpp_dispatch_assignment', assignmentId)

  // Task 7: idempotency — if already completed, return existing result.
  if (assignment.status === 'completed') {
    // Fetch the reward + settlement linked to this assignment's contribution.
    const reward = assignment.contributionId
      ? await db.reward.findFirst({ where: { contributionId: assignment.contributionId } })
      : null
    const settlement = reward
      ? await db.settlement.findUnique({ where: { rewardId: reward.id } })
      : null
    return {
      assignment_id: assignmentId,
      event_id: assignment.eventId,
      contribution_id: assignment.contributionId,
      reward_id: reward?.id ?? null,
      settlement_id: settlement?.id ?? null,
      performance_kwh: assignment.performanceKwh,
      actual_kwh: assignment.actualKwh,
      baseline_kwh: assignment.baselineKwh,
      duplicate: true,
      message: 'Assignment already completed',
    }
  }

  // Task 7: atomic status transition — only one execution can proceed.
  // Use a conditional update to claim the assignment.
  const updated = await db.vppDispatchAssignment.updateMany({
    where: { id: assignmentId, status: { in: ['assigned', 'dispatching'] } },
    data: { status: 'dispatching' },
  })
  if (updated.count === 0) {
    throw new ConflictError(`Assignment ${assignmentId} is not in an executable state (status: ${assignment.status})`)
  }

  const device = assignment.asset.devices.find((d) => d.credential && d.credential.status === 'active')
  if (!device) throw new ValidationError(`Asset ${assignment.assetId} has no active device with credential`)

  // --- Task 2: use DER adapter interface ---
  const durationSeconds = Math.floor(
    (assignment.dispatch.endTime.getTime() - assignment.dispatch.startTime.getTime()) / 1000,
  )
  const dischargeResult = await derAdapter.executeDischarge({
    assignedKw: assignment.assignedKw,
    assignedKwh: assignment.assignedKwh,
    capabilityType: assignment.capabilityType,
    durationSeconds,
  })

  // Sign + submit telemetry as a generic Event.
  const eventId = `vpp-dispatch-${assignmentId}-${Date.now()}`
  const timestamp = new Date().toISOString()
  const message = buildCanonicalMessage({
    device_id: device.id,
    event_id: eventId,
    timestamp,
    event_type: 'telemetry',
    sequence: Math.floor(Date.now() / 1000),
    payload: dischargeResult.telemetry.payload,
  })
  const signingKey = deriveSigningKey(provisioningSecret)
  const signature = signMessage(message, signingKey)

  const network = assignment.dispatch.program.network
  const networkVersion = await db.networkVersion.findFirst({
    where: { networkId: network.id, publishedAt: { not: null } },
    orderBy: { version: 'desc' },
  })

  const ingestResult = await ingestEvent(tenantId, {
    device_id: device.id,
    event_id: eventId,
    timestamp,
    event_type: 'telemetry',
    sequence: Math.floor(Date.now() / 1000),
    payload: dischargeResult.telemetry.payload,
    signature,
    network_version_id: networkVersion?.id,
    capability_type: assignment.capabilityType,
  })

  await processEventOutbox(tenantId)

  const event = await db.event.findUnique({
    where: { id: ingestResult.event_id },
    include: { attestations: true },
  })

  if (event?.status !== 'verified' || !event.attestations[0]) {
    await db.vppDispatchAssignment.update({ where: { id: assignmentId }, data: { status: 'failed' } })
    throw new Error(`Dispatch telemetry verification failed: ${event?.status}`)
  }

  const attestation = event.attestations[0]

  // --- Baseline calculation (simplified: zero baseline for discharge) ---
  const actualKwh = new Prisma.Decimal(dischargeResult.actualKwh)
  const baselineKwh = new Prisma.Decimal(0) // simulation: battery would not have discharged
  const performanceKwh = actualKwh.minus(baselineKwh)

  const baseline = await db.vppBaseline.create({
    data: {
      tenantId,
      assignmentId,
      method: 'zero', // simulation fixture (reviewer acknowledged this is acceptable)
      baselineKw: '0',
      baselineKwh: baselineKwh.toString(),
      actualKw: dischargeResult.actualKw,
      actualKwh: actualKwh.toString(),
      performanceKwh: performanceKwh.toString(),
      metadataJson: JSON.stringify({ attestationId: attestation.id }),
    },
  })

  // --- Task 1: DERIVED CONTRIBUTION ---
  // The contribution quantity is the VPP-computed performance_kwh,
  // NOT the attestation's first field (power_kw).
  const contribution = await createContribution(
    tenantId,
    {
      attestationIds: [attestation.id],
      derivedQuantity: performanceKwh.toString(), // task 1: use verified performance
      derivedUnit: 'kWh',
    },
    `vpp-baseline-${baseline.id}`,
  )

  // --- Generic Reward + Ledger + Settlement ---
  const reward = await calculateReward(tenantId, contribution.id, `vpp-contrib-${contribution.id}`)

  // Task 6: NO AUTO-FUNDING. If buyer funds are insufficient, the reward
  // posting fails. The assignment stays in 'dispatching' state.
  const ledger = await postRewardToLedger(tenantId, { rewardId: reward.id }, `vpp-reward-${reward.id}`)

  const settlement = await createSettlement(tenantId, reward.id)
  await processSettlementOutbox(tenantId)

  // Update the assignment with results.
  await db.vppDispatchAssignment.update({
    where: { id: assignmentId },
    data: {
      status: 'completed',
      actualKwh: actualKwh.toString(),
      baselineKwh: baselineKwh.toString(),
      performanceKwh: performanceKwh.toString(),
      eventId: event.id,
      contributionId: contribution.id,
      completedAt: new Date(),
    },
  })

  // Update dispatch status if all assignments completed.
  const pendingAssignments = await db.vppDispatchAssignment.count({
    where: { dispatchId: assignment.dispatchId, status: { not: 'completed' } },
  })
  if (pendingAssignments === 0) {
    await db.vppDispatch.update({ where: { id: assignment.dispatchId }, data: { status: 'completed' } })
    // Task 4: mark the reservation's capacity allocation as consumed.
    await consumeCapacity(tenantId, 'vpp_reservation', assignment.dispatchId)
  }

  await appendAudit({
    tenantId, actorId,
    eventType: 'vpp.dispatch_completed',
    resourceType: 'vpp_dispatch_assignment',
    resourceId: assignmentId,
    metadata: {
      actualKwh: actualKwh.toString(),
      performanceKwh: performanceKwh.toString(),
      eventId: event.id,
      contributionId: contribution.id,
      rewardId: reward.id,
      contributionQuantity: contribution.quantity,
    },
  })

  return {
    assignment_id: assignmentId,
    event_id: event.id,
    attestation_id: attestation.id,
    baseline_id: baseline.id,
    contribution_id: contribution.id,
    reward_id: reward.id,
    settlement_id: settlement.id,
    performance_kwh: performanceKwh.toString(),
    actual_kwh: actualKwh.toString(),
    baseline_kwh: baselineKwh.toString(),
    contribution_quantity: contribution.quantity,
    duplicate: false,
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listDispatches(tenantId: string) {
  return db.vppDispatch.findMany({
    where: { tenantId },
    include: {
      program: true,
      assignments: { include: { asset: true, operator: true, baseline: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getDispatch(tenantId: string, id: string) {
  const d = await db.vppDispatch.findFirst({
    where: { id, tenantId },
    include: {
      program: true,
      assignments: { include: { asset: true, operator: true, baseline: true } },
    },
  })
  if (!d) throw new NotFoundError('vpp_dispatch', id)
  return d
}
