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

WORK-001 is VERIFIED. WORK-001 through WORK-016 are VERIFIED in dependency order. `IAAS-DOM-ARCH-4` is the current frozen domain architecture. WORK-017 is READY and is the only eligible implementation Work Item.

## WORK-001 — WorkflowOS Specification and Governance Foundation
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: none
Requirements: `GOV-001` through `GOV-008`; acceptance criteria `W001-AC01` through `W001-AC13`.
Objective: establish persistent governance/specification without changing IAAS production behavior.
Repository Scope: `spec/` governance documents and its executable consistency gate.
Architecture Constraints: frozen governance architecture; no production implementation.
Out of Scope: domain feature implementation, migrations, runtime changes, vertical networks.
Acceptance Criteria: `W001-AC01` through `W001-AC13`.
Required Verification: specification inspection; automated consistency checks; negative validator tests; CI execution; exact scope inspection; independent Architect Review.
Definition of Done: specification committed; checks and tests pass; CI records pass; Architect approves; PR merged; Work Item VERIFIED.

## WORK-002 — Repository Baseline and Domain Architecture V1
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-001`
Requirements: truth-classified repository baseline; canonical `IAAS-DOM-ARCH-1`.
Objective: audit repository and establish canonical V1 domain architecture.
Repository Scope: `docs/architecture/` and `spec/` domain architecture layer.
Architecture Constraints: derived only from verified baseline; architecture changes require ACR/new version.
Out of Scope: broad refactors and future feature implementation.
Acceptance Criteria: `W002-AC01` through `W002-AC04`.
Required Verification: baseline inspection; specification validation; Architect Review.
Definition of Done: baseline and V1 architecture committed and verified.

## WORK-003 — VerifiedEvidenceContext Implementation
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-002`
Requirements: `DOM-013`, ACR-001.
Objective: implement frozen VerifiedEvidenceContext boundary.
Repository Scope: evidence/economic boundary services, VPP adapter, tests.
Architecture Constraints: preserve durable evidence sources, kernel boundary, Data Plane/Economic Pipeline independence.
Out of Scope: ledger redesign, Data Plane redesign, Transform/Extension work.
Acceptance Criteria: `W003-AC01` through `W003-AC09`.
Required Verification: static checks; unit/PG/VPP tests; anti-dependency tests; CI; Architect Review.
Definition of Done: criteria verified and merged.

## WORK-004 — Runtime Registry Bootstrap Reliability
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-003`
Requirements: `BASE-001` through `BASE-003`.
Objective: restore runtime/bootstrap behavior.
Repository Scope: runtime/bootstrap code and tests.
Architecture Constraints: preserve runtime kinds, isolation, singleton behavior, vertical neutrality.
Out of Scope: runtime redesign and unrelated subsystems.
Acceptance Criteria: `W004-AC01` through `W004-AC09`.
Required Verification: runtime resolution; registry stability; dependent integration tests; CI; Architect Review.
Definition of Done: runtime registration verified and merged.

## WORK-005 — Integration Test Fixture and Prerequisite Reliability
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-004`
Requirements: `BASE-004` through `BASE-006`.
Objective: make affected PostgreSQL integration fixtures explicit and deterministic.
Repository Scope: affected tests/helpers only.
Architecture Constraints: no production auto-fixtures; PostgreSQL and tenant isolation canonical.
Out of Scope: production work and schema redesign.
Acceptance Criteria: `W005-AC01` through `W005-AC08`.
Required Verification: affected PG suites; isolation; validator; scope; Architect Review.
Definition of Done: fixture failures eliminated and verified.

