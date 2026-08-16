// =============================================================================
// Kernel: Generic Execution Service
// =============================================================================
// Vertical-agnostic execution lifecycle. VPP dispatch wraps this; future
// verticals (storage, compute, wireless) do the same.
//
// The execution service provides:
//   - createExecution(): create a generic execution request
//   - createExecutionAssignment(): assign an asset to an execution
//   - updateAssignmentResults(): record verified results
//   - getExecution(): query with assignments
//
// The vertical (VPP, storage, etc.) is responsible for:
//   - Calling the adapter to execute the physical work
//   - Running vertical-specific verification (e.g., VPP baseline engine)
//   - Computing the verified contribution quantity
//   - Creating the generic Contribution from the verified result
//
// The execution model itself is pure lifecycle management — it doesn't
// know about energy, baselines, or portfolios.
// =============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { NotFoundError, ValidationError } from '@/lib/domain/errors'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateExecutionInput {
  tenantId: string
  networkId: string
  requestedQuantity: string
  requestedUnit: string
  startTime: Date
  endTime: Date
  sourceType: string  // e.g., 'vpp_dispatch'
  sourceId?: string   // e.g., VppDispatch.id
  metadataJson?: Record<string, unknown>
}

export interface CreateExecutionAssignmentInput {
  tenantId: string
  executionId: string
  assetId: string
  operatorId: string
  capabilityType: string
  assignedQuantity: string
  assignedUnit: string
  capacityCommitmentId?: string
}

export interface ExecutionResult {
  executionId: string
  status: string
  assignmentCount: number
  completedAssignments: number
  failedAssignments: number
}

// ---------------------------------------------------------------------------
// Create execution
// ---------------------------------------------------------------------------

export async function createExecution(input: CreateExecutionInput) {
  const execution = await db.execution.create({
    data: {
      tenantId: input.tenantId,
      networkId: input.networkId,
      requestedQuantity: input.requestedQuantity,
      requestedUnit: input.requestedUnit,
      startTime: input.startTime,
      endTime: input.endTime,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      metadataJson: JSON.stringify(input.metadataJson ?? {}),
    },
  })
  return execution
}

// ---------------------------------------------------------------------------
// Create assignment
// ---------------------------------------------------------------------------

export async function createExecutionAssignment(input: CreateExecutionAssignmentInput) {
  const assignment = await db.executionAssignment.create({
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
  return assignment
}

// ---------------------------------------------------------------------------
// Update assignment results
// ---------------------------------------------------------------------------

export async function updateAssignmentResults(
  tenantId: string,
  assignmentId: string,
  results: {
    actualQuantity?: string
    actualUnit?: string
    verifiedQuantity?: string
    verifiedUnit?: string
    eventId?: string
    contributionId?: string
    status?: string
    economicStage?: string
  },
) {
  const assignment = await db.executionAssignment.findFirst({
    where: { id: assignmentId, tenantId },
  })
  if (!assignment) throw new NotFoundError('execution_assignment', assignmentId)

  return db.executionAssignment.update({
    where: { id: assignmentId },
    data: {
      ...(results.actualQuantity ? { actualQuantity: results.actualQuantity } : {}),
      ...(results.actualUnit ? { actualUnit: results.actualUnit } : {}),
      ...(results.verifiedQuantity ? { verifiedQuantity: results.verifiedQuantity } : {}),
      ...(results.verifiedUnit ? { verifiedUnit: results.verifiedUnit } : {}),
      ...(results.eventId ? { eventId: results.eventId } : {}),
      ...(results.contributionId ? { contributionId: results.contributionId } : {}),
      ...(results.status ? { status: results.status } : {}),
      ...(results.economicStage ? { economicStage: results.economicStage } : {}),
      ...(results.status === 'completed' ? { completedAt: new Date() } : {}),
    },
  })
}

// ---------------------------------------------------------------------------
// Update execution status
// ---------------------------------------------------------------------------

export async function updateExecutionStatus(
  tenantId: string,
  executionId: string,
  status: string,
) {
  const result = await db.execution.updateMany({
    where: { id: executionId, tenantId },
    data: { status },
  })
  if (result.count === 0) throw new NotFoundError('execution', executionId)
  return { executionId, status }
}

// ---------------------------------------------------------------------------
// Get execution with assignments
// ---------------------------------------------------------------------------

export async function getExecution(tenantId: string, executionId: string) {
  const execution = await db.execution.findFirst({
    where: { id: executionId, tenantId },
    include: {
      assignments: {
        include: {
          asset: { select: { id: true, name: true, assetType: true } },
          operator: { select: { id: true, displayName: true } },
        },
      },
    },
  })
  if (!execution) throw new NotFoundError('execution', executionId)
  return execution
}

// ---------------------------------------------------------------------------
// Get execution result summary
// ---------------------------------------------------------------------------

export async function getExecutionResult(tenantId: string, executionId: string): Promise<ExecutionResult> {
  const execution = await db.execution.findFirst({
    where: { id: executionId, tenantId },
    include: {
      assignments: { select: { status: true } },
    },
  })
  if (!execution) throw new NotFoundError('execution', executionId)

  const assignments = execution.assignments
  return {
    executionId,
    status: execution.status,
    assignmentCount: assignments.length,
    completedAssignments: assignments.filter((a) => a.status === 'completed').length,
    failedAssignments: assignments.filter((a) => a.status === 'failed' || a.status === 'reconciliation_required').length,
  }
}

// ---------------------------------------------------------------------------
// Find execution by source (vertical link)
// ---------------------------------------------------------------------------

export async function findExecutionBySource(
  tenantId: string,
  sourceType: string,
  sourceId: string,
) {
  const execution = await db.execution.findFirst({
    where: { tenantId, sourceType, sourceId },
  })
  return execution
}
