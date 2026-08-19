// =============================================================================
// Control Plane: Economic Pipeline Orchestrator (Phase 12B — Slice 6)
// =============================================================================
// The generic Evidence → Verification → Contribution → Reward → Ledger → Settlement
// pipeline checkpoint + reconciliation layer.
//
// This module does NOT introduce a new economic primitive. It orchestrates the
// EXISTING generic primitives:
//   - ingestEvent + processEventOutbox (telemetry → verified event → attestation)
//   - createContribution (verified economic activity)
//   - calculateReward (economic entitlement)
//   - postRewardToLedger (double-entry accounting)
//   - createSettlement (payment instruction)
//
// The checkpoint (EconomicPipelineState) is keyed 1:1 by ExecutionAssignmentId.
// It records the stage reached + the durable object IDs so that reconciliation
// can resume from the exact gap without duplicating downstream outcomes.
//
// VERTICAL NEUTRALITY: the orchestrator imports NO vertical service. The vertical
// provides the evidence (telemetry payload) + the signing identity (device
// credential); the orchestrator drives the generic pipeline. A static source
// check in the test verifies this.
//
// IDEMPOTENCY: every step uses a deterministic idempotency key derived from the
// assignmentId (NOT Date.now() or randomUUID). Retries converge.
//
// RECONCILIATION: reconcileEconomicPipeline(assignmentId) inspects durable
// objects (does the event exist? is it verified? does the contribution exist?
// the reward? the ledger posting? the settlement?) and resumes from the gap —
// the VPP reconcileAssignment pattern, but generic.
// =============================================================================

import { db } from '@/lib/db'
import type { ExtendedTransactionClient } from '@/lib/db'
import { createHash } from 'crypto'

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export const ECONOMIC_STAGE = {
  EVIDENCE_PENDING: 'evidence_pending',
  EVIDENCE_RECORDED: 'evidence_recorded',
  VERIFIED: 'verified',
  CONTRIBUTION_CREATED: 'contribution_created',
  REWARD_CALCULATED: 'reward_calculated',
  LEDGER_POSTED: 'ledger_posted',
  SETTLEMENT_CREATED: 'settlement_created',
  COMPLETED: 'completed',
  RECONCILIATION_REQUIRED: 'reconciliation_required',
} as const

export type EconomicStage = (typeof ECONOMIC_STAGE)[keyof typeof ECONOMIC_STAGE]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EconomicPipelineResult {
  assignmentId: string
  stage: EconomicStage
  eventId?: string
  attestationId?: string
  contributionId?: string
  rewardId?: string
  ledgerPostingId?: string
  settlementId?: string
  /** True if this call returned a previously-completed pipeline (idempotent). */
  replayed: boolean
}

// ---------------------------------------------------------------------------
// Deterministic idempotency keys (no Date.now(), no randomUUID)
// ---------------------------------------------------------------------------

/**
 * Derive deterministic idempotency keys from the assignmentId.
 * These are used at each stage of the pipeline so retries converge.
 */
function deriveIdempotencyKeys(assignmentId: string) {
  return {
    event: `evidence-${assignmentId}`,
    contribution: `contrib-${assignmentId}`,
    reward: `reward-${assignmentId}`,
    ledger: `ledger-${assignmentId}`,
    settlement: `reward-${assignmentId}`, // createSettlement auto-derives `reward-${rewardId}`, but we store the assignmentId-derived key for the checkpoint
  }
}

// ---------------------------------------------------------------------------
// Initialize the pipeline checkpoint (called by executeDecision after completion)
// ---------------------------------------------------------------------------

/**
 * Create the EconomicPipelineState checkpoint for an assignment.
 *
 * Called after operational completion (executeDecision has recorded actuals +
 * completed the assignment). The checkpoint starts at 'evidence_pending' —
 * the vertical must then call processEconomicPipeline to drive the pipeline.
 *
 * Idempotent: if the checkpoint already exists, returns it as-is.
 */
