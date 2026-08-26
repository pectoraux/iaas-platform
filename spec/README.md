# IAAS Specification System

This directory is the persistent planning and governance layer for IAAS implementation.

## Current Canonical State

- Governance Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Domain Architecture: `IAAS-DOM-ARCH-4` (FROZEN)
- Approved ACR: `ACR-003`
- `IAAS-DOM-ARCH-3`: immutable historical architecture
- `DOM-P04`: superseded in current V4 by `DOM-018..DOM-022`
- `DOM-P05..DOM-P08`: FUTURE/OPEN/RESEARCH

## Core Documents

- `architecture.md` — architecture version index and current canonical domain architecture.
- `architecture-lock.md` — frozen architecture rules and workflow invariants.
- `requirements.md` — governance requirements and acceptance criteria.
- `work-items.md` — bounded Work Items and lifecycle.
- `dependency-graph.md` — Work Item eligibility/dependency graph.
- `work-order-template.md` — implementation-agent handoff format.
- `architecture-change-request.md` — architecture evolution protocol.
- `architecture-change-requests/ACR-001.md` — approved V2 promotion.
- `architecture-change-requests/ACR-002.md` — approved V3 promotion.
- `architecture-change-requests/ACR-003.md` — approved V4 promotion.
- `verification.md` — objective evidence protocol.
- `domain-architecture-v3.md` — immutable V3 historical architecture.
- `domain-architecture-v4.md` — current canonical V4 architecture.
- `domain-requirements-v4.md` — current V4 requirements.
- `domain-dependency-graph-v4.md` — current V4 dependency delta.

## Authority Chain

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
