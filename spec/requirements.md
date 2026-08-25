# IAAS Requirements

## GOV-001 — Frozen Architecture

Every Work Item MUST identify one governing architecture version; frozen versions MUST NOT be edited in place.

Acceptance: `GOV-001-AC01` frozen governance version exists; `AC02` every Work Item names one version; `AC03` domain changes require ACR/new version.

## GOV-002 — Traceable Work Items

Every Work Item MUST define requirements, acceptance criteria, dependencies, scope, verification, and Definition of Done.

Acceptance: mandatory fields present; ACs link to a Work Item; dependencies resolve and graph is acyclic.

## GOV-003 — Evidence-Based Verification

Acceptance MUST use objective evidence. Agent narrative alone cannot establish PASS.

Acceptance: criteria specify evidence; verification records concrete evidence; review does not replace verification.

## GOV-004 — Separate Verification and Architect Review

Verification tests behavioral satisfaction; Architect Review tests architectural and scope compliance.

Acceptance: both are separate workflow decisions; an implementation can pass verification and still receive REQUEST_CHANGES; architecture insufficiency routes to ACR.

## GOV-005 — Single Active PR

Each Work Item MUST have no more than one active implementation PR.

## GOV-006 — Truth Classification

Repository discoveries MUST distinguish `OBSERVED`, `INFERRED`, `CONFIRMED`, and `PROPOSED` and preserve evidence sources.

## GOV-007 — Scope Containment

The implementation agent MUST stay within the Work Order and stop on architecture ambiguity, missing prerequisites, contradictions, or architecture-change requirements.

## GOV-008 — Dependency Eligibility

Only Work Items whose dependencies are VERIFIED may become implementation-eligible.

## WORK-001 Freeze

No production IAAS feature is authorized by these requirements. Domain requirements are derived by WORK-002 after baseline audit.