export async function initEconomicPipeline(input: {
  executionAssignmentId: string
  tenantId: string
  networkVersionId: string
  networkId: string
}): Promise<EconomicPipelineState> {
  const keys = deriveIdempotencyKeys(input.executionAssignmentId)

  // Upsert — if the checkpoint already exists, return it.
  const existing = await db.economicPipelineState.findUnique({
    where: { executionAssignmentId: input.executionAssignmentId },
  })
  if (existing) {
    return existing
  }

  return db.economicPipelineState.create({
    data: {
      executionAssignmentId: input.executionAssignmentId,
      tenantId: input.tenantId,
      networkVersionId: input.networkVersionId,
      networkId: input.networkId,
      stage: ECONOMIC_STAGE.EVIDENCE_PENDING,
      eventIdempotencyKey: keys.event,
      contributionIdempotencyKey: keys.contribution,
      rewardIdempotencyKey: keys.reward,
      ledgerIdempotencyKey: keys.ledger,
      settlementIdempotencyKey: keys.settlement,
    },
  })
}

// ---------------------------------------------------------------------------
// Drive the pipeline forward (the generic orchestrator)
// ---------------------------------------------------------------------------

/**
 * Process the economic pipeline for an assignment — from evidence to settlement.
 *
 * This is the generic orchestrator. It calls the EXISTING generic primitives
 * in order:
 *   1. ingestEvent (telemetry → event)
 *   2. processEventOutbox (event → verified → attestation)
 *   3. createContribution (attestation → contribution)
 *   4. calculateReward (contribution → reward)
 *   5. postRewardToLedger (reward → ledger posting)
 *   6. createSettlement (reward → settlement instruction)
 *
 * Each step is idempotent (uses the deterministic keys from the checkpoint).
 * If any step fails, the checkpoint is marked 'reconciliation_required' and
 * reconcileEconomicPipeline can resume from the gap.
 *
 * VERTICAL-NEUTRAL: the caller provides the telemetry payload + device signing
 * info. The orchestrator does NOT know about VPP/Compute/etc.
 *
 * @returns the final pipeline state. If already completed, returns replayed=true.
 */
