// =============================================================================
// Kernel: Network Runtime Contract (Phase 5)
// =============================================================================
// The NetworkRuntime is the kernel-level entry point for execution lifecycle
// operations. Every active NetworkVersion resolves to exactly one runtime
// implementation via the RuntimeRegistry.
//
// The dependency direction is:
//
//   Vertical (VPP) → RuntimeRegistry → NetworkRuntime → Execution → Adapter
//
// The vertical NEVER touches Execution records directly — it goes through the
// runtime. This prevents the "abstraction exists but the vertical bypasses it"
// anti-pattern that Phase 4 corrected for the Execution model.
//
// Runtime kinds:
//   infrastructure — the network operates by directly dispatching assets
//                    (VPP DERs, storage nodes, compute GPUs). This is the
//                    current model.
//   protocol       — the network operates via an on-chain or protocol-level
//                    consensus mechanism. Execution is governed by protocol
//                    rules, not direct asset dispatch.
//   hybrid         — the network uses infrastructure for physical execution
//                    but protocol for settlement/attestation.
//
// All three kinds implement the SAME contract. The difference is in HOW they
// execute, not WHAT they execute.
// =============================================================================

import type { Prisma } from '@prisma/client'
import type { db as dbType } from '@/lib/db'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The set of allowed runtime kinds. A NetworkVersion's runtimeKind MUST be
 * one of these. Adding a new kind requires:
 *   1. Adding it here
 *   2. Implementing a NetworkRuntime for it
 *   3. Registering it in the RuntimeRegistry
 */
export const RUNTIME_KINDS = ['infrastructure', 'protocol', 'hybrid'] as const
export type RuntimeKind = (typeof RUNTIME_KINDS)[number]

/**
 * A Prisma client that can read/write Execution + ExecutionAssignment rows.
 * Accepts either the full PrismaClient or a TransactionClient.
 */
export type RuntimeClient = Prisma.TransactionClient | typeof dbType

/**
 * Input for creating a generic Execution via the runtime.
 */
export interface RuntimeCreateExecutionInput {
  tenantId: string
  networkId: string
  requestedQuantity: string
  requestedUnit: string
  startTime: Date
  endTime: Date
  sourceType: string // e.g., 'vpp_dispatch'
  sourceId?: string | null // e.g., VppDispatch.id (null if not yet known)
  metadataJson?: Record<string, unknown>
}

/**
 * Input for creating a generic ExecutionAssignment via the runtime.
 */
export interface RuntimeCreateAssignmentInput {
  tenantId: string
  executionId: string
  assetId: string
  operatorId: string
  capabilityType: string
  assignedQuantity: string
  assignedUnit: string
  capacityCommitmentId?: string
}

/**
 * Verified results from executing an assignment.
 */
export interface RuntimeAssignmentResults {
  actualQuantity?: string
  actualUnit?: string
  verifiedQuantity?: string
  verifiedUnit?: string
  eventId?: string
  contributionId?: string
}

// ---------------------------------------------------------------------------
// NetworkRuntime — the contract all runtimes implement
// ---------------------------------------------------------------------------

/**
 * Every active NetworkVersion resolves to exactly one NetworkRuntime
 * implementation. The vertical (VPP, future verticals) calls the runtime
 * to manage the generic Execution lifecycle. The vertical owns the
 * vertical-specific economics (baseline, contribution, reward, settlement);
 * the runtime owns the execution lifecycle (created → executing → completed).
 *
 * TRANSACTION-AWARE:
 * All methods accept a `tx` (Prisma TransactionClient or db) as the first
 * argument. The caller passes the same transaction that is performing the
 * vertical's state transitions, so the generic execution lifecycle changes
 * are atomic with the vertical's transitions.
 */
export interface NetworkRuntime {
  /** The runtime kind this implementation handles. */
  readonly kind: RuntimeKind

  /**
   * Create a generic Execution record. Called by the vertical's dispatch
   * creation (e.g., VPP createDispatch).
   */
  createExecution(
    tx: RuntimeClient,
    input: RuntimeCreateExecutionInput,
  ): Promise<{ id: string }>

  /**
   * Link the Execution's sourceId back to the vertical record that created it.
   * Called after the vertical record (e.g., VppDispatch) has been created,
   * so the Execution can reference it via sourceType + sourceId.
   */
  linkExecutionSource(
    tx: RuntimeClient,
    executionId: string,
    sourceId: string,
  ): Promise<void>

  /**
   * Create a generic ExecutionAssignment. Called by the vertical's dispatch
   * creation for each assigned asset.
   */
  createExecutionAssignment(
    tx: RuntimeClient,
    input: RuntimeCreateAssignmentInput,
  ): Promise<{ id: string }>

  /**
   * Transition the parent Execution to 'executing' and mark the assignment
   * as actively executing. Called when the vertical begins physical execution
   * of the assignment (e.g., VPP dispatches the DER).
   */
  beginAssignmentExecution(
    tx: RuntimeClient,
    executionId: string,
    executionAssignmentId: string,
  ): Promise<void>

  /**
   * Record verified results on an assignment (actuals, verified quantity,
   * links to Event/Contribution). Called after the vertical has verified
   * the execution output.
   */
  recordAssignmentResults(
    tx: RuntimeClient,
    executionAssignmentId: string,
    results: RuntimeAssignmentResults,
  ): Promise<void>

  /**
   * Complete an assignment: transition ExecutionAssignment → 'completed' and
   * atomically finalize the parent Execution if all assignments are terminal.
   * Called when the vertical has finished all economic processing (reward,
   * ledger, settlement) for this assignment.
   */
  completeAssignment(
    tx: RuntimeClient,
    tenantId: string,
    executionAssignmentId: string,
    executionId: string,
  ): Promise<void>

  /**
   * Fail an assignment: transition ExecutionAssignment → 'failed' and
   * atomically finalize the parent Execution if all assignments are terminal.
   * Called when the vertical encounters a pre-usage failure (no irreversible
   * action has occurred).
   */
  failAssignment(
    tx: RuntimeClient,
    tenantId: string,
    executionAssignmentId: string,
    executionId: string,
  ): Promise<void>

  /**
   * Defensively finalize the parent Execution if all assignments are terminal.
   * Idempotent — safe to call from the vertical's finalization logic.
   */
  finalizeIfTerminal(
    tx: RuntimeClient,
    tenantId: string,
    executionId: string,
  ): Promise<string | null>
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a runtimeKind string is one of the allowed values.
 * Throws ValidationError if invalid.
 */
export function validateRuntimeKind(kind: string): asserts kind is RuntimeKind {
  if (!RUNTIME_KINDS.includes(kind as RuntimeKind)) {
    throw new Error(
      `Invalid runtimeKind '${kind}'. Allowed values: ${RUNTIME_KINDS.join(', ')}`,
    )
  }
}

/**
 * Type guard: is this string a valid RuntimeKind?
 */
export function isRuntimeKind(kind: string): kind is RuntimeKind {
  return RUNTIME_KINDS.includes(kind as RuntimeKind)
}
