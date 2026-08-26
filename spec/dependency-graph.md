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
WORK-014 -> WORK-015
WORK-015 -> WORK-016
WORK-016 -> WORK-017
WORK-017 -> WORK-018
```

WORK-001 is VERIFIED. WORK-001 through WORK-017 are VERIFIED in dependency order. `IAAS-DOM-ARCH-4` is the current frozen domain architecture. WORK-018 depends on WORK-017; that dependency is satisfied, so WORK-018 is READY and is the only eligible implementation Work Item.

A Work Item is eligible only when its architecture version is valid, all dependencies exist and are VERIFIED, acceptance/verification data is complete, no unresolved architecture change blocks it, and it has at most one active implementation PR.

The graph MUST be acyclic. Domain primitive dependencies are maintained separately from the Work Item graph.

WORK-003 through WORK-008 were governed by IAAS-DOM-ARCH-2; WORK-009 through WORK-014 by IAAS-DOM-ARCH-3; WORK-015 through WORK-018 are governed by frozen IAAS-DOM-ARCH-4. Work Item governance authority remains IAAS-GOV-ARCH-1.

WORK-016 is the verified ExtensionRegistry production slice. WORK-017 is the verified ExtensionRuntime production slice. WORK-018 is the durable ExtensionProvenance persistence slice and is released only against `spec/work-orders/WORK-018.md`.
