// =============================================================================
// Control Plane: Economic Pipeline Durable Reconciliation (Phase 12B — Slice 6)
// =============================================================================
// This module hardens the existing EconomicPipelineState reconciler without
// introducing another economic primitive.
//
// The original orchestrator records checkpoint IDs after each durable stage.
// A process crash can occur AFTER a stage transaction commits but BEFORE the
// checkpoint row is updated. Reconciliation therefore cannot trust checkpoint
// IDs or the stage field alone.
//
// This wrapper reconstructs the checkpoint from durable identities FIRST:
//   Event            ← (tenantId, eventIdempotencyKey)
//   Contribution     ← (tenantId, contributionIdempotencyKey)
//   Reward           ← (tenantId, rewardIdempotencyKey)
//   LedgerPosting    ← (tenantId, ledgerIdempotencyKey)
//   Settlement       ← rewardId (the settlement is 1:1 with Reward)
//
// Once the checkpoint is hydrated, the existing generic reconciler resumes the
// pipeline. No vertical services are imported and no new economic data model is
// introduced.
//
// SAFETY CONTRACT:
// - We never fabricate evidence when the durable Event does not exist. The
//   original evidence payload may be transient/vertical-specific and is not
//   reconstructed from memory during reconciliation.
// - We require the discovered durable chain to be contiguous. A ledger posting
//   without its reward, or a settlement without its reward, is treated as an
//   integrity failure rather than creating a second economic chain.
// - Duplicate/recovery races are re-driven once after durable re-hydration;
//   deterministic idempotency keys converge the outcome.
// =============================================================================

import { db } from '@/lib/db'
import {
  reconcileEconomicPipeline as reconcileEconomicPipelineBase,
  ECONOMIC_STAGE,
  type EconomicPipelineResult,
} from './economic-pipeline'

interface DurableEconomicState {
  executionAssignmentId: string
  tenantId: string
  eventId: string | null
  attestationId: string | null
  contributionId: string | null
  rewardId: string | null
  ledgerPostingId: string | null
  settlementId: string | null
  stage: string
}

function resultFromState(state: DurableEconomicState, replayed = false): EconomicPipelineResult {
  return {
    assignmentId: state.executionAssignmentId,
    stage: state.stage as EconomicPipelineResult['stage'],
    eventId: state.eventId ?? undefined,
    attestationId: state.attestationId ?? undefined,
    contributionId: state.contributionId ?? undefined,
    rewardId: state.rewardId ?? undefined,
    ledgerPostingId: state.ledgerPostingId ?? undefined,
    settlementId: state.settlementId ?? undefined,
    replayed,
  }
}

/**
 * Reconstruct checkpoint IDs from durable objects and persist the recovered
 * checkpoint before delegating to the existing generic reconciler.
 */
