// =============================================================================
// VPP Service — Energy Virtual Power Plant domain layer.
//
// CRITICAL ARCHITECTURAL RULE: this service does NOT modify or duplicate the
// generic pipeline. It uses:
//   - generic Event (for telemetry)
//   - generic Attestation (for verified performance)
//   - generic Contribution (for kWh delivered)
//   - generic Reward (for payment calculation)
//   - generic Ledger (for double-entry accounting)
//   - generic Settlement (for payout)
//
// The VPP layer owns:
//   - VppBuyerProgram (commercial terms)
//   - VppCapacityReservation (operator commits capacity)
//   - VppDispatch (buyer requests discharge)
//   - VppDispatchAssignment (which asset discharges how much)
//   - VppBaseline (actual vs baseline = performance)
//
// The flow:
//   1. Create buyer program (references generic RewardRule)
//   2. Operators reserve capacity (VppCapacityReservation)
//   3. Buyer requests dispatch (VppDispatch)
//   4. Platform assigns assets (VppDispatchAssignment)
//   5. Simulated DER adapter generates discharge telemetry → generic Event
//   6. Worker verifies → generic Attestation
//   7. Baseline engine computes performance → generic Contribution
//   8. Reward engine calculates → generic Reward
//   9. Ledger posts → generic LedgerPosting
//  10. Settlement worker pays → generic Settlement
// =============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { NotFoundError, ValidationError, ConflictError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { ingestEvent, buildCanonicalMessage } from './ingestion.service'
import { processEventOutbox } from './worker.service'
import { createContribution } from './contribution.service'
import { calculateReward } from './reward.service'
import { postRewardToLedger, recordBuyerFunding } from './ledger.service'
import { createSettlement } from './settlement.service'
import { processSettlementOutbox } from './worker.service'
import { signMessage, deriveSigningKey } from '@/lib/domain/crypto'
import { getPublishedConfiguration } from './network.service'

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
  // Validate network + reward rule belong to tenant.
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
// Capacity Reservations
// ---------------------------------------------------------------------------

export interface CreateReservationInput {
  programId: string
  operatorId: string
  assetId: string
  capabilityType: string
  reservedKw: string
  reservedKwh?: string
}

export async function createCapacityReservation(tenantId: string, input: CreateReservationInput, actorId?: string) {
  const program = await db.vppBuyerProgram.findFirst({ where: { id: input.programId, tenantId } })
  if (!program) throw new NotFoundError('vpp_buyer_program', input.programId)

  const reservation = await db.vppCapacityReservation.create({
    data: {
      tenantId,
      programId: input.programId,
      operatorId: input.operatorId,
      assetId: input.assetId,
      capabilityType: input.capabilityType,
      reservedKw: input.reservedKw,
      reservedKwh: input.reservedKwh ?? null,
    },
  })

  await appendAudit({
    tenantId, actorId,
    eventType: 'vpp.reservation_created',
    resourceType: 'vpp_capacity_reservation',
    resourceId: reservation.id,
    metadata: { programId: input.programId, assetId: input.assetId, capabilityType: input.capabilityType, reservedKw: input.reservedKw },
  })

  return reservation
}

// ---------------------------------------------------------------------------
// Dispatch
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
    include: { reservations: { where: { status: 'active' }, include: { asset: true } } },
  })
  if (!program) throw new NotFoundError('vpp_buyer_program', input.programId)

  // Check sufficient reserved capacity.
  const totalReservedKw = program.reservations.reduce(
    (sum, r) => sum.plus(new Prisma.Decimal(r.reservedKw)),
    new Prisma.Decimal(0),
  )
  if (totalReservedKw.lessThan(new Prisma.Decimal(input.requestedKw))) {
    throw new ValidationError(
      `Insufficient reserved capacity: ${totalReservedKw.toString()} kW < requested ${input.requestedKw} kW`,
    )
  }

  const dispatch = await db.vppDispatch.create({
    data: {
      tenantId,
      programId: input.programId,
      requestedKw: input.requestedKw,
      requestedKwh: input.requestedKwh,
      startTime: new Date(input.startTime),
      endTime: new Date(input.endTime),
      reason: input.reason ?? null,
    },
  })

  // Assign assets proportionally (simple: distribute by reserved capacity ratio).
  const requestedKw = new Prisma.Decimal(input.requestedKw)
  const assignments: Array<{ id: string; assetId: string; assignedKw: string; assignedKwh: string }> = []
  for (const reservation of program.reservations) {
    const ratio = new Prisma.Decimal(reservation.reservedKw).div(totalReservedKw)
    const assignedKw = requestedKw.times(ratio)
    const assignedKwh = new Prisma.Decimal(input.requestedKwh).times(ratio)
    const assignment = await db.vppDispatchAssignment.create({
      data: {
        tenantId,
        dispatchId: dispatch.id,
        assetId: reservation.assetId,
        operatorId: reservation.operatorId,
        capabilityType: reservation.capabilityType,
        assignedKw: assignedKw.toFixed(8),
        assignedKwh: assignedKwh.toFixed(8),
      },
    })
    assignments.push({ id: assignment.id, assetId: reservation.assetId, assignedKw: assignedKw.toString(), assignedKwh: assignedKwh.toString() })
  }

  await db.vppDispatch.update({ where: { id: dispatch.id }, data: { status: 'assigned' } })

  await appendAudit({
    tenantId, actorId,
    eventType: 'vpp.dispatch_created',
    resourceType: 'vpp_dispatch',
    resourceId: dispatch.id,
    metadata: { programId: input.programId, requestedKw: input.requestedKw, assignments: assignments.length },
  })

  return { dispatch: { ...dispatch, status: 'assigned' }, assignments }
}