## WORK-006 — Baseline Typecheck and Architecture Contract Recovery
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-005`
Requirements: `BASE-007` through `BASE-010`.
Objective: eliminate in-scope baseline Typecheck and Architecture Contract failures.
Repository Scope: minimal production/type-contract corrections and related tests.
Architecture Constraints: preserve runtime/economic/Data Plane/vertical-neutral boundaries.
Out of Scope: new primitives, broad refactors, compiler suppression.
Acceptance Criteria: `W006-AC01` through `W006-AC10`.
Required Verification: baseline captures; Typecheck; architecture tests; PG; validator; lint; scope; Architect Review.
Definition of Done: in-scope failures eliminated and verified.

## WORK-007 — Typecheck Residual Closure and TypeScript Project Boundaries
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-006`
Requirements: `BASE-011` through `BASE-014`.
Objective: close residual Typecheck failures and establish explicit TS project boundaries.
Repository Scope: VPP typing defect, TS configuration, targeted tests/CI.
Architecture Constraints: no suppression; no architecture redesign.
Out of Scope: new domain/network features.
Acceptance Criteria: `W007-AC01` through `W007-AC10`.
Required Verification: Typecheck; boundary tests; architecture/PG/validator/lint/scope gates; Architect Review.
Definition of Done: Typecheck clean and residuals classified.

## WORK-008 — Architecture Truth Reconciliation and Verified-Evidence Promotion
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-007`
Requirements: `BASE-015`, governance requirements.
Objective: reconcile verified repository reality into the domain planning layer.
Repository Scope: specification and reconciliation evidence only.
Architecture Constraints: V2 frozen; unrelated future primitives remain future.
Out of Scope: production code and unrelated promotions.
Acceptance Criteria: `W008-AC01` through `W008-AC08`.
Required Verification: truth inventory; historical preservation; regression tests; full gates; Architect Review.
Definition of Done: truth drift reconciled and verified.

## WORK-009 — Transform Stack Architecture Freeze
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-008`
Requirements: `BASE-016`, `ACR-002` (APPROVED).
Objective: freeze Transform → Registry → Runtime → Record boundary without implementation.
Repository Scope: architecture/specification/tests only.
Architecture Constraints: V2 immutable; no production Transform implementation in this slice.
Out of Scope: production implementation, marketplace, SDK, sandbox, signatures.
Acceptance Criteria: `W009-AC01` through `W009-AC08`.
Required Verification: ACR traceability; V3 consistency; responsibility separation; regression tests; CI; scope; Architect Review.
Definition of Done: V3 frozen and verified.

## WORK-010 — TransformRegistry Implementation
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-009`
Requirements: `BASE-017`, `DOM-015`.
Objective: implement generic service-layer TransformRegistry.
Repository Scope: service, persistence, tests, architecture checks.
Architecture Constraints: tenant-scoped catalog only; no execution; PostgreSQL durable; no kernel/vertical/economic/data-plane coupling.
Out of Scope: Runtime, concrete transforms, marketplace, SDK, sandbox, signatures.
Acceptance Criteria: `W010-AC01` through `W010-AC08`.
Required Verification: unit/PG/tenant/concurrency/anti-dependency tests; validator; Typecheck; lint; CI; Architect Review.
Definition of Done: Registry verified and merged.

## WORK-011 — TransformRuntime Implementation
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-010`
Requirements: `DOM-016`.
Objective: implement service-layer TransformRuntime.
Repository Scope: runtime service and tests.
Architecture Constraints: resolve only through Registry; immutable TransformRecord; no catalog ownership; no cross-layer coupling.
Out of Scope: concrete transforms, marketplace, SDK, sandbox, signatures.
Acceptance Criteria: `W011-AC01` through `W011-AC10`.
Required Verification: unit/PG/idempotency/failure/provenance/anti-dependency tests and all gates.
Definition of Done: Runtime verified and merged.

## WORK-012 — Transform Stack Truth Synchronization
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-011`
Requirements: truth synchronization; governance requirements.
Objective: reconcile V3 specifications with verified Transform Stack reality.
Repository Scope: `spec/` and regression tests only.
Architecture Constraints: V3 remains frozen; no DOM-P04..P08 promotion in this slice.
Out of Scope: production behavior and architecture changes.
Acceptance Criteria: `W012-AC01` through `W012-AC06`.
Required Verification: validator; truth-regression tests; architecture/Typecheck/PG/lint/scope gates; Architect Review.
Definition of Done: V3 synchronized and verified.

## WORK-013 — Transform Stack End-to-End Conformance and Integration Hardening
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-012`
Requirements: `DOM-014` through `DOM-017`.
Objective: prove Registry → Runtime → Record works as one coherent subsystem.
Repository Scope: conformance tests; architecture regressions; CI/test configuration; evidence.
Architecture Constraints: Registry catalog authority; Runtime executor; Record immutable provenance; PostgreSQL durable; no cross-layer coupling; no concrete transform.
Out of Scope: new Transform primitives, architecture changes, concrete transforms, marketplace, SDK, sandbox, economic/data-plane redesign.
Acceptance Criteria: `W013-AC01` through `W013-AC11`.
Required Verification: PG end-to-end; tenant isolation; idempotency; failure/provenance; anti-dependency tests; validator; Typecheck; architecture suite; lint; scope; Architect Review.
Definition of Done: objectively verified; PR merged; Work Item VERIFIED.