async function hydrateEconomicCheckpoint(executionAssignmentId: string): Promise<DurableEconomicState> {
  const state = await db.economicPipelineState.findUnique({
    where: { executionAssignmentId },
  })

  if (!state) {
    throw new Error(`EconomicPipelineState not found for assignment '${executionAssignmentId}'.`)
  }

  let event = state.eventId
    ? await db.event.findUnique({
        where: { id: state.eventId },
        include: { attestations: true },
      })
    : null

  // First-stage recovery is deterministic when the Event transaction already
  // committed but the checkpoint update did not.
  if (!event) {
    event = await db.event.findUnique({
      where: {
        tenantId_externalEventId: {
          tenantId: state.tenantId,
          externalEventId: state.eventIdempotencyKey,
        },
      },
      include: { attestations: true },
    })
  }

  // There is no safe generic way to recreate a missing evidence payload from
  // durable execution state. Never fabricate an Event with an empty payload or
  // an empty signing key. Leave the checkpoint recoverable/manual instead.
  if (!event) {
    await db.economicPipelineState.update({
      where: { executionAssignmentId },
      data: {
        stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
        reconciliationReason:
          'Evidence Event is not durable; automatic reconciliation cannot safely reconstruct vertical evidence input',
        lastReconciledAt: new Date(),
      },
    })

    return {
      executionAssignmentId,
      tenantId: state.tenantId,
      eventId: null,
      attestationId: null,
      contributionId: null,
      rewardId: null,
      ledgerPostingId: null,
      settlementId: null,
      stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
    }
  }

  const attestation =
    state.attestationId
      ? await db.attestation.findUnique({ where: { id: state.attestationId } })
      : event.attestations[0] ?? null

  // Verification rejection is a terminal negative result. Never proceed into
  // economic stages, even if a corrupted checkpoint contains downstream IDs.
  if (event.status === 'rejected') {
    const downstream = await Promise.all([
      db.contribution.findUnique({ where: { tenantId_idempotencyKey: { tenantId: state.tenantId, idempotencyKey: state.contributionIdempotencyKey } } }),
      db.reward.findUnique({ where: { tenantId_idempotencyKey: { tenantId: state.tenantId, idempotencyKey: state.rewardIdempotencyKey } } }),
      db.ledgerPosting.findUnique({ where: { tenantId_idempotencyKey: { tenantId: state.tenantId, idempotencyKey: state.ledgerIdempotencyKey } } }),
      state.rewardId ? db.settlement.findUnique({ where: { rewardId: state.rewardId } }) : null,
    ])

    if (downstream.some(Boolean)) {
      throw new Error(
        `Economic integrity violation for assignment '${executionAssignmentId}': verification rejected but downstream economic objects exist`,
      )
    }

    await db.economicPipelineState.update({
      where: { executionAssignmentId },
      data: {
        eventId: event.id,
        attestationId: null,
        contributionId: null,
        rewardId: null,
        ledgerPostingId: null,
        settlementId: null,
        stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
        reconciliationReason: `Event ${event.id} was rejected by verification`,
        lastReconciledAt: new Date(),
      },
    })

    return {
      executionAssignmentId,
      tenantId: state.tenantId,
      eventId: event.id,
      attestationId: null,
      contributionId: null,
      rewardId: null,
      ledgerPostingId: null,
      settlementId: null,
      stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
    }
  }

  if (event.status !== 'verified' || !attestation) {
    // The Event exists, but verification has not durably completed yet. Let the
    // base reconciler drive the verification worker rather than fabricating
    // downstream economic state.
    await db.economicPipelineState.update({
      where: { executionAssignmentId },
      data: {
        eventId: event.id,
        stage: ECONOMIC_STAGE.EVIDENCE_RECORDED,
        lastReconciledAt: new Date(),
      },
    })

    return {
      executionAssignmentId,
      tenantId: state.tenantId,
      eventId: event.id,
      attestationId: null,
      contributionId: null,
      rewardId: null,
      ledgerPostingId: null,
      settlementId: null,
      stage: ECONOMIC_STAGE.EVIDENCE_RECORDED,
    }
  }

  const contribution = await db.contribution.findUnique({
    where: {
      tenantId_idempotencyKey: {
        tenantId: state.tenantId,
        idempotencyKey: state.contributionIdempotencyKey,
      },
    },
  })

  const reward = await db.reward.findUnique({
    where: {
      tenantId_idempotencyKey: {
        tenantId: state.tenantId,
        idempotencyKey: state.rewardIdempotencyKey,
      },
    },
  })

  const ledgerPosting = await db.ledgerPosting.findUnique({
    where: {
      tenantId_idempotencyKey: {
        tenantId: state.tenantId,
        idempotencyKey: state.ledgerIdempotencyKey,
      },
    },
  })

  const effectiveRewardId = reward?.id ?? state.rewardId ?? null
  const settlement = effectiveRewardId
    ? await db.settlement.findUnique({ where: { rewardId: effectiveRewardId } })
    : null

  // A downstream object without its parent is not an ordinary retry case. The
  // system must stop instead of fabricating a replacement economic chain.
  if (ledgerPosting && !reward) {
    throw new Error(
      `Economic integrity violation for assignment '${executionAssignmentId}': durable ledger posting exists without durable reward`,
    )
  }
  if (settlement && !reward) {
    throw new Error(
      `Economic integrity violation for assignment '${executionAssignmentId}': durable settlement exists without durable reward`,
    )
  }
  if (reward && !contribution) {
    throw new Error(
      `Economic integrity violation for assignment '${executionAssignmentId}': durable reward exists without durable contribution`,
    )
  }

  let stage = ECONOMIC_STAGE.VERIFIED
  if (contribution) stage = ECONOMIC_STAGE.CONTRIBUTION_CREATED
  if (reward) stage = ECONOMIC_STAGE.REWARD_CALCULATED
  if (ledgerPosting) stage = ECONOMIC_STAGE.LEDGER_POSTED
  if (settlement) stage = ECONOMIC_STAGE.SETTLEMENT_CREATED
  if (settlement && state.stage === ECONOMIC_STAGE.COMPLETED) stage = ECONOMIC_STAGE.COMPLETED

  const hydrated = await db.economicPipelineState.update({
    where: { executionAssignmentId },
    data: {
      eventId: event.id,
      attestationId: attestation.id,
      contributionId: contribution?.id ?? null,
      rewardId: reward?.id ?? null,
      ledgerPostingId: ledgerPosting?.id ?? null,
      settlementId: settlement?.id ?? null,
      stage,
      reconciliationReason: null,
      lastReconciledAt: new Date(),
    },
  })

  return {
    executionAssignmentId,
    tenantId: state.tenantId,
    eventId: hydrated.eventId,
    attestationId: hydrated.attestationId,
    contributionId: hydrated.contributionId,
    rewardId: hydrated.rewardId,
    ledgerPostingId: hydrated.ledgerPostingId,
    settlementId: hydrated.settlementId,
    stage: hydrated.stage,
  }
}

