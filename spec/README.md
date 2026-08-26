# IAAS Specification System

This directory is the persistent planning and governance layer for IAAS implementation.

## Documents

- `architecture.md` — architecture-version index and current canonical domain architecture.
- `architecture-lock.md` — frozen architecture rules and workflow invariants.
- `requirements.md` — governance requirements and acceptance criteria.
- `work-items.md` — bounded implementation units and lifecycle.
- `dependency-graph.md` — Work Item eligibility/dependency graph.
- `work-order-template.md` — canonical implementation-agent handoff format.
- `architecture-change-request.md` — controlled architecture evolution protocol.
- `architecture-change-requests/ACR-001.md` — approved VerifiedEvidenceContext promotion.
- `architecture-change-requests/ACR-002.md` — approved Transform Stack promotion.
- `architecture-change-requests/ACR-003.md` — approved Extension Stack promotion / V4 freeze.
- `verification.md` — evidence and verification protocol.
- `domain-architecture.md` — immutable Domain Architecture V1 (SUPERSEDED).
- `domain-architecture-v2.md` — immutable Domain Architecture V2 (SUPERSEDED).
- `domain-architecture-v3.md` — immutable Domain Architecture V3 (SUPERSEDED historical record).
- `domain-architecture-v4.md` — current canonical Domain Architecture V4 (FROZEN).
- `domain-requirements.md` — V1 domain requirements.
- `domain-requirements-v2.md` — V2 domain requirements.
- `domain-requirements-v3.md` — V3 domain requirements.
- `domain-requirements-v4.md` — current V4 domain requirements.
- `domain-dependency-graph.md` — V1 domain primitive dependency DAG.
- `domain-dependency-graph-v2.md` — V2 dependency delta.
- `domain-dependency-graph-v3.md` — V3 dependency delta.
- `domain-dependency-graph-v4.md` — current V4 Extension Stack dependency delta.

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
