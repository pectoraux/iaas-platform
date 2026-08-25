# IAAS Dependency Graph

## Governance Graph

```text
WORK-001
  |
  v
WORK-002
```

`WORK-001` has no dependencies and is the only Work Item eligible for initial execution.

`WORK-002` MUST NOT become `READY`, `ASSIGNED`, or `IMPLEMENTING` until WORK-001 reaches `VERIFIED`.

## Eligibility Rule

A Work Item is eligible only when:

1. its governing architecture version is identified and valid;
2. every declared dependency exists;
3. every declared dependency is `VERIFIED`;
4. its acceptance criteria and verification requirements are complete;
5. it has no unresolved architecture-change prerequisite;
6. it has at most one active implementation PR.

## Cycle Rule

The dependency graph MUST be acyclic. A Work Item may not depend on itself directly or indirectly.

## Future Domain Graph

The detailed IAAS domain implementation graph is intentionally NOT frozen by WORK-001. It will be derived from `IAAS-DOM-ARCH-1` in WORK-002 rather than copied from a guessed chronological roadmap.

Candidate domains to be ordered after WORK-002 include:

```text
Identity / Tenancy
      -> Resources / Capabilities
      -> Networks / Memberships
      -> Allocation / Commitment / Reservation
      -> Execution / Lease / Fencing
      -> Runtime families
      -> Node
      -> Bundle / Data Plane
      -> Routing
      -> Transport
      -> Delivery Confirmation
      -> Verification / Evidence
      -> Economics
      -> Workflow / Orchestration
      -> Ownership / Entitlements
      -> Network Launch / Network-as-Code
      -> Extensions / Adapters
      -> Reference Networks
```

This is a domain decomposition hint only. WORK-002 must derive the actual DAG from evidence and architecture contracts.
