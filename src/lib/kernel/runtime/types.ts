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
 *
 * Phase 5.4: contributionId is intentionally ABSENT from this type. The
 * only way to link a contribution to an assignment is via linkContribution(),
 * which enforces write-once semantics. recordAssignmentResults() records
 * OPERATIONAL results only (actuals, verified quantity, event) — it cannot
 * set the economic contribution link.
 */
export interface RuntimeAssignmentResults {
  actualQuantity?: string
  actualUnit?: string
  verifiedQuantity?: string
  verifiedUnit?: string
  eventId?: string
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
   * links to Event). Called after the vertical has verified the execution
   * output — this is OPERATIONAL completion, not economic completion.
   *
   * Phase 5.2: The contributionId is NOT set here. It is set later via
   * linkContribution() after the vertical creates its economic contribution.
   * This separates operational results (actuals, verified quantity) from
   * economic links (contribution).
   */
  recordAssignmentResults(
    tx: RuntimeClient,
    executionAssignmentId: string,
    results: RuntimeAssignmentResults,
  ): Promise<void>

  /**
   * Link a contribution to an assignment AFTER operational completion.
   * Called by the vertical after it has created its economic contribution
   * (which depends on the verified results). This is an economic link,
   * not an operational one — the assignment is already completed by this
   * point.
   *
   * Phase 5.4 — WRITE-ONCE SEMANTICS:
   * The kernel guarantees that a contribution link is immutable once set:
   *
   *   NULL → C1   allowed (first link)
   *   C1  → C1   no-op (idempotent re-link of the same contribution)
   *   C1  → C2   REJECTED (cannot replace an existing contribution)
   *   non-completed → REJECTED (cannot link before operational completion)
   *
   * This prevents a stale or duplicated economic worker from relinking a
   * completed assignment to a different contribution. The vertical does not
   * need to implement this safety — the runtime enforces it.
   *
   * THROWS on rejection (count=0 after CAS). The error distinguishes:
   *   - assignment not found
   *   - assignment not completed
   *   - assignment already linked to a different contribution
   */
  linkContribution(
    tx: RuntimeClient,
    executionAssignmentId: string,
    contributionId: string,
  ): Promise<void>

  /**
   * Complete an assignment: transition ExecutionAssignment → 'completed' and
   * atomically finalize the parent Execution if all assignments are terminal.
   *
   * Phase 5.2 — EXECUTION/ECONOMICS SEPARATION:
   * This is called after OPERATIONAL execution + verification, NOT after
   * economic settlement. The generic Execution answers "did the work
   * execute?" — it does NOT wait for reward/ledger/settlement. Those are
   * VPP-specific economic obligations that continue AFTER the generic
   * assignment is completed.
   *
   *   physical execution → telemetry → verification → baseline
   *       → recordAssignmentResults → completeAssignment  ← HERE
   *       → (generic Execution is now completed)
   *       → contribution → reward → ledger → settlement  ← economic, separate
   *
   * If settlement fails AFTER this point, the generic assignment STAYS
   * completed. The VPP layer enters 'reconciliation_required' for economic
   * recovery, but the generic execution layer is not affected.
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
   *
   * Phase 5.2: This is only called for OPERATIONAL failures (physical
   * execution failed, or verification failed before operational completion).
   * It must NOT be called for economic failures (settlement failure) after
   * the assignment is already completed.
   *
   * CAS GUARANTEE: If the assignment is already 'completed', this is a
   * no-op — operational completion is irreversible. A settlement failure
   * cannot change a completed assignment to failed.
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