## WORK-014 — Extension Stack Architecture and ACR-003
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-013`
Requirements: `ACR-003`; governance requirements; historical `DOM-P04`.
Objective: produce, review, and approve Extension Stack architecture proposal that became V4.
Repository Scope: `spec/` architecture/change-control documents, tests, dependency graph, Work Item/Work Order records, evidence.
Architecture Constraints: V3 remained frozen during review; no production implementation; no Prisma; no sandbox selection; no marketplace/SDK/concrete extensions.
Out of Scope: Extension production code, sandbox, marketplace, SDK, licensing, economic attribution, cryptographic mechanism, schema redesign, DOM-P05..P08 promotion.
Acceptance Criteria: `W014-AC01` through `W014-AC11`.
Required Verification: ACR completeness; candidate V4 consistency; responsibility/security/lifecycle invariants; anti-dependencies; V3 immutability; DOM-P04 non-promotion; validator; Typecheck; Architecture Contract Tests; lint; scope; Architect Review.
Definition of Done: ACR-003 approved; candidate V4 complete; PR merged; Work Item VERIFIED.

## WORK-015 — IAAS-DOM-ARCH-4 Freeze and DOM-P04 Truth Promotion
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-014`
Requirements: `ACR-003`; V4 `DOM-018..DOM-022`.
Objective: persist approved ACR-003, freeze V4 as canonical, promote DOM-P04, preserve V3 immutable, release no production implementation.
Repository Scope: governance/specification, Work Item/dependency records, regression tests, CI, evidence only.
Architecture Constraints: V4 frozen; V3 immutable; no production implementation; no Prisma; no sandbox selection; DOM-P05..DOM-P08 future/open/research.
Out of Scope: Extension production code, Registry/Runtime implementation, Prisma, sandbox, Marketplace, SDK, licensing, economic attribution, concrete extensions, DOM-P05..P08 promotion.
Acceptance Criteria: `W015-AC01` through `W015-AC11`.
Required Verification: ACR/V4 state inspection; V3 immutability; V4 freeze/promotion tests; validator; Typecheck; Architecture Contract Tests; lint; CI; exact scope; Architect Review.
Definition of Done: V4 frozen/canonical; DOM-P04 promoted; WORK-014 VERIFIED; WORK-015 merged and VERIFIED; no production implementation.

