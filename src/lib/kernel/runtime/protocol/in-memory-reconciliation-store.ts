// =============================================================================
// Kernel: In-Memory Reconciliation Store (Phase 11B)
// =============================================================================
// An in-memory implementation of ReconciliationStore for tests that don't use
// PostgreSQL. Mirrors the same atomicity + uniqueness discipline as the
// Postgres implementation, just without persistence.
//
// This is NOT durable (process restart loses state). It exists so that the
// happy-path tests can verify the reconciliation contract without a database.
// Crash-recovery tests MUST use PostgresReconciliationStore.
// =============================================================================

import type {
  ReconciliationStore,
  PhysicalExecutionEvidence,
  PendingCommitment,
  ProtocolOutcome,
} from './reconciliation-types'
import { mapBatchStatusToReconciliationState } from './reconciliation-types'

export class InMemoryReconciliationStore implements ReconciliationStore {
  private readonly evidence = new Map<string, PhysicalExecutionEvidence>()
  private readonly commitments = new Map<string, PendingCommitment>()
  private readonly commitmentsByEvidence = new Map<string, string>() // evidenceId → commitmentId

  async recordPending(
    evidence: PhysicalExecutionEvidence,
    intendedTransactionId: string,
    sender: string,
    nonce: number,
  ): Promise<PendingCommitment> {
    // C3: at most one commitment per evidenceId. If one exists, return it.
    const existingId = this.commitmentsByEvidence.get(evidence.evidenceId)
    if (existingId) {
      const existing = this.commitments.get(existingId)
      if (existing) return existing
    }

    // E1: evidence is immutable. Store if not present.
    if (!this.evidence.has(evidence.evidenceId)) {
      this.evidence.set(evidence.evidenceId, evidence)
    }

    const commitment: PendingCommitment = {
      commitmentId: `pending-${this.commitments.size + 1}-${evidence.evidenceId.slice(0, 8)}`,
      evidenceId: evidence.evidenceId,
      networkVersionId: evidence.networkVersionId,
      intendedTransactionId,
      sender,
      nonce,
      status: 'PENDING',
      createdAt: new Date(),
    }

    this.commitments.set(commitment.commitmentId, commitment)
    this.commitmentsByEvidence.set(evidence.evidenceId, commitment.commitmentId)
    return commitment
  }

  async resolve(
    commitmentId: string,
    outcome: ProtocolOutcome,
  ): Promise<PendingCommitment> {
    const commitment = this.commitments.get(commitmentId)
    if (!commitment) {
      throw new Error(
        `InMemoryReconciliationStore.resolve: commitment ${commitmentId} not found`,
      )
    }

    // C4: a commitment never transitions backwards.
    if (commitment.status !== 'PENDING') {
      throw new Error(
        `InMemoryReconciliationStore.resolve: commitment ${commitmentId} is already ` +
          `resolved (status=${commitment.status}); a commitment never transitions ` +
          `backwards (C4).`,
      )
    }

    // Advance the commitment PENDING → terminal.
    // R1: the BatchExecutionStatus → ReconciliationState mapping is pure and
    // computed here (at write time).
    const reconciliationState = mapBatchStatusToReconciliationState(outcome.status)
    const resolved: PendingCommitment = {
      ...commitment,
      status: reconciliationState,
      resolvedAt: outcome.recordedAt,
      outcomeId: outcome.outcomeId,
    }
    this.commitments.set(commitmentId, resolved)
    return resolved
  }

  async loadPending(): Promise<PendingCommitment[]> {
    return Array.from(this.commitments.values()).filter(
      (c) => c.status === 'PENDING',
    )
  }

  async findByEvidence(evidenceId: string): Promise<PendingCommitment | null> {
    const id = this.commitmentsByEvidence.get(evidenceId)
    if (!id) return null
    return this.commitments.get(id) ?? null
  }

  async loadEvidence(evidenceId: string): Promise<PhysicalExecutionEvidence | null> {
    return this.evidence.get(evidenceId) ?? null
  }

  /**
   * In-memory store has no journal. Returns null — recovery will always
   * re-submit. This is correct for happy-path tests; crash-after-commit
   * tests that need journal lookup use a custom store or PostgreSQL.
   */
  async findCommittedTransaction(
    _networkVersionId: string,
    _transactionId: string,
  ): Promise<Date | null> {
    return null
  }
}
