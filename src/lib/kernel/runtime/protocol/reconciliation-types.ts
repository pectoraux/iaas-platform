// =============================================================================
// Kernel: Hybrid Reconciliation Protocol Objects (Phase 11B — corrected)
// =============================================================================
// The four-primitive object model for physical→protocol handoff, specified in
// docs/phase-11a-protocol-specification.md §4.
//
//   PhysicalExecutionEvidence
//              ↓ (durably recorded first)
//   ReconciliationAttempt   ← renamed from PendingCommitment
//              ↓ (protocol submission attempted)
//   ProtocolOutcome
//              ↓ (precise cause preserved)
//   ReconciliationState
//
// PHASE 11B CORRECTION (attempt-based lifecycle):
//   The original 6e31067 model enforced ONE commitment per evidence via
//   UNIQUE(evidenceId). This caused a critical defect: a retry after a
//   terminal failure returned the SAME resolved commitment, and
//   executeHybrid misreported it as EXECUTED without submitting anything.
//
//   The corrected model separates:
//     - Evidence: immutable fact (one per physical action).
//     - Attempt: a reconciliation try (PENDING → terminal). MULTIPLE attempts
//       can exist per evidence — a failed terminal attempt can be followed by
//       a NEW attempt that legitimately re-submits.
//     - Outcome: one per (attemptId, finalityCertificate). Append-only.
//
//   recordPending now ALWAYS creates a new PENDING attempt. The caller decides
//   when to retry. C3 (idempotence) is redefined: at most one PENDING attempt
//   per evidence at a time (a new attempt requires the previous one to be
//   terminal).
//
// PHASE 11B CORRECTION (finalityCertificate):
//   computeOutcome now reads batchResult.finalityCertificate (the actual
//   consensus certificate = SHA-256 of ordered tx IDs), NOT the transaction ID.
//   BatchExecutionResult was extended to carry this field.
//
// ANTI-CONFLATION (spec §7, invariant R2):
//   No two distinct BatchExecutionStatus values map to the same
//   ReconciliationState. Computed at write time and stored (R1).
// =============================================================================

import { createHash, randomUUID } from 'crypto'
import type { RuntimeExecuteResult } from '../types'
import type { BatchExecutionStatus, BatchExecutionResult } from './types'

