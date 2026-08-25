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

Status: `READY`

Architecture Version: `IAAS-GOV-ARCH-1`

Dependencies: none

Objective: establish persistent governance/specification without changing IAAS production behavior.

Scope: `spec/` governance documents and their executable consistency gate.

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

Status: `BLOCKED` until WORK-001 is VERIFIED.

Architecture Version: `IAAS-GOV-ARCH-1`

Dependencies: `WORK-001`

Objective: audit architecture documents, code, schema, tests, CI, and history into a truth-classified repository baseline and canonical `IAAS-DOM-ARCH-1`.

Required deliverables: `docs/architecture/REPOSITORY-BASELINE.md`, canonical Domain Architecture V1, domain requirements, domain dependency graph.

Out of Scope: broad refactors, unrelated feature expansion, and future-feature implementation.
