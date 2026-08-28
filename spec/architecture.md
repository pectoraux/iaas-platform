# IAAS Architecture Specification

## Versions

| Artifact | Version | Status |
|---|---|---|
| Governance Architecture | `IAAS-GOV-ARCH-1` | FROZEN |
| Domain Architecture | `IAAS-DOM-ARCH-6` | FROZEN / CURRENT CANONICAL |
| Domain Architecture | `IAAS-DOM-ARCH-5` | SUPERSEDED / IMMUTABLE |
| Domain Architecture | `IAAS-DOM-ARCH-4` | SUPERSEDED / IMMUTABLE |
| Domain Architecture | `IAAS-DOM-ARCH-3` | SUPERSEDED / IMMUTABLE |
| Domain Architecture | `IAAS-DOM-ARCH-2` | SUPERSEDED / IMMUTABLE |
| Domain Architecture | `IAAS-DOM-ARCH-1` | SUPERSEDED / IMMUTABLE |

`IAAS-DOM-ARCH-6` is the current canonical domain architecture on main. It was approved through `ACR-005` and frozen by WORK-024 (the dedicated V6 freeze gate).

`IAAS-DOM-ARCH-5` is superseded and immutable. It remains the authoritative frozen record for the V5-era program (`WORK-001`..`WORK-022`) and its sandbox contract remains implemented and verified on main.

## Current Canonical Architecture

The current canonical Domain Architecture is `IAAS-DOM-ARCH-6`, published in `spec/domain-architecture-v6.md`.

V6 is the architecture-completion baseline: it preserves every V1-V5 frozen invariant and adds the missing generic contracts (NetworkInstance/lifecycle, Network-as-Code launch, composition/export/import, allocation strategy and temporal coordination, fragmentation/reassembly, generic trust/signature semantics, unified package architecture, distribution/marketplace separation, economic metering/attribution/pricing boundaries, operations lifecycle, observability/evidence contracts, and the canonical SDK boundary) so that further implementation is a realization of already-decided architecture.

## V6 Architecture

`IAAS-DOM-ARCH-6` was proposed as the architecture-completion baseline, independently reviewed with `ACR-005`, approved, and frozen by WORK-024. It does not rewrite V1-V5; the historical documents remain the immutable records of their eras.

Federation remains OPEN / RESEARCH and is explicitly not promoted to a frozen V6 production primitive.

## Historical Immutability

`spec/domain-architecture.md`, `spec/domain-architecture-v2.md`, `spec/domain-architecture-v3.md`, `spec/domain-architecture-v4.md`, and `spec/domain-architecture-v5.md` are historical/frozen architecture records. They must not be rewritten in place to incorporate V6.

Similarly, V1-V5 domain requirement and dependency-graph documents remain immutable records. V6 uses new versioned documents for current planning.

## Canonical Evidence Rule

The repository remains evidence, not automatically architecture. Architectural truth is established through ACRs, frozen versioned architecture documents, requirements, verification evidence, and Architect Review.
