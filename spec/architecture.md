# IAAS Architecture Specification

## Versions

| Artifact | Version | Status |
|---|---|---|
| Governance Architecture | `IAAS-GOV-ARCH-1` | FROZEN |
| Domain Architecture | `IAAS-DOM-ARCH-5` | FROZEN / CURRENT CANONICAL |
| Domain Architecture | `IAAS-DOM-ARCH-4` | SUPERSEDED / IMMUTABLE |
| Domain Architecture | `IAAS-DOM-ARCH-3` | SUPERSEDED / IMMUTABLE |
| Domain Architecture | `IAAS-DOM-ARCH-2` | SUPERSEDED / IMMUTABLE |
| Domain Architecture | `IAAS-DOM-ARCH-1` | SUPERSEDED / IMMUTABLE |
| Domain Architecture | `IAAS-DOM-ARCH-6` | CANDIDATE / UNDER REVIEW |

`IAAS-DOM-ARCH-5` is the current canonical domain architecture on main. It is frozen through approved `ACR-004` and WORK-020.

`IAAS-DOM-ARCH-6` is a candidate architecture under `ACR-005` in branch `architect/v6-completion-candidate`. It is NOT frozen and MUST NOT authorize production implementation until independently reviewed and released by a V6 freeze Work Item.

## Current Canonical Architecture

The current canonical Domain Architecture is `IAAS-DOM-ARCH-5`, published in `spec/domain-architecture-v5.md`.

V5 inherits V4 and freezes the WASI Component Model / capability-sandbox contract for untrusted extensions. The contract fixes trust boundaries, capability enforcement, resource-measurement semantics, lifecycle/termination semantics, tenant isolation, and deny-by-default fallback without freezing a specific WASI revision or concrete runtime.

## V6 Candidate

`IAAS-DOM-ARCH-6` is the proposed architecture-completion baseline. It does not rewrite V1-V5. It adds the missing generic contracts required to make implementation mechanical: NetworkInstance/lifecycle, Network-as-Code launch, composition/export/import, allocation strategy and temporal coordination, fragmentation/reassembly, generic trust/signature semantics, unified package architecture, distribution/marketplace separation, economic metering/attribution/pricing boundaries, operations lifecycle, observability/evidence contracts, canonical SDK boundary, and a formal reference-network conformance program.

Federation remains OPEN / RESEARCH and is explicitly not promoted to a frozen V6 production primitive.

## Historical Immutability

`spec/domain-architecture.md`, `spec/domain-architecture-v2.md`, `spec/domain-architecture-v3.md`, `spec/domain-architecture-v4.md`, and `spec/domain-architecture-v5.md` are historical/frozen architecture records. They must not be rewritten in place to incorporate V6.

Similarly, V1-V5 domain requirement and dependency-graph documents remain immutable records. V6 uses new versioned documents for current planning.

## Canonical Evidence Rule

The repository remains evidence, not automatically architecture. Architectural truth is established through ACRs, frozen versioned architecture documents, requirements, verification evidence, and Architect Review.
