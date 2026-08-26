// =============================================================================
// VerifiedEvidenceContext — IAAS-DOM-ARCH-2 (ACR-001 / WORK-003)
// =============================================================================
// The generic, vertical-neutral boundary for already-verified economic
// evidence entering the generic Economic Pipeline.
//
// Contract source: spec/domain-architecture-v2.md §2, spec/domain-requirements-
// v2.md DOM-013, spec/architecture-change-requests/ACR-001.md.
//
// A VerifiedEvidenceContext represents already-verified economic evidence
// WITHOUT duplicating durable Event/VerificationResult/Attestation payloads.
// It references authoritative durable identities and carries the verification
// policy/version required to validate provenance. It is immutable after
// construction.
//
// Prohibitions (IAAS-DOM-ARCH-2 §2.5):
//   - NOT a replacement for Event, VerificationResult, or Attestation.
//   - NOT a ledger/accounting primitive.
//   - NOT owned by the kernel (this module lives in src/lib/domain/, not
//     src/lib/kernel/).
//   - NOT vertical-specific (this module imports NO vertical service).
// =============================================================================

/**
 * Immutable value object: already-verified economic evidence entering the
 * generic Economic Pipeline.
 *
 * Fields reference durable PostgreSQL identities; no durable payload is
 * duplicated. Immutability is enforced by `Object.freeze` at construction
 * (W003-AC01) and by the readonly TypeScript surface.
 */
export interface VerifiedEvidenceContext {
  /** Tenant scope (matches the underlying Event/Attestation). */
  readonly tenantId: string
  /** Network scope when the underlying evidence is network-scoped. */
  readonly networkId: string
  /** Authoritative durable Event identity. */
  readonly eventId: string
  /** Authoritative durable Attestation identity. */
  readonly attestationId: string
  /** Verification policy id (the NetworkVersion id whose policy produced the attestation). */
  readonly verificationPolicyId: string
  /** Verification policy version (NetworkVersion.version; matches Attestation.verificationPolicyVersion). */
  readonly verificationPolicyVersion: number
  /** Deterministic evidence identity (Event.externalEventId / idempotency key) for provenance validation. */
  readonly evidenceIdentity: string
  /** Provenance: when the verified evidence was issued (attestation createdAt). */
  readonly issuedAt: string
}

/**
 * Construct an immutable VerifiedEvidenceContext.
 *
 * Validates the ACR-001 field contract (all fields required, non-empty). Does
 * NOT validate durable references against the database — that is the job of
 * `applyVerifiedEvidence` in the economic-pipeline module, which performs
 * durable identity validation + stale/NULL recovery (W003-AC05).
 *
 * The returned object is frozen (W003-AC01 immutability).
 */
export function createVerifiedEvidenceContext(input: {
  tenantId: string
  networkId: string
  eventId: string
  attestationId: string
  verificationPolicyId: string
  verificationPolicyVersion: number
  evidenceIdentity: string
  issuedAt: string
}): VerifiedEvidenceContext {
  const errors: string[] = []
  if (!input.tenantId) errors.push('tenantId is required')
  if (!input.networkId) errors.push('networkId is required')
  if (!input.eventId) errors.push('eventId is required')
  if (!input.attestationId) errors.push('attestationId is required')
  if (!input.verificationPolicyId) errors.push('verificationPolicyId is required')
  if (input.verificationPolicyVersion === undefined || input.verificationPolicyVersion === null || Number.isNaN(input.verificationPolicyVersion)) {
    errors.push('verificationPolicyVersion is required')
  }
  if (!input.evidenceIdentity) errors.push('evidenceIdentity is required')
  if (!input.issuedAt) errors.push('issuedAt is required')
  if (errors.length > 0) {
    throw new Error(`VerifiedEvidenceContext construction failed: ${errors.join('; ')}`)
  }

  return Object.freeze({
    tenantId: input.tenantId,
    networkId: input.networkId,
    eventId: input.eventId,
    attestationId: input.attestationId,
    verificationPolicyId: input.verificationPolicyId,
    verificationPolicyVersion: input.verificationPolicyVersion,
    evidenceIdentity: input.evidenceIdentity,
    issuedAt: input.issuedAt,
  }) as VerifiedEvidenceContext
}

/**
 * Structural type guard — true if a value structurally matches the context
 * contract. Used by the economic pipeline to accept either a constructed
 * context or a plain object conforming to the shape.
 */
export function isVerifiedEvidenceContext(value: unknown): value is VerifiedEvidenceContext {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.tenantId === 'string' &&
    typeof v.networkId === 'string' &&
    typeof v.eventId === 'string' &&
    typeof v.attestationId === 'string' &&
    typeof v.verificationPolicyId === 'string' &&
    typeof v.verificationPolicyVersion === 'number' &&
    typeof v.evidenceIdentity === 'string' &&
    typeof v.issuedAt === 'string'
  )
}
