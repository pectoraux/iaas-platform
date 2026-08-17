// =============================================================================
// Kernel: Hybrid Reconciliation Protocol Objects (Phase 11B)
// =============================================================================
// The four-primitive object model for physical→protocol handoff, specified in
// docs/phase-11a-protocol-specification.md §4.
//
//   PhysicalExecutionEvidence
//              ↓ (durably recorded first)
//   PendingCommitment
//              ↓ (protocol submission attempted)
//   ProtocolOutcome
//              ↓ (precise cause preserved)
//   ReconciliationState
//
// ARCHITECTURAL RULES (from Phase 11A spec):
//   - Each primitive is content-addressed where it represents a fact (evidence,
//     outcome) and lifecycle-tagged where it represents a process (commitment).
//   - No primitive stores another primitive's guts by reference; each stores
//     hashes and IDs so the record is a durable protocol artifact, not an
//     in-memory DTO.
//   - "Durable" means written through the same atomic, OCC-guarded, journaled
//     PostgreSQL path that PostgresProtocolStateStore uses (spec §2 rule 7).
//
// ANTI-CONFLATION (spec §7, invariant R2):
//   No two distinct BatchExecutionStatus values map to the same
//   ReconciliationState. The mapping is a pure function computed at write time
//   and stored, not re-derived on read.
// =============================================================================

import { createHash, randomUUID } from 'crypto'
import type { RuntimeExecuteResult } from './../../types'
import type { BatchExecutionStatus, BatchExecutionResult } from './types'

// ---------------------------------------------------------------------------
// Canonical serialization (for content-addressed identity)
// ---------------------------------------------------------------------------

/**
 * Recursively sort object keys to produce a canonical JSON representation.
 *
 * Same algorithm as the canonicalize() in executor.ts — kept private here to
 * avoid touching frozen kernel code. Two objects with the same semantic content
 * but different property insertion order produce the same serialized form and
 * therefore the same hash.
 */
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

/** SHA-256 of the canonical JSON form of a value. */
function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

// ---------------------------------------------------------------------------
// Primitive 1: PhysicalExecutionEvidence
// ---------------------------------------------------------------------------

/**
 * Prove that a physical action occurred in the infrastructure world. This is
 * the bridge between "the real world did something" and "the protocol may owe
 * a state transition."
 *
 * IDENTITY (spec §4.1 E2): content-addressed.
 *   evidenceId = SHA-256(canonical(executionAssignmentId, networkVersionId,
 *                                 resultDigest, occurredAt))
 *
 * The same physical result always yields the same evidence ID. occurredAt is
 * included so that two physically identical results at different times produce
 * distinct evidence (they ARE distinct events).
 *
 * IMMUTABILITY (spec §4.1 E1): evidence is immutable after creation. There is
 * no update path.
 *
 * RE-DERIVATION (spec §6.3): the evidence stores the full canonical
 * RuntimeExecuteResult (resultJson) so that, after a crash, the intended
 * protocol transaction can be re-derived deterministically from the evidence
 * (C2). This mirrors how ProtocolStateSnapshot stores both stateJson (full
 * state) and stateHash (identity).
 */
export interface PhysicalExecutionEvidence {
  /** Content-addressed identity (spec §4.1 E2). */
  readonly evidenceId: string
  /** The infrastructure assignment that produced it. */
  readonly executionAssignmentId: string
  /** The runtime kind that produced this evidence ('hybrid' today). */
  readonly runtimeKind: 'hybrid'
  /** The protocol scope this evidence is intended for. */
  readonly networkVersionId: string
  /** SHA-256 of the canonical RuntimeExecuteResult. */
  readonly resultDigest: string
  /** The full canonical RuntimeExecuteResult (for re-derivation at recovery). */
  readonly resultJson: string
  /** Wall-clock of physical completion (recorded once, non-deterministic). */
  readonly occurredAt: Date
}

/**
 * Compute a PhysicalExecutionEvidence from a runtime result.
 *
 * PURE: same inputs → same evidenceId (modulo occurredAt, which is provided by
 * the caller and recorded once).
 */
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

