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
WORK-018 -> WORK-019
WORK-019 -> WORK-020
WORK-020 -> WORK-021
```

WORK-001 through WORK-020 are VERIFIED in dependency order. `IAAS-DOM-ARCH-4` remains immutable historical architecture and `IAAS-DOM-ARCH-5` is the current frozen domain architecture. WORK-020 is VERIFIED after approved ACR-004 and V5 freeze. WORK-021 depends on WORK-020; that dependency is satisfied, so WORK-021 is READY and is the only eligible implementation Work Item.

A Work Item is eligible only when its architecture version is valid, all dependencies exist and are VERIFIED, acceptance/verification data is complete, no unresolved architecture change blocks it, and it has at most one active implementation PR.

The graph MUST be acyclic. Domain primitive dependencies are maintained separately from the Work Item graph.

WORK-003 through WORK-008 were governed by IAAS-DOM-ARCH-2; WORK-009 through WORK-014 by IAAS-DOM-ARCH-3; WORK-015 through WORK-019 by IAAS-DOM-ARCH-4; WORK-020 through subsequent sandbox implementation Work Items are governed by IAAS-DOM-ARCH-5.

WORK-016 is the verified ExtensionRegistry slice. WORK-017 is the verified ExtensionRuntime slice. WORK-018 is the verified durable ExtensionProvenance slice. WORK-019 is the verified sandbox architecture decision. WORK-020 is the verified V5 freeze/promotion slice. WORK-021 is the WASI Sandbox Host Foundation implementation slice.