// ---------------------------------------------------------------------------
// Simulated DER Adapter + Dispatch Execution
// ---------------------------------------------------------------------------

/**
 * Execute a dispatch assignment using a SIMULATED DER adapter.
 *
 * The simulated adapter:
 *   1. Generates discharge telemetry (power_kw, energy_kwh, state_of_charge_pct)
 *   2. Signs it with the device's credential
 *   3. Submits it as a generic Event via the generic ingestion API
 *   4. The worker verifies it → creates a generic Attestation
 *   5. The baseline engine computes performance (actual - baseline)
 *   6. A generic Contribution is created from the performance
 *   7. The generic Reward + Ledger + Settlement pipeline runs
 *
 * This proves the VPP can use the generic platform end-to-end.
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

  const device = assignment.asset.devices.find((d) => d.credential && d.credential.status === 'active')
  if (!device) throw new ValidationError(`Asset ${assignment.assetId} has no active device with credential`)

  // Mark assignment as dispatching.
  await db.vppDispatchAssignment.update({ where: { id: assignmentId }, data: { status: 'dispatching' } })

  // --- Simulated DER adapter: generate discharge telemetry ---
  // In a real adapter, this would come from the hardware vendor API.
  // Here we simulate: actual discharge ≈ assigned (with small variance).
  const assignedKwh = new Prisma.Decimal(assignment.assignedKwh)
  const actualKwh = assignedKwh.times(new Prisma.Decimal('0.98')) // 98% efficiency
  const actualKw = new Prisma.Decimal(assignment.assignedKw).times(new Prisma.Decimal('0.98'))
  const stateOfCharge = 65 // percent after discharge

  const payload = {
    power_kw: parseFloat(actualKw.toString()),
    available_energy_kwh: parseFloat(actualKwh.toString()),
    state_of_charge_pct: stateOfCharge,
  }

  // Sign the telemetry with the device's credential.
  const eventId = `vpp-dispatch-${assignmentId}-${Date.now()}`
  const timestamp = new Date().toISOString()
  const message = buildCanonicalMessage({
    device_id: device.id,
    event_id: eventId,
    timestamp,
    event_type: 'telemetry',
    sequence: Math.floor(Date.now() / 1000),
    payload,
  })
  const signingKey = deriveSigningKey(provisioningSecret)
  const signature = signMessage(message, signingKey)

  // Submit as a generic Event (uses the generic ingestion API).
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
    payload,
    signature,
    network_version_id: networkVersion?.id,
    capability_type: assignment.capabilityType,
  })

  // Process the outbox (runs verification → creates attestation).
  await processEventOutbox(tenantId)

  // Reload the event to get the attestation.
  const event = await db.event.findUnique({
    where: { id: ingestResult.event_id },
    include: { attestations: true },
  })

  if (event?.status !== 'verified' || !event.attestations[0]) {
    throw new Error(`Dispatch telemetry verification failed: ${event?.status}`)
  }

  const attestation = event.attestations[0]

  // --- Baseline engine: compute performance ---
  // For the simulation: baseline = 0 (battery would not have discharged without dispatch).
  // Performance = actual - baseline = actual.
  const baselineKwh = new Prisma.Decimal(0)
  const performanceKwh = actualKwh.minus(baselineKwh)

  const baseline = await db.vppBaseline.create({
    data: {
      tenantId,
      assignmentId,
      method: 'zero', // simplified: baseline is zero for discharge events
      baselineKw: '0',
      baselineKwh: baselineKwh.toString(),
      actualKw: actualKw.toString(),
      actualKwh: actualKwh.toString(),
      performanceKwh: performanceKwh.toString(),
      metadataJson: JSON.stringify({ attestationId: attestation.id }),
    },
  })

  // --- Create generic Contribution from performance ---
  // The contribution quantity is the performance kWh (verified energy delivered).
  const contribution = await createContribution(
    tenantId,
    { attestationIds: [attestation.id] },
    `vpp-baseline-${baseline.id}`,
  )

  // --- Generic Reward + Ledger + Settlement ---
  const reward = await calculateReward(tenantId, contribution.id, `vpp-contrib-${contribution.id}`)

  // Fund the buyer (if not already funded) + post to ledger.
  try {
    await postRewardToLedger(tenantId, { rewardId: reward.id }, `vpp-reward-${reward.id}`)
  } catch (err) {
    if (err instanceof ValidationError && err.message.includes('Insufficient buyer funding')) {
      // Auto-fund the buyer for the demo.
      const gross = new Prisma.Decimal(reward.calculation.gross)
      await recordBuyerFunding(tenantId, gross.plus(1000).toString(), `vpp-funding-${Date.now()}`)
      await postRewardToLedger(tenantId, { rewardId: reward.id }, `vpp-reward-${reward.id}`)
    } else {
      throw err
    }
  }

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

  // Update dispatch status if all assignments are completed.
  const pendingAssignments = await db.vppDispatchAssignment.count({
    where: { dispatchId: assignment.dispatchId, status: { not: 'completed' } },
  })
  if (pendingAssignments === 0) {
    await db.vppDispatch.update({ where: { id: assignment.dispatchId }, data: { status: 'completed' } })
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