/**
 * Public reconciliation entry point.
 *
 * Hydrate from durable state first, then run the frozen generic orchestrator.
 * A single retry after hydration handles benign duplicate-invocation races
 * where another worker wins a deterministic idempotency insert first.
 */
export async function reconcileEconomicPipeline(
  executionAssignmentId: string,
): Promise<EconomicPipelineResult> {
  const hydrated = await hydrateEconomicCheckpoint(executionAssignmentId)

  if (hydrated.stage === ECONOMIC_STAGE.RECONCILIATION_REQUIRED && !hydrated.eventId) {
    return resultFromState(hydrated)
  }

  if (hydrated.stage === ECONOMIC_STAGE.RECONCILIATION_REQUIRED) {
    const state = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId },
    })
    if (state?.stage === ECONOMIC_STAGE.RECONCILIATION_REQUIRED && state.reconciliationReason?.includes('rejected by verification')) {
      return resultFromState({
        executionAssignmentId,
        tenantId: hydrated.tenantId,
        eventId: hydrated.eventId,
        attestationId: hydrated.attestationId,
        contributionId: hydrated.contributionId,
        rewardId: hydrated.rewardId,
        ledgerPostingId: hydrated.ledgerPostingId,
        settlementId: hydrated.settlementId,
        stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
      })
    }
  }

  try {
    return await reconcileEconomicPipelineBase(executionAssignmentId)
  } catch (firstError) {
    // Another invocation may have committed a deterministic downstream object
    // just before this worker observed its missing checkpoint ID. Re-hydrate and
    // drive the base reconciler once more rather than surfacing a transient
    // duplicate-key race as a permanent economic failure.
    await hydrateEconomicCheckpoint(executionAssignmentId)
    try {
      return await reconcileEconomicPipelineBase(executionAssignmentId)
    } catch {
      throw firstError
    }
  }
}
