// =============================================================================
// Kernel: In-Memory Reconciliation Store (Phase 11B — corrected)
// =============================================================================
// In-memory implementation of ReconciliationStore. Mirrors the Postgres
// attempt-based model: recordPending ALWAYS creates a NEW PENDING attempt;
// C3 rejects a new PENDING if one exists for that evidence; terminal attempts
// do NOT block new attempts.
//
// NOT durable (process restart loses state). Happy-path tests use this;
// crash-recovery tests use a journal-aware wrapper or PostgresReconciliationStore.
// =============================================================================

import type {
  ReconciliationStore,
  PhysicalExecutionEvidence,
  ReconciliationAttempt,
  ProtocolOutcome,
} from './reconciliation-types'
import { mapBatchStatusToReconciliationState } from './reconciliation-types'

export class InMemoryReconciliationStore implements ReconciliationStore {
  private readonly evidence = new Map<string, PhysicalExecutionEvidence>()
  private readonly attempts = new Map<string, ReconciliationAttempt>()
  private readonly attemptsByEvidence = new Map<string, string[]>() // evidenceId → attemptIds (ordered)

  async recordPending(
    evidence: PhysicalExecutionEvidence,
    intendedTransactionId: string,
    sender: string,
    nonce: number,
  ): Promise<ReconciliationAttempt> {
    // E1: evidence is immutable.
    if (!this.evidence.has(evidence.evidenceId)) {
      this.evidence.set(evidence.evidenceId, evidence)
    }

    // C3: reject if a PENDING attempt already exists for this evidence.
    const attemptIds = this.attemptsByEvidence.get(evidence.evidenceId) ?? []
    const pending = attemptIds
      .map((id) => this.attempts.get(id))
      .find((a) => a && a.status === 'PENDING')
    if (pending) {
      throw new Error(
        `InMemoryReconciliationStore.recordPending: a PENDING attempt already exists ` +
          `for evidenceId ${evidence.evidenceId} (attemptId ${pending.attemptId}). ` +
          `Concurrent retry race — resolve the existing attempt before creating a new one (C3).`,
      )
    }

    // ALWAYS create a new attempt row.
    const attempt: ReconciliationAttempt = {
      attemptId: `attempt-${this.attempts.size + 1}-${evidence.evidenceId.slice(0, 8)}`,
      evidenceId: evidence.evidenceId,
      networkVersionId: evidence.networkVersionId,
      intendedTransactionId,
      sender,
      nonce,
      status: 'PENDING',
      createdAt: new Date(),
    }

    this.attempts.set(attempt.attemptId, attempt)
    attemptIds.push(attempt.attemptId)
    this.attemptsByEvidence.set(evidence.evidenceId, attemptIds)
    return attempt
  }

  async resolve(
    attemptId: string,
    outcome: ProtocolOutcome,
  ): Promise<ReconciliationAttempt> {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) {
      throw new Error(
        `InMemoryReconciliationStore.resolve: attempt ${attemptId} not found`,
      )
    }

    // C4: a commitment never transitions backwards.
    if (attempt.status !== 'PENDING') {
      throw new Error(
        `InMemoryReconciliationStore.resolve: attempt ${attemptId} is already ` +
          `resolved (status=${attempt.status}); a commitment never transitions ` +
          `backwards (C4).`,
      )
    }

    // R1: map at write time.
    const reconciliationState = mapBatchStatusToReconciliationState(outcome.status)
    const resolved: ReconciliationAttempt = {
      ...attempt,
      status: reconciliationState,
      resolvedAt: outcome.recordedAt,
      outcomeId: outcome.outcomeId,
    }
    this.attempts.set(attemptId, resolved)
    return resolved
  }

  async loadPending(): Promise<ReconciliationAttempt[]> {
    return Array.from(this.attempts.values()).filter((a) => a.status === 'PENDING')
  }

  async findByEvidence(evidenceId: string): Promise<ReconciliationAttempt | null> {
    const ids = this.attemptsByEvidence.get(evidenceId)
    if (!ids || ids.length === 0) return null
    // Most recent = last in the array.
    const lastId = ids[ids.length - 1]
    return this.attempts.get(lastId) ?? null
  }

  async loadEvidence(evidenceId: string): Promise<PhysicalExecutionEvidence | null> {
    return this.evidence.get(evidenceId) ?? null
  }

  async findCommittedTransaction(
    _networkVersionId: string,
    _transactionId: string,
  ): Promise<Date | null> {
    return null
  }
}