## WORK-016 — ExtensionRegistry Implementation
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-015`
Requirements: `DOM-019`; inherited V4 Extension Stack requirements.
Objective: implement the service-layer ExtensionRegistry contract defined by frozen DOM-019.
Repository Scope: ExtensionRegistry service; tenant-scoped persistence; targeted unit/PostgreSQL tests; anti-dependency tests; CI/specification evidence.
Architecture Constraints: Registry is catalog/lifecycle authority and never executes; PostgreSQL is durable source; V4 frozen; no Runtime/Provenance implementation; no kernel/vertical/economic/data-plane coupling.
Out of Scope: ExtensionRuntime, ExtensionProvenance storage/service, concrete extensions, sandbox technology, Marketplace, SDK, licensing, economic attribution, DOM-P05..P08, V4 changes, WORK-017.
Acceptance Criteria: `W016-AC01` through `W016-AC08`.
Required Verification: unit; PostgreSQL; tenant isolation; lifecycle/revocation; concurrency/idempotency; anti-dependency; validator; Typecheck; Architecture Contract Tests; PostgreSQL suite; lint; scope; Architect Review.
Definition of Done: DOM-019 implemented without architecture drift; objective evidence recorded; PR reviewed/approved/merged; WORK-016 VERIFIED by Architect.

## WORK-017 — ExtensionRuntime Implementation
Status: `READY`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-016`
Requirements: `DOM-020`; V4 Extension Stack requirements.
Objective: implement the service-layer ExtensionRuntime contract defined by frozen DOM-020.
Repository Scope: ExtensionRuntime service; targeted unit/PostgreSQL tests; capability/resource enforcement; lifecycle/idempotency/failure tests; anti-dependency evidence; CI/specification evidence.
Architecture Constraints: resolve only through ExtensionRegistry; runtime is execution/isolation authority; registry remains catalog/lifecycle authority; V4 frozen; durable provenance remains a separate service boundary; sandbox remains OPEN/RESEARCH.
Out of Scope: ExtensionRegistry redesign except compliance fixes; durable ExtensionProvenance storage/schema/service; sandbox technology selection/implementation; concrete extensions; Marketplace; SDK; licensing; economic attribution; V4 changes; WORK-018.
Acceptance Criteria: `W017-AC01` ExtensionRegistry-only resolution; `W017-AC02` activated-state execution gate; `W017-AC03` minimum(declared, approved) capability/resource ceiling; `W017-AC04` reverse/verify semantics; `W017-AC05` failure provenance emission + rethrow; `W017-AC06` deterministic idempotent replay convergence; `W017-AC07` tenant isolation; `W017-AC08` no catalog/lifecycle ownership; `W017-AC09` no durable provenance implementation; `W017-AC10` V4 anti-dependencies; `W017-AC11` all required gates and independent Architect Review.
Required Verification: unit; PostgreSQL; lifecycle; capability/resource; failure/provenance payload; idempotency; tenant isolation; anti-dependency; validator; Typecheck; Architecture Contract Tests; PostgreSQL suite; lint; exact scope; Architect Review.
Definition of Done: DOM-020 implemented without architecture drift; objective evidence recorded; one active PR; verification passes; Architect approves; PR merges; WORK-017 becomes VERIFIED.

## WORK-018 — ExtensionProvenance Durable Persistence
Status: `READY`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-017`
Requirements: `DOM-022`; inherited V4 provenance requirements.
Objective: implement the service-layer durable ExtensionProvenance boundary required by frozen DOM-022, consuming provenance payloads emitted by ExtensionRuntime without taking Runtime execution ownership.
Repository Scope: provenance service/boundary, PostgreSQL persistence, tenant-scoped immutable record, fingerprint/idempotency enforcement, targeted unit/PostgreSQL/architecture tests, CI/specification evidence.
Architecture Constraints: service-layer boundary; PostgreSQL is durable source; immutable after creation; tenant-scoped; one durable record per tenant/idempotency key; runtime emits but does not own persistence; no extension execution; no Registry redesign; V4 frozen.
Out of Scope: sandbox selection/implementation, concrete extensions, Marketplace, SDK, licensing, economic attribution, cryptographic certification mechanism, Registry/Runtime redesign, vertical/economic/data-plane/kernel coupling, DOM-P05..P08, WORK-019.
Acceptance Criteria: `W018-AC01` immutable 11-field provenance schema; `W018-AC02` tenant isolation; `W018-AC03` SHA-256 fingerprint of frozen material fields; `W018-AC04` one durable record per tenant/idempotency key with concurrency convergence; `W018-AC05` success/failure provenance persistence including failed rethrow semantics; `W018-AC06` service boundary ownership separate from ExtensionRuntime; `W018-AC07` PostgreSQL durable source and no update/delete mutation path; `W018-AC08` no prohibited cross-layer dependencies; `W018-AC09` all required gates and independent Architect Review.
Required Verification: unit; PostgreSQL; concurrent idempotency; tenant isolation; immutability; fingerprint determinism; failure provenance; anti-dependency; validator; Typecheck; Architecture Contract Tests; PostgreSQL suite; lint; exact scope; Architect Review.
Definition of Done: DOM-022 implemented without architecture drift; objective evidence recorded; one active PR; verification passes; Architect approves; PR merges; WORK-018 becomes VERIFIED.
