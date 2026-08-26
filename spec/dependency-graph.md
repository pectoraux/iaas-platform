# IAAS Dependency Graph

## Initial Graph

```text
WORK-001 -> WORK-002
```

WORK-001 has no dependencies and was the first eligible Work Item. WORK-001 is VERIFIED. WORK-002 depends on `WORK-001`; that dependency is satisfied, so WORK-002 is eligible (released by the Architect after WORK-001 verification).

A Work Item is eligible only when its architecture version is valid, all dependencies exist and are VERIFIED, acceptance/verification data is complete, no unresolved architecture change blocks it, and it has at most one active implementation PR.

The graph MUST be acyclic. The detailed domain primitive DAG is derived from `IAAS-DOM-ARCH-1` by WORK-002 (see `spec/domain-dependency-graph.md`), not from a guessed chronological roadmap.
