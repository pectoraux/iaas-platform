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
```

WORK-001 is VERIFIED. WORK-002 through WORK-012 are VERIFIED. WORK-013 depends on WORK-012; that dependency is satisfied, so WORK-013 is READY and has been released by the Architect.

A Work Item is eligible only when its architecture version is valid, all dependencies exist and are VERIFIED, acceptance/verification data is complete, no unresolved architecture change blocks it, and it has at most one active implementation PR.

The graph MUST be acyclic. Domain primitive dependencies are maintained separately from the Work Item graph.

`WORK-003` is governed by `IAAS-DOM-ARCH-2` and ACR-001 while its Work Item governing authority remains `IAAS-GOV-ARCH-1`.

`WORK-004`, `WORK-005`, `WORK-006`, `WORK-007`, and `WORK-008` are governed by `IAAS-DOM-ARCH-2` while their Work Item governing authority remains `IAAS-GOV-ARCH-1`.

`WORK-009`, `WORK-010`, `WORK-011`, `WORK-012`, and `WORK-013` are governed by `IAAS-DOM-ARCH-3` while their Work Item governing authority remains `IAAS-GOV-ARCH-1`.

WORK-001 is VERIFIED, which is the eligibility/release condition for WORK-002; the same verified-dependency rule applies transitively to subsequent Work Items.
