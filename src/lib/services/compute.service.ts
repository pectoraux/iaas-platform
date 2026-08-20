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
import {
  ensureCapacityResource,
  createCapacityReservation,
  createCapacityCommitment,
  recordUsage,
  releaseCommitment,
} from './capacity.service'
import { signMessage, deriveSigningKey } from '@/lib/domain/crypto'
import { randomUUID } from 'crypto'
import { resolveRuntime, type RuntimeKind } from '@/lib/kernel/runtime'
import {
  initEconomicPipeline,
  processEconomicPipeline,
  type EconomicPipelineResult,
} from '@/lib/control-plane/economic-pipeline'

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
  /**
   * Phase 8C: Optional explicit adapter selection. If specified, the runtime
   * resolves the exact adapter via adapterRegistry.resolve({ adapterType }).
   * If omitted, resolves the single adapter for the asset type.
   * Used by failure tests to pass a nonexistent adapterType — triggers
   * adapter resolution failure AFTER capacity + execution are created.
   */
  adapterType?: string
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

  // Phase 8C: Stable source ID for the entire job lifecycle.
  // Used consistently for reservation, commitment, usage, audit, and
  // failure cleanup (releaseCommitment). Uses crypto.randomUUID() for
  // collision resistance under concurrency.
  const computeJobId = `compute-job-${randomUUID()}`

  const reservation = await createCapacityReservation({
    tenantId,
    assetId: input.assetId,
    networkId: input.networkId,
    capabilityType: input.capabilityType,
    requestedAmount: input.assignedQuantity,
    startTime,
    endTime,
    sourceType: 'compute_job',
    sourceId: computeJobId,
  })

  const commitment = await createCapacityCommitment({
    tenantId,
    reservationId: reservation.reservationId,
    committedAmount: input.assignedQuantity,
    unit: input.assignedUnit,
    startTime,
    endTime,
    sourceType: 'compute_job',
    sourceId: computeJobId,
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
  // Phase 8C: Passes adapterType if specified (for explicit adapter selection
  // or failure testing with a nonexistent adapterType).
  // Phase 12B Slice 7: acquire an execution lease before executing (required
  // by the Slice 5 lease validation injected into the runtime).
  const { acquireExecutionLease } = await import('@/lib/control-plane/execution-lease')
  const leaseResult = await acquireExecutionLease({
    executionAssignmentId: execution.executionAssignmentId,
    workerIdentity: `compute-${computeJobId}`,
  })
  if (!leaseResult.acquired) {
    await releaseCommitment(tenantId, 'compute_job', computeJobId)
    throw new Error(`Could not acquire execution lease: ${leaseResult.reason}`)
  }
  const lease = leaseResult.lease!

  let executeResult
  try {
    executeResult = await runtime.executeAssignment({
      assetId: input.assetId,
      assetType: asset.assetType,
      capabilityType: input.capabilityType,
      adapterType: input.adapterType,
      assignedQuantity: input.assignedQuantity,
      assignedUnit: input.assignedUnit,
      durationSeconds: input.durationSeconds,
      parameters: input.parameters,
      leaseId: lease.id,
      leaseVersion: lease.leaseVersion,
      workerIdentity: `compute-${computeJobId}`,
    })
  } catch (err) {
    // Adapter resolution or execution threw an exception (not success=false).
    // Fail the assignment + release capacity.
    await db.$transaction(async (tx) => {
      await runtime.failAssignment(tx, tenantId, execution.executionAssignmentId, execution.executionId)
    })
    await releaseCommitment(tenantId, 'compute_job', computeJobId)
    throw new Error(`Compute execution failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!executeResult.success) {
    // Fail the assignment via the runtime (operational failure).
    await db.$transaction(async (tx) => {
      await runtime.failAssignment(tx, tenantId, execution.executionAssignmentId, execution.executionId)
    })
    // Phase 8C: Release capacity using the SAME computeJobId used for
    // reservation + commitment. Previous code used Date.now() here,
    // producing a different ID — releaseCommitment could never find it.
    await releaseCommitment(tenantId, 'compute_job', computeJobId)
    throw new Error(`Compute execution failed: ${executeResult.error}`)
  }

  // Complete the execution lease (success).
  const { completeExecutionLease } = await import('@/lib/control-plane/execution-lease')
  await completeExecutionLease({
    leaseId: lease.id,
    leaseVersion: lease.leaseVersion,
    workerIdentity: `compute-${computeJobId}`,
  })

  // --- 3. Record results + complete the assignment (OPERATIONAL COMPLETION) ---
  // Phase 5.2 / 8C: operational completion happens BEFORE economics.
  // The generic ExecutionAssignment is completed when the work is verified,
  // NOT when the contribution/reward/settlement succeeds.
  await db.$transaction(async (tx) => {
    await runtime.recordAssignmentResults(tx, execution.executionAssignmentId, {
      actualQuantity: executeResult.actualQuantity,
      actualUnit: executeResult.actualUnit,
      verifiedQuantity: executeResult.actualQuantity,
      verifiedUnit: executeResult.actualUnit,
    })
    await runtime.completeAssignment(tx, tenantId, execution.executionAssignmentId, execution.executionId)
  })

  // --- 4. Record capacity usage ---
  await recordUsage({
    tenantId,
    commitmentId: commitment.commitmentId,
    quantity: executeResult.actualQuantity,
    unit: executeResult.actualUnit,
    startTime,
    endTime,
    sourceType: 'compute_job',
    sourceId: computeJobId,
  })

  // --- 5. Initialize + run the generic economic pipeline ---
  // Phase 12B Slice 7: Compute delegates economic processing to the generic
  // EconomicPipelineState + processEconomicPipeline. No compute-specific
  // economic primitives are created — the generic pipeline orchestrates
  // Event → Verification → Attestation → Contribution → Reward → Ledger →
  // Settlement through deterministic idempotency keys.
  await initEconomicPipeline({
    executionAssignmentId: execution.executionAssignmentId,
    tenantId,
    networkVersionId: networkVersion.id,
    networkId: input.networkId,
  })

  const economicResult = await processEconomicPipeline({
    executionAssignmentId: execution.executionAssignmentId,
    telemetryPayload: executeResult.telemetryPayload,
    actualQuantity: executeResult.actualQuantity,
    actualUnit: executeResult.actualUnit,
    deviceId: device.id,
    signingKey: deriveSigningKey(provisioningSecret),
    capabilityType: input.capabilityType,
    timestamp: new Date().toISOString(),
    sequence: Math.floor(Date.now() / 1000),
  })

  await appendAudit({
    tenantId,
    actorId,
    eventType: 'compute.job_completed',
    resourceType: 'execution',
    resourceId: execution.executionId,
    metadata: {
      actualQuantity: executeResult.actualQuantity,
      actualUnit: executeResult.actualUnit,
      eventId: economicResult.eventId,
      attestationId: economicResult.attestationId,
      contributionId: economicResult.contributionId,
      rewardId: economicResult.rewardId,
      ledgerPostingId: economicResult.ledgerPostingId,
      settlementId: economicResult.settlementId,
      economicStage: economicResult.stage,
    },
  })

  return {
    executionId: execution.executionId,
    executionAssignmentId: execution.executionAssignmentId,
    eventId: economicResult.eventId!,
    attestationId: economicResult.attestationId!,
    contributionId: economicResult.contributionId!,
    rewardId: economicResult.rewardId!,
    settlementId: economicResult.settlementId!,
    actualQuantity: executeResult.actualQuantity,
    actualUnit: executeResult.actualUnit,
  }
}
