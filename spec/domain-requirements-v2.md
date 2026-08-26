# IAAS Domain Requirements — IAAS-DOM-ARCH-2

- Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Architecture Change Request: `ACR-001`

## DOM-013 — VerifiedEvidenceContext Boundary

The platform MUST expose an immutable, generic `VerifiedEvidenceContext` as the explicit boundary for already-verified economic evidence entering the generic Economic Pipeline.

Acceptance requirements:

1. The context references authoritative durable `Event` and `Attestation` identities rather than duplicating their payloads.
2. The context carries the verification policy/version and deterministic evidence identity required to validate provenance.
3. The context is immutable after construction.
4. The generic Economic Pipeline accepts the context without importing any vertical service.
5. VPP-specific evidence and baseline calculation remain inside the VPP boundary; VPP emits the generic context.
6. Durable PostgreSQL Event/VerificationResult/Attestation records remain the source of truth.
7. Reconciliation validates referenced identities and preserves existing stale/invalid-reference recovery behavior.
8. The context is not a kernel primitive, ledger primitive, or replacement for Event/VerificationResult/Attestation.
9. The implementation preserves Data Plane ↔ Economic Pipeline independence.

Classification: CONFIRMED by ACR-001; implemented and VERIFIED by WORK-003.
