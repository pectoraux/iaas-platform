// =============================================================================
// Compute Service — Compute vertical domain layer.
//
// Phase 8B: This service orchestrates a complete Compute workload through the
// generic economic pipeline:
//
//   Execution → Event → Verification → Attestation → Contribution →
//   Reward → Ledger → Settlement
//
// CRITICAL ARCHITECTURAL RULE: this service uses ONLY generic platform
// primitives — the SAME services that VPP uses. It does NOT create any
// compute-specific economic primitives. The only compute-specific additions
// are:
//   - The compute template (configuration)
//   - The compute adapter (physical execution)
//   - This orchestration service (calls generic services in sequence)
//
// The generic services used:
//   - InfrastructureRuntime (generic execution lifecycle)
//   - AdapterRegistry → SimulatedComputeAdapter (physical execution)
//   - ingestion.service (Event ingestion)
//   - worker.service (verification + attestation)
//   - contribution.service (Contribution creation)
//   - reward.service (Reward calculation)
//   - ledger.service (double-entry accounting)
//   - settlement.service (payout)
//   - capacity.service (CapacityResource → Reservation → Commitment → Usage)
//
// This is the proof that the architecture is a Network Operating System:
// a new vertical needs only a template + an adapter + an orchestration
// service. The kernel is unchanged.
// =============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit } from '@/lib/domain/audit'
import { ingestEvent, buildCanonicalMessage } from './ingestion.service'
import { processEventOutbox, processSettlementForReward } from './worker.service'
import { createContribution } from './contribution.service'
import { calculateReward } from './reward.service'
import { postRewardToLedger } from './ledger.service'
import { createSettlement } from './settlement.service'
import {
  ensureCapacityResource,
  createCapacityReservation,
  createCapacityCommitment,
  recordUsage,
  releaseCommitment,
} from './capacity.service'
import { signMessage, deriveSigningKey } from '@/lib/domain/crypto'
import { resolveRuntime, type RuntimeKind } from '@/lib/kernel/runtime'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateComputeJobInput {
  networkId: string
  assetId: string
  operatorId: string
  capabilityType: string // 'gpu_compute' | 'cpu_compute'
  assignedQuantity: string // e.g., '10' (GPU-hours)
  assignedUnit: string // e.g., 'GPU-hours'
  durationSeconds: number
  parameters?: Record<string, unknown> // e.g., { gpuCount: 4 }
}

export interface ComputeJobResult {
  executionId: string
  executionAssignmentId: string
  eventId: string
  attestationId: string
  contributionId: string
  rewardId: string
  settlementId: string
  actualQuantity: string
  actualUnit: string
}

// ---------------------------------------------------------------------------
// Create + Execute a Compute Job
// ---------------------------------------------------------------------------

/**
 * Create and execute a complete Compute job through the generic economic
 * pipeline.
 *
 * This is the Phase 8B proof: the SAME generic services that VPP uses
 * serve compute — with zero kernel modifications.
 *
 * The pipeline:
 *   1. Resolve the InfrastructureRuntime from the network's NetworkVersion
 *   2. Create Execution + ExecutionAssignment via the runtime
 *   3. Execute the compute job via runtime.executeAssignment (→ ComputeAdapter)
 *   4. Sign + submit telemetry as a generic Event
 *   5. Process the event through generic verification → attestation
 *   6. Create a Contribution from the verified result
 *   7. Record results + complete the assignment via the runtime
 *   8. Link the contribution (write-once)
 *   9. Record capacity usage
 *  10. Calculate Reward
 *  11. Post to Ledger
 *  12. Create + process Settlement
 *
 * No VPP-specific logic. No baseline engine. No portfolio. No buyer settlement.
 * Just the generic pipeline.
 */
