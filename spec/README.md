# IAAS Specification System

This directory is the persistent planning and governance layer for IAAS implementation.

## Documents

- `architecture.md` — architecture-version index and domain-architecture authority map.
- `architecture-lock.md` — frozen architecture rules and workflow invariants.
- `requirements.md` — governance requirements and acceptance criteria.
- `work-items.md` — bounded implementation units and lifecycle.
- `dependency-graph.md` — Work Item eligibility/dependency graph.
- `work-order-template.md` — canonical implementation-agent handoff format.
- `architecture-change-request.md` — controlled architecture evolution protocol.
- `architecture-change-requests/ACR-001.md` — approved promotion of VerifiedEvidenceContext.
- `architecture-change-requests/ACR-002.md` — approved promotion of Transform Stack boundary.
- `architecture-change-requests/ACR-003.md` — candidate promotion of Extension Stack boundary (UNDER_REVIEW).
- `verification.md` — evidence and verification protocol.
- `domain-architecture.md` — immutable Domain Architecture V1 (`IAAS-DOM-ARCH-1`, SUPERSEDED).
- `domain-architecture-v2.md` — immutable Domain Architecture V2 (`IAAS-DOM-ARCH-2`, SUPERSEDED).
- `domain-architecture-v3.md` — canonical Domain Architecture V3 (`IAAS-DOM-ARCH-3`, FROZEN).
- `domain-architecture-v4.md` — candidate Domain Architecture V4 (`IAAS-DOM-ARCH-4`, CANDIDATE).
- `domain-requirements.md` — V1 domain requirements.
- `domain-requirements-v2.md` — V2 domain requirements (`DOM-013`).
- `domain-requirements-v3.md` — V3 domain requirements (`DOM-014`..`DOM-017`).
- `domain-requirements-v4.md` — V4 candidate domain requirements (`DOM-018`..`DOM-021`).
- `domain-dependency-graph.md` — V1 domain primitive dependency DAG.
- `domain-dependency-graph-v2.md` — V2 dependency delta for VerifiedEvidenceContext.
- `domain-dependency-graph-v3.md` — V3 dependency delta for Transform Stack.
- `domain-dependency-graph-v4.md` — V4 candidate dependency delta for Extension Stack.

## Authority Model

```text
Architecture
    ↓
Requirements
    ↓
Acceptance Criteria
    ↓
Work Items
    ↓
Dependency Graph
    ↓
Work Order
    ↓
Implementation
    ↓
Verification
    ↓
Architect Review
```

The specification layer does not replace repository truth. It governs how repository changes become accepted architectural state.
