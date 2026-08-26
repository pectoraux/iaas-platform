/// <reference types="bun-types" />
/**
 * WORK-003 — VerifiedEvidenceContext PostgreSQL Integration Tests
 *
 * Proves W003-AC05 (durable-reference validation + stale/invalid recovery)
 * and W003-AC08 (PostgreSQL remains the durable source of truth) against a
 * real PostgreSQL database.
 *
 * Coverage:
 *   - valid durable Event/Attestation references → checkpoint pre-populated,
 *     stage advanced to VERIFIED.
 *   - stale Event reference (non-existent id) → rejected (throw).
 *   - stale Attestation reference (wrong id) → rejected (throw).
 *   - tenant scope mismatch → rejected (throw).
 *   - verificationPolicyVersion mismatch → rejected (throw).
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
  createDevice,
  assignAssetToNetwork,
} from '../src/lib/services/registry.service'
import { ingestEvent, buildCanonicalMessage } from '../src/lib/services/ingestion.service'
import { processEventOutbox } from '../src/lib/services/worker.service'
import { signMessage, deriveSigningKey } from '../src/lib/domain/crypto'
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
let deviceId: string
let assetId: string
let provisioningSecret: string

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
  const asset = await createAsset(tenantId, {
    operatorId: operator.id,
    assetType: 'battery',
    name: 'W003 DER',
  })
  assetId = asset.id
  await assignAssetToNetwork(tenantId, assetId, networkId, 'energy_discharge', '100', 'kW')

  const provisioned = await createDevice(tenantId, {
    assetId,
    deviceType: 'battery_controller',
    manufacturer: 'Simulated',
    model: 'DER-Adapter-v1',
  })
  deviceId = provisioned.device.id
  provisioningSecret = provisioned.provisioningSecret
})

/** Ingest a telemetry event + process the outbox so an Attestation exists. */
async function ingestAndVerify(assignmentId: string) {
  const eventId = `evidence-${assignmentId}`
  const signingKey = deriveSigningKey(provisioningSecret)
  const timestamp = new Date().toISOString()
  const payload = { power_kw: 50 }
  const message = buildCanonicalMessage({
    device_id: deviceId,
    event_id: eventId,
    timestamp,
    event_type: 'telemetry',
    sequence: 1,
    payload,
  })
  const signature = signMessage(message, signingKey)
  const ingestResult = await ingestEvent(tenantId, {
    device_id: deviceId,
    event_id: eventId,
    timestamp,
    event_type: 'telemetry',
    sequence: 1,
    payload,
    signature,
    capability_type: 'energy_discharge',
  })
  await processEventOutbox(tenantId)
  const event = await db.event.findUnique({
    where: { id: ingestResult.event_id },
    include: { attestations: true },
  })
  if (!event || event.status !== 'verified' || !event.attestations[0]) {
    throw new Error(`W003 test setup failed: event not verified (status=${event?.status})`)
  }
  return { event, attestation: event.attestations[0] }
}

/** Create a minimal Execution + ExecutionAssignment for the checkpoint. */
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
  const operatorId = (await db.operator.findFirst({ where: { tenantId } }))!.id
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
    const { assignment, assignmentId } = await createAssignmentAndCheckpoint('valid')
    const { event, attestation } = await ingestAndVerify(assignmentId)

    const context = createVerifiedEvidenceContext({
      tenantId,
      networkId,
      eventId: event.id,
      attestationId: attestation.id,
      verificationPolicyId: networkVersionId,
      verificationPolicyVersion: networkVersionNumber,
      evidenceIdentity: `evidence-${assignmentId}`,
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
    const { assignment, assignmentId } = await createAssignmentAndCheckpoint('stale-evt')
    const { attestation } = await ingestAndVerify(assignmentId)
    const context = createVerifiedEvidenceContext({
      tenantId,
      networkId,
      eventId: 'nonexistent-event-id',
      attestationId: attestation.id,
      verificationPolicyId: networkVersionId,
      verificationPolicyVersion: networkVersionNumber,
      evidenceIdentity: `evidence-${assignmentId}`,
      issuedAt: attestation.createdAt.toISOString(),
    })

    await expect(
      applyVerifiedEvidence({ executionAssignmentId: assignment.id, context }),
    ).rejects.toThrow(/referenced Event.*not found.*stale\/invalid reference/)
  })

  it('rejects a stale (wrong) Attestation reference', async () => {
    const { assignment, assignmentId } = await createAssignmentAndCheckpoint('stale-att')
    const { event } = await ingestAndVerify(assignmentId)
    const context = createVerifiedEvidenceContext({
      tenantId,
      networkId,
      eventId: event.id,
      attestationId: 'nonexistent-attestation-id',
      verificationPolicyId: networkVersionId,
      verificationPolicyVersion: networkVersionNumber,
      evidenceIdentity: `evidence-${assignmentId}`,
      issuedAt: new Date().toISOString(),
    })

    await expect(
      applyVerifiedEvidence({ executionAssignmentId: assignment.id, context }),
    ).rejects.toThrow(/referenced Attestation.*not found.*stale\/invalid reference/)
  })

  it('rejects a tenant scope mismatch', async () => {
    const { assignment, assignmentId } = await createAssignmentAndCheckpoint('tenant')
    const { event, attestation } = await ingestAndVerify(assignmentId)
    const context = createVerifiedEvidenceContext({
      tenantId: 'different-tenant-id',
      networkId,
      eventId: event.id,
      attestationId: attestation.id,
      verificationPolicyId: networkVersionId,
      verificationPolicyVersion: networkVersionNumber,
      evidenceIdentity: `evidence-${assignmentId}`,
      issuedAt: attestation.createdAt.toISOString(),
    })

    await expect(
      applyVerifiedEvidence({ executionAssignmentId: assignment.id, context }),
    ).rejects.toThrow(/tenant scope mismatch/)
  })

  it('rejects a verificationPolicyVersion mismatch', async () => {
    const { assignment, assignmentId } = await createAssignmentAndCheckpoint('policy')
    const { event, attestation } = await ingestAndVerify(assignmentId)
    const context = createVerifiedEvidenceContext({
      tenantId,
      networkId,
      eventId: event.id,
      attestationId: attestation.id,
      verificationPolicyId: networkVersionId,
      verificationPolicyVersion: 999, // wrong version
      evidenceIdentity: `evidence-${assignmentId}`,
      issuedAt: attestation.createdAt.toISOString(),
    })

    await expect(
      applyVerifiedEvidence({ executionAssignmentId: assignment.id, context }),
    ).rejects.toThrow(/verificationPolicyVersion mismatch/)
  })

  it('rejects when the checkpoint does not exist (initEconomicPipeline not called)', async () => {
    const { event, attestation } = await ingestAndVerify(`w003-nocheckpoint-${Date.now()}`)
    const context = createVerifiedEvidenceContext({
      tenantId,
      networkId,
      eventId: event.id,
      attestationId: attestation.id,
      verificationPolicyId: networkVersionId,
      verificationPolicyVersion: networkVersionNumber,
      evidenceIdentity: event.externalEventId ?? 'evidence',
      issuedAt: attestation.createdAt.toISOString(),
    })

    await expect(
      applyVerifiedEvidence({ executionAssignmentId: 'nonexistent-assignment-id', context }),
    ).rejects.toThrow(/EconomicPipelineState not found.*Call initEconomicPipeline first/)
  })
})
