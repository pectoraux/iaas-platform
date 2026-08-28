# IAAS Specification System

This directory is the persistent planning and governance layer for IAAS implementation.

## Documents

- `architecture.md` — architecture-version index and domain-architecture authority map.
- `architecture-lock.md` — frozen governance rules, current V5 state, and V6 freeze gate.
- `requirements.md` — stable governance/baseline requirements.
- `work-items.md` — current V5-era implementation registry and lifecycle state.
- `work-items-v6.md` — candidate post-V6 implementation program.
- `dependency-graph.md` — current Work Item eligibility graph through WORK-022.
- `dependency-graph-v6.md` — candidate V6 implementation DAG.
- `work-order-template.md` — canonical implementation-agent handoff format.
- `architecture-change-request.md` — controlled architecture evolution protocol.
- `architecture-change-requests/ACR-001.md` — approved promotion of VerifiedEvidenceContext.
- `architecture-change-requests/ACR-002.md` — approved promotion of Transform Stack boundary.
- `architecture-change-requests/ACR-003.md` — approved promotion of Extension Stack boundary.
- `architecture-change-requests/ACR-004.md` — approved V5 WASI capability-sandbox contract.
- `architecture-change-requests/ACR-005.md` — V6 architecture-completion candidate under review.
- `verification.md` — evidence and verification protocol.
- `architecture-inventory-v6.md` — V6 architectural inventory and truth classification.
- `domain-architecture.md` — immutable Domain Architecture V1 (`IAAS-DOM-ARCH-1`, SUPERSEDED).
- `domain-architecture-v2.md` — immutable Domain Architecture V2 (`IAAS-DOM-ARCH-2`, SUPERSEDED).
- `domain-architecture-v3.md` — immutable Domain Architecture V3 (`IAAS-DOM-ARCH-3`, SUPERSEDED).
- `domain-architecture-v4.md` — immutable Domain Architecture V4 (`IAAS-DOM-ARCH-4`, SUPERSEDED).
- `domain-architecture-v5.md` — current canonical Domain Architecture V5 (`IAAS-DOM-ARCH-5`, FROZEN).
- `domain-architecture-v6.md` — candidate Domain Architecture V6 (`IAAS-DOM-ARCH-6`, UNDER REVIEW).
- `domain-requirements.md` — immutable V1 domain requirements.
- `domain-requirements-v2.md` — immutable V2 requirements.
- `domain-requirements-v3.md` — immutable V3 requirements.
- `domain-requirements-v4.md` — immutable V4 requirements.
- `domain-requirements-v6.md` — candidate V6 domain requirements.
- `domain-dependency-graph.md` — immutable V1 domain primitive DAG.
- `domain-dependency-graph-v2.md` — immutable V2 dependency delta.
- `domain-dependency-graph-v3.md` — immutable V3 dependency delta.
- `domain-dependency-graph-v4.md` — immutable V4 dependency delta.
- `domain-dependency-graph-v6.md` — candidate V6 domain primitive DAG.

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

## V6 Status

`IAAS-DOM-ARCH-5` remains the current frozen architecture on main. `IAAS-DOM-ARCH-6` is a candidate under ACR-005 and is not yet an implementation authority. No V6 production Work Item may become READY until the V6 freeze gate passes.
