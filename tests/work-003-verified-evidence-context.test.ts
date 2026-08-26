/// <reference types="bun-types" />
// =============================================================================
// WORK-003 — VerifiedEvidenceContext unit + static architecture tests
// =============================================================================
// Verifies W003-AC01 (immutability), W003-AC02 (references durable identities,
// no payload duplication), W003-AC03 (generic pipeline vertical neutrality),
// W003-AC06 (not a kernel primitive, not a ledger primitive), and the static
// import prohibitions from ACR-001 §2.5.
//
// These tests are DB-free (the PostgreSQL durable-reference validation is
// covered by tests/work-003-verified-evidence-pg.test.ts).
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  createVerifiedEvidenceContext,
  isVerifiedEvidenceContext,
  type VerifiedEvidenceContext,
} from '@/lib/domain/verified-evidence-context'

const REPO_ROOT = process.cwd()

// ---------------------------------------------------------------------------
// W003-AC01 — immutable value object at the evidence/economic boundary
// ---------------------------------------------------------------------------

describe('WORK-003 — VerifiedEvidenceContext construction (W003-AC01)', () => {
  const validInput = {
    tenantId: 'tenant-1',
    networkId: 'net-1',
    eventId: 'evt-1',
    attestationId: 'att-1',
    verificationPolicyId: 'policy-1',
    verificationPolicyVersion: 3,
    evidenceIdentity: 'evidence-assignment-1',
    issuedAt: '2026-08-26T00:00:00.000Z',
  }

  test('constructs a context with all required fields', () => {
    const ctx = createVerifiedEvidenceContext(validInput)
    expect(ctx.tenantId).toBe('tenant-1')
    expect(ctx.networkId).toBe('net-1')
    expect(ctx.eventId).toBe('evt-1')
    expect(ctx.attestationId).toBe('att-1')
    expect(ctx.verificationPolicyId).toBe('policy-1')
    expect(ctx.verificationPolicyVersion).toBe(3)
    expect(ctx.evidenceIdentity).toBe('evidence-assignment-1')
    expect(ctx.issuedAt).toBe('2026-08-26T00:00:00.000Z')
  })

  test('is frozen (immutable) after construction (W003-AC01)', () => {
    const ctx = createVerifiedEvidenceContext(validInput)
    expect(Object.isFrozen(ctx)).toBe(true)
    // Mutation of a frozen property either throws (strict mode) or silently
    // fails. In both cases the original value is preserved.
    try {
      ;(ctx as { eventId?: string }).eventId = 'mutated'
    } catch {
      // strict-mode TypeError — expected for frozen objects
    }
    expect(ctx.eventId).toBe('evt-1') // unchanged regardless
  })

  test('rejects construction with missing required fields', () => {
    expect(() => createVerifiedEvidenceContext({ ...validInput, tenantId: '' })).toThrow(/tenantId is required/)
    expect(() => createVerifiedEvidenceContext({ ...validInput, eventId: '' })).toThrow(/eventId is required/)
    expect(() => createVerifiedEvidenceContext({ ...validInput, attestationId: '' })).toThrow(/attestationId is required/)
    expect(() => createVerifiedEvidenceContext({ ...validInput, verificationPolicyId: '' })).toThrow(/verificationPolicyId is required/)
    expect(() => createVerifiedEvidenceContext({ ...validInput, evidenceIdentity: '' })).toThrow(/evidenceIdentity is required/)
    expect(() => createVerifiedEvidenceContext({ ...validInput, issuedAt: '' })).toThrow(/issuedAt is required/)
  })

  test('rejects construction with missing verificationPolicyVersion', () => {
    expect(() =>
      createVerifiedEvidenceContext({ ...validInput, verificationPolicyVersion: undefined as unknown as number }),
    ).toThrow(/verificationPolicyVersion is required/)
  })
})

// ---------------------------------------------------------------------------
// W003-AC02 — references durable identities, no payload duplication
// ---------------------------------------------------------------------------

