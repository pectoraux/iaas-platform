# IAAS Work Items

## Schema

Every Work Item MUST define: Work ID, Objective, Governing Architecture Version, Requirements, Acceptance Criteria, Dependencies, Architecture Constraints, Repository Scope, Out of Scope, Required Verification, Definition of Done.

## Lifecycle

```text
DRAFT -> READY -> ASSIGNED -> IMPLEMENTING -> PR_OPEN -> VERIFYING -> ARCHITECT_REVIEW -> MERGED -> VERIFIED
VERIFYING -> VERIFICATION_FAILED -> IMPLEMENTING
ARCHITECT_REVIEW -> REQUEST_CHANGES -> IMPLEMENTING
ARCHITECT_REVIEW -> ARCHITECTURE_CHANGE_REQUIRED -> ARCHITECTURE_CHANGE_REQUEST
ARCHITECT_REVIEW -> IMPLEMENTATION_BLOCKED -> IMPLEMENTING
```

## WORK-001 — WorkflowOS Specification and Governance Foundation

Status: `VERIFIED`

Architecture Version: `IAAS-GOV-ARCH-1`

Dependencies: none

Requirements: `GOV-001` through `GOV-008`; acceptance criteria `W001-AC01` through `W001-AC13`.

Objective: establish persistent governance/specification without changing IAAS production behavior.

Repository Scope: `spec/` governance documents and their executable consistency gate.

Architecture Constraints: frozen governance architecture `IAAS-GOV-ARCH-1` (no change without an approved ACR); no IAAS production implementation; no domain architecture creation (pending WORK-002).

Out of Scope: domain feature implementation, migrations, runtime changes, vertical networks, Domain Architecture V1.

Acceptance Criteria:

- `W001-AC01` frozen governance architecture exists.
- `W001-AC02` every Work Item names exactly one architecture version.
- `W001-AC03` requirements and objective ACs are explicit.
- `W001-AC04` dependencies and out-of-scope boundaries are explicit.
- `W001-AC05` architecture changes require an ACR.
- `W001-AC06` agent claims cannot establish PASS.
- `W001-AC07` verification evidence maps to ACs.
- `W001-AC08` Architect Review is distinct from Verification.
- `W001-AC09` max one active implementation PR per Work Item.
- `W001-AC10` dependency graph has no unresolved/circular dependencies.
- `W001-AC11` truth classification supports OBSERVED/INFERRED/CONFIRMED/PROPOSED.
- `W001-AC12` next Work Item is dependency-derived.
- `W001-AC13` no IAAS production code changes in WORK-001.

Required Verification:

- repository specification inspection against every W001 acceptance criterion;
- automated specification consistency check covering required documents, stable IDs, architecture-version references, dependency resolution, and forbidden WORK-001 production-scope changes;
- negative tests proving the validator rejects representative specification inconsistencies;
- CI execution of the consistency check;
- PR diff inspection confirming only governance/specification artifacts changed;
- independent Architect Review after verification evidence is available.

Definition of Done: specification committed; automated consistency checks pass; negative tests pass; CI records the pass; production diff is empty; architect approves; PR merged; Work Item VERIFIED.

## WORK-002 — Repository Baseline and Domain Architecture V1

Status: `VERIFIED`

Architecture Version: `IAAS-GOV-ARCH-1`

Dependencies: `WORK-001`

Requirements: truth-classified repository baseline covering architecture documents, code, schema, tests, CI, and history; deliverables `docs/architecture/REPOSITORY-BASELINE.md`, canonical Domain Architecture V1, domain requirements, domain dependency graph.

Objective: audit architecture documents, code, schema, tests, CI, and history into a truth-classified repository baseline and canonical `IAAS-DOM-ARCH-1`.

Repository Scope: `docs/architecture/` baseline documents and the `spec/` domain architecture layer, as authorized by the WORK-002 Work Order.

Architecture Constraints: frozen governance architecture `IAAS-GOV-ARCH-1` governs all changes; the domain architecture is derived only from the verified repository baseline; domain architecture changes require an approved ACR and a new version.

Out of Scope: broad refactors, unrelated feature expansion, and future-feature implementation.

Acceptance Criteria:

- `W002-AC01` repository baseline exists and is truth-classified.
- `W002-AC02` canonical `IAAS-DOM-ARCH-1` is published and registered.
- `W002-AC03` domain requirements and domain dependency graph exist.
- `W002-AC04` no scope beyond the repository baseline audit and domain architecture V1.

Required Verification: repository baseline inspection against truth classifications; automated specification consistency validation; independent Architect Review after WORK-001 is VERIFIED.

Definition of Done: repository baseline committed; canonical domain architecture approved by the Architect; domain requirements and dependency graph committed; Work Item VERIFIED.
