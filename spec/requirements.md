# IAAS Requirements

## Requirement Schema

Every requirement has:

- Stable ID
- Title
- Description
- Governing architecture version
- Dependencies
- Verification requirements
- Acceptance criteria

## Governance Requirements

### GOV-001 — Frozen Architecture

A governing architecture version MUST be explicitly identified for every Work Item. Frozen versions MUST NOT be edited in place.

Acceptance Criteria:

- `GOV-001-AC01`: The repository identifies `IAAS-GOV-ARCH-1` as the frozen governance architecture.
- `GOV-001-AC02`: Every Work Item declares exactly one architecture version.
- `GOV-001-AC03`: Domain architecture changes are represented by a new version/change request rather than silent mutation.

Evidence: repository specification inspection and static consistency checks.

### GOV-002 — Traceable Work Items

Every implementation Work Item MUST trace to requirements, acceptance criteria, dependencies, scope boundaries, verification evidence, and a Definition of Done.

Acceptance Criteria:

- `GOV-002-AC01`: Work Item records contain all mandatory fields.
- `GOV-002-AC02`: Every acceptance criterion is linked to its parent Work Item.
- `GOV-002-AC03`: Every dependency resolves to an existing Work Item.
- `GOV-002-AC04`: The dependency graph is acyclic.

Evidence: specification validator and dependency graph inspection.

### GOV-003 — Evidence-Based Verification

Acceptance cannot be based solely on an implementation agent's claim. Each acceptance criterion MUST identify objective evidence and its evaluation result.

Acceptance Criteria:

- `GOV-003-AC01`: Acceptance criteria declare an evidence type.
- `GOV-003-AC02`: Verification records reference concrete evidence.
- `GOV-003-AC03`: Architect Review cannot substitute for verification evidence.

Evidence: specification validator and review records.

### GOV-004 — Distinct Verification and Architecture Review

Verification MUST answer whether behavior satisfies acceptance criteria. Architect Review MUST separately answer whether the implementation conforms to the governing architecture and scope.

Acceptance Criteria:

- `GOV-004-AC01`: Workflow models Verification and Architect Review as separate states/decisions.
- `GOV-004-AC02`: A technically passing implementation may still receive `REQUEST_CHANGES`.
- `GOV-004-AC03`: Architecture insufficiency routes through Architecture Change Request.

Evidence: workflow contract and review records.

### GOV-005 — Single Active PR

A Work Item MUST have no more than one active implementation PR.

Acceptance Criteria:

- `GOV-005-AC01`: Work Item records can identify the active implementation PR.
- `GOV-005-AC02`: Historical PRs remain traceable without becoming competing active implementations.

Evidence: repository/PR inspection and future workflow enforcement.

### GOV-006 — Truth Classification

Repository discoveries MUST preserve the distinction between `OBSERVED`, `INFERRED`, `CONFIRMED`, and `PROPOSED`.

Acceptance Criteria:

- `GOV-006-AC01`: Baseline records support all four classifications.
- `GOV-006-AC02`: Every non-obvious architectural claim can cite its evidence source.
- `GOV-006-AC03`: Proposed design cannot be represented as historical fact without an explicit confirmation event.

Evidence: WORK-002 baseline audit.

### GOV-007 — Scope Containment

An implementation agent MUST implement only the bounded Work Order and must stop when architecture ambiguity, prerequisite failure, requirement contradiction, or architecture change is required.

Acceptance Criteria:

- `GOV-007-AC01`: Work Orders contain explicit out-of-scope boundaries.
- `GOV-007-AC02`: Stop conditions are documented.
- `GOV-007-AC03`: Scope expansion requires a new Work Item or approved architecture change.

Evidence: Work Order records and architect review.

### GOV-008 — Dependency Eligibility

Only Work Items whose declared dependencies are `VERIFIED` may become implementation-eligible.

Acceptance Criteria:

- `GOV-008-AC01`: Dependency graph has no unresolved dependencies.
- `GOV-008-AC02`: Circular dependencies are rejected.
- `GOV-008-AC03`: Eligibility is derived from dependency state rather than a manually chosen milestone order.

Evidence: dependency validator.

## Implementation Freeze for WORK-001

No production IAAS feature is authorized by these governance requirements. Domain requirements will be derived by WORK-002 after the repository baseline audit.
