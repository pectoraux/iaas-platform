# IAAS Work Items

## Work Item Schema

Every Work Item MUST define:

- Work ID
- Objective
- Governing Architecture Version
- Requirements
- Acceptance Criteria
- Dependencies
- Architecture Constraints
- Repository Scope
- Out of Scope
- Required Verification
- Definition of Done

## Workflow State Machine

```text
DRAFT
  -> READY
  -> ASSIGNED
  -> IMPLEMENTING
  -> PR_OPEN
  -> VERIFYING
  -> ARCHITECT_REVIEW
  -> MERGED
  -> VERIFIED
```

Correction paths:

```text
VERIFYING -> VERIFICATION_FAILED -> IMPLEMENTING
ARCHITECT_REVIEW -> REQUEST_CHANGES -> IMPLEMENTING
ARCHITECT_REVIEW -> ARCHITECTURE_CHANGE_REQUIRED -> ARCHITECTURE_CHANGE_REQUEST
ARCHITECT_REVIEW -> IMPLEMENTATION_BLOCKED -> IMPLEMENTING
```

`VERIFIED` is the only state that makes a Work Item a satisfied dependency.

## WORK-001 — WorkflowOS Specification and Governance Foundation

Status: `READY`

Objective:

Establish the persistent IAAS governance layer for architecture versions, requirements, acceptance criteria, Work Items, dependencies, evidence-based verification, and architect review without changing IAAS production behavior.

Governing Architecture Version: `IAAS-GOV-ARCH-1`

Requirements:

- GOV-001
- GOV-002
- GOV-003
- GOV-004
- GOV-005
- GOV-006
- GOV-007
- GOV-008

Dependencies: none

Repository Scope:

- `spec/`
- governance documentation needed to make the specification self-consistent

Out of Scope:

- IAAS domain feature implementation
- Node/Data Plane/Routing/Transport changes
- schema/data migrations
- runtime behavior changes
- vertical network implementation
- Domain Architecture V1

Required Verification:

- specification consistency validation
- dependency graph validation
- repository diff inspection
- architect review

Acceptance Criteria:

- `W001-AC01`: one frozen governance architecture version exists.
- `W001-AC02`: every Work Item references exactly one architecture version.
- `W001-AC03`: every Work Item declares requirements and objective acceptance criteria.
- `W001-AC04`: every Work Item declares dependencies and out-of-scope boundaries.
- `W001-AC05`: architecture changes require an explicit Architecture Change Request.
- `W001-AC06`: agent assertions cannot mark acceptance criteria PASS.
- `W001-AC07`: verification evidence is mapped to acceptance criteria.
- `W001-AC08`: Architect Review is separate from Verification.
- `W001-AC09`: only one active implementation PR is allowed per Work Item.
- `W001-AC10`: dependency graph contains no unresolved or circular dependencies.
- `W001-AC11`: repository truth classification supports OBSERVED, INFERRED, CONFIRMED, PROPOSED.
- `W001-AC12`: the next Work Item is dependency-derived, not selected by the implementation agent.
- `W001-AC13`: no IAAS production code is changed by WORK-001.

Definition of Done:

- governance specification committed on the WORK-001 branch
- consistency checks pass
- no production implementation changes are present
- architect review approves the governance foundation
- PR merged
- Work Item marked `VERIFIED`

## WORK-002 — Repository Baseline and Domain Architecture V1

Status: `BLOCKED` until WORK-001 is `VERIFIED`

Objective:

Audit the existing repository and reconcile the current constitutional architecture, Phase 13R reconciliation, Phase 14 contracts, source code, schemas, tests, CI, and implementation history into a canonical Domain Architecture Version 1 and truth-classified repository baseline.

Governing Architecture Version: `IAAS-GOV-ARCH-1`

Dependencies: `WORK-001`

Required Deliverables:

- `docs/architecture/REPOSITORY-BASELINE.md`
- canonical `IAAS-DOM-ARCH-1`
- domain requirements derived from the reconciled architecture
- domain dependency graph

Out of Scope:

- broad refactor
- feature expansion not required to reconcile the baseline
- implementing future architecture

Acceptance Criteria:

- every major architectural claim has an evidence classification
- existing architecture documents are mapped into the canonical architecture
- conflicts are explicitly resolved or become Architecture Change Requests
- existing implementations are not upgraded from evidence to intent without confirmation
- the resulting domain architecture is coherent, versioned, and frozen before downstream implementation resumes
