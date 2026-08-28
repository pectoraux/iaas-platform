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
- `architecture-change-requests/ACR-005.md` — approved V6 architecture-completion baseline (APPROVED; V6 frozen via WORK-024).
- `verification.md` — evidence and verification protocol.
- `architecture-inventory-v6.md` — V6 architectural inventory and truth classification.
- `domain-architecture.md` — immutable Domain Architecture V1 (`IAAS-DOM-ARCH-1`, SUPERSEDED).
- `domain-architecture-v2.md` — immutable Domain Architecture V2 (`IAAS-DOM-ARCH-2`, SUPERSEDED).
- `domain-architecture-v3.md` — immutable Domain Architecture V3 (`IAAS-DOM-ARCH-3`, SUPERSEDED).
- `domain-architecture-v4.md` — immutable Domain Architecture V4 (`IAAS-DOM-ARCH-4`, SUPERSEDED).
- `domain-architecture-v5.md` — superseded immutable Domain Architecture V5 (`IAAS-DOM-ARCH-5`, FROZEN; superseded by V6).
- `domain-architecture-v6.md` — current canonical Domain Architecture V6 (`IAAS-DOM-ARCH-6`, FROZEN).
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

`IAAS-DOM-ARCH-6` is the current canonical frozen architecture on main (ACR-005 APPROVED; frozen by WORK-024). V6 production Work Items are released strictly according to `spec/dependency-graph-v6.md`; WORK-025 is the sole released item. `IAAS-DOM-ARCH-5` is superseded and immutable.

## V6 Validation Gate

The repository exposes `bun run v6:validate` and includes `tests/v6-architecture-completion.test.ts`. These checks are part of CI and validate frozen-state markers, historical V1-V5 immutability (git blob SHAs), V6 status, Work Item completeness, DAG acyclicity, forbidden dependency invariants, WorkflowOS exclusion, and the sole-READY release state. The freeze cannot rely on agent assertion alone.