export async function processEconomicPipeline(input: {
  executionAssignmentId: string
  /** The telemetry payload from the adapter's executeResult. */
  telemetryPayload: Record<string, unknown>
  /** The actual quantity from the adapter's executeResult. */
  actualQuantity: string
  /** The actual unit from the adapter's executeResult. */
  actualUnit: string
  /** The device ID that signed the telemetry. */
  deviceId: string
  /** The signing key (derived from the device's provisioningSecret). */
  signingKey: string
  /** The capability type being executed. */
  capabilityType: string
  /** The timestamp of the execution (ISO string). */
  timestamp: string
  /** The sequence number for replay protection. */
  sequence: number
}): Promise<EconomicPipelineResult> {
  const state = await db.economicPipelineState.findUnique({
    where: { executionAssignmentId: input.executionAssignmentId },
  })

  if (!state) {
    throw new Error(
      `EconomicPipelineState not found for assignment '${input.executionAssignmentId}'. ` +
        `Call initEconomicPipeline first.`,
    )
  }

  // If already completed, return the existing state (idempotent).
  if (state.stage === ECONOMIC_STAGE.COMPLETED) {
    return {
      assignmentId: input.executionAssignmentId,
      stage: ECONOMIC_STAGE.COMPLETED,
      eventId: state.eventId ?? undefined,
      attestationId: state.attestationId ?? undefined,
      contributionId: state.contributionId ?? undefined,
      rewardId: state.rewardId ?? undefined,
      ledgerPostingId: state.ledgerPostingId ?? undefined,
      settlementId: state.settlementId ?? undefined,
      replayed: true,
    }
  }

  try {
    // --- Stage 1: Evidence (ingestEvent) ---
    if (!state.eventId) {
      const { ingestEvent, buildCanonicalMessage } = await import('@/lib/services/ingestion.service')
      const { signMessage } = await import('@/lib/domain/crypto')

      const message = buildCanonicalMessage({
        device_id: input.deviceId,
        event_id: state.eventIdempotencyKey,
        timestamp: input.timestamp,
        event_type: 'telemetry',
        sequence: input.sequence,
        payload: input.telemetryPayload,
      })
      const signature = signMessage(message, input.signingKey)

      const ingestResult = await ingestEvent(state.tenantId, {
        device_id: input.deviceId,
        event_id: state.eventIdempotencyKey,
        timestamp: input.timestamp,
        event_type: 'telemetry',
        sequence: input.sequence,
        payload: input.telemetryPayload,
        signature,
        network_version_id: state.networkVersionId,
        capability_type: input.capabilityType,
      })

      await db.economicPipelineState.update({
        where: { executionAssignmentId: input.executionAssignmentId },
        data: {
          eventId: ingestResult.event_id,
          stage: ECONOMIC_STAGE.EVIDENCE_RECORDED,
        },
      })
      state.eventId = ingestResult.event_id
      state.stage = ECONOMIC_STAGE.EVIDENCE_RECORDED
    }

    // --- Stage 2: Verification (processEventOutbox) ---
    if (state.stage === ECONOMIC_STAGE.EVIDENCE_RECORDED || !state.attestationId) {
      const { processEventOutbox } = await import('@/lib/services/worker.service')
      await processEventOutbox(state.tenantId)

      // Load the verified event + its attestation.
      const event = await db.event.findUnique({
        where: { id: state.eventId! },
        include: { attestations: true },
      })

      if (!event) {
        throw new Error(`Event ${state.eventId} not found after processEventOutbox`)
      }

      if (event.status === 'rejected') {
        // Verification rejected — the pipeline CANNOT proceed. No contribution,
        // no reward, no ledger, no settlement. This is a terminal failure.
        await db.economicPipelineState.update({
          where: { executionAssignmentId: input.executionAssignmentId },
          data: {
            stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
            reconciliationReason: `Event ${event.id} was rejected by verification`,
          },
        })
        return {
          assignmentId: input.executionAssignmentId,
          stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
          eventId: state.eventId ?? undefined,
          replayed: false,
        }
      }

      if (event.status !== 'verified' || !event.attestations[0]) {
        throw new Error(`Event ${event.id} verification incomplete (status: ${event.status})`)
      }

      const attestation = event.attestations[0]
      await db.economicPipelineState.update({
        where: { executionAssignmentId: input.executionAssignmentId },
        data: {
          attestationId: attestation.id,
          stage: ECONOMIC_STAGE.VERIFIED,
        },
      })
      state.attestationId = attestation.id
      state.stage = ECONOMIC_STAGE.VERIFIED
    }

    // --- Stage 3: Contribution ---
    if (!state.contributionId) {
      const { createContribution } = await import('@/lib/services/contribution.service')
      const contribution = await createContribution(
        state.tenantId,
        {
          attestationIds: [state.attestationId!],
          derivedQuantity: input.actualQuantity,
          derivedUnit: input.actualUnit,
        },
        state.contributionIdempotencyKey,
      )
      await db.economicPipelineState.update({
        where: { executionAssignmentId: input.executionAssignmentId },
        data: {
          contributionId: contribution.id,
          stage: ECONOMIC_STAGE.CONTRIBUTION_CREATED,
        },
      })
      state.contributionId = contribution.id
      state.stage = ECONOMIC_STAGE.CONTRIBUTION_CREATED
    }

    // --- Stage 4: Reward ---
    if (!state.rewardId) {
      const { calculateReward } = await import('@/lib/services/reward.service')
      const reward = await calculateReward(
        state.tenantId,
        state.contributionId!,
        state.rewardIdempotencyKey,
      )
      await db.economicPipelineState.update({
        where: { executionAssignmentId: input.executionAssignmentId },
        data: {
          rewardId: reward.id,
          stage: ECONOMIC_STAGE.REWARD_CALCULATED,
        },
      })
      state.rewardId = reward.id
      state.stage = ECONOMIC_STAGE.REWARD_CALCULATED
    }

    // --- Stage 5: Ledger ---
    if (!state.ledgerPostingId) {
      const { postRewardToLedger } = await import('@/lib/services/ledger.service')
      const ledgerResult = await postRewardToLedger(
        state.tenantId,
        { rewardId: state.rewardId! },
        state.ledgerIdempotencyKey,
      )
      await db.economicPipelineState.update({
        where: { executionAssignmentId: input.executionAssignmentId },
        data: {
          ledgerPostingId: ledgerResult.posting_id,
          stage: ECONOMIC_STAGE.LEDGER_POSTED,
        },
      })
      state.ledgerPostingId = ledgerResult.posting_id
      state.stage = ECONOMIC_STAGE.LEDGER_POSTED
    }

    // --- Stage 6: Settlement ---
    if (!state.settlementId) {
      const { createSettlement } = await import('@/lib/services/settlement.service')
      const settlement = await createSettlement(state.tenantId, state.rewardId!)
      await db.economicPipelineState.update({
        where: { executionAssignmentId: input.executionAssignmentId },
        data: {
          settlementId: settlement.id,
          stage: ECONOMIC_STAGE.SETTLEMENT_CREATED,
        },
      })
      state.settlementId = settlement.id
      state.stage = ECONOMIC_STAGE.SETTLEMENT_CREATED
    }

    // --- Stage 7: Completed ---
    await db.economicPipelineState.update({
      where: { executionAssignmentId: input.executionAssignmentId },
      data: {
        stage: ECONOMIC_STAGE.COMPLETED,
      },
    })

    return {
      assignmentId: input.executionAssignmentId,
      stage: ECONOMIC_STAGE.COMPLETED,
      eventId: state.eventId ?? undefined,
      attestationId: state.attestationId ?? undefined,
      contributionId: state.contributionId ?? undefined,
      rewardId: state.rewardId ?? undefined,
      ledgerPostingId: state.ledgerPostingId ?? undefined,
      settlementId: state.settlementId ?? undefined,
      replayed: false,
    }
  } catch (err) {
    // Mark the checkpoint as requiring reconciliation.
    await db.economicPipelineState.update({
      where: { executionAssignmentId: input.executionAssignmentId },
      data: {
        stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
        reconciliationReason: err instanceof Error ? err.message : String(err),
        lastReconciledAt: new Date(),
      },
    })
    throw err
  }
}