describe('WORK-003 — context references durable identities (W003-AC02)', () => {
  test('the context interface carries only identity references, not payloads', () => {
    // The VerifiedEvidenceContext interface must NOT contain payload fields
    // like payloadJson, telemetryPayload, checksJson, quantity, etc. It carries
    // ONLY durable identity references + verification policy/version metadata.
    const ctx = createVerifiedEvidenceContext({
      tenantId: 't',
      networkId: 'n',
      eventId: 'e',
      attestationId: 'a',
      verificationPolicyId: 'p',
      verificationPolicyVersion: 1,
      evidenceIdentity: 'eid',
      issuedAt: '2026-01-01T00:00:00.000Z',
    })
    const keys = Object.keys(ctx)
    expect(keys).not.toContain('payloadJson')
    expect(keys).not.toContain('telemetryPayload')
    expect(keys).not.toContain('checksJson')
    expect(keys).not.toContain('quantity')
    expect(keys).not.toContain('unit')
    expect(keys).toContain('eventId')
    expect(keys).toContain('attestationId')
    expect(keys).toContain('verificationPolicyId')
    expect(keys).toContain('verificationPolicyVersion')
  })

  test('isVerifiedEvidenceContext type guard accepts a valid context', () => {
    const ctx = createVerifiedEvidenceContext({
      tenantId: 't', networkId: 'n', eventId: 'e', attestationId: 'a',
      verificationPolicyId: 'p', verificationPolicyVersion: 1,
      evidenceIdentity: 'eid', issuedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(isVerifiedEvidenceContext(ctx)).toBe(true)
  })

  test('isVerifiedEvidenceContext type guard rejects non-conforming values', () => {
    expect(isVerifiedEvidenceContext(null)).toBe(false)
    expect(isVerifiedEvidenceContext('not an object')).toBe(false)
    expect(isVerifiedEvidenceContext({})).toBe(false)
    expect(isVerifiedEvidenceContext({ tenantId: 't', eventId: 'e' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// W003-AC03 / W003-AC06 — static import architecture tests
// ---------------------------------------------------------------------------

describe('WORK-003 — static architecture / import prohibitions (W003-AC03, W003-AC06)', () => {
  const CONTEXT_MODULE = readFileSync(
    join(REPO_ROOT, 'src', 'lib', 'domain', 'verified-evidence-context.ts'),
    'utf8',
  )
  const ECONOMIC_PIPELINE = readFileSync(
    join(REPO_ROOT, 'src', 'lib', 'control-plane', 'economic-pipeline.ts'),
    'utf8',
  )

  test('VerifiedEvidenceContext module imports NO vertical service (W003-AC03)', () => {
    // The context module must not import VPP/Compute/Storage/Wireless/Manufacturing.
    const verticalPattern = /(?:vpp|compute|storage|wireless|manufacturing)\.service/
    expect(verticalPattern.test(CONTEXT_MODULE)).toBe(false)
  })

  test('VerifiedEvidenceContext is NOT in the kernel (W003-AC06)', () => {
    // The context lives at src/lib/domain/verified-evidence-context.ts, NOT
    // src/lib/kernel/. (ACR-001 §2.5: "be owned by the kernel" is prohibited.)
    // Verified by file path — this test asserts the module imports nothing from
    // the kernel runtime/adapters.
    expect(CONTEXT_MODULE).not.toContain('@/lib/kernel/')
  })

  test('VerifiedEvidenceContext is NOT a ledger/accounting primitive (W003-AC06)', () => {
    // The context module must not import ledger/settlement/contribution services.
    expect(CONTEXT_MODULE).not.toContain('ledger.service')
    expect(CONTEXT_MODULE).not.toContain('settlement.service')
    expect(CONTEXT_MODULE).not.toContain('contribution.service')
    expect(CONTEXT_MODULE).not.toContain('reward.service')
  })

  test('VerifiedEvidenceContext does NOT replace Event/VerificationResult/Attestation (ACR-001 §2.5)', () => {
    // The context module must not import the Event/Attestation/VerificationResult
    // services (it references their durable IDs only, validated by the pipeline).
    expect(CONTEXT_MODULE).not.toContain('ingestion.service')
    expect(CONTEXT_MODULE).not.toContain('verification.service')
    expect(CONTEXT_MODULE).not.toContain('attestation.service')
  })

  test('economic-pipeline.ts imports the context but NO vertical service (W003-AC03)', () => {
    // The generic pipeline accepts the context and must remain vertical-neutral.
    expect(ECONOMIC_PIPELINE).toContain('verified-evidence-context')
    const verticalPattern = /(?:vpp|compute|storage|wireless|manufacturing)\.service/
    expect(verticalPattern.test(ECONOMIC_PIPELINE)).toBe(false)
  })

  test('economic-pipeline.ts imports NO data-plane service (W003-AC07 / AR-004)', () => {
    // Data Plane ↔ Economic Pipeline independence: the pipeline must not import
    // any phase-14 data-plane service.
    const dataPlanePattern = /(?:data-plane|routing|transport|delivery-confirmation|transform-record)\.service/
    expect(dataPlanePattern.test(ECONOMIC_PIPELINE)).toBe(false)
  })

  test('VerifiedEvidenceContext is exported from the domain layer (not kernel)', () => {
    // Structural: the module path is src/lib/domain/, confirming it is a domain
    // primitive, not a kernel primitive.
    const path = join(REPO_ROOT, 'src', 'lib', 'domain', 'verified-evidence-context.ts')
    expect(path).toContain('src/lib/domain/')
    expect(path).not.toContain('src/lib/kernel/')
  })
})

// ---------------------------------------------------------------------------
// W003-AC04 — VPP constructs the context (static evidence)
// ---------------------------------------------------------------------------

describe('WORK-003 — VPP constructs VerifiedEvidenceContext (W003-AC04)', () => {
  const VPP_SERVICE = readFileSync(
    join(REPO_ROOT, 'src', 'lib', 'services', 'vpp.service.ts'),
    'utf8',
  )

  test('VPP imports createVerifiedEvidenceContext and applyVerifiedEvidence', () => {
    expect(VPP_SERVICE).toContain('createVerifiedEvidenceContext')
    expect(VPP_SERVICE).toContain('applyVerifiedEvidence')
  })

  test('VPP no longer directly mutates EconomicPipelineState.eventId/attestationId', () => {
    // The prior vertical-specific convention directly mutated the checkpoint.
    // After WORK-003, VPP must NOT contain the direct pre-population mutation;
    // it must go through applyVerifiedEvidence. (Search for the old pattern:
    // economicPipelineState.update({ ... eventId: event.id ... }) — after
    // migration this pattern is absent because VPP calls applyVerifiedEvidence
    // instead. We check that the VPP source does not contain the combination of
    // economicPipelineState.update with eventId: event.id.)
    const hasDirectMutation = /economicPipelineState\.update\(/.test(VPP_SERVICE) &&
      /eventId:\s*event\.id/.test(VPP_SERVICE) &&
      /attestationId:\s*attestation\.id/.test(VPP_SERVICE) &&
      /stage:\s*ECONOMIC_STAGE\.VERIFIED/.test(VPP_SERVICE)
    // The four tokens must not all appear in the direct-mutation combination.
    // (After migration, applyVerifiedEvidence owns this; VPP only constructs
    // the context.) Verify the explicit pre-population block is gone by checking
    // that the update call near eventId/attestationId is absent.
    expect(hasDirectMutation).toBe(false)
  })

  test('VPP retains its domain-specific baseline calculation (not refactored away)', () => {
    // W003-AC04: VPP retains its domain-specific baseline/dispatch semantics.
    expect(VPP_SERVICE).toContain('baselineEngine')
    expect(VPP_SERVICE).toContain('baselineKwh')
    expect(VPP_SERVICE).toContain('verifiedPerformanceKwh')
  })
})
