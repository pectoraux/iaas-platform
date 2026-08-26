# IAAS Specification System

This directory is the persistent planning and governance layer for IAAS implementation.

## Documents

- `architecture.md` — architecture-version index and domain-architecture authority map.
- `architecture-lock.md` — frozen governance rules and workflow invariants.
- `requirements.md` — stable requirements and acceptance criteria.
- `work-items.md` — bounded implementation units and lifecycle.
- `dependency-graph.md` — eligibility and dependency graph.
- `work-order-template.md` — canonical implementation-agent handoff format.
- `architecture-change-request.md` — controlled architecture evolution protocol.
- `verification.md` — evidence and verification protocol.
- `domain-architecture.md` — canonical Domain Architecture V1 (`IAAS-DOM-ARCH-1`, FROZEN).
- `domain-requirements.md` — domain requirements derived from `IAAS-DOM-ARCH-1`.
- `domain-dependency-graph.md` — domain primitive dependency DAG derived from `IAAS-DOM-ARCH-1`.

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
