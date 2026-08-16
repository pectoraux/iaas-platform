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
// Type alias: accepts either the full PrismaClient or a TransactionClient.
// ---------------------------------------------------------------------------

/** A client that can read/write Execution + ExecutionAssignment rows. */
type ExecutionClient = Prisma.TransactionClient | typeof db

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

// ---------------------------------------------------------------------------
// Finalize execution if all assignments are terminal (Phase 4.2 hardened)
// ---------------------------------------------------------------------------

/**
 * The set of terminal states for a generic ExecutionAssignment.
 *
 * Terminal = the assignment has reached a state where no further execution
 * work will occur. The execution result (success or failure) is known.
 *
 * 'reconciliation_required' is NOT a generic ExecutionAssignment state — it
 * is a VPP-specific economic-recovery state on VppDispatchAssignment. The
 * generic ExecutionAssignment that a VPP assignment wraps is set to 'failed'
 * when the VPP assignment enters 'reconciliation_required'. So the generic
 * layer only ever sees 'completed' or 'failed' as terminal assignment states.
 */
const EXECUTION_ASSIGNMENT_TERMINAL_STATES = ['completed', 'failed'] as const

/**
 * PARENT EXECUTION SEMANTICS (Phase 4.2 — explicit definition):
 *
 * The generic Execution tracks the EXECUTION LIFECYCLE — "did the work
 * execute?" — NOT the commercial outcome. Its status transitions are:
 *
 *     created → assigned → executing → completed
 *
 * `completed` means the execution lifecycle has ENDED: every assignment has
 * reached a terminal state (completed or failed). It does NOT mean every
 * assignment succeeded. An execution with failed assignments is still
 * `completed` — the execution happened, some assignments failed. The
 * per-assignment success/failure is recorded on ExecutionAssignment.status.
 *
 * The generic Execution does NOT carry VPP financial states. These live on
 * VppDispatch (the VPP-specific wrapper):
 *
 *     VPP delivery_complete         → Execution completed
 *     VPP buyer_settlement_pending  → Execution completed (already)
 *     VPP reconciliation_required   → Execution completed (already)
 *     VPP completed                 → Execution completed (already)
 *
 * VPP's `reconciliation_required` (an economic recovery state) maps to
 * generic ExecutionAssignment.status = `failed` — the work did not complete
 * successfully, and the generic layer does not model financial recovery.
 *
 * TRANSACTION-AWARE:
 * This function accepts a `tx` (Prisma TransactionClient or the db client)
 * as its first argument. The caller MUST pass the same transaction client
 * that is performing the last assignment's terminal transition, so the
 * parent finalization is atomic with the assignment transition:
 *
 *   - If the assignment transition commits → the parent finalization commits.
 *   - If the assignment transition rolls back → both roll back.
 *
 * This guarantees there is never a partial state where an assignment is
 * terminal but the parent Execution is stuck in `executing`.
 *
 * IDEMPOTENT:
 * If the Execution is already `completed`, this is a no-op. Safe to call
 * from multiple code paths (e.g., the atomic in-transition call + a
 * defensive fallback in the vertical's finalization logic).
 *
 * @param tx          The Prisma transaction client (or db) to use for reads/writes.
 * @param tenantId    Tenant scope.
 * @param executionId The Execution ID.
 * @returns The resulting Execution status (`'completed'`), or `null` if no
 *          transition occurred (execution not found, no assignments, or
 *          assignments not all terminal).
 */
export async function finalizeExecutionIfTerminal(
  tx: ExecutionClient,
  tenantId: string,
  executionId: string,
): Promise<string | null> {
  const execution = await tx.execution.findFirst({
    where: { id: executionId, tenantId },
    include: {
      assignments: { select: { status: true } },
    },
  })
  if (!execution) return null

  // Already completed — idempotent no-op. The generic Execution has only
  // ONE terminal parent state: 'completed'. There is no 'failed' parent
  // state (failed assignments still produce a 'completed' execution).
  if (execution.status === 'completed') {
    return 'completed'
  }

  const assignments = execution.assignments
  if (assignments.length === 0) return null

  // Check if ALL assignments are execution-terminal.
  // The generic layer only sees 'completed' or 'failed' (VPP's
  // 'reconciliation_required' is mapped to 'failed' by the VPP service
  // before this function is called). The defensive check below also
  // treats 'reconciliation_required' as terminal in case a vertical
  // forgets to map it.
  const allTerminal = assignments.every((a) =>
    EXECUTION_ASSIGNMENT_TERMINAL_STATES.includes(a.status as (typeof EXECUTION_ASSIGNMENT_TERMINAL_STATES)[number]) ||
    a.status === 'reconciliation_required',
  )

  if (!allTerminal) return null

  // All assignments are terminal → finalize the parent Execution.
  // CAS (compare-and-swap): only transition if not already 'completed'.
  // This defends against concurrent finalization attempts — two callers
  // racing to finalize will both pass the read check, but only one's
  // updateMany will match (the other's WHERE clause won't match a row
  // already at 'completed'). Both return 'completed' (idempotent).
  await tx.execution.updateMany({
    where: { id: executionId, status: { not: 'completed' } },
    data: { status: 'completed' },
  })

  return 'completed'
}
