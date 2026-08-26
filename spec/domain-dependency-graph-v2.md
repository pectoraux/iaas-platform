# IAAS Domain Dependency Graph — IAAS-DOM-ARCH-2

- Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Architecture Change Request: `ACR-001`

## New V2 Edge

```text
Event + VerificationResult + Attestation
                ↓
   VerifiedEvidenceContext
                ↓
     Generic Economic Pipeline
```

`VerifiedEvidenceContext` depends on the durable evidence/verification/attestation boundary. The Generic Economic Pipeline may consume the context, but the context MUST NOT depend on any vertical service.

## Prohibitions

```text
VerifiedEvidenceContext ✗-> VPP
VerifiedEvidenceContext ✗-> Compute
VerifiedEvidenceContext ✗-> Storage
VerifiedEvidenceContext ✗-> Wireless
VerifiedEvidenceContext ✗-> Manufacturing
VerifiedEvidenceContext ✗-> Kernel
VerifiedEvidenceContext ✗-> LedgerPosting
VerifiedEvidenceContext ✗-> Settlement
```

## Inherited V1 Direction

All edges and anti-drift prohibitions in `spec/domain-dependency-graph.md` remain in force. In particular, the Economic Pipeline and Data Plane remain parallel independent substrates.

No cycle is introduced by `VerifiedEvidenceContext`.
