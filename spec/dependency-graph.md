# IAAS Dependency Graph

## Current Graph

```text
WORK-001 -> WORK-002
WORK-002 -> WORK-003
WORK-003 -> WORK-004
WORK-004 -> WORK-005
WORK-005 -> WORK-006
```

WORK-001 is VERIFIED. WORK-002 is VERIFIED. WORK-003 is VERIFIED. WORK-004 is VERIFIED. WORK-005 is VERIFIED. WORK-006 depends on WORK-005; that dependency is satisfied, so WORK-006 is eligible and has been released by the Architect.

A Work Item is eligible only when its architecture version is valid, all dependencies exist and are VERIFIED, acceptance/verification data is complete, no unresolved architecture change blocks it, and it has at most one active implementation PR.

The graph MUST be acyclic. Domain primitive dependencies are maintained separately from the Work Item graph.

`WORK-003` is governed by `IAAS-DOM-ARCH-2` and ACR-001 while its Work Item governing authority remains `IAAS-GOV-ARCH-1`.

`WORK-004`, `WORK-005`, and `WORK-006` are governed by `IAAS-DOM-ARCH-2` while their Work Item governing authority remains `IAAS-GOV-ARCH-1`.
