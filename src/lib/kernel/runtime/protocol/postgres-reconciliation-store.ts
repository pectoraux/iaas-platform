// =============================================================================
// Kernel: PostgreSQL Reconciliation Store (Phase 11B — corrected)
// =============================================================================
// Durable persistence for the hybrid reconciliation primitives (spec §5).
//
// PHASE 11B CORRECTION (attempt lifecycle):
//   recordPending now ALWAYS creates a NEW PENDING attempt. It does NOT return
//   an existing terminal attempt (fixes the 6e31067 defect where a retry was
//   misreported as EXECUTED). C3 (corrected): rejects a new PENDING attempt
//   if one already exists for that evidenceId (concurrent retry race).
//
// DURABILITY BAR (spec §2 rule 7, §5): atomic db.$transaction, mirroring
// PostgresProtocolStateStore. No partial writes are observable.
// =============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import type {
  ReconciliationStore,
  PhysicalExecutionEvidence,
  ReconciliationAttempt,
  ProtocolOutcome,
} from './reconciliation-types'
import { mapBatchStatusToReconciliationState } from './reconciliation-types'

export class PostgresReconciliationStore implements ReconciliationStore {
  /**
   * Atomic: writes evidence + a NEW PENDING attempt, in one tx.
   *
   * C3 (corrected): rejects if a PENDING attempt already exists for this
   * evidenceId (concurrent retry race). Terminal attempts do NOT block new
   * attempts — a retry after failure legitimately creates a new PENDING row.
   *
   * ALWAYS creates a new attempt. Never returns an existing terminal attempt.
   */
  async recordPending(
    evidence: PhysicalExecutionEvidence,
    intendedTransactionId: string,
    sender: string,
    nonce: number,
  ): Promise<ReconciliationAttempt> {
    return db.$transaction(async (tx) => {
      // C3: check for an existing PENDING attempt for this evidence.
      const existingPending = await tx.reconciliationAttempt.findFirst({
        where: { evidenceId: evidence.evidenceId, status: 'PENDING' },
      })
      if (existingPending) {
        throw new Error(
          `ReconciliationStore.recordPending: a PENDING attempt already exists ` +
            `for evidenceId ${evidence.evidenceId} (attemptId ${existingPending.attemptId}). ` +
            `Concurrent retry race — resolve the existing attempt before creating a new one (C3).`,
        )
      }

      // Evidence is immutable (E1). Upsert so re-derivation is idempotent at
      // the evidence level (the attempt uniqueness is the stronger guard).
      await tx.physicalExecutionEvidence.upsert({
        where: { evidenceId: evidence.evidenceId },
        create: {
          evidenceId: evidence.evidenceId,
          executionAssignmentId: evidence.executionAssignmentId,
          runtimeKind: evidence.runtimeKind,
          networkVersionId: evidence.networkVersionId,
          resultDigest: evidence.resultDigest,
          resultJson: evidence.resultJson,
          occurredAt: evidence.occurredAt,
        },
        update: {},
      })

      // ALWAYS create a new attempt row.
      const attempt = await tx.reconciliationAttempt.create({
        data: {
          evidenceId: evidence.evidenceId,
          networkVersionId: evidence.networkVersionId,
          intendedTransactionId,
          sender,
          nonce,
          status: 'PENDING',
        },
      })

      return toReconciliationAttempt(attempt)
    })
  }

