/// <reference types="bun-types" />
/**
 * WORK-003 — VerifiedEvidenceContext PostgreSQL Integration Tests
 *
 * Proves W003-AC05 (durable-reference validation + stale/invalid recovery)
 * and W003-AC08 (PostgreSQL remains the durable source of truth) against a
 * real PostgreSQL database.
 *
 * These tests create durable Event + Attestation records directly via Prisma
 * (bypassing the ingest/verify chain) so the focus is purely on
 * `applyVerifiedEvidence`'s reference-validation and checkpoint-pre-population
 * behavior. The ingest/verify chain is already covered by the existing VPP
 * integration tests; WORK-003's contract is the context boundary, not
 * re-verifying the ingest chain.
 *
 * Coverage:
 *   - valid durable Event/Attestation references → checkpoint pre-populated,
 *     stage advanced to VERIFIED.
 *   - stale Event reference (non-existent id) → rejected (throw).
 *   - stale Attestation reference (wrong id) → rejected (throw).
 *   - tenant scope mismatch → rejected (throw).
 *   - verificationPolicyVersion mismatch → rejected (throw).
 *   - non-verified Attestation (status != 'verified') → rejected (throw).
 *   - checkpoint missing (initEconomicPipeline not called) → rejected.
 *
 * Run: bun test tests/work-003-verified-evidence-pg.test.ts --timeout 120000
 *      (requires DATABASE_URL pointing at a real PostgreSQL instance)
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import {
  createOperator,
  createAsset,
} from '../src/lib/services/registry.service'
import {
  initEconomicPipeline,
  applyVerifiedEvidence,
  ECONOMIC_STAGE,
} from '../src/lib/control-plane/economic-pipeline'
import { createVerifiedEvidenceContext } from '../src/lib/domain/verified-evidence-context'

let tenantId: string
let networkId: string
let networkVersionId: string
let networkVersionNumber: number
let assetId: string
let operatorId: string

beforeAll(async () => {
  const tenant = await createTenant({
    name: 'WORK-003 VerifiedEvidenceContext PG',
    slug: `w003-vec-pg-${Date.now()}`,
    plan: 'growth',
  })
  tenantId = tenant.id

  const { network, version } = await instantiateTemplate(tenantId, 'energy-vpp')
  networkId = network!.id
  networkVersionId = version!.id
  networkVersionNumber = version!.version

  const operator = await createOperator(tenantId, { displayName: 'W003 Operator' })
  operatorId = operator.id
  const asset = await createAsset(tenantId, {
    operatorId,
    assetType: 'battery',
    name: 'W003 DER',
  })
  assetId = asset.id
})

/** Create a durable Event + Attestation directly via Prisma. */
async function createDurableEventAndAttestation(label: string, options?: {
  attestationStatus?: string
  policyVersion?: number
}) {
  const eventId = `evt-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const event = await db.event.create({
    data: {
      tenantId,
      networkVersionId,
      assetId,
      deviceId: null,
      capabilityType: 'energy_discharge',
      externalEventId: eventId,
      eventType: 'telemetry',
      occurredAt: new Date(),
      sequence: 1,
      payloadJson: JSON.stringify({ power_kw: 5.0, available_energy_kwh: 13.5, state_of_charge_pct: 80 }),
      schemaVersion: 1,
      status: 'verified',
    },
  })
  const attestation = await db.attestation.create({
    data: {
      tenantId,
      eventId: event.id,
      claimType: 'valid_measurement',
      quantity: 5.0,
      unit: 'kW',
      status: options?.attestationStatus ?? 'verified',
      verificationPolicyVersion: options?.policyVersion ?? networkVersionNumber,
      verifierVersion: 'v1',
    },
  })
  return { event, attestation, externalEventId: eventId }
}

/** Create a minimal Execution + ExecutionAssignment + checkpoint. */
async function createAssignmentAndCheckpoint(label: string) {
  const assignmentId = `w003-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const execution = await db.execution.create({
    data: {
      tenantId,
      networkId,
      networkVersionId,
      requestedQuantity: '10',
      requestedUnit: 'kW',
      startTime: new Date(),
      endTime: new Date(),
      status: 'completed',
      sourceType: 'w003_test',
      sourceId: assignmentId,
    },
  })
  const assignment = await db.executionAssignment.create({
    data: {
      tenantId,
      executionId: execution.id,
      assetId,
      operatorId,
      capabilityType: 'energy_discharge',
      assignedQuantity: '10',
      assignedUnit: 'kW',
      status: 'completed',
    },
  })
  await initEconomicPipeline({
    executionAssignmentId: assignment.id,
    tenantId,
    networkVersionId,
    networkId,
  })
  return { assignment, assignmentId }
}

