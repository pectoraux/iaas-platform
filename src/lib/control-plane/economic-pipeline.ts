// =============================================================================
// Control Plane: Economic Pipeline Orchestrator (Phase 12B — Slice 6)
// =============================================================================
// The generic economic pipeline checkpoint + reconciliation layer.
//
// EVIDENCE ADAPTER (terminology — narrowed):
//   The current evidence chain for infrastructure networks is:
//     Event (device-signed telemetry) → VerificationResult → Attestation.
//   This is the "current infrastructure evidence adapter" — NOT the universal
//   evidence abstraction itself. A future slice may introduce a generic
//   Evidence model that supports non-telemetry evidence (meter readings,
//   protocol receipts, work completion reports, etc.) via a pluggable
//   EvidenceAdapter interface. For now, Event/Attestation IS the evidence
//   chain, and this orchestrator drives it without introducing a new
//   Evidence table.
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
import {
  createVerifiedEvidenceContext,
  isVerifiedEvidenceContext,
  type VerifiedEvidenceContext,
} from '@/lib/domain/verified-evidence-context'

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
// VerifiedEvidenceContext handoff — IAAS-DOM-ARCH-2 (ACR-001 / WORK-003)
// ---------------------------------------------------------------------------
// The generic, vertical-neutral boundary for already-verified economic
// evidence. A vertical (e.g. VPP) performs its own evidence + verification +
// baseline calculation, constructs a VerifiedEvidenceContext, and hands it
// here. This function validates the durable references against PostgreSQL and
// pre-populates the checkpoint so processEconomicPipeline skips the evidence
// + verification stages and proceeds directly to Contribution → Reward →
// Ledger → Settlement.
//
// This replaces the prior vertical-specific convention of directly mutating
// EconomicPipelineState.eventId/attestationId from the vertical. The generic
// pipeline now owns the pre-population boundary; verticals only construct the
// context (W003-AC03 / W003-AC05).
//
// Durable PostgreSQL Event/Attestation remain the source of truth (ACR-001 §8;
// W003-AC08). Stale/invalid references follow the existing reconciliation
// recovery rules: a referenced Event/Attestation that cannot be validated is
// rejected (throw), forcing the caller to re-establish the durable evidence —
// consistent with reconcileEconomicPipeline's stale/NULL recovery (W003-AC05).
// ---------------------------------------------------------------------------

/**
 * Result of applying a VerifiedEvidenceContext to a pipeline checkpoint.
 * Records the validated durable identities and the stage the checkpoint was
 * advanced to.
 */
export interface AppliedVerifiedEvidence {
  executionAssignmentId: string
  validatedEventId: string
  validatedAttestationId: string
  stage: EconomicStage
}

/**
 * Apply a VerifiedEvidenceContext to an assignment's economic-pipeline
 * checkpoint.
 *
 * Steps:
 *   1. require the checkpoint to exist (initEconomicPipeline must have run).
 *   2. validate the context's durable references against PostgreSQL:
 *        - Event exists, belongs to the same tenant, and its externalEventId
 *          (deterministic identity) matches the context.evidenceIdentity.
 *        - Attestation exists, belongs to the same tenant + Event, and its
 *          verificationPolicyVersion matches the context.verificationPolicyVersion.
 *        - The Event's NetworkVersion.networkId matches the context.networkId.
 *   3. pre-populate the checkpoint with the validated durable IDs and advance
 *      the stage to VERIFIED, so processEconomicPipeline skips evidence +
 *      verification and proceeds to Contribution → Reward → Ledger → Settlement.
 *
 * If any durable reference is stale/invalid, this throws (rejection), forcing
 * the caller to re-establish durable evidence. This preserves the existing
 * reconciliation recovery behavior (stale/NULL references are not silently
 * accepted).
 *
 * VERTICAL NEUTRALITY: this function imports NO vertical service. It accepts
 * only the generic VerifiedEvidenceContext (W003-AC03).
 */
