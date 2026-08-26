# IAAS Dependency Graph

## Current Graph

```text
WORK-001 -> WORK-002
WORK-002 -> WORK-003
WORK-003 -> WORK-004
WORK-004 -> WORK-005
WORK-005 -> WORK-006
WORK-006 -> WORK-007
WORK-007 -> WORK-008
WORK-008 -> WORK-009
WORK-009 -> WORK-010
WORK-010 -> WORK-011
WORK-011 -> WORK-012
WORK-012 -> WORK-013
WORK-013 -> WORK-014
```

WORK-001 through WORK-013 are VERIFIED. WORK-014 depends on WORK-013; that dependency is satisfied, so WORK-014 is READY and has been released by the Architect.

A Work Item is eligible only when its architecture version is valid, all dependencies exist and are VERIFIED, acceptance/verification data is complete, no unresolved architecture change blocks it, and it has at most one active implementation PR.

The graph MUST be acyclic. Domain primitive dependencies are maintained separately from the Work Item graph.

`WORK-003` is governed by `IAAS-DOM-ARCH-2` and ACR-001 while its Work Item governing authority remains `IAAS-GOV-ARCH-1`.

`WORK-004`, `WORK-005`, `WORK-006`, `WORK-007`, and `WORK-008` are governed by `IAAS-DOM-ARCH-2` while their Work Item governing authority remains `IAAS-GOV-ARCH-1`.

`WORK-009`, `WORK-010`, `WORK-011`, `WORK-012`, and `WORK-013` are governed by `IAAS-DOM-ARCH-3` while their Work Item governing authority remains `IAAS-GOV-ARCH-1`.

`WORK-014` is a governance/architecture-change Work Item under `IAAS-GOV-ARCH-1`; it proposes `IAAS-DOM-ARCH-4` through `ACR-003`. V3 remains FROZEN until that ACR is explicitly approved and the new domain architecture is frozen.

WORK-001 is VERIFIED, which is the eligibility/release condition for WORK-002; the same verified-dependency rule applies transitively to subsequent Work Items.