/**
 * The resolved classification of a commitment, derived from its
 * ProtocolOutcome.status. Expressed in terms of the *reconciliation action*
 * required, not the batch status.
 *
 * ANTI-CONFLATION (spec §7, invariant R2): no two distinct BatchExecutionStatus
 * values map to the same ReconciliationState. The conflation found in
 * Phase 10.5D (where REJECTED_BY_CONSENSUS, EXECUTION_FAILED,
 * INVALID_FINALITY_CERTIFICATE, and NO_TRANSACTIONS all collapsed to
 * RECONCILIATION_REQUIRED) is structurally impossible under this type.
 *
 * This is also the `status` field of PendingCommitment after resolution.
 * Before resolution, the status is PENDING.
 */
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
 * PURE (spec §7 R1): computed at write time and stored, not re-derived on
 * read, so that a later change to the mapping cannot rewrite history.
 *
 * ANTI-CONFLATION (spec §7 R2): no two distinct input statuses map to the same
 * output state. This is enforced structurally — each case returns a distinct
 * value.
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
// Primitive 2: PendingCommitment
// ---------------------------------------------------------------------------

/**
 * Durable record that links a PhysicalExecutionEvidence to a protocol
 * transaction that SHOULD be derived from it. This is the "I owe the protocol
 * a transition" record. It is the crash barrier.
 *
 * IDENTITY (spec §4.2): own UUID (commitmentId) for operational addressing.
 *
 * CRITICAL DIFFERENCE FROM 10.5D: the commitment does NOT store the whole
 * RuntimeExecuteResult or the whole ProtocolTransaction. It stores evidenceId
 * (a hash) and intendedTransactionId (a hash). The full objects remain in
 * their own tables. The commitment is a durable linkage record, not a bag of
 * objects.
 *
 * INVARIANTS (spec §4.2):
 *   C1. PENDING means: physical action occurred + durably evidenced, AND
 *       protocol outcome is not yet durably recorded.
 *   C2. intendedTransactionId is deterministic from evidence + nonce + sender
 *       + networkVersionId (the bridge is a pure function of the result).
 *   C3. At most one PENDING commitment per evidenceId (UNIQUE constraint).
 *   C4. A commitment never transitions backwards. PENDING → {RECONCILED,
 *       <cause>} is the only forward edge. Terminal causes are not auto-retried
 *       by the kernel.
 */
export interface PendingCommitment {
  /** UUID, operational handle. */
  readonly commitmentId: string
  /** FK to PhysicalExecutionEvidence (durable). */
  readonly evidenceId: string
  /** Protocol scope. */
  readonly networkVersionId: string
  /**
   * The deterministic ProtocolTransaction.id the bridge WILL derive (computed
   * from evidence, not from a re-execution of the bridge). Spec §4.2 C2.
   */
  readonly intendedTransactionId: string
  /** Current reconciliation status (PENDING before resolution). */
  status: ReconciliationState
  /** When the commitment was durably written. */
  readonly createdAt: Date
  /** When the protocol outcome was durably recorded, if ever. */
  resolvedAt?: Date
  /** FK to the recorded ProtocolOutcome (by outcome ID), if resolved. */
  outcomeId?: string
}

// ---------------------------------------------------------------------------
// Primitive 3: ProtocolOutcome
// ---------------------------------------------------------------------------

/**
 * Durable record of what the protocol layer returned for a given
 * intendedTransactionId. The captured BatchExecutionResult, preserved WITH its
 * precise BatchExecutionStatus, never collapsed.
 *
 * IDENTITY (spec §4.3): content-addressed.
 *   outcomeId = SHA-256(commitmentId, transactionId, finalityCertificate,
 *                       status)
 *
 * INVARIANTS (spec §4.3):
 *   O1. status is the EXACT BatchExecutionStatus returned by submitTransaction.
 *       Never rewritten into a coarser value.
 *   O2. One outcome per (commitmentId, finalityCertificate). A re-submission
 *       after a crash that produces a different certificate produces a NEW
 *       outcome row; history is append-only.
 *   O3. Does NOT store the receipts array; stores a digest. The receipts are
 *       already durably recorded by the protocol transition journal.
 */
export interface ProtocolOutcome {
  /** Content-addressed identity (spec §4.3). */
  readonly outcomeId: string
  /** FK back to the commitment. */
  readonly commitmentId: string
  /**
   * The ProtocolTransaction.id actually submitted (equals
   * intendedTransactionId if the bridge is deterministic; recording both lets
   * reconciliation detect bridge drift — spec §6.4).
   */
  readonly transactionId: string
  /** The certificate of the finalized batch (null if rejected pre-finalization). */
  readonly finalityCertificate: string | null
  /** The precise BatchExecutionStatus (spec §4.3 O1). */
  readonly status: BatchExecutionStatus
  /** SHA-256 of the canonical receipts array (spec §4.3 O3). */
  readonly receiptsDigest: string | null
  /** The error string from the batch result, if any. */
  readonly error: string | null
  /** When the outcome was durably written. */
  readonly recordedAt: Date
}