export async function createAndExecuteComputeJob(
  tenantId: string,
  input: CreateComputeJobInput,
  provisioningSecret: string,
  actorId?: string,
): Promise<ComputeJobResult> {
  // --- Load the network + current version ---
  const network = await db.networkDefinition.findFirst({
    where: { id: input.networkId, tenantId },
    include: {
      versions: { where: { publishedAt: { not: null } }, orderBy: { version: 'desc' }, take: 1 },
    },
  })
  if (!network) throw new NotFoundError('network', input.networkId)
  if (!network.currentVersionId) throw new ValidationError('Network has no published version')

  const networkVersion = network.versions[0]
  if (!networkVersion) throw new NotFoundError('network_version', `network ${input.networkId}`)

  // --- Resolve the InfrastructureRuntime from the NetworkVersion's runtimeKind ---
  const runtime = resolveRuntime((networkVersion.runtimeKind ?? 'infrastructure') as RuntimeKind)

  // --- Load the asset + device ---
  const asset = await db.asset.findFirst({
    where: { id: input.assetId, tenantId },
    include: { devices: { include: { credential: true } } },
  })
  if (!asset) throw new NotFoundError('asset', input.assetId)

  const device = asset.devices.find((d) => d.credential && d.credential.status === 'active')
  if (!device) {
    throw new ValidationError(`Asset ${input.assetId} has no active device with credential`)
  }

  // --- Capacity: create resource + reservation + commitment ---
  // This exercises the generic capacity kernel for compute (GPU-hours).
  // The asset must already be assigned to the network with the capability.
  await ensureCapacityResource(tenantId, input.assetId, input.networkId, input.capabilityType)

  const startTime = new Date()
  const endTime = new Date(startTime.getTime() + input.durationSeconds * 1000)

  const reservation = await createCapacityReservation({
    tenantId,
    assetId: input.assetId,
    networkId: input.networkId,
    capabilityType: input.capabilityType,
    requestedAmount: input.assignedQuantity,
    startTime,
    endTime,
    sourceType: 'compute_job',
    sourceId: `compute-job-${Date.now()}`,
  })

  const commitment = await createCapacityCommitment({
    tenantId,
    reservationId: reservation.reservationId,
    committedAmount: input.assignedQuantity,
    unit: input.assignedUnit,
    startTime,
    endTime,
    sourceType: 'compute_job',
    sourceId: `compute-job-${Date.now()}`,
  })

  // --- 1. Create Execution + ExecutionAssignment via the runtime ---
  const execution = await db.$transaction(async (tx) => {
    const exec = await runtime.createExecution(tx, {
      tenantId,
      networkId: input.networkId,
      requestedQuantity: input.assignedQuantity,
      requestedUnit: input.assignedUnit,
      startTime,
      endTime,
      sourceType: 'compute_job',
      metadataJson: { capabilityType: input.capabilityType, assetId: input.assetId },
    })

    // Link the execution source (for provenance).
    // We use a placeholder sourceId here since we don't have a separate
    // compute_dispatch model — the Execution IS the job record.
    await runtime.linkExecutionSource(tx, exec.id, `compute-execution-${exec.id}`)

    const assignment = await runtime.createExecutionAssignment(tx, {
      tenantId,
      executionId: exec.id,
      assetId: input.assetId,
      operatorId: input.operatorId,
      capabilityType: input.capabilityType,
      assignedQuantity: input.assignedQuantity,
      assignedUnit: input.assignedUnit,
      capacityCommitmentId: commitment.commitmentId,
    })

    return { executionId: exec.id, executionAssignmentId: assignment.id }
  })

  // --- 2. Execute the compute job via runtime.executeAssignment ---
  // This resolves the ComputeAdapter via the AdapterRegistry and calls
  // adapter.execute(). The runtime owns physical execution.
  const executeResult = await runtime.executeAssignment({
    assetId: input.assetId,
    assetType: asset.assetType,
    capabilityType: input.capabilityType,
    assignedQuantity: input.assignedQuantity,
    assignedUnit: input.assignedUnit,
    durationSeconds: input.durationSeconds,
    parameters: input.parameters,
  })

  if (!executeResult.success) {
    // Fail the assignment via the runtime (operational failure).
    await db.$transaction(async (tx) => {
      await runtime.failAssignment(tx, tenantId, execution.executionAssignmentId, execution.executionId)
    })
    await releaseCommitment(tenantId, 'compute_job', `compute-job-${Date.now()}`)
    throw new Error(`Compute execution failed: ${executeResult.error}`)
  }

  // --- 3. Sign + submit telemetry as a generic Event ---
  const eventId = `compute-job-${execution.executionAssignmentId}-${Date.now()}`
  const timestamp = new Date().toISOString()
  const sequence = Math.floor(Date.now() / 1000)
  const message = buildCanonicalMessage({
    device_id: device.id,
    event_id: eventId,
    timestamp,
    event_type: 'telemetry',
    sequence,
    payload: executeResult.telemetryPayload,
  })
  const signingKey = deriveSigningKey(provisioningSecret)
  const signature = signMessage(message, signingKey)

  // Resolve the network version for verification (same immutable version).
  const ingestResult = await ingestEvent(tenantId, {
    device_id: device.id,
    event_id: eventId,
    timestamp,
    event_type: 'telemetry',
    sequence,
    payload: executeResult.telemetryPayload,
    signature,
    network_version_id: networkVersion.id,
    capability_type: input.capabilityType,
  })

  // --- 4. Process the event through generic verification → attestation ---
  await processEventOutbox(tenantId)

  const event = await db.event.findUnique({
    where: { id: ingestResult.event_id },
    include: { attestations: true },
  })

  if (event?.status !== 'verified' || !event.attestations[0]) {
    throw new Error(`Compute telemetry verification failed: ${event?.status}`)
  }

  const attestation = event.attestations[0]

  // --- 5. Create a Contribution from the verified result ---
  // The actual GPU-hours delivered becomes the Contribution quantity.
  // This is the SAME generic contribution service VPP uses.
  const contribution = await createContribution(
    tenantId,
    {
      attestationIds: [attestation.id],
      derivedQuantity: executeResult.actualQuantity,
      derivedUnit: executeResult.actualUnit,
    },
    `compute-attestation-${attestation.id}`,
  )

  // --- 6. Record results + complete the assignment (operational completion) ---
  // Phase 5.2: operational completion happens BEFORE economics.
  await db.$transaction(async (tx) => {
    await runtime.recordAssignmentResults(tx, execution.executionAssignmentId, {
      actualQuantity: executeResult.actualQuantity,
      actualUnit: executeResult.actualUnit,
      verifiedQuantity: executeResult.actualQuantity,
      verifiedUnit: executeResult.actualUnit,
      eventId: event.id,
    })
    await runtime.completeAssignment(tx, tenantId, execution.executionAssignmentId, execution.executionId)
  })

  // --- 7. Link the contribution (write-once, after operational completion) ---
  await db.$transaction(async (tx) => {
    await runtime.linkContribution(tx, execution.executionAssignmentId, contribution.id)
  })

  // --- 8. Record capacity usage ---
  await recordUsage({
    tenantId,
    commitmentId: commitment.commitmentId,
    quantity: executeResult.actualQuantity,
    unit: executeResult.actualUnit,
    startTime,
    endTime,
    sourceType: 'compute_job',
    sourceId: `compute-job-${Date.now()}`,
  })

  // --- 9. Calculate Reward (generic reward service) ---
  const reward = await calculateReward(tenantId, contribution.id, `compute-contrib-${contribution.id}`)

  // --- 10. Post to Ledger (generic ledger service) ---
  await postRewardToLedger(tenantId, { rewardId: reward.id }, `compute-reward-${reward.id}`)

  // --- 11. Create + process Settlement (generic settlement service) ---
  const settlement = await createSettlement(tenantId, reward.id)
  await processSettlementForReward(tenantId, reward.id)

  await appendAudit({
    tenantId,
    actorId,
    eventType: 'compute.job_completed',
    resourceType: 'execution',
    resourceId: execution.executionId,
    metadata: {
      actualQuantity: executeResult.actualQuantity,
      actualUnit: executeResult.actualUnit,
      eventId: event.id,
      contributionId: contribution.id,
      rewardId: reward.id,
      settlementId: settlement.id,
    },
  })

  return {
    executionId: execution.executionId,
    executionAssignmentId: execution.executionAssignmentId,
    eventId: event.id,
    attestationId: attestation.id,
    contributionId: contribution.id,
    rewardId: reward.id,
    settlementId: settlement.id,
    actualQuantity: executeResult.actualQuantity,
    actualUnit: executeResult.actualUnit,
  }
}