export async function applyVerifiedEvidence(input: {
  executionAssignmentId: string
  context: VerifiedEvidenceContext
}): Promise<AppliedVerifiedEvidence> {
  const { executionAssignmentId, context } = input

  if (!isVerifiedEvidenceContext(context)) {
    throw new Error(
      `applyVerifiedEvidence: invalid VerifiedEvidenceContext for assignment '${executionAssignmentId}'.`,
    )
  }

  // 1. The checkpoint must exist.
  const state = await db.economicPipelineState.findUnique({
    where: { executionAssignmentId },
  })
  if (!state) {
    throw new Error(
      `applyVerifiedEvidence: EconomicPipelineState not found for assignment '${executionAssignmentId}'. Call initEconomicPipeline first.`,
    )
  }

  // Tenant scope integrity: the context's tenantId must match the checkpoint's.
  if (context.tenantId !== state.tenantId) {
    throw new Error(
      `applyVerifiedEvidence: tenant scope mismatch (context=${context.tenantId}, checkpoint=${state.tenantId}) for assignment '${executionAssignmentId}'.`,
    )
  }

  // 2. Validate the durable Event reference.
  const event = await db.event.findUnique({
    where: { id: context.eventId },
    include: {
      networkVersion: { select: { networkId: true } },
      attestations: { select: { id: true, verificationPolicyVersion: true, status: true } },
    },
  })
  if (!event || event.tenantId !== context.tenantId) {
    throw new Error(
      `applyVerifiedEvidence: referenced Event '${context.eventId}' not found in tenant '${context.tenantId}' (stale/invalid reference) for assignment '${executionAssignmentId}'.`,
    )
  }
  // Deterministic identity validation (Event.externalEventId is the
  // idempotency key; reconcileEconomicPipeline uses eventIdempotencyKey).
  const expectedIdentity = state.eventIdempotencyKey
  if (event.externalEventId && event.externalEventId !== context.evidenceIdentity) {
    throw new Error(
      `applyVerifiedEvidence: evidenceIdentity mismatch (context=${context.evidenceIdentity}, event.externalEventId=${event.externalEventId}) for assignment '${executionAssignmentId}'.`,
    )
  }
  if (expectedIdentity && event.externalEventId && event.externalEventId !== expectedIdentity) {
    throw new Error(
      `applyVerifiedEvidence: Event.externalEventId '${event.externalEventId}' does not match the checkpoint's deterministic eventIdempotencyKey '${expectedIdentity}' for assignment '${executionAssignmentId}'.`,
    )
  }
  // Network scope integrity.
  if (event.networkVersion.networkId !== context.networkId) {
    throw new Error(
      `applyVerifiedEvidence: network scope mismatch (context=${context.networkId}, event=${event.networkVersion.networkId}) for assignment '${executionAssignmentId}'.`,
    )
  }

  // 3. Validate the durable Attestation reference.
  const attestation = event.attestations.find((a) => a.id === context.attestationId)
  if (!attestation) {
    throw new Error(
      `applyVerifiedEvidence: referenced Attestation '${context.attestationId}' not found on Event '${context.eventId}' (stale/invalid reference) for assignment '${executionAssignmentId}'.`,
    )
  }
  if (attestation.verificationPolicyVersion !== context.verificationPolicyVersion) {
    throw new Error(
      `applyVerifiedEvidence: verificationPolicyVersion mismatch (context=${context.verificationPolicyVersion}, attestation=${attestation.verificationPolicyVersion}) for assignment '${executionAssignmentId}'.`,
    )
  }
  if (attestation.status !== 'verified') {
    throw new Error(
      `applyVerifiedEvidence: referenced Attestation '${context.attestationId}' is not verified (status='${attestation.status}') for assignment '${executionAssignmentId}'.`,
    )
  }

  // 4. Pre-populate the checkpoint with the validated durable IDs and advance
  //    to VERIFIED. processEconomicPipeline will skip evidence + verification.
  await db.economicPipelineState.update({
    where: { executionAssignmentId },
    data: {
      eventId: event.id,
      attestationId: attestation.id,
      stage: ECONOMIC_STAGE.VERIFIED,
    },
  })

  return {
    executionAssignmentId,
    validatedEventId: event.id,
    validatedAttestationId: attestation.id,
    stage: ECONOMIC_STAGE.VERIFIED,
  }
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
  /**
   * TEST-ONLY HOOK: if set, processEconomicPipeline throws after completing
   * the specified stage but BEFORE the next stage starts. This lets a test
   * inject a real failure at an economic stage boundary (not a deletion-based
   * simulation). The checkpoint reflects the last completed stage, and
   * reconciliation can resume from the durable boundary.
   *
   * Production callers MUST NOT pass this hook. No effect when omitted.
   */
  failAfterStage?: EconomicStage
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
      if (input.failAfterStage === ECONOMIC_STAGE.EVIDENCE_RECORDED) {
        throw new Error('TEST-ONLY: injected failure after EVIDENCE_RECORDED')
      }
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
      if (input.failAfterStage === ECONOMIC_STAGE.VERIFIED) {
        throw new Error('TEST-ONLY: injected failure after VERIFIED')
      }
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
      if (input.failAfterStage === ECONOMIC_STAGE.CONTRIBUTION_CREATED) {
        throw new Error('TEST-ONLY: injected failure after CONTRIBUTION_CREATED')
      }
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
      if (input.failAfterStage === ECONOMIC_STAGE.REWARD_CALCULATED) {
        throw new Error('TEST-ONLY: injected failure after REWARD_CALCULATED')
      }
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
      if (input.failAfterStage === ECONOMIC_STAGE.LEDGER_POSTED) {
        throw new Error('TEST-ONLY: injected failure after LEDGER_POSTED')
      }
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
      if (input.failAfterStage === ECONOMIC_STAGE.SETTLEMENT_CREATED) {
        throw new Error('TEST-ONLY: injected failure after SETTLEMENT_CREATED')
      }
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
 * DURABLE-STATE HYDRATION (hardened):
 * Before re-driving the pipeline, this function inspects PostgreSQL durable
 * state and reconstructs the checkpoint from existing durable objects. The
 * checkpoint is treated as CACHEABLE RECOVERY METADATA — the durable domain
 * objects are the source of truth. If a durable object exists but the
 * checkpoint forgot its ID, the ID is recovered. No replacement object is
 * created merely because the checkpoint forgot its ID.
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

  // --- DURABLE-STATE HYDRATION ---
  // Inspect PostgreSQL durable state and reconstruct the checkpoint from
  // existing durable objects. The checkpoint is derived/cacheable recovery
  // metadata — the durable domain objects are the source of truth.
  //
  // STALE-ID HANDLING (hardened):
  // For every checkpointed durable stage, the checkpoint ID is VALIDATED:
  //   1. If the checkpoint ID is present → load the referenced durable object.
  //   2. Validate the loaded object belongs to THIS assignment's deterministic
  //      identity (not another tenant's or another assignment's object).
  //   3. If the loaded object is wrong/stale/nonexistent → discard the checkpoint
  //      ID and rediscover by deterministic identity.
  //   4. If the checkpoint ID is absent → rediscover by deterministic identity.
  //   5. Persist the canonical durable ID into the checkpoint.
  //
  // This prevents cross-assignment poisoning (A's checkpoint pointing to B's
  // contribution) and cross-tenant contamination.
  const updates: Record<string, string | null> = {}

  // R1: Event — validate checkpoint ID, then rediscover by deterministic identity.
  let event: { id: string; status: string; payloadJson: string; capabilityType: string; occurredAt: Date; sequence: number | null; deviceId: string | null; attestations: Array<{ id: string }> } | null = null
  if (state.eventId) {
    // Load the referenced event.
    const referencedEvent = await db.event.findUnique({
      where: { id: state.eventId },
      include: { attestations: true },
    })
    // Validate: does it belong to this assignment's deterministic identity?
    if (referencedEvent && referencedEvent.tenantId === state.tenantId && referencedEvent.externalEventId === state.eventIdempotencyKey) {
      event = referencedEvent
    } else {
      // Stale or wrong — discard.
      updates.eventId = null
      state.eventId = null
    }
  }
  if (!event) {
    // Rediscover by deterministic identity.
    event = await db.event.findUnique({
      where: {
        tenantId_externalEventId: {
          tenantId: state.tenantId,
          externalEventId: state.eventIdempotencyKey,
        },
      },
      include: { attestations: true },
    })
    if (event) {
      updates.eventId = event.id
      state.eventId = event.id
    }
  }

  // R2: Attestation — validate checkpoint ID, then rediscover from the recovered Event.
  let attestationId: string | null = null
  if (state.attestationId && event) {
    // Load the referenced attestation and validate it belongs to this event.
    const referencedAttestation = await db.attestation.findUnique({
      where: { id: state.attestationId },
    })
    if (referencedAttestation && referencedAttestation.eventId === event.id) {
      attestationId = referencedAttestation.id
    } else {
      // Stale or wrong — discard.
      updates.attestationId = null
      state.attestationId = null
    }
  }
  if (!attestationId && event && event.attestations.length > 0) {
    // Rediscover from the event's attestations.
    attestationId = event.attestations[0].id
    updates.attestationId = attestationId
    state.attestationId = attestationId
  }

  // R3: Contribution — validate checkpoint ID, then rediscover by deterministic identity.
  if (state.contributionId) {
    const referencedContribution = await db.contribution.findUnique({
      where: { id: state.contributionId },
    })
    if (!referencedContribution || referencedContribution.tenantId !== state.tenantId || referencedContribution.idempotencyKey !== state.contributionIdempotencyKey) {
      // Stale or wrong — discard.
      updates.contributionId = null
      state.contributionId = null
    }
  }
  if (!state.contributionId) {
    const contribution = await db.contribution.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: state.tenantId,
          idempotencyKey: state.contributionIdempotencyKey,
        },
      },
    })
    if (contribution) {
      updates.contributionId = contribution.id
      state.contributionId = contribution.id
    }
  }

  // R4: Reward — validate checkpoint ID, then rediscover by deterministic identity.
  if (state.rewardId) {
    const referencedReward = await db.reward.findUnique({
      where: { id: state.rewardId },
    })
    if (!referencedReward || referencedReward.tenantId !== state.tenantId || referencedReward.idempotencyKey !== state.rewardIdempotencyKey) {
      updates.rewardId = null
      state.rewardId = null
    }
  }
  if (!state.rewardId) {
    const reward = await db.reward.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: state.tenantId,
          idempotencyKey: state.rewardIdempotencyKey,
        },
      },
    })
    if (reward) {
      updates.rewardId = reward.id
      state.rewardId = reward.id
    }
  }

  // R5: LedgerPosting — validate checkpoint ID, then rediscover by deterministic identity.
  if (state.ledgerPostingId) {
    const referencedPosting = await db.ledgerPosting.findUnique({
      where: { id: state.ledgerPostingId },
    })
    if (!referencedPosting || referencedPosting.tenantId !== state.tenantId || referencedPosting.idempotencyKey !== state.ledgerIdempotencyKey) {
      updates.ledgerPostingId = null
      state.ledgerPostingId = null
    }
  }
  if (!state.ledgerPostingId) {
    const posting = await db.ledgerPosting.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: state.tenantId,
          idempotencyKey: state.ledgerIdempotencyKey,
        },
      },
    })
    if (posting) {
      updates.ledgerPostingId = posting.id
      state.ledgerPostingId = posting.id
    }
  }

  // R6: Settlement — validate checkpoint ID, then rediscover by reward's 1:1 settlement.
  if (state.settlementId) {
    const referencedSettlement = await db.settlement.findUnique({
      where: { id: state.settlementId },
    })
    // Validate: settlement must belong to this assignment's reward.
    if (!referencedSettlement || !state.rewardId || referencedSettlement.rewardId !== state.rewardId) {
      updates.settlementId = null
      state.settlementId = null
    }
  }
  if (!state.settlementId && state.rewardId) {
    const settlement = await db.settlement.findUnique({
      where: { rewardId: state.rewardId },
    })
    if (settlement) {
      updates.settlementId = settlement.id
      state.settlementId = settlement.id
    }
  }

  // Persist any recovered IDs to the checkpoint.
  if (Object.keys(updates).length > 0) {
    await db.economicPipelineState.update({
      where: { executionAssignmentId },
      data: updates,
    })
  }

  // --- Check for verification rejection (terminal negative state) ---
  // If the event exists but is rejected, reconciliation must NOT create
  // economic value. This is terminal — no contribution/reward/ledger/settlement.
  if (event && event.status === 'rejected' && !state.attestationId) {
    await db.economicPipelineState.update({
      where: { executionAssignmentId },
      data: {
        stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
        reconciliationReason: `Event ${event.id} was rejected by verification — no economic value can be created`,
      },
    })
    return {
      assignmentId: executionAssignmentId,
      stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED,
      eventId: state.eventId ?? undefined,
      replayed: false,
    }
  }

  // Load the assignment's actuals.
  const assignment = await db.executionAssignment.findUnique({
    where: { id: executionAssignmentId },
    select: { actualQuantity: true, actualUnit: true, capabilityType: true },
  })
  const actualQuantity = assignment?.actualQuantity ?? '0'
  const actualUnit = assignment?.actualUnit ?? ''
  const capabilityType = event?.capabilityType ?? assignment?.capabilityType ?? ''

  const telemetryPayload: Record<string, unknown> = event
    ? (JSON.parse(event.payloadJson as string) as Record<string, unknown>)
    : {}
  const timestamp = event?.occurredAt.toISOString() ?? new Date().toISOString()
  const sequence = event?.sequence ?? 0
  const deviceId = event?.deviceId ?? ''

  // We do NOT need the signingKey for reconciliation. The event is already
  // ingested + signed. processEconomicPipeline will skip the ingest stage
  // (state.eventId is now set) and proceed directly to verification +
  // downstream steps.
  const signingKey = ''

  // Re-drive the pipeline. processEconomicPipeline will skip completed stages
  // (each stage checks if the durable object ID is already set — which we
  // just hydrated from durable state).
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