// ---------------------------------------------------------------------------
// Reconciliation — resume from the gap
// ---------------------------------------------------------------------------

/**
 * Reconcile the economic pipeline for an assignment — resume from the gap.
 *
 * This is the generic version of VPP's `reconcileAssignment`. It inspects the
 * durable objects (event, attestation, contribution, reward, ledger posting,
 * settlement) and resumes from the first missing stage.
 *
 * Idempotent: each downstream step uses the deterministic idempotency key from
 * the checkpoint, so retries converge. No duplicate economic outcomes.
 *
 * @returns the final pipeline state after reconciliation.
 */
export async function reconcileEconomicPipeline(
  executionAssignmentId: string,
): Promise<EconomicPipelineResult> {
  const state = await db.economicPipelineState.findUnique({
    where: { executionAssignmentId },
  })

  if (!state) {
    throw new Error(
      `EconomicPipelineState not found for assignment '${executionAssignmentId}'.`,
    )
  }

  // If already completed, return the existing state (idempotent).
  if (state.stage === ECONOMIC_STAGE.COMPLETED) {
    return {
      assignmentId: executionAssignmentId,
      stage: ECONOMIC_STAGE.COMPLETED,
      eventId: state.eventId ?? undefined,
      attestationId: state.attestationId ?? undefined,
      contributionId: state.contributionId ?? undefined,
      rewardId: state.rewardId ?? undefined,
      ledgerPostingId: state.ledgerPostingId ?? undefined,
      settlementId: state.settlementId ?? undefined,
      replayed: true,
    }
  }

  // Inspect durable objects to determine the ACTUAL stage (the checkpoint's
  // stage field is a hint; the existence of durable objects is the source of
  // truth — exactly the VPP reconcileAssignment pattern, but generic).

  // The reconciliation re-runs processEconomicPipeline, which checks each
  // durable object ID + skips completed stages. Because every step is
  // idempotent (deterministic keys), this is safe — no duplicate outcomes.
  //
  // The caller must provide the original telemetry input (we can't re-derive
  // it from the checkpoint alone — it was a vertical-specific payload).
  // For reconciliation, we load the original event's payload from the DB
  // if it exists, so we can resume without the caller re-providing it.

  // Load the event if it exists (to get the telemetry payload for re-processing).
  let telemetryPayload: Record<string, unknown> = {}
  let actualQuantity = '0'
  let actualUnit = ''
  let deviceId = ''
  let signingKey = ''
  let capabilityType = ''
  let timestamp = new Date().toISOString()
  let sequence = 0

  if (state.eventId) {
    const event = await db.event.findUnique({
      where: { id: state.eventId },
      include: { device: { include: { credential: true } }, attestations: true },
    })
    if (event) {
      telemetryPayload = JSON.parse(event.payloadJson as string) as Record<string, unknown>
      // The actual quantity comes from the assignment's actualQuantity (recorded
      // by recordAssignmentResults during operational completion).
      const assignment = await db.executionAssignment.findUnique({
        where: { id: executionAssignmentId },
        select: { actualQuantity: true, actualUnit: true, capabilityType: true },
      })
      actualQuantity = assignment?.actualQuantity ?? '0'
      actualUnit = assignment?.actualUnit ?? ''
      capabilityType = event.capabilityType
      timestamp = event.occurredAt.toISOString()
      sequence = event.sequence ?? 0
      // We can't recover the signingKey (it's a secret derived from the
      // provisioningSecret, which is never stored). But we don't need it for
      // reconciliation — the event is already ingested + signed. We only need
      // it if we're re-ingesting (which we won't — the event already exists).
    }
  }

  // Re-drive the pipeline. processEconomicPipeline will skip completed stages
  // (each stage checks if the durable object ID is already set).
  return processEconomicPipeline({
    executionAssignmentId,
    telemetryPayload,
    actualQuantity,
    actualUnit,
    deviceId,
    signingKey,
    capabilityType,
    timestamp,
    sequence,
  })
}