  /**
   * Atomic: writes the outcome + advances the attempt status, in one tx.
   * The attempt must currently be PENDING. The outcome is append-only (O2,
   * now enforced by @@unique([attemptId, finalityCertificate])).
   */
  async resolve(
    attemptId: string,
    outcome: ProtocolOutcome,
  ): Promise<ReconciliationAttempt> {
    const updated = await db.$transaction(async (tx) => {
      // Append-only outcome write (O2). The @@unique([attemptId, finalityCertificate])
      // constraint enforces one outcome per (attempt, certificate).
      await tx.protocolOutcome.upsert({
        where: { outcomeId: outcome.outcomeId },
        create: {
          outcomeId: outcome.outcomeId,
          attemptId: outcome.attemptId,
          transactionId: outcome.transactionId,
          finalityCertificate: outcome.finalityCertificate,
          status: outcome.status,
          receiptsDigest: outcome.receiptsDigest,
          error: outcome.error,
          recordedAt: outcome.recordedAt,
        },
        update: {},
      })

      // R1: map BatchExecutionStatus → ReconciliationState at write time.
      const reconciliationState = mapBatchStatusToReconciliationState(outcome.status)
      // C4: forward only. WHERE status = 'PENDING'.
      const result = await tx.reconciliationAttempt.updateMany({
        where: { attemptId, status: 'PENDING' },
        data: {
          status: reconciliationState,
          resolvedAt: outcome.recordedAt,
          outcomeId: outcome.outcomeId,
        },
      })

      if (result.count === 0) {
        const existing = await tx.reconciliationAttempt.findUnique({
          where: { attemptId },
        })
        if (!existing) {
          throw new Error(
            `ReconciliationStore.resolve: attempt ${attemptId} not found`,
          )
        }
        throw new Error(
          `ReconciliationStore.resolve: attempt ${attemptId} is already ` +
            `resolved (status=${existing.status}); a commitment never transitions ` +
            `backwards (C4).`,
        )
      }

      return tx.reconciliationAttempt.findUnique({ where: { attemptId } })
    })

    if (!updated) {
      throw new Error(
        `ReconciliationStore.resolve: attempt ${attemptId} disappeared during resolve`,
      )
    }

    return toReconciliationAttempt(updated)
  }

  async loadPending(): Promise<ReconciliationAttempt[]> {
    const rows = await db.reconciliationAttempt.findMany({
      where: { status: 'PENDING' },
    })
    return rows.map(toReconciliationAttempt)
  }

  /**
   * Load the most recent attempt for an evidenceId.
   */
  async findByEvidence(evidenceId: string): Promise<ReconciliationAttempt | null> {
    const row = await db.reconciliationAttempt.findFirst({
      where: { evidenceId },
      orderBy: { createdAt: 'desc' },
    })
    return row ? toReconciliationAttempt(row) : null
  }

  async loadEvidence(evidenceId: string): Promise<PhysicalExecutionEvidence | null> {
    const row = await db.physicalExecutionEvidence.findUnique({
      where: { evidenceId },
    })
    if (!row) return null
    return {
      evidenceId: row.evidenceId,
      executionAssignmentId: row.executionAssignmentId,
      runtimeKind: row.runtimeKind as 'hybrid',
      networkVersionId: row.networkVersionId,
      resultDigest: row.resultDigest,
      resultJson: row.resultJson,
      occurredAt: row.occurredAt,
    }
  }

  async findCommittedTransaction(
    networkVersionId: string,
    transactionId: string,
  ): Promise<Date | null> {
    const transition = await db.protocolTransition.findFirst({
      where: { networkVersionId, transactionHash: transactionId },
      select: { createdAt: true },
    })
    return transition?.createdAt ?? null
  }
}

function toReconciliationAttempt(row: {
  attemptId: string
  evidenceId: string
  networkVersionId: string
  intendedTransactionId: string
  sender: string
  nonce: number
  status: string
  createdAt: Date
  resolvedAt: Date | null
  outcomeId: string | null
}): ReconciliationAttempt {
  return {
    attemptId: row.attemptId,
    evidenceId: row.evidenceId,
    networkVersionId: row.networkVersionId,
    intendedTransactionId: row.intendedTransactionId,
    sender: row.sender,
    nonce: row.nonce,
    status: row.status as ReconciliationAttempt['status'],
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? undefined,
    outcomeId: row.outcomeId ?? undefined,
  }
}