// ---------------------------------------------------------------------------
// Canonical serialization (for content-addressed identity)
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  const sortedKeys = Object.keys(value as Record<string, unknown>).sort()
  const result: Record<string, unknown> = {}
  for (const key of sortedKeys) {
    result[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return result
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

// ---------------------------------------------------------------------------
// Primitive 1: PhysicalExecutionEvidence
// ---------------------------------------------------------------------------

/**
 * Prove that a physical action occurred in the infrastructure world.
 *
 * IDENTITY (spec §4.1 E2): content-addressed.
 *   evidenceId = SHA-256(canonical(executionAssignmentId, networkVersionId,
 *                                 resultDigest, occurredAt))
 *
 * IMMUTABILITY (spec §4.1 E1): evidence is immutable after creation.
 *
 * RE-DERIVATION (spec §6.3): stores the full canonical RuntimeExecuteResult
 * (resultJson) so the intended protocol transaction can be re-derived after a
 * crash (C2).
 */
export interface PhysicalExecutionEvidence {
  readonly evidenceId: string
  readonly executionAssignmentId: string
  readonly runtimeKind: 'hybrid'
  readonly networkVersionId: string
  readonly resultDigest: string
  readonly resultJson: string
  readonly occurredAt: Date
}

export function computeEvidence(
  executionAssignmentId: string,
  networkVersionId: string,
  result: RuntimeExecuteResult,
  occurredAt: Date,
): PhysicalExecutionEvidence {
  const resultJson = JSON.stringify(canonicalize(result))
  const resultDigest = sha256(result)
  const evidenceId = sha256({
    executionAssignmentId,
    networkVersionId,
    resultDigest,
    occurredAt: occurredAt.toISOString(),
  })
  return {
    evidenceId,
    executionAssignmentId,
    runtimeKind: 'hybrid',
    networkVersionId,
    resultDigest,
    resultJson,
    occurredAt,
  }
}

// ---------------------------------------------------------------------------
// Primitive 4 (defined early because 2 references it): ReconciliationState
// ---------------------------------------------------------------------------

export type ReconciliationState =
  | 'PENDING'
  | 'RECONCILED'
  | 'RECONCILIATION_REQUIRED_EXECUTION_FAILURE'
  | 'RECONCILIATION_REQUIRED_CONSENSUS_REJECTION'
  | 'RECONCILIATION_REQUIRED_CERTIFICATE_INVALID'
  | 'RECONCILIATION_REQUIRED_INVARIANT_VIOLATION'

/**
 * Map a BatchExecutionStatus to a ReconciliationState.
 *
 * PURE (spec §7 R1) + ANTI-CONFLATION (spec §7 R2): each case returns a
 * distinct value. Structurally impossible to collapse causes.
 */
export function mapBatchStatusToReconciliationState(
  status: BatchExecutionStatus,
): Exclude<ReconciliationState, 'PENDING'> {
  switch (status) {
    case 'EXECUTED':
      return 'RECONCILED'
    case 'EXECUTION_FAILED':
      return 'RECONCILIATION_REQUIRED_EXECUTION_FAILURE'
    case 'REJECTED_BY_CONSENSUS':
      return 'RECONCILIATION_REQUIRED_CONSENSUS_REJECTION'
    case 'INVALID_FINALITY_CERTIFICATE':
      return 'RECONCILIATION_REQUIRED_CERTIFICATE_INVALID'
    case 'NO_TRANSACTIONS':
      return 'RECONCILIATION_REQUIRED_INVARIANT_VIOLATION'
  }
}

// ---------------------------------------------------------------------------
// Primitive 2: ReconciliationAttempt (renamed from PendingCommitment)
// ---------------------------------------------------------------------------

/**
 * A reconciliation attempt: links PhysicalExecutionEvidence to a protocol
 * transaction submission try. This is the crash barrier.
 *
 * PHASE 11B CORRECTION (attempt lifecycle):
 *   Multiple attempts can exist per evidence. A failed terminal attempt can
 *   be followed by a NEW attempt that legitimately re-submits. This fixes the
 *   6e31067 defect where a retry returned the same resolved commitment and
 *   executeHybrid misreported it as EXECUTED.
 *
 *   C3 (corrected): at most one PENDING attempt per evidence at a time.
 *   Enforced by the store (a new attempt requires no existing PENDING attempt
 *   for that evidence). Terminal attempts are preserved for history.
 *
 *   C4: an attempt never transitions backwards. PENDING → {RECONCILED,
 *   <cause>} is the only forward edge. A new attempt is a NEW row, not a
 *   backwards transition.
 *
 *   C2: intendedTransactionId is derived from the STORED EVIDENCE via the
 *   bridge's deriveTransactionId contract (spec §6.4). At submission time,
 *   the bridge's full transaction builder produces a transaction from the LIVE
 *   result; the kernel compares transaction.id against the stored
 *   intendedTransactionId. Mismatch → input drift (live result differs from
 *   stored evidence). See the HybridBridge interface for the honest scope of
 *   this independence (separation of input, not independent algorithm).
 */
export interface ReconciliationAttempt {
  /** UUID, operational handle. */
  readonly attemptId: string
  /** FK to PhysicalExecutionEvidence (durable). */
  readonly evidenceId: string
  /** Protocol scope. */
  readonly networkVersionId: string
  /**
   * The deterministic ProtocolTransaction.id the bridge MUST produce.
   * Computed INDEPENDENTLY from evidence via deriveIntendedTransactionId
   * (spec §4.2 C2, §6.4). The bridge output is verified against this at
   * submission time — not just at recovery.
   */
  readonly intendedTransactionId: string
  /** The sender identity for re-derivation at recovery (spec §6.3). */
  readonly sender: string
  /** The sender's nonce for re-derivation at recovery (spec §6.3). */
  readonly nonce: number
  /** Current reconciliation status (PENDING before resolution). */
  status: ReconciliationState
  /** When the attempt was durably written. */
  readonly createdAt: Date
  /** When the protocol outcome was durably recorded, if ever. */
  resolvedAt?: Date
  /** FK to the recorded ProtocolOutcome, if resolved. */
  outcomeId?: string
}

/**
 * Backward-compatible alias. Existing code that references PendingCommitment
 * continues to work; the type is identical.
 */
export type PendingCommitment = ReconciliationAttempt

// ---------------------------------------------------------------------------
// Primitive 3: ProtocolOutcome
// ---------------------------------------------------------------------------

/**
 * Sentinel value for outcomes where no batch was finalized (pre-finalization
 * rejections: REJECTED_BY_CONSENSUS, NO_TRANSACTIONS). Used INSTEAD of NULL
 * so that the @@unique([attemptId, finalityCertificate]) constraint actually
 * enforces O2.
 *
 * PHASE 11B FIX (Defect 6 — O2 nullable loophole): PostgreSQL UNIQUE allows
 * multiple NULL values, so using NULL for pre-finalization outcomes would
 * let an attempt accumulate multiple (attemptId, NULL) rows. The sentinel
 * '' (empty string) is a real value that the constraint treats as equal to
 * itself, so O2 is genuinely enforced.
 *
 * '' is chosen because a valid finality certificate is always a 64-char
 * SHA-256 hex; '' is never a valid certificate, so there's no collision risk.
 */
export const NO_FINALITY_CERTIFICATE = ''

/**
 * Durable record of what the protocol layer returned for a given attempt.
 *
 * IDENTITY (spec §4.3): content-addressed.
 *   outcomeId = SHA-256(attemptId, transactionId, finalityCertificate, status)
 *
 * INVARIANTS (spec §4.3):
 *   O1. status is the EXACT BatchExecutionStatus. Never rewritten.
 *   O2. One outcome per (attemptId, finalityCertificate). ENFORCED by
 *       @@unique([attemptId, finalityCertificate]) in the schema, using the
 *       NO_FINALITY_CERTIFICATE sentinel instead of NULL (Defect 6 fix —
 *       PostgreSQL UNIQUE allows multiple NULLs, which broke O2).
 *   O3. Does NOT store the receipts array; stores a digest.
 *
 * PHASE 11B CORRECTION (finalityCertificate):
 *   The `finalityCertificate` field holds the ACTUAL consensus certificate
 *   (SHA-256 of ordered tx IDs), threaded from BatchExecutionResult.
 *   Pre-finalization outcomes use NO_FINALITY_CERTIFICATE (''), not NULL.
 */
export interface ProtocolOutcome {
  readonly outcomeId: string
  /** FK back to the attempt. */
  readonly attemptId: string
  /**
   * The ProtocolTransaction.id actually submitted (equals
   * intendedTransactionId if the bridge is deterministic; recording both lets
   * reconciliation detect bridge drift — spec §6.4).
   */
  readonly transactionId: string
  /**
   * The actual consensus certificate, or NO_FINALITY_CERTIFICATE ('') if the
   * batch was rejected pre-finalization. Never NULL (Defect 6 fix).
   */
  readonly finalityCertificate: string
  /** The precise BatchExecutionStatus (spec §4.3 O1). */
  readonly status: BatchExecutionStatus
  /** SHA-256 of the canonical receipts array (spec §4.3 O3). */
  readonly receiptsDigest: string | null
  readonly error: string | null
  readonly recordedAt: Date
}

/**
 * Compute a ProtocolOutcome from a batch result + attempt.
 *
 * PHASE 11B FIX (Defect 6): uses NO_FINALITY_CERTIFICATE ('') instead of NULL
 * for pre-finalization outcomes, so O2 is genuinely enforced by the unique
 * constraint.
 *
 * PURE: same inputs → same outcomeId.
 */
export function computeOutcome(
  attemptId: string,
  transactionId: string,
  batchResult: BatchExecutionResult,
  recordedAt: Date,
): ProtocolOutcome {
  const finalityCertificate = batchResult.finalityCertificate ?? NO_FINALITY_CERTIFICATE
  const receiptsDigest = batchResult.receipts.length > 0
    ? sha256(batchResult.receipts)
    : null

  const outcomeId = sha256({
    attemptId,
    transactionId,
    finalityCertificate,
    status: batchResult.status,
  })

  return {
    outcomeId,
    attemptId,
    transactionId,
    finalityCertificate,
    status: batchResult.status,
    receiptsDigest,
    error: batchResult.error ?? null,
    recordedAt,
  }
}

/**
 * Compute a SYNTHETIC outcome for crash recovery (spec §6.3): the protocol
 * commit succeeded before the crash, so the transition journal contains the
 * transaction, but no outcome was durably recorded.
 *
 * The finalityCertificate for a single-transaction batch is SHA-256(txId)
 * (computeFinalityCertificate joins ordered IDs with ':', so for one tx it's
 * SHA-256(txId)).
 *
 * PURE: same inputs → same outcomeId.
 */
export function computeSyntheticExecutedOutcome(
  attemptId: string,
  transactionId: string,
  recordedAt: Date,
): ProtocolOutcome {
  const finalityCertificate = createHash('sha256').update(transactionId).digest('hex')

  const outcomeId = sha256({
    attemptId,
    transactionId,
    finalityCertificate,
    status: 'EXECUTED',
  })
  return {
    outcomeId,
    attemptId,
    transactionId,
    finalityCertificate,
    status: 'EXECUTED',
    receiptsDigest: null,
    error: null,
    recordedAt,
  }
}

// ---------------------------------------------------------------------------
// ReconciliationStore — durable persistence contract (spec §5.1, corrected)
// ---------------------------------------------------------------------------

/**
 * Durable store for the reconciliation primitives.
 *
 * DURABILITY BAR (spec §5): recordPending and resolve each execute as a single
 * atomic transaction. No partial writes are observable.
 *
 * ATTEMPT LIFECYCLE (Phase 11B correction):
 *   recordPending ALWAYS creates a NEW PENDING attempt. It does NOT return an
 *   existing terminal attempt. A retry after failure creates a new attempt
 *   linked to the same evidence. C3 (corrected): the store rejects a new
 *   PENDING attempt if one already exists for that evidence (a concurrent
 *   retry race); terminal attempts do not block new attempts.
 */
export interface ReconciliationStore {
  /**
   * Atomic: writes evidence + a NEW PENDING attempt referencing it, in one tx.
   *
   * C3 (corrected): creates a NEW attempt each call. The store enforces that
   * no existing PENDING attempt exists for this evidenceId (concurrent retry
   * race protection). Terminal attempts do NOT block new attempts — a retry
   * after failure legitimately creates a new PENDING attempt.
   *
   * @returns the new PENDING attempt.
   * @throws if a PENDING attempt already exists for this evidenceId.
   */
  recordPending(
    evidence: PhysicalExecutionEvidence,
    intendedTransactionId: string,
    sender: string,
    nonce: number,
  ): Promise<ReconciliationAttempt>

  /**
   * Atomic: writes the outcome + advances the attempt status, in one tx.
   * The attempt must currently be PENDING. The outcome is append-only (O2).
   * Returns the updated attempt (now in a terminal ReconciliationState).
   */
  resolve(
    attemptId: string,
    outcome: ProtocolOutcome,
  ): Promise<ReconciliationAttempt>

  /**
   * Restart recovery (spec §6.3): load all attempts still in PENDING.
   */
  loadPending(): Promise<ReconciliationAttempt[]>

  /**
   * Operational read: load the most recent attempt for an evidenceId.
   * Returns null if no attempt exists.
   */
  findByEvidence(evidenceId: string): Promise<ReconciliationAttempt | null>

  /**
   * Load an evidence record by ID (for re-derivation at recovery — spec §6.3).
   */
  loadEvidence(evidenceId: string): Promise<PhysicalExecutionEvidence | null>

  /**
   * Journal lookup (spec §6.3): check if a protocol transaction has already
   * been committed. Returns the commit timestamp if found, null otherwise.
   */
  findCommittedTransaction(
    networkVersionId: string,
    transactionId: string,
  ): Promise<Date | null>

  /**
   * Ensure the partial unique index for C3 exists (Defect 5 + 9 fix).
   *
   * C3 (race-proof): at most one PENDING attempt per evidence at a time,
   * enforced by a PostgreSQL partial unique index:
   *   CREATE UNIQUE INDEX IF NOT EXISTS recon_attempt_pending_unique
   *     ON "ReconciliationAttempt" ("evidenceId") WHERE "status" = 'PENDING'
   *
   * SCHEMA LIFECYCLE (Defect 9 fix): the index is created by a proper Prisma
   * migration (prisma/migrations/20260817000000_recon_c3_partial_unique/), which
   * is the source of truth. This method is a SAFETY NET — it runs
   * `CREATE UNIQUE INDEX IF NOT EXISTS` on startup to handle environments that
   * haven't run the migration (e.g., a fresh dev DB created via `db push`
   * without migrations). It is idempotent and does not replace the migration.
   *
   * Race-proof under PostgreSQL default (READ COMMITTED) isolation: two
   * concurrent INSERTs of PENDING for the same evidenceId cannot both
   * succeed — one fails with a unique violation.
   *
   * The PostgresReconciliationStore executes this via $executeRawUnsafe. The
   * InMemoryReconciliationStore is a no-op (single-threaded, no race).
   */
  ensureC3UniqueIndex(): Promise<void>
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function createPendingCommitment(
  evidence: PhysicalExecutionEvidence,
  intendedTransactionId: string,
  sender: string,
  nonce: number,
): ReconciliationAttempt {
  return {
    attemptId: randomUUID(),
    evidenceId: evidence.evidenceId,
    networkVersionId: evidence.networkVersionId,
    intendedTransactionId,
    sender,
    nonce,
    status: 'PENDING',
    createdAt: new Date(),
  }
}
