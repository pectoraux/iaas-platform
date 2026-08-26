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

## WORK-003 — VerifiedEvidenceContext Implementation

Status: `VERIFIED`

Architecture Version: `IAAS-GOV-ARCH-1`

Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)

Architecture Change Request: `ACR-001` (APPROVED)

Dependencies: `WORK-002`

Requirements: `DOM-013`; ACR-001; inherited V2 rules in `IAAS-DOM-ARCH-2`.

Objective: implement the frozen `VerifiedEvidenceContext` contract defined by `IAAS-DOM-ARCH-2`, replacing the implicit vertical-specific pre-validated-evidence convention with an explicit generic boundary.

Repository Scope: existing evidence/verification services, generic economic pipeline integration, VPP adapter integration, targeted tests, and governance-specification tests required to prove the V2 contract.

Architecture Constraints: `IAAS-DOM-ARCH-2` is FROZEN; `IAAS-GOV-ARCH-1` is FROZEN; do not create a kernel primitive; preserve durable Event/VerificationResult/Attestation as source of truth; preserve Data Plane ↔ Economic Pipeline independence; verticals may produce the context but generic code may not import vertical services.

Out of Scope: ledger redesign, new economic primitives, changes to the Data Plane, TransformRegistry/Runtime, Extension/Marketplace/SDK work, broad VPP refactor, schema redesign unrelated to the context contract, architecture-version changes.

Acceptance Criteria:

- `W003-AC01` immutable `VerifiedEvidenceContext` contract exists at the evidence/economic boundary.
- `W003-AC02` context references durable Event/Attestation identities and verification policy/version without duplicating durable payloads.
- `W003-AC03` generic Economic Pipeline accepts the context without importing any vertical service.
- `W003-AC04` VPP produces the context while retaining its domain-specific baseline/dispatch semantics.
- `W003-AC05` reconciliation validates context references and preserves existing stale/invalid-reference recovery behavior.
- `W003-AC06` context is not owned by the kernel and is not a ledger/accounting primitive.
- `W003-AC07` Data Plane ↔ Economic Pipeline independence remains intact and is mechanically regression-tested.
- `W003-AC08` PostgreSQL remains the durable source of truth; no SQLite or in-memory-only replacement is introduced.
- `W003-AC09` all implementation and regression tests pass, with objective evidence recorded.

Required Verification:

- static architecture/import checks;
- unit tests for context construction/immutability;
- PostgreSQL integration tests for durable-reference validation;
- VPP-to-context integration test;
- stale/invalid-reference recovery tests;
- Data Plane ↔ Economic Pipeline anti-dependency regression checks;
- CI evidence and PR diff inspection;
- independent Architect Review.

Definition of Done: implementation committed; W003 acceptance criteria objectively verified; CI evidence recorded; no architecture drift; PR merged; Work Item VERIFIED.

## WORK-004 — Runtime Registry Bootstrap Reliability

Status: `READY`

Architecture Version: `IAAS-GOV-ARCH-1`

Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)

Dependencies: `WORK-003`

Requirements: `BASE-001` through `BASE-003`; inherited runtime boundaries from `IAAS-DOM-ARCH-2`.

Objective: restore the implemented Runtime Registry contract so published NetworkVersion runtime kinds resolve through the intended bootstrap path.

Repository Scope: `src/lib/kernel/runtime/`, `src/lib/bootstrap/`, runtime initialization/registration entrypoints, targeted runtime-resolution/integration tests, and narrowly-scoped CI/test bootstrap configuration only if required by the existing architectural contract.

Architecture Constraints: frozen governance/domain architecture; preserve the three runtime kinds, runtime isolation, HybridRuntime bridge rule, singleton registry behavior, and vertical neutrality.

Out of Scope: runtime architecture redesign, new runtime kinds, Data Plane changes, Economic Pipeline changes, Prisma/schema redesign, unrelated baseline TypeScript fixes, new network features, WORK-005+.

Acceptance Criteria:

- `W004-AC01` infrastructure runtime resolves through the intended bootstrap path.
- `W004-AC02` protocol runtime resolves through the intended bootstrap path.
- `W004-AC03` registry stability/singleton behavior is preserved.
- `W004-AC04` frozen runtime architecture and isolation rules remain unchanged.
- `W004-AC05` Phase 5.1 runtime-resolution tests pass without weakening architectural expectations.
- `W004-AC06` dependent Phase 5.2/5.4, Phase 8B/8C, and VPP execution-invariant runtime-registration failures are eliminated.
- `W004-AC07` generic runtime code remains vertical-neutral.
- `W004-AC08` no persistence/Data Plane/Economic Pipeline redesign occurs.
- `W004-AC09` complete objective verification evidence is produced.

Required Verification:

- Phase 5.1 runtime-resolution tests;
- registry stability tests;
- dependent Phase 5.2/5.4, Phase 8B/8C, and VPP execution-invariant regressions;
- static runtime-isolation checks;
- CI evidence and exact diff inspection;
- independent Architect Review.

Definition of Done: runtime registration restored through the intended architecture; targeted failures eliminated; frozen architecture unchanged; CI evidence complete; PR merged; Work Item VERIFIED.
