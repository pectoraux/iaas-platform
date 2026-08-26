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

Status: `VERIFIED`

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

## WORK-005 — Integration Test Fixture and Prerequisite Reliability

Status: `VERIFIED`

Architecture Version: `IAAS-GOV-ARCH-1`

Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)

Dependencies: `WORK-004`

Requirements: `BASE-004` through `BASE-006`; inherited PostgreSQL, tenant-isolation, generic Execution, and runtime boundaries from `IAAS-DOM-ARCH-2`.

Objective: restore the remaining PostgreSQL integration-test baseline by making tenant-scoped operator/asset/device/capability prerequisites explicit and deterministic in the affected tests, without changing IAAS production behavior or architecture.

Repository Scope: affected PostgreSQL integration tests under `tests/`, existing test fixture utilities/helpers under `tests/` only if a deterministic shared helper is warranted, targeted CI test selection, WORK-005 evidence, and governance/specification tests required by the new Work Item.

Architecture Constraints: `IAAS-GOV-ARCH-1` and `IAAS-DOM-ARCH-2` remain FROZEN; PostgreSQL remains canonical; tenant isolation is mandatory; no production auto-fixture behavior; RuntimeRegistry bootstrap semantics remain unchanged; no Data Plane/Economic Pipeline/ledger/runtime-boundary changes.

Out of Scope: production changes merely to satisfy tests, global fixture redesign without evidence, new persistence abstractions, Prisma/schema changes without Architect escalation, unrelated TypeScript/architecture-contract failures, new network features, WORK-006+, frozen architecture changes.

Acceptance Criteria:

- `W005-AC01` every affected integration test explicitly establishes the operator/asset/device/capability prerequisites it consumes or uses a deterministic helper.
- `W005-AC02` affected PostgreSQL integration tests pass from a clean database without relying on execution order or another test file's records.
- `W005-AC03` no production IAAS service is changed solely to compensate for missing test fixtures.
- `W005-AC04` tenant-scoped fixture isolation is mechanically tested.
- `W005-AC05` runtime/execution/capacity/economic/Data Plane/vertical boundaries remain unchanged.
- `W005-AC06` the residual operator+asset setup-failure class identified after WORK-004 is eliminated for affected tests.
- `W005-AC07` unrelated pre-existing failures remain explicitly classified and untouched.
- `W005-AC08` complete objective evidence is produced.

Required Verification:

- affected Phase 5.2/5.4 PostgreSQL tests;
- affected Phase 8B/8C PostgreSQL tests;
- explicit tenant-isolation regression test;
- clean-database/no-cross-file-fixture evidence;
- governance validator;
- exact diff/scope inspection;
- independent Architect Review.

Definition of Done: affected tests establish prerequisites deterministically; residual fixture failures are eliminated; tenant isolation is regression-tested; no production behavior or frozen architecture changes; targeted CI passes; evidence complete; PR merged; Work Item VERIFIED.

## WORK-006 — Baseline Typecheck and Architecture Contract Recovery

Status: `VERIFIED`

Architecture Version: `IAAS-GOV-ARCH-1`

Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)

Dependencies: `WORK-005`

Requirements: `BASE-007` through `BASE-010`; inherited architecture/runtime/economic/Data Plane boundaries.

Objective: eliminate the remaining Typecheck and Architecture Contract Test failures on the verified baseline without redesigning IAAS architecture.

Repository Scope: `src/` only where a real compiler/type/architecture defect is demonstrated; `tests/architecture-contract.test.ts` and directly related tests when assertions are stale; targeted regression tests; targeted CI/configuration; WORK-006 evidence; governance test updates required only because WORK-006 is issued.

Architecture Constraints: frozen `IAAS-GOV-ARCH-1` and `IAAS-DOM-ARCH-2`; preserve InfrastructureRuntime / ProtocolRuntime / HybridRuntime boundaries; preserve Data Plane ↔ Economic Pipeline independence; generic kernel/runtime code remains vertical-neutral; PostgreSQL remains canonical.

Out of Scope: new domain primitives/network features; runtime/economic/data-plane/transform/extension/marketplace/SDK redesign; Prisma schema changes without escalation; broad refactoring; `any`/`@ts-ignore`/compiler suppression; frozen architecture changes; WORK-007+.

Acceptance Criteria:

- `W006-AC01` clean-main TypeScript failures are captured, classified, and traced.
- `W006-AC02` all in-scope TypeScript errors are eliminated and final `tsc --noEmit` is clean for the baseline.
- `W006-AC03` all Architecture Contract Test failures are captured and classified.
- `W006-AC04` all in-scope Architecture Contract Test failures are eliminated without weakening frozen architecture rules.
- `W006-AC05` every production/type-contract correction is minimal and regression-tested.
- `W006-AC06` no new vertical/runtime/economic/Data Plane coupling is introduced.
- `W006-AC07` PostgreSQL integration tests remain green.
- `W006-AC08` validator, architecture tests, typecheck, lint, targeted regressions, and scope evidence are recorded.
- `W006-AC09` every residual out-of-scope failure is documented and assigned to a future bounded Work Item.
- `W006-AC10` no frozen architecture is modified in place.

