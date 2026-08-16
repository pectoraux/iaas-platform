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

/**
 * Input for the runtime's physical execution of an assignment.
 * Phase 6: The vertical provides the asset type (for adapter resolution),
 * the assigned quantity, and execution parameters.
 * Phase 7.2: The vertical can optionally specify adapterType for deterministic
 * adapter selection when multiple adapters serve the same asset type.
 */
export interface RuntimeExecuteInput {
  /** The asset to execute on (looked up to determine assetType for adapter resolution). */
  assetId: string
  /** The asset type (e.g., 'battery', 'compute_node') — determines the adapter. */
  assetType: string
  /**
   * The capability to execute (e.g., 'energy_discharge').
   * Also used by the registry for capability-aware resolution.
   */
  capabilityType: string
  /**
   * Phase 7.2: Optional explicit adapter selection.
   *
   * If specified, the runtime resolves the exact adapter via:
   *   adapterRegistry.resolve({ assetType, adapterType, capabilityType })
   *
   * If omitted, the runtime resolves the single adapter for the asset type.
   * If multiple adapters are registered and adapterType is omitted,
   * resolution is AMBIGUOUS and throws.
   *
   * This allows Phase 8 (Compute) to select 'gpu_cluster' for 'compute_node'
   * without modifying the kernel, while VPP can omit it (single energy adapter).
   */
  adapterType?: string
  /** Assigned quantity (e.g., assignedKwh). */
  assignedQuantity: string
  assignedUnit: string
  /** Duration in seconds. */
  durationSeconds: number
  /** Additional vertical-specific parameters (e.g., assignedKw for VPP). */
  parameters?: Record<string, unknown>
}

/**
 * Result of the runtime's physical execution of an assignment.
 * Phase 6: The vertical takes this result and processes it (sign telemetry,
 * submit event, verify, compute baseline, etc.).
 */
export interface RuntimeExecuteResult {
  /** Actual output quantity (e.g., actualKwh). */
  actualQuantity: string
  actualUnit: string
  /** Raw telemetry payload from the physical adapter. */
  telemetryPayload: Record<string, unknown>
  /** Whether the execution succeeded. */
  success: boolean
  /** Error message if failed. */
  error?: string
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
   * Execute a physical assignment via the AdapterRegistry.
   *
   * Phase 6 — PHYSICAL EXECUTION BOUNDARY:
   * This is the runtime's ownership of physical execution. It:
   *   1. Resolves the adapter for the asset via AdapterRegistry
   *   2. Calls adapter.execute() — commands the physical asset
   *   3. Acquires the telemetry + actuals from the adapter
   *   4. Returns the raw result to the vertical
   *
   * The vertical (VPP) does NOT import or instantiate the adapter. It calls
   * this method, gets the raw telemetry + actuals, and then:
   *   - Signs + submits the telemetry as a generic Event (vertical-specific)
   *   - Verifies the event (generic pipeline, vertical triggers)
   *   - Computes baseline (vertical-specific)
   *   - Calls recordAssignmentResults + completeAssignment
   *   - Runs the economic pipeline (contribution, reward, settlement)
   *
   * The runtime does NOT know about baselines, contributions, or settlements.
   * It only knows how to execute an asset and acquire telemetry.
   *
   * THROWS on physical execution failure (adapter error, asset offline, etc.).
   * The vertical catches this and calls failAssignment (if before operational
   * completion) or markReconciliationRequired (if after).
   */
  executeAssignment(
    input: RuntimeExecuteInput,
  ): Promise<RuntimeExecuteResult>

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
