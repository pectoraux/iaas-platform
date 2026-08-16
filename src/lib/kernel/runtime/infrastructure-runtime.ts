// =============================================================================
// Kernel: Infrastructure Runtime (Phase 5)
// =============================================================================
// The InfrastructureRuntime is the runtime implementation for
// runtimeKind = 'infrastructure'. It is the CURRENT execution model:
// the vertical directly dispatches assets (VPP DERs, future storage nodes,
// compute GPUs) and the runtime manages the generic Execution lifecycle.
//
// This runtime wraps the execution.service.ts kernel primitive. The
// vertical (VPP) calls this runtime — it never calls execution.service.ts
// directly. This establishes the dependency direction:
//
//   VPP → RuntimeRegistry → InfrastructureRuntime → execution.service → Execution
//
// The InfrastructureRuntime is transaction-aware: all methods accept a `tx`
// (Prisma TransactionClient or db) so the generic execution lifecycle changes
// are atomic with the vertical's state transitions.
// =============================================================================

import { finalizeExecutionIfTerminal } from '../execution/execution.service'
import type {
  NetworkRuntime,
  RuntimeAssignmentResults,
  RuntimeClient,
  RuntimeCreateAssignmentInput,
  RuntimeCreateExecutionInput,
} from './types'

// ---------------------------------------------------------------------------
// InfrastructureRuntime
// ---------------------------------------------------------------------------

export class InfrastructureRuntime implements NetworkRuntime {
  readonly kind = 'infrastructure' as const

  async createExecution(
    tx: RuntimeClient,
    input: RuntimeCreateExecutionInput,
  ): Promise<{ id: string }> {
    const execution = await tx.execution.create({
      data: {
        tenantId: input.tenantId,
        networkId: input.networkId,
        requestedQuantity: input.requestedQuantity,
        requestedUnit: input.requestedUnit,
        startTime: input.startTime,
        endTime: input.endTime,
        status: 'assigned',
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        metadataJson: JSON.stringify(input.metadataJson ?? {}),
      },
    })
    return { id: execution.id }
  }

  async linkExecutionSource(
    tx: RuntimeClient,
    executionId: string,
    sourceId: string,
  ): Promise<void> {
    await tx.execution.update({
      where: { id: executionId },
      data: { sourceId },
    })
  }

  async createExecutionAssignment(
    tx: RuntimeClient,
    input: RuntimeCreateAssignmentInput,
  ): Promise<{ id: string }> {
    const assignment = await tx.executionAssignment.create({
      data: {
        tenantId: input.tenantId,
        executionId: input.executionId,
        assetId: input.assetId,
        operatorId: input.operatorId,
        capabilityType: input.capabilityType,
        assignedQuantity: input.assignedQuantity,
        assignedUnit: input.assignedUnit,
        capacityCommitmentId: input.capacityCommitmentId ?? null,
      },
    })
    return { id: assignment.id }
  }

  async beginAssignmentExecution(
    tx: RuntimeClient,
    executionId: string,
    _executionAssignmentId: string,
  ): Promise<void> {
    // Transition the parent Execution from 'assigned' → 'executing'.
    // CAS (compare-and-swap): only transitions if currently 'assigned'.
    // Idempotent — if already 'executing', this is a no-op.
    await tx.execution.updateMany({
      where: { id: executionId, status: 'assigned' },
      data: { status: 'executing' },
    })
  }

  async recordAssignmentResults(
    tx: RuntimeClient,
    executionAssignmentId: string,
    results: RuntimeAssignmentResults,
  ): Promise<void> {
    await tx.executionAssignment.update({
      where: { id: executionAssignmentId },
      data: {
        ...(results.actualQuantity ? { actualQuantity: results.actualQuantity } : {}),
        ...(results.actualUnit ? { actualUnit: results.actualUnit } : {}),
        ...(results.verifiedQuantity ? { verifiedQuantity: results.verifiedQuantity } : {}),
        ...(results.verifiedUnit ? { verifiedUnit: results.verifiedUnit } : {}),
        ...(results.eventId ? { eventId: results.eventId } : {}),
        ...(results.contributionId ? { contributionId: results.contributionId } : {}),
      },
    })
  }

  async linkContribution(
    tx: RuntimeClient,
    executionAssignmentId: string,
    contributionId: string,
  ): Promise<void> {
    // Link the economic contribution to the assignment. This is an economic
    // link, not an operational one — the assignment may already be completed.
    await tx.executionAssignment.update({
      where: { id: executionAssignmentId },
      data: { contributionId },
    })
  }

  async completeAssignment(
    tx: RuntimeClient,
    tenantId: string,
    executionAssignmentId: string,
    executionId: string,
  ): Promise<void> {
    // Complete the assignment + atomically finalize the parent Execution.
    // Both happen in the SAME transaction (tx) — if one fails, both roll back.
    //
    // Phase 5.2: This is OPERATIONAL completion — called after physical
    // execution + verification, NOT after economic settlement.
    await tx.executionAssignment.update({
      where: { id: executionAssignmentId },
      data: { status: 'completed', economicStage: 'completed', completedAt: new Date() },
    })
    await finalizeExecutionIfTerminal(tx, tenantId, executionId)
  }

  async failAssignment(
    tx: RuntimeClient,
    tenantId: string,
    executionAssignmentId: string,
    executionId: string,
  ): Promise<void> {
    // Phase 5.2: CAS — only fail if NOT already completed. Operational
    // completion is irreversible. A settlement failure AFTER operational
    // completion must NOT change the generic assignment to failed.
    //
    // This is the critical guard that enforces the execution/economics
    // separation: if the vertical accidentally calls failAssignment after
    // completeAssignment, the CAS prevents the status from being overwritten.
    await tx.executionAssignment.updateMany({
      where: { id: executionAssignmentId, status: { not: 'completed' } },
      data: { status: 'failed' },
    })
    await finalizeExecutionIfTerminal(tx, tenantId, executionId)
  }

  async finalizeIfTerminal(
    tx: RuntimeClient,
    tenantId: string,
    executionId: string,
  ): Promise<string | null> {
    return finalizeExecutionIfTerminal(tx, tenantId, executionId)
  }
}