Required Verification:

- clean-main Typecheck baseline capture;
- complete Architecture Contract Test suite;
- final `bunx tsc --noEmit`;
- targeted regression tests for all implementation corrections;
- PostgreSQL integration suite;
- governance specification validator;
- lint;
- exact diff/scope inspection;
- independent Architect Review.

Definition of Done: Typecheck and Architecture Contract failures within scope are eliminated; residuals are evidenced; PostgreSQL remains green; no architecture drift; PR merged; Work Item VERIFIED.

## WORK-007 — Typecheck Residual Closure and TypeScript Project Boundaries

Status: `VERIFIED`

Architecture Version: `IAAS-GOV-ARCH-1`

Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)

Dependencies: `WORK-006`

Requirements: `BASE-011` through `BASE-014`; inherited frozen runtime, vertical-neutrality, and repository-governance boundaries.

Objective: close the five residual Typecheck failures left after WORK-006 without weakening the compiler gate: fix the genuine production `baselineEngine` defect and establish explicit, testable TypeScript project boundaries for `examples/` and `skills/` rather than silently excluding broken code.

Repository Scope: `src/lib/services/vpp.service.ts` and directly related production types; root and auxiliary `tsconfig*.json` / TypeScript project configuration required to establish explicit boundaries; targeted auxiliary configuration/tests; targeted regression tests; CI/test configuration required to validate the boundaries; WORK-007 evidence; governance test updates required solely because WORK-007 is issued.

Architecture Constraints: `IAAS-GOV-ARCH-1` and `IAAS-DOM-ARCH-2` remain FROZEN; do not change RuntimeRegistry, InfrastructureRuntime, ProtocolRuntime, HybridRuntime, Economic Pipeline, Data Plane, ledger, or Prisma schema; generic kernel/runtime code remains vertical-neutral; PostgreSQL remains canonical; do not weaken TypeScript strictness or introduce compiler-wide suppression.

Out of Scope: new domain primitives/network features; runtime/economic/data-plane architecture redesign; unrelated dependency expansion; `any`, `@ts-ignore`, `@ts-expect-error`, `skipLibCheck`, or broad unexplained exclusions; frozen architecture changes; WORK-008+.

Acceptance Criteria:

- `W007-AC01` residual Typecheck failures are reproduced and classified with concrete evidence.
- `W007-AC02` baselineEngine production Typecheck failure is eliminated without suppression while preserving dynamic-import behavior.
- `W007-AC03` TypeScript project boundaries are explicit and each auxiliary tree is either validated by its own project configuration or explicitly classified as non-application material.
- `W007-AC04` no broken auxiliary TypeScript code is silently hidden by an unexplained broad exclusion.
- `W007-AC05` final IAAS application `tsc --noEmit` is clean.
- `W007-AC06` Architecture Contract Tests, PostgreSQL integration tests, specification validation, and lint remain green.
- `W007-AC07` frozen runtime architecture, vertical neutrality, and Data Plane ↔ Economic Pipeline independence remain intact.
- `W007-AC08` regression tests prove the baselineEngine typing boundary and TypeScript project-boundary decision.
- `W007-AC09` residual auxiliary-project failures, if any, are explicitly classified and assigned rather than concealed.
- `W007-AC10` no frozen architecture version is modified and no ACR is required unless a genuine architectural contradiction is demonstrated.

Required Verification:

- clean-main residual Typecheck capture;
- final IAAS application `tsc --noEmit`;
- any auxiliary TypeScript project checks established by WORK-007;
- baselineEngine targeted regression test;
- Architecture Contract Test suite;
- PostgreSQL integration suite;
- specification validator;
- lint;
- exact diff/scope verification;
- independent Architect Review.

Definition of Done: residual Typecheck failures are objectively classified; baselineEngine is fixed with regression evidence; TypeScript project boundaries are explicit and validated; IAAS application Typecheck is clean; all existing CI gates remain green; evidence is recorded; PR merged; Work Item VERIFIED.

## WORK-008 — Architecture Truth Reconciliation and Verified-Evidence Promotion

Status: `VERIFIED`

Architecture Version: `IAAS-GOV-ARCH-1`

Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)

Dependencies: `WORK-007`

Requirements: `BASE-015`; `GOV-001`, `GOV-003`, `GOV-006`, `GOV-008`.

Objective: synchronize the canonical planning/specification layer with verified repository reality after WORK-003 and WORK-007. The V1-derived domain requirements still label `DOM-P01 VerifiedEvidenceContext` as `PROPOSED`, even though ACR-001 was approved, `IAAS-DOM-ARCH-2` was frozen, and WORK-003 was implemented and VERIFIED.

Repository Scope: `spec/` specification documents; `docs/architecture/` only for reconciliation/addendum evidence; directly related specification tests; CI configuration only when required.

