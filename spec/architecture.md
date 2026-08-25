# IAAS Architecture Specification

## Versioning

| Artifact | Version | Status |
|---|---|---|
| Governance Architecture | `IAAS-GOV-ARCH-1` | FROZEN |
| Domain Architecture | `IAAS-DOM-ARCH-1` | PENDING WORK-002 |

The existing authoritative domain architecture is currently distributed across `docs/architecture/ARCHITECTURE-CONSTITUTION.md`, the Phase 13 reconciliation documents, and the Phase 14 contracts. WORK-002 will reconcile those documents with the actual repository into one canonical Domain Architecture Version 1.

## Purpose

IAAS is an Infrastructure-as-a-Network platform for deploying decentralized physical infrastructure networks as easily as deploying software infrastructure.

## Governance Principle

Architecture is upstream of implementation. A frozen architecture constrains implementation; implementation does not redefine a frozen architecture.

## Architectural Domains Under Baseline Audit

The repository baseline must explicitly assess at least:

- Identity and tenancy
- Resources and capabilities
- Networks and memberships
- Allocation, commitment, reservation, and execution
- Ownership and entitlements
- Execution leases and fencing
- Runtime families
- Nodes
- Bundles and data plane
- Routing and transport
- Delivery confirmation
- Transform provenance and future transform runtime
- Verification, evidence, attestation, contribution, rewards, ledger, settlement
- Workflow and orchestration
- Network launch / Network-as-Code
- Extensions and adapters
- Vertical network implementations

These domains are **candidate architectural areas**, not permission to implement them in WORK-001.

## Existing Architectural Authority

Until `IAAS-DOM-ARCH-1` is frozen, the existing architecture documents remain the primary domain evidence. The Phase 13R reconciliation commit explicitly admitted Phase 14A-F implementations into the constitutional architecture and preserved anti-drift boundaries. The reconciliation also records that TransformRegistry/Runtime, extensions, marketplace, SDK, RemoteAPI, and sandbox remain future concepts.

## Prohibited Shortcut

No new vertical-specific abstraction may be introduced merely to unblock an implementation. A missing generic primitive or contradictory requirement must be surfaced as an Architecture Change Request.

## Next Authority Transition

WORK-002 will produce:

1. `docs/architecture/REPOSITORY-BASELINE.md`
2. `IAAS-DOM-ARCH-1` canonical architecture
3. explicit observed/inferred/confirmed/proposed classifications
4. the domain requirement set from which later Work Items are derived
