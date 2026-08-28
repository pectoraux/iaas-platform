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
WORK-021 -> WORK-022
```

WORK-001 through WORK-021 are VERIFIED in dependency order. `IAAS-DOM-ARCH-5` is the current frozen domain architecture. WORK-022 is defined and was released as READY on main, but the architecture-completion mandate places WORK-022 under an explicit implementation hold in the V6 candidate branch: it MUST NOT be implemented while ACR-005 / V6 architecture completion is under review.

A Work Item is eligible only when its architecture version is valid, all dependencies exist and are VERIFIED, acceptance/verification data is complete, no unresolved architecture change blocks it, and it has at most one active implementation PR. The architecture-completion gate is an explicit additional hold on implementation release while V6 is under review.

The graph MUST be acyclic. Domain primitive dependencies are maintained separately from the Work Item graph.

WORK-003 through WORK-008 were governed by IAAS-DOM-ARCH-2; WORK-009 through WORK-014 by IAAS-DOM-ARCH-3; WORK-015 through WORK-020 by the then-current V4/V5 architecture transitions; WORK-021 and WORK-022 are governed by the frozen V5 sandbox contract.

WORK-016 is the verified ExtensionRegistry slice. WORK-017 is the verified ExtensionRuntime slice. WORK-018 is the verified durable ExtensionProvenance slice. WORK-019 is the verified sandbox architecture decision. WORK-020 is the verified V5 freeze/promotion slice. WORK-021 is the verified WASI Sandbox Host Foundation implementation slice. WORK-022 is the sandbox lifecycle completion slice (V5 §2.5: deactivation terminates active execution contexts; installation validates without execution).

## V6 Transition Rule

The current V5 graph remains historical/current-state evidence. The candidate post-V6 implementation graph is maintained in `spec/dependency-graph-v6.md` and `spec/work-items-v6.md`.

No production Work Item is eligible from the V6 candidate graph until `WORK-024` completes the V6 freeze gate and `IAAS-DOM-ARCH-6` is FROZEN.
