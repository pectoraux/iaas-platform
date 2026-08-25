# IAAS Dependency Graph

## Initial Graph

```text
WORK-001 -> WORK-002
```

WORK-001 has no dependencies and is the only initially eligible Work Item. WORK-002 is blocked until WORK-001 is VERIFIED.

A Work Item is eligible only when its architecture version is valid, all dependencies exist and are VERIFIED, acceptance/verification data is complete, no unresolved architecture change blocks it, and it has at most one active implementation PR.

The graph MUST be acyclic. The detailed domain DAG will be derived from `IAAS-DOM-ARCH-1` by WORK-002, not from a guessed chronological roadmap.
