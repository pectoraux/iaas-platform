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
import { resolveAdapter } from './adapters-init'
import type {
  NetworkRuntime,
  RuntimeAssignmentResults,
  RuntimeClient,
  RuntimeCreateAssignmentInput,
  RuntimeCreateExecutionInput,
  RuntimeExecuteInput,
  RuntimeExecuteResult,
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

  // Phase 6: Physical execution boundary.
  // The runtime resolves the adapter via AdapterRegistry, calls adapter.execute(),
  // and returns the raw telemetry + actuals. The vertical processes the result.
  async executeAssignment(
    input: RuntimeExecuteInput,
  ): Promise<RuntimeExecuteResult> {
    // Resolve the adapter for this asset type via the AdapterRegistry.
    // Throws if no adapter is registered — no silent fallback.
    const adapter = resolveAdapter(input.assetType)

    // Execute the physical command via the adapter.
    const result = await adapter.execute({
      assetId: input.assetId,
      capabilityType: input.capabilityType,
      assignedQuantity: input.assignedQuantity,
      assignedUnit: input.assignedUnit,
      durationSeconds: input.durationSeconds,
      parameters: input.parameters,
    })

    if (!result.success) {
      return {
        actualQuantity: '0',
        actualUnit: input.assignedUnit,
        telemetryPayload: {},
        success: false,
        error: result.error ?? 'Unknown adapter execution failure',
      }
    }

    return {
      actualQuantity: result.actualQuantity,
      actualUnit: result.actualUnit,
      telemetryPayload: result.telemetry.payload,
      success: true,
    }
  }

  async recordAssignmentResults(
    tx: RuntimeClient,
    executionAssignmentId: string,
    results: RuntimeAssignmentResults,
  ): Promise<void> {
    // Phase 5.4: contributionId is NOT written here. The only way to link
    // a contribution is via linkContribution(), which enforces write-once
    // semantics. recordAssignmentResults records OPERATIONAL results only.
    await tx.executionAssignment.update({
      where: { id: executionAssignmentId },
      data: {
        ...(results.actualQuantity ? { actualQuantity: results.actualQuantity } : {}),
        ...(results.actualUnit ? { actualUnit: results.actualUnit } : {}),
        ...(results.verifiedQuantity ? { verifiedQuantity: results.verifiedQuantity } : {}),
        ...(results.verifiedUnit ? { verifiedUnit: results.verifiedUnit } : {}),
        ...(results.eventId ? { eventId: results.eventId } : {}),
      },
    })
  }

  async linkContribution(
    tx: RuntimeClient,
    executionAssignmentId: string,
    contributionId: string,
  ): Promise<void> {
    // Phase 5.4: Write-once CAS.
    //
    // The CAS condition is:
    //   id = ? AND status = 'completed' AND (contributionId IS NULL OR contributionId = ?)
    //
    // This enforces:
    //   NULL → C1   allowed (first link)
    //   C1  → C1   no-op (idempotent — updateMany matches but value is unchanged)
    //   C1  → C2   REJECTED (CAS doesn't match — contributionId is already C1)
    //   non-completed → REJECTED (CAS doesn't match — status is not 'completed')
    //
    // If count=0, we read the assignment to determine the reason and throw
    // an explicit error. The CAS is the authority (prevents race conditions);
    // the read is only for error reporting.
    const result = await tx.executionAssignment.updateMany({
      where: {
        id: executionAssignmentId,
        status: 'completed',
        OR: [
          { contributionId: null },
          { contributionId: contributionId },
        ],
      },
      data: { contributionId },
    })

    if (result.count > 0) {
      return // success (new link or idempotent re-link)
    }

    // count=0: determine the reason for the rejection.
    const assignment = await tx.executionAssignment.findUnique({
      where: { id: executionAssignmentId },
      select: { status: true, contributionId: true },
    })

    if (!assignment) {
      throw new Error(`Cannot link contribution: assignment ${executionAssignmentId} not found`)
    }
    if (assignment.status !== 'completed') {
      throw new Error(
        `Cannot link contribution: assignment ${executionAssignmentId} is not completed (status: ${assignment.status}). ` +
          `A contribution can only be linked to a completed assignment.`,
      )
    }
    // status is 'completed' but CAS didn't match → already linked to a different contribution.
    throw new Error(
      `Cannot link contribution: assignment ${executionAssignmentId} is already linked to contribution ` +
        `${assignment.contributionId} (cannot replace with ${contributionId}). ` +
        `A contribution link is write-once — it cannot be replaced.`,
    )
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
    //
    // Phase 5.3: No economicStage on the generic assignment — that's a
    // vertical concept. The generic layer only tracks `status`.
    await tx.executionAssignment.update({
      where: { id: executionAssignmentId },
      data: { status: 'completed', completedAt: new Date() },
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
