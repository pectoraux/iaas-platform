// =============================================================================
// Kernel: PostgreSQL Reconciliation Store (Phase 11B)
// =============================================================================
// Durable persistence for the hybrid reconciliation primitives (spec §5).
//
// DURABILITY BAR (spec §2 rule 7, §5): "durable" means written through the
// same kind of atomic, OCC-guarded, journaled PostgreSQL path that
// PostgresProtocolStateStore uses. This implementation mirrors that pattern:
//
//   - recordPending: atomic db.$transaction writes evidence + commitment.
//     The @@unique([evidenceId]) constraint enforces C3 (at most one
//     commitment per evidence) — a re-derivation after a crash returns the
//     existing row, not a duplicate.
//   - resolve: atomic db.$transaction writes the outcome + advances the
//     commitment status. The outcome is append-only (O2).
//
// No partial writes are observable. An in-memory object is not durable;
// only a committed PostgreSQL transaction is.
// =============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import type {
  ReconciliationStore,
  PhysicalExecutionEvidence,
  PendingCommitment,
  ProtocolOutcome,
} from './reconciliation-types'
import { mapBatchStatusToReconciliationState } from './reconciliation-types'

/**
 * PostgreSQL-backed ReconciliationStore.
 *
 * Sibling to PostgresProtocolStateStore. Uses the same atomic-transaction +
 * unique-constraint discipline. No in-memory caching of mutable state — every
 * read goes to the database (correctness over speed; reconciliation is not a
 * hot path).
 */
export class PostgresReconciliationStore implements ReconciliationStore {
  /**
   * Atomic: writes evidence + a PENDING commitment referencing it, in one tx.
   *
   * IDEMPOTENCE (spec §4.2 C3): the @@unique([evidenceId]) constraint means
   * a second call with the same evidenceId fails with P2002. We catch that and
   * return the existing commitment — re-deriving the same evidence after a
   * crash is safe and does not double-count.
   */
  async recordPending(
    evidence: PhysicalExecutionEvidence,
    intendedTransactionId: string,
    sender: string,
    nonce: number,
  ): Promise<PendingCommitment> {
    try {
      const created = await db.$transaction(async (tx) => {
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

        const commitment = await tx.pendingCommitment.create({
          data: {
            evidenceId: evidence.evidenceId,
            networkVersionId: evidence.networkVersionId,
            intendedTransactionId,
            sender,
            nonce,
            status: 'PENDING',
          },
        })

        return commitment
      })

      return toPendingCommitment(created)
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await db.pendingCommitment.findUnique({
          where: { evidenceId: evidence.evidenceId },
        })
        if (existing) {
          return toPendingCommitment(existing)
        }
      }
      throw err
    }
  }

  /**
   * Atomic: writes the outcome + advances the commitment status, in one tx.
   *
   * The commitment must currently be PENDING. The outcome is append-only
   * (O2). Returns the updated commitment (now in a terminal state).
   *
   * C4 (spec §4.2): a commitment never transitions backwards. This is
   * enforced by the WHERE clause on the update (status = 'PENDING'). If the
   * commitment is already resolved, the update affects 0 rows and we throw.
   */
  async resolve(
    commitmentId: string,
    outcome: ProtocolOutcome,
  ): Promise<PendingCommitment> {
    const updated = await db.$transaction(async (tx) => {
      // Append-only outcome write (O2).
      await tx.protocolOutcome.upsert({
        where: { outcomeId: outcome.outcomeId },
        create: {
          outcomeId: outcome.outcomeId,
          commitmentId: outcome.commitmentId,
          transactionId: outcome.transactionId,
          finalityCertificate: outcome.finalityCertificate,
          status: outcome.status,
          receiptsDigest: outcome.receiptsDigest,
          error: outcome.error,
          recordedAt: outcome.recordedAt,
        },
        update: {}, // outcomes are immutable (append-only, O2)
      })

      // Advance the commitment PENDING → terminal (C4: forward only).
      // The WHERE status = 'PENDING' enforces C4: a resolved commitment
      // cannot be re-resolved.
      // R1: the BatchExecutionStatus → ReconciliationState mapping is pure and
      // computed here (at write time), not re-derived on read.
      const reconciliationState = mapBatchStatusToReconciliationState(outcome.status)
      const result = await tx.pendingCommitment.updateMany({
        where: { commitmentId, status: 'PENDING' },
        data: {
          status: reconciliationState,
          resolvedAt: outcome.recordedAt,
          outcomeId: outcome.outcomeId,
        },
      })

      if (result.count === 0) {
        // Either the commitment doesn't exist, or it's already resolved (C4).
        const existing = await tx.pendingCommitment.findUnique({
          where: { commitmentId },
        })
        if (!existing) {
          throw new Error(
            `ReconciliationStore.resolve: commitment ${commitmentId} not found`,
          )
        }
        throw new Error(
          `ReconciliationStore.resolve: commitment ${commitmentId} is already ` +
            `resolved (status=${existing.status}); a commitment never transitions ` +
            `backwards (C4).`,
        )
      }

      return tx.pendingCommitment.findUnique({ where: { commitmentId } })
    })

    if (!updated) {
      throw new Error(
        `ReconciliationStore.resolve: commitment ${commitmentId} disappeared during resolve`,
      )
    }

    return toPendingCommitment(updated)
  }

  /**
   * Restart recovery (spec §6.3): load all commitments still in PENDING.
   * Used by the recovery path on process restart.
   */
  async loadPending(): Promise<PendingCommitment[]> {
    const rows = await db.pendingCommitment.findMany({
      where: { status: 'PENDING' },
    })
    return rows.map(toPendingCommitment)
  }

  /**
   * Operational read: load a commitment by evidenceId.
   */
  async findByEvidence(evidenceId: string): Promise<PendingCommitment | null> {
    const row = await db.pendingCommitment.findUnique({
      where: { evidenceId },
    })
    return row ? toPendingCommitment(row) : null
  }

  /**
   * Load an evidence record by ID (for re-derivation at recovery — spec §6.3).
   * Returns the evidence with its full resultJson, or null if not found.
   */
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

  /**
   * Journal lookup (spec §6.3): check if a protocol transaction has already
   * been committed. Queries the ProtocolTransition table by transactionHash.
   * Returns the commit timestamp if found, null otherwise.
   */
  async findCommittedTransaction(
    networkVersionId: string,
    transactionId: string,
  ): Promise<Date | null> {
    const transition = await db.protocolTransition.findFirst({
      where: {
        networkVersionId,
        transactionHash: transactionId,
      },
      select: { createdAt: true },
    })
    return transition?.createdAt ?? null
  }
}

// ---------------------------------------------------------------------------
// Row → domain object mappers
// ---------------------------------------------------------------------------

function toPendingCommitment(row: {
  commitmentId: string
  evidenceId: string
  networkVersionId: string
  intendedTransactionId: string
  sender: string
  nonce: number
  status: string
  createdAt: Date
  resolvedAt: Date | null
  outcomeId: string | null
}): PendingCommitment {
  return {
    commitmentId: row.commitmentId,
    evidenceId: row.evidenceId,
    networkVersionId: row.networkVersionId,
    intendedTransactionId: row.intendedTransactionId,
    sender: row.sender,
    nonce: row.nonce,
    status: row.status as PendingCommitment['status'],
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? undefined,
    outcomeId: row.outcomeId ?? undefined,
  }
}