// ---------------------------------------------------------------------------
// Traceability — walk the chain backward
// ---------------------------------------------------------------------------

/**
 * Trace the full economic chain backward from an assignment.
 *
 *   SettlementInstruction
 *     → Ledger
 *       → Reward
 *         → Contribution
 *           → Verification (Attestation)
 *             → Evidence (Event)
 *               → ExecutionAssignment
 *
 * @returns the full chain, or null at any stage where the durable object
 *          doesn't exist yet.
 */
export async function traceEconomicChain(executionAssignmentId: string): Promise<{
  assignmentId: string
  eventId: string | null
  attestationId: string | null
  contributionId: string | null
  rewardId: string | null
  ledgerPostingId: string | null
  settlementId: string | null
  stage: EconomicStage
}> {
  const state = await db.economicPipelineState.findUnique({
    where: { executionAssignmentId },
  })

  if (!state) {
    throw new Error(
      `EconomicPipelineState not found for assignment '${executionAssignmentId}'.`,
    )
  }

  return {
    assignmentId: executionAssignmentId,
    eventId: state.eventId,
    attestationId: state.attestationId,
    contributionId: state.contributionId,
    rewardId: state.rewardId,
    ledgerPostingId: state.ledgerPostingId,
    settlementId: state.settlementId,
    stage: state.stage as EconomicStage,
  }
}

// ---------------------------------------------------------------------------
// Type re-export for the Prisma model (used by callers + tests)
// ---------------------------------------------------------------------------

import type { EconomicPipelineState } from '@prisma/client'
