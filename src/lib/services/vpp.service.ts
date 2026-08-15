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
import { processEventOutbox, processSettlementOutbox, processSettlementForReward } from './worker.service'
import { createContribution } from './contribution.service'
import { calculateReward } from './reward.service'
import { postRewardToLedger } from './ledger.service'
import { createSettlement } from './settlement.service'
import { signMessage, deriveSigningKey } from '@/lib/domain/crypto'
import {
  createCapacityReservation as allocateReservation,
  createCapacityCommitment,
  recordUsage,
  releaseCommitment,
  findReservationBySource,
} from './capacity.service'
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

  // ATOMIC: VPP reservation + capacity reservation in ONE transaction.
  // The VPP reservation is created first, then the platform capacity
  // reservation with sourceId = vppReservation.id.
  const result = await db.$transaction(async (tx) => {
    // Create the VPP reservation first (inside the transaction).
    const vppReservation = await tx.vppCapacityReservation.create({
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

    // Create the platform capacity reservation (inside the same transaction).
    // Physical capacity is resolved from the verified assignment.
    const capacityReservation = await allocateReservation({
      tenantId,
      assetId: input.assetId,
      networkId: program.networkId,
      capabilityType: input.capabilityType,
      requestedAmount: input.reservedKw,
      startTime: new Date(input.startTime),
      endTime: new Date(input.endTime),
      sourceType: 'vpp_reservation',
      sourceId: vppReservation.id,
    }, tx)

    return { vppReservation, capacityReservation }
  }, { timeout: 30000 })

  const { vppReservation, capacityReservation } = result

  await appendAudit({
    tenantId, actorId,
    eventType: 'vpp.reservation_created',
    resourceType: 'vpp_capacity_reservation',
    resourceId: vppReservation.id,
    metadata: {
      programId: input.programId, assetId: input.assetId, capabilityType: input.capabilityType,
      reservedKw: input.reservedKw,
      capacityReservationId: capacityReservation.reservationId,
    },
  })

  return { reservation: vppReservation, capacityReservation }
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

    // Assign assets proportionally + create capacity commitments (atomic).
    // Fix 1: each assignment creates its OWN CapacityCommitment (1:1).
    // The commitmentId is stored on the assignment for direct lookup.
    for (const reservation of reservations) {
      const ratio = new Prisma.Decimal(reservation.reservedKw).div(totalReservedKw)
      const assignedKw = requestedKw.times(ratio)
      const assignedKwh = requestedKwh.times(ratio)

      // Find the platform capacity reservation for this VPP reservation (inside tx).
      const capacityReservation = await tx.capacityReservation.findFirst({
        where: { tenantId, sourceType: 'vpp_reservation', sourceId: reservation.id, status: 'active' },
      })

      let commitmentId: string | null = null
      if (capacityReservation) {
        // Create a capacity commitment for THIS assignment (not the dispatch).
        const commitment = await createCapacityCommitment({
          tenantId,
          reservationId: capacityReservation.id,
          committedAmount: assignedKw.toFixed(8),
          unit: 'kW',
          startTime,
          endTime,
          sourceType: 'vpp_dispatch_assignment',
          sourceId: `assignment-${created.id}-${reservation.assetId}`, // unique per assignment
        }, tx)
        commitmentId = commitment.commitmentId
      }

      // Store the commitmentId on the assignment for direct lookup.
      await tx.vppDispatchAssignment.create({
        data: {
          tenantId,
          dispatchId: created.id,
          assetId: reservation.assetId,
          operatorId: reservation.operatorId,
          capabilityType: reservation.capabilityType,
          assignedKw: assignedKw.toFixed(8),
          assignedKwh: assignedKwh.toFixed(8),
          capacityCommitmentId: commitmentId,
        },
      })
    }

    return created
  }, { timeout: 30000 })

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

  // Fix 2: atomic status transition — ONLY 'assigned' can transition to 'dispatching'.
  const updated = await db.vppDispatchAssignment.updateMany({
    where: { id: assignmentId, status: 'assigned' },
    data: { status: 'dispatching' },
  })
  if (updated.count === 0) {
    throw new ConflictError(`Assignment ${assignmentId} is not in 'assigned' state (current: ${assignment.status}). Concurrent execution rejected.`)
  }

  // State machine:
  //   ASSIGNED → DISPATCHING → DELIVERY_VERIFIED → USAGE_RECORDED → SETTLEMENT_PENDING → COMPLETED
  //   Pre-usage failure: → FAILED → commitment RELEASED (no money moved)
  //   Post-usage failure: → RECONCILIATION_REQUIRED → commitment stays CONSUMED (liability exists)
  const releaseAssignmentCapacity = async () => {
    if (assignment.capacityCommitmentId) {
      await releaseCommitment(tenantId, 'vpp_dispatch_assignment', `assignment-${assignment.dispatchId}-${assignment.assetId}`)
    }
  }

  // Pre-usage failure: release capacity (no irreversible action has occurred).
  const failAssignment = async () => {
    await db.vppDispatchAssignment.update({ where: { id: assignmentId }, data: { status: 'failed' } })
    await releaseAssignmentCapacity()
  }

  // Post-usage failure: capacity is CONSUMED, money may have moved.
  // Do NOT release. Enter reconciliation state for retry.
  const markReconciliationRequired = async (reason: string) => {
    await db.vppDispatchAssignment.update({
      where: { id: assignmentId },
      data: { status: 'reconciliation_required' },
    })
    await appendAudit({
      tenantId, actorId,
      eventType: 'vpp.reconciliation_required',
      resourceType: 'vpp_dispatch_assignment',
      resourceId: assignmentId,
      metadata: { reason, commitmentId: assignment.capacityCommitmentId },
    })
  }

  // Track whether usage has been recorded (determines failure handling).
  let usageRecorded = false

  try {
    const device = assignment.asset.devices.find((d) => d.credential && d.credential.status === 'active')
    if (!device) {
      throw new ValidationError(`Asset ${assignment.assetId} has no active device with credential`)
    }

    // --- DER adapter (can throw on network/hardware errors) ---
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
    const sequence = Math.floor(Date.now() / 1000)
    const message = buildCanonicalMessage({
      device_id: device.id,
      event_id: eventId,
      timestamp,
      event_type: 'telemetry',
      sequence,
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
      sequence,
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
      throw new Error(`Dispatch telemetry verification failed: ${event?.status}`)
    }

    const attestation = event.attestations[0]

    // --- Baseline calculation (VPP-2C: production baseline via HistoricalTelemetryProvider) ---
    // FIX: Uses BaselineContext (production input) — NEVER ground truth.
    // FIX: Resolves strategy from persisted policy (not hardcoded).
    // FIX: Prevents negative performance payments: max(0, actual - baseline).
    const actualKwh = new Prisma.Decimal(dischargeResult.actualKwh)

    const { SimulatedHistoricalTelemetryProvider } = await import('./historical-telemetry-provider.service')
    const baselineEngine = await import('./baseline-engine.service')
    const getStrategy = baselineEngine.getStrategy
    type BaselineContext = baselineEngine.BaselineContext
    const telemetryProvider = new SimulatedHistoricalTelemetryProvider()

    // Get historical telemetry (training data — strictly before dispatch).
    const historicalDays = await telemetryProvider.getHistory(
      assignment.assetId,
      assignment.dispatch.startTime,
      14,
    )

    if (!historicalDays || historicalDays.length < 3) {
      throw new Error('BASELINE_UNAVAILABLE: insufficient historical telemetry for baseline calculation')
    }

    // Build BaselineContext from observable dispatch parameters ONLY.
    // This contains NO ground truth (no trueCounterfactual, no trueIncremental).
    const dispatchDurationHours = Math.ceil(
      (assignment.dispatch.endTime.getTime() - assignment.dispatch.startTime.getTime()) / 3600000,
    )
    const dispatchHour = assignment.dispatch.startTime.getHours()
    const dispatchDate = assignment.dispatch.startTime.toISOString().split('T')[0]
    const dayOfWeek = assignment.dispatch.startTime.getDay()

    const baselineContext: BaselineContext = {
      dispatchStartIndex: dispatchHour * 4,
      dispatchEndIndex: Math.min(95, dispatchHour * 4 + dispatchDurationHours * 4),
      dispatchDate,
      dayOfWeek,
      isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    }

    // Resolve the baseline strategy from the PERSISTED NetworkVersion policy.
    // The baselinePolicyJson is immutable once the version is published.
    const networkDef = await db.networkDefinition.findUnique({
      where: { id: assignment.dispatch.program.networkId },
    })
    if (!networkDef || !networkDef.currentVersionId) {
      throw new Error('BASELINE_UNAVAILABLE: network or current version not found')
    }
    const versionForPolicy = await db.networkVersion.findUnique({
      where: { id: networkDef.currentVersionId },
    })
    if (!versionForPolicy) {
      throw new Error('BASELINE_UNAVAILABLE: network version not found')
    }

    let strategyName: string
    if (versionForPolicy.baselinePolicyJson) {
      const policy = JSON.parse(versionForPolicy.baselinePolicyJson)
      if (policy.status !== 'accepted' || !policy.selectedStrategy) {
        throw new Error(`BASELINE_UNAVAILABLE: baseline policy status is '${policy.status}'`)
      }
      strategyName = policy.selectedStrategy
    } else {
      // No policy persisted on this version — use default.
      // This allows backward compatibility with versions created before VPP-2C.
      strategyName = 'weekday_weekend_average'
    }

    const baselineStrategy = getStrategy(strategyName)
    if (!baselineStrategy) {
      throw new Error(`BASELINE_UNAVAILABLE: strategy '${strategyName}' not found in registry`)
    }

    const baselinePrediction = baselineStrategy.predict(historicalDays, baselineContext)

    const baselineKwh = new Prisma.Decimal(baselinePrediction.predictedCounterfactualKwh)
    // FIX: Prevent negative performance payments.
    // rawPerformanceKwh preserves the signed value for analytics.
    // verifiedPerformanceKwh is max(0, actual - baseline) — the economically payable quantity.
    const rawPerformanceKwh = actualKwh.minus(baselineKwh)
    const verifiedPerformanceKwh = rawPerformanceKwh.isNegative()
      ? new Prisma.Decimal(0)
      : rawPerformanceKwh

    // Fetch ground truth for METADATA ONLY (not used in baseline calculation).
    const groundTruth = await telemetryProvider.getDispatchDayGroundTruth?.(
      assignment.assetId,
      assignment.dispatch.startTime,
      dispatchDurationHours,
      parseFloat(assignment.assignedKw),
    )

    const baseline = await db.vppBaseline.create({
      data: {
        tenantId,
        assignmentId,
        method: baselinePrediction.method,
        baselineKw: '0',
        baselineKwh: baselineKwh.toString(),
        actualKw: dischargeResult.actualKw,
        actualKwh: actualKwh.toString(),
        performanceKwh: verifiedPerformanceKwh.toString(),
        metadataJson: JSON.stringify({
          attestationId: attestation.id,
          baselineMethod: baselinePrediction.method,
          strategyName,
          predictedCounterfactualKwh: baselinePrediction.predictedCounterfactualKwh,
          rawPerformanceKwh: rawPerformanceKwh.toString(), // signed value for analytics
          verifiedPerformanceKwh: verifiedPerformanceKwh.toString(), // non-negative payable
          negativePerformanceClipped: rawPerformanceKwh.isNegative(),
          trueCounterfactualKwh: groundTruth?.trueCounterfactualKwh ?? null, // metadata only
          trueIncrementalKwh: groundTruth?.trueIncrementalKwh ?? null, // metadata only
          historyDays: historicalDays.length,
          provider: 'simulated',
        }),
      },
    })

    // --- Derived contribution (uses verifiedPerformanceKwh — never negative) ---
    const contribution = await createContribution(
      tenantId,
      {
        attestationIds: [attestation.id],
        derivedQuantity: verifiedPerformanceKwh.toString(),
        derivedUnit: 'kWh',
      },
      `vpp-baseline-${baseline.id}`,
    )

    // Persist delivery results + stage = delivery_verified.
    await db.vppDispatchAssignment.update({
      where: { id: assignmentId },
      data: {
        economicStage: 'delivery_verified',
        actualKwh: actualKwh.toString(),
        baselineKwh: baselineKwh.toString(),
        performanceKwh: verifiedPerformanceKwh.toString(),
        eventId: event.id,
        contributionId: contribution.id,
      },
    })

    // --- RECORD USAGE BEFORE ANY IRREVERSIBLE FINANCIAL SETTLEMENT ---
    if (assignment.capacityCommitmentId) {
      await recordUsage({
        tenantId,
        commitmentId: assignment.capacityCommitmentId,
        quantity: actualKwh.toString(),
        unit: 'kWh',
        startTime: assignment.dispatch.startTime,
        endTime: assignment.dispatch.endTime,
        sourceType: 'vpp_dispatch_assignment',
        sourceId: `assignment-${assignment.dispatchId}-${assignment.assetId}`,
      })
    }
    usageRecorded = true
    await db.vppDispatchAssignment.update({ where: { id: assignmentId }, data: { economicStage: 'usage_recorded' } })

    // --- Reward ---
    const reward = await calculateReward(tenantId, contribution.id, `vpp-contrib-${contribution.id}`)
    await db.vppDispatchAssignment.update({ where: { id: assignmentId }, data: { economicStage: 'reward_calculated' } })

    // --- Ledger ---
    await postRewardToLedger(tenantId, { rewardId: reward.id }, `vpp-reward-${reward.id}`)
    await db.vppDispatchAssignment.update({ where: { id: assignmentId }, data: { economicStage: 'ledger_posted' } })

    // --- Settlement ---
    const settlement = await createSettlement(tenantId, reward.id)
    await db.vppDispatchAssignment.update({ where: { id: assignmentId }, data: { economicStage: 'settlement_pending' } })

    // Use the TARGETED, LEASE-SAFE settlement processor — NOT the tenant-wide outbox.
    // This ensures: settlement status is the source of truth for assignment completion.
    // If settlement fails → assignment enters RECONCILIATION_REQUIRED (not COMPLETED).
    const settlementResult = await processSettlementForReward(tenantId, reward.id)
    if (!settlementResult.completed) {
      // Settlement did not complete. The assignment must NOT be marked COMPLETED.
      // Enter reconciliation state — capacity stays consumed, usage stays,
      // financial liability exists. Reconciliation can retry.
      throw new Error(`Settlement not completed (status: ${settlementResult.settlementId})`)
    }

    // --- COMPLETED (only reached if settlement succeeded) ---
    await db.vppDispatchAssignment.update({
      where: { id: assignmentId },
      data: { status: 'completed', economicStage: 'completed', completedAt: new Date() },
    })

    // Update dispatch status if all assignments completed.
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
        performanceKwh: verifiedPerformanceKwh.toString(),
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
      performance_kwh: verifiedPerformanceKwh.toString(),
      actual_kwh: actualKwh.toString(),
      baseline_kwh: baselineKwh.toString(),
      contribution_quantity: contribution.quantity,
      duplicate: false,
    }
  } catch (err) {
    // STATE MACHINE FAILURE HANDLING:
    // Pre-usage failure (usageRecorded = false): → FAILED → release capacity.
    //   No irreversible action has occurred. Safe to release.
    // Post-usage failure (usageRecorded = true): → RECONCILIATION_REQUIRED.
    //   Capacity is CONSUMED. Money may have moved. Do NOT release.
    //   Financial reconciliation can retry settlement.
    if (usageRecorded) {
      await markReconciliationRequired(err instanceof Error ? err.message : 'Post-usage failure')
    } else {
      await failAssignment()
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Reconciliation (RECONCILIATION_REQUIRED → RECONCILING → COMPLETED)
// ---------------------------------------------------------------------------

/**
 * Reconcile an assignment in RECONCILIATION_REQUIRED state.
 *
 * Inspects durable state (economicStage + linked entities) and resumes at the
 * first missing economic stage:
 *
 *   usage exists, reward missing → calculate reward
 *   reward exists, ledger missing → post to ledger
 *   ledger exists, settlement missing → create settlement
 *   settlement exists but not completed → process settlement outbox
 *   settlement completed → mark assignment COMPLETED
 *
 * Every stage is idempotent. Does NOT re-execute DER dispatch or create
 * duplicate usage.
 *
 * Concurrency-safe: RECONCILIATION_REQUIRED → RECONCILING atomic claim.
 */
export async function reconcileAssignment(
  tenantId: string,
  assignmentId: string,
  actorId?: string,
): Promise<{ assignment_id: string; status: string; economic_stage: string; message: string }> {
  // Atomic claim: only one reconciler can proceed.
  const claimed = await db.vppDispatchAssignment.updateMany({
    where: { id: assignmentId, tenantId, status: 'reconciliation_required' },
    data: { status: 'reconciling' },
  })
  if (claimed.count === 0) {
    const current = await db.vppDispatchAssignment.findFirst({ where: { id: assignmentId, tenantId } })
    return {
      assignment_id: assignmentId,
      status: current?.status ?? 'unknown',
      economic_stage: current?.economicStage ?? 'unknown',
      message: `Assignment is not in reconciliation_required state (current: ${current?.status})`,
    }
  }

  const assignment = await db.vppDispatchAssignment.findFirst({
    where: { id: assignmentId, tenantId },
    include: { dispatch: true },
  })
  if (!assignment) throw new NotFoundError('vpp_dispatch_assignment', assignmentId)

  try {
    // Inspect DURABLE OBJECTS (not just economicStage) to determine the actual
    // next stage. The economicStage checkpoint is a hint, but the existence/state
    // of reward, ledger posting, and settlement is the source of truth.
    if (!assignment.contributionId) {
      throw new Error('Cannot reconcile: contributionId missing')
    }

    // 1. Check if reward exists. If not, calculate it.
    let reward = await db.reward.findFirst({ where: { contributionId: assignment.contributionId } })
    if (!reward) {
      reward = await calculateReward(tenantId, assignment.contributionId, `vpp-contrib-${assignment.contributionId}`)
      await db.vppDispatchAssignment.update({ where: { id: assignmentId }, data: { economicStage: 'reward_calculated' } })
    }

    // 2. Check if reward is posted to ledger. If not, post it.
    if (reward.status === 'calculated') {
      await postRewardToLedger(tenantId, { rewardId: reward.id }, `vpp-reward-${reward.id}`)
      // Reload reward to get updated status.
      reward = (await db.reward.findUnique({ where: { id: reward.id } }))!
      await db.vppDispatchAssignment.update({ where: { id: assignmentId }, data: { economicStage: 'ledger_posted' } })
    }

    // 3. Check if settlement exists. If not, create it.
    let settlement = await db.settlement.findUnique({ where: { rewardId: reward.id } })
    if (!settlement) {
      settlement = await createSettlement(tenantId, reward.id)
      await db.vppDispatchAssignment.update({ where: { id: assignmentId }, data: { economicStage: 'settlement_pending' } })
    }

    // 4. Process the specific settlement if not yet completed.
    if (settlement.status !== 'completed') {
      await processSettlementForReward(tenantId, reward.id)
      settlement = (await db.settlement.findUnique({ where: { rewardId: reward.id } }))!
    }

    // 5. Check if settlement is now completed.
    if (settlement.status === 'completed') {
      await db.vppDispatchAssignment.update({
        where: { id: assignmentId },
        data: { status: 'completed', economicStage: 'completed', completedAt: new Date() },
      })
      const pending = await db.vppDispatchAssignment.count({
        where: { dispatchId: assignment.dispatchId, status: { not: 'completed' } },
      })
      if (pending === 0) {
        await db.vppDispatch.update({ where: { id: assignment.dispatchId }, data: { status: 'completed' } })
      }
      await appendAudit({
        tenantId, actorId,
        eventType: 'vpp.reconciliation_completed',
        resourceType: 'vpp_dispatch_assignment',
        resourceId: assignmentId,
        metadata: { rewardId: reward.id, settlementId: settlement.id },
      })
      return { assignment_id: assignmentId, status: 'completed', economic_stage: 'completed', message: 'Reconciliation succeeded' }
    }

    // Settlement still not completed.
    await db.vppDispatchAssignment.update({ where: { id: assignmentId }, data: { status: 'reconciliation_required' } })
    return {
      assignment_id: assignmentId,
      status: 'reconciliation_required',
      economic_stage: assignment.economicStage,
      message: 'Reconciliation attempted but settlement not yet completed. Manual review may be needed.',
    }
  } catch (err) {
    // Reconciliation itself failed → back to reconciliation_required.
    await db.vppDispatchAssignment.update({ where: { id: assignmentId }, data: { status: 'reconciliation_required' } })
    throw err
  }
}

// Backward-compatible alias.
export const retrySettlement = reconcileAssignment

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