/**
 * Compute a ProtocolOutcome from a batch result + commitment.
 *
 * PURE: same inputs → same outcomeId. Spec §4.3 identity.
 */
export function computeOutcome(
  commitmentId: string,
  transactionId: string,
  batchResult: BatchExecutionResult,
  recordedAt: Date,
): ProtocolOutcome {
  const finalityCertificate = batchResult.receipts.length > 0
    // The receipt's transaction ID is the canonical anchor; the finality
    // certificate is captured from the batch the runtime executed. For
    // outcomes where consensus rejected pre-finalization, there is no
    // certificate (null).
    ? (batchResult.receipts[0]?.receipt?.transactionId ?? null)
    : null

  const receiptsDigest = batchResult.receipts.length > 0
    ? sha256(batchResult.receipts)
    : null

  const outcomeId = sha256({
    commitmentId,
    transactionId,
    finalityCertificate,
    status: batchResult.status,
  })

  return {
    outcomeId,
    commitmentId,
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
 * transaction, but no outcome was durably recorded. This synthesizes an
 * EXECUTED outcome from the journal evidence.
 *
 * PURE: same inputs → same outcomeId.
 */
export function computeSyntheticExecutedOutcome(
  commitmentId: string,
  transactionId: string,
  recordedAt: Date,
): ProtocolOutcome {
  const outcomeId = sha256({
    commitmentId,
    transactionId,
    finalityCertificate: transactionId,
    status: 'EXECUTED',
  })
  return {
    outcomeId,
    commitmentId,
    transactionId,
    finalityCertificate: transactionId,
    status: 'EXECUTED',
    receiptsDigest: null,
    error: null,
    recordedAt,
  }
}

// ---------------------------------------------------------------------------
// ReconciliationStore — durable persistence contract (spec §5.1)
// ---------------------------------------------------------------------------

/**
 * Durable store for the reconciliation primitives. Sibling to
 * ProtocolStateStore. The implementation is Phase 11B; this contract is
 * Phase 11A §5.1.
 *
 * DURABILITY BAR (spec §5): recordPending and resolve each execute as a single
 * atomic transaction (db.$transaction in the Postgres implementation). No
 * partial writes are observable. This mirrors PostgresProtocolStateStore.commit
 * (atomic snapshot + transition journal).
 *
 * IDEMPOTENCE (spec §4.2 C3): recordPending enforces at most one PENDING
 * commitment per evidenceId. Re-deriving the same evidence after a crash
 * returns the existing commitment, not a duplicate.
 */
export interface ReconciliationStore {
  /**
   * Atomic: writes evidence + a PENDING commitment referencing it, in one tx.
   * Enforces C3 (at most one PENDING per evidenceId) via UNIQUE(evidenceId).
   * Returns the commitment (PENDING). If a PENDING commitment for this
   * evidenceId already exists, returns the existing one (idempotent).
   */
  recordPending(
    evidence: PhysicalExecutionEvidence,
    intendedTransactionId: string,
  ): Promise<PendingCommitment>

  /**
   * Atomic: writes the outcome + advances the commitment status, in one tx.
   * The commitment must currently be PENDING. The outcome is append-only.
   * Returns the updated commitment (now in a terminal ReconciliationState).
   */
  resolve(
    commitmentId: string,
    outcome: ProtocolOutcome,
  ): Promise<PendingCommitment>

  /**
   * Restart recovery (spec §6.3): load all commitments still in PENDING.
   * Used by the recovery path on process restart.
   */
  loadPending(): Promise<PendingCommitment[]>

  /**
   * Operational read: load a commitment by evidenceId (for de-dup at the
   * application layer before physical execution, if desired).
   */
  findByEvidence(evidenceId: string): Promise<PendingCommitment | null>

  /**
   * Load an evidence record by ID (for re-derivation at recovery — spec §6.3).
   * Returns the evidence with its full resultJson, or null if not found.
   */
  loadEvidence(evidenceId: string): Promise<PhysicalExecutionEvidence | null>
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Create a new PendingCommitment (PENDING) in memory. The store is responsible
 * for durably persisting it via recordPending().
 */
export function createPendingCommitment(
  evidence: PhysicalExecutionEvidence,
  intendedTransactionId: string,
): PendingCommitment {
  return {
    commitmentId: randomUUID(),
    evidenceId: evidence.evidenceId,
    networkVersionId: evidence.networkVersionId,
    intendedTransactionId,
    status: 'PENDING',
    createdAt: new Date(),
  }
}