describe('WORK-003 — VerifiedEvidenceContext PostgreSQL integration (W003-AC05, W003-AC08)', () => {
  it('pre-populates the checkpoint with valid durable references and advances to VERIFIED', async () => {
    const { assignment } = await createAssignmentAndCheckpoint('valid')
    const { event, attestation, externalEventId } = await createDurableEventAndAttestation('valid')

    const context = createVerifiedEvidenceContext({
      tenantId,
      networkId,
      eventId: event.id,
      attestationId: attestation.id,
      verificationPolicyId: networkVersionId,
      verificationPolicyVersion: networkVersionNumber,
      evidenceIdentity: externalEventId,
      issuedAt: attestation.createdAt.toISOString(),
    })

    const result = await applyVerifiedEvidence({
      executionAssignmentId: assignment.id,
      context,
    })

    expect(result.validatedEventId).toBe(event.id)
    expect(result.validatedAttestationId).toBe(attestation.id)
    expect(result.stage).toBe(ECONOMIC_STAGE.VERIFIED)

    const state = await db.economicPipelineState.findUnique({
      where: { executionAssignmentId: assignment.id },
    })
    expect(state?.eventId).toBe(event.id)
    expect(state?.attestationId).toBe(attestation.id)
    expect(state?.stage).toBe(ECONOMIC_STAGE.VERIFIED)
  })

  it('rejects a stale (non-existent) Event reference', async () => {
    const { assignment } = await createAssignmentAndCheckpoint('stale-evt')
    const { attestation, externalEventId } = await createDurableEventAndAttestation('stale-evt-att')
    const context = createVerifiedEvidenceContext({
      tenantId,
      networkId,
      eventId: 'nonexistent-event-id',
      attestationId: attestation.id,
      verificationPolicyId: networkVersionId,
      verificationPolicyVersion: networkVersionNumber,
      evidenceIdentity: externalEventId,
      issuedAt: attestation.createdAt.toISOString(),
    })

    await expect(
      applyVerifiedEvidence({ executionAssignmentId: assignment.id, context }),
    ).rejects.toThrow(/referenced Event.*not found.*stale\/invalid reference/)
  })

  it('rejects a stale (wrong) Attestation reference', async () => {
    const { assignment } = await createAssignmentAndCheckpoint('stale-att')
    const { event, externalEventId } = await createDurableEventAndAttestation('stale-att-evt')
    const context = createVerifiedEvidenceContext({
      tenantId,
      networkId,
      eventId: event.id,
      attestationId: 'nonexistent-attestation-id',
      verificationPolicyId: networkVersionId,
      verificationPolicyVersion: networkVersionNumber,
      evidenceIdentity: externalEventId,
      issuedAt: new Date().toISOString(),
    })

    await expect(
      applyVerifiedEvidence({ executionAssignmentId: assignment.id, context }),
    ).rejects.toThrow(/referenced Attestation.*not found.*stale\/invalid reference/)
  })

  it('rejects a tenant scope mismatch', async () => {
    const { assignment } = await createAssignmentAndCheckpoint('tenant')
    const { event, attestation, externalEventId } = await createDurableEventAndAttestation('tenant-evt')
    const context = createVerifiedEvidenceContext({
      tenantId: 'different-tenant-id',
      networkId,
      eventId: event.id,
      attestationId: attestation.id,
      verificationPolicyId: networkVersionId,
      verificationPolicyVersion: networkVersionNumber,
      evidenceIdentity: externalEventId,
      issuedAt: attestation.createdAt.toISOString(),
    })

    await expect(
      applyVerifiedEvidence({ executionAssignmentId: assignment.id, context }),
    ).rejects.toThrow(/tenant scope mismatch/)
  })

  it('rejects a verificationPolicyVersion mismatch', async () => {
    const { assignment } = await createAssignmentAndCheckpoint('policy')
    const { event, attestation, externalEventId } = await createDurableEventAndAttestation('policy-evt')
    const context = createVerifiedEvidenceContext({
      tenantId,
      networkId,
      eventId: event.id,
      attestationId: attestation.id,
      verificationPolicyId: networkVersionId,
      verificationPolicyVersion: 999, // wrong version
      evidenceIdentity: externalEventId,
      issuedAt: attestation.createdAt.toISOString(),
    })

    await expect(
      applyVerifiedEvidence({ executionAssignmentId: assignment.id, context }),
    ).rejects.toThrow(/verificationPolicyVersion mismatch/)
  })

  it('rejects a non-verified Attestation (status != verified)', async () => {
    const { assignment } = await createAssignmentAndCheckpoint('not-verified')
    const { event, attestation, externalEventId } = await createDurableEventAndAttestation('not-verified-evt', {
      attestationStatus: 'disputed',
    })
    const context = createVerifiedEvidenceContext({
      tenantId,
      networkId,
      eventId: event.id,
      attestationId: attestation.id,
      verificationPolicyId: networkVersionId,
      verificationPolicyVersion: networkVersionNumber,
      evidenceIdentity: externalEventId,
      issuedAt: attestation.createdAt.toISOString(),
    })

    await expect(
      applyVerifiedEvidence({ executionAssignmentId: assignment.id, context }),
    ).rejects.toThrow(/not verified/)
  })

  it('rejects when the checkpoint does not exist (initEconomicPipeline not called)', async () => {
    const { event, attestation, externalEventId } = await createDurableEventAndAttestation('no-checkpoint')
    const context = createVerifiedEvidenceContext({
      tenantId,
      networkId,
      eventId: event.id,
      attestationId: attestation.id,
      verificationPolicyId: networkVersionId,
      verificationPolicyVersion: networkVersionNumber,
      evidenceIdentity: externalEventId,
      issuedAt: attestation.createdAt.toISOString(),
    })

    await expect(
      applyVerifiedEvidence({ executionAssignmentId: 'nonexistent-assignment-id', context }),
    ).rejects.toThrow(/EconomicPipelineState not found.*Call initEconomicPipeline first/)
  })
})
