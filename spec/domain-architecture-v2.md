# IAAS Domain Architecture — IAAS-DOM-ARCH-2

- Domain Architecture Version: `IAAS-DOM-ARCH-2`
- Status: **FROZEN**
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Supersedes: `IAAS-DOM-ARCH-1`
- Architecture Change Request: `ACR-001`

## 1. Version Relationship

`IAAS-DOM-ARCH-2` preserves every rule and primitive of `IAAS-DOM-ARCH-1` except the explicit evidence-boundary addition defined below. The V1 document remains immutable historical architecture; this document is the current canonical domain architecture.

## 2. VerifiedEvidenceContext

### 2.1 Purpose

`VerifiedEvidenceContext` is the generic, vertical-neutral boundary for already-verified economic evidence entering the generic Economic Pipeline without repeating evidence/verification stages.

It formalizes the future evolution identified in the V1 architecture and Constitution §6.

### 2.2 Contract

The context is an immutable value object containing, at minimum:

```text
VerifiedEvidenceContext
  ├─ tenantId
  ├─ networkId (when the underlying evidence is network-scoped)
  ├─ eventId
  ├─ attestationId
  ├─ verificationPolicyId
  ├─ verificationPolicyVersion
  ├─ evidenceIdentity / deterministic identity reference
  └─ provenance / issuedAt metadata
```

The exact storage shape is an implementation decision within WORK-003, subject to this contract. The context MUST NOT duplicate the durable Event, VerificationResult, or Attestation payloads.

### 2.3 Source of Truth

`VerifiedEvidenceContext` is NOT a durable economic truth record. PostgreSQL `Event`, `VerificationResult`, and `Attestation` remain authoritative. Reconciliation MUST validate the referenced identities and MUST preserve stale/invalid-reference recovery behavior.

### 2.4 Boundary

```text
Vertical-specific evidence + verification
              ↓
     VerifiedEvidenceContext
              ↓
      Generic Economic Pipeline
              ↓
 Contribution → Reward → LedgerPosting → Settlement
```

The generic Economic Pipeline MUST accept the context without importing any vertical service.

### 2.5 Prohibitions

`VerifiedEvidenceContext` MUST NOT:

- become a replacement for Event, VerificationResult, or Attestation;
- become a ledger/accounting primitive;
- own evidence storage;
- require VPP, Compute, Storage, Wireless, Manufacturing, or any other vertical;
- be owned by the kernel;
- permit bypassing durable identity validation.

## 3. Migration Boundary

The existing VPP pre-pipeline evidence pattern is migrated to construct a `VerifiedEvidenceContext`. VPP retains its domain-specific baseline calculation and dispatch semantics. The generic Economic Pipeline remains vertical-neutral.

## 4. Inherited Architecture

All requirements, boundaries, anti-drift rules, identity/resource distinctions, runtime isolation, control-plane pipeline, data-plane independence, PostgreSQL mandate, TransformRecord partial-implementation status, future TransformRegistry/TransformRuntime, Extension, Marketplace, SDK, and other V1 rules remain unchanged.

See `spec/domain-architecture.md` (`IAAS-DOM-ARCH-1`) for the immutable V1 record.

## 5. Verification Requirements

The implementation of this version MUST prove:

1. context immutability;
2. durable Event/Attestation source-of-truth preservation;
3. deterministic identity/reference validation;
4. stale/invalid reference rejection or recovery consistent with existing reconciliation;
5. generic-pipeline vertical neutrality;
6. no kernel ownership/dependency;
7. VPP migration without changing its domain-specific baseline semantics;
8. no change to the Data Plane ↔ Economic Pipeline independence.