Architecture Constraints: `IAAS-GOV-ARCH-1` and `IAAS-DOM-ARCH-2` remain FROZEN; no production code changes; no new domain primitives; no new ACRs unless a genuine contradiction is discovered; no promotion of unrelated FUTURE items; frozen architecture versions are not modified in place (historical V1 preserved with addendum).

Out of Scope: production code changes, frozen architecture mutation, new primitives, promoting TransformRegistry/TransformRuntime/Extensions/Marketplace/SDK/Fragmentation, new ACRs without genuine contradiction, WORK-009+.

Acceptance Criteria:

- `W008-AC01` truth drift inventory: every stale statement captured with source, current statement, verified evidence, classification, required correction.
- `W008-AC02` VerifiedEvidenceContext is no longer represented as merely proposed in the current domain requirements/index; identified as implemented under IAAS-DOM-ARCH-2, traced to ACR-001 and WORK-003.
- `W008-AC03` IAAS-DOM-ARCH-1 remains immutable historical architecture; wording not silently rewritten.
- `W008-AC04` no other DOM-Pxx future/open/research item is promoted without its own verified architecture decision.
- `W008-AC05` cross-document consistency: domain-architecture.md, domain-architecture-v2.md, domain-requirements.md, architecture.md, architecture-lock.md, work-items.md, dependency-graph.md remain mutually consistent.
- `W008-AC06` regression protection: deterministic specification tests detect a future reversion that incorrectly labels a VERIFIED primitive as merely proposed.
- `W008-AC07` no production changes (src/, prisma/, runtime, economic, Data Plane, vertical).
- `W008-AC08` governance gates remain green (validator, architecture-contract, Typecheck, PostgreSQL, lint, diff-scope).

Required Verification:

- truth-drift inventory;
- updated current-domain requirement/index state;
- historical V1 unchanged evidence;
- regression test proving the verified-evidence promotion cannot silently revert;
- full CI evidence;
- exact diff/scope evidence;
- independent Architect Review.

Definition of Done: truth drift is inventoried; VerifiedEvidenceContext is correctly represented as implemented/current; historical V1 remains immutable; unrelated future primitives remain future/proposed; regression protection is added; all governance and engineering CI gates remain green; PR submitted; Architect Review approves; PR merged; WORK-008 becomes VERIFIED only after independent Architect Review.

## WORK-009 — Transform Stack Architecture Freeze

Status: `READY`

Architecture Version: `IAAS-GOV-ARCH-1`

Domain Architecture: `IAAS-DOM-ARCH-3` (target — to be frozen by this Work Item)

Dependencies: `WORK-008`

Requirements: `BASE-016`; `ACR-002` (APPROVED).

Objective: produce and freeze `IAAS-DOM-ARCH-3`, promoting the Transform Stack boundary (Transform → TransformRegistry → TransformRuntime → TransformRecord) from FUTURE to FROZEN-CONTRACT without implementing TransformRegistry or TransformRuntime in production.

Repository Scope: `spec/` architecture/requirements/dependency-graph documents; governance-layer registration; targeted specification/architecture regression tests; CI configuration only when required.

Architecture Constraints: `IAAS-GOV-ARCH-1` and `IAAS-DOM-ARCH-2` remain FROZEN (V2 not modified in place); no production implementation; no Prisma schema changes; no `src/` changes; no TransformRegistry/TransformRuntime services; no marketplace/SDK/sandbox/economic/data-plane implementation; no premature technology decisions.

Out of Scope: production implementation of TransformRegistry/TransformRuntime, Prisma schema changes, marketplace/extension/SDK work, economic integration, data-plane implementation, sandbox technology selection, cryptographic-signature infrastructure, plugin packaging, WORK-010+.

Acceptance Criteria:

- `W009-AC01` ACR-002 traceability is explicit.
- `W009-AC02` IAAS-DOM-ARCH-3 is complete, internally consistent, and registered as the frozen canonical architecture.
- `W009-AC03` Transform/Registry/Runtime responsibilities are non-overlapping.
- `W009-AC04` TransformRecord remains immutable provenance and service-layer only.
- `W009-AC05` all dependency and anti-dependency directions are explicit.
- `W009-AC06` discovery/version/certification/revocation/execution/verification/failure/idempotency boundaries are explicit without over-specifying technology.
- `W009-AC07` production implementation remains prohibited; next implementation Work Item blocked until WORK-009 VERIFIED.
- `W009-AC08` regression tests prove architecture-version integrity, V2 immutability, and zero production-code scope.

Required Verification:

- ACR-002 traceability;
- IAAS-DOM-ARCH-3 completeness + registration;
- Transform Stack responsibility separation;
- anti-dependency direction evidence;
- regression tests;
- validator + CI evidence;
- exact diff/scope verification;
- independent Architect Review.

Definition of Done: IAAS-DOM-ARCH-3 is frozen and registered; Transform Stack contract is complete; V2 remains immutable; no production implementation; regression protection added; all CI gates green; PR submitted; Architect Review approves; PR merged; WORK-009 becomes VERIFIED only after independent Architect Review.
