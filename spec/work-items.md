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

WORK-001 is VERIFIED. WORK-001 through WORK-021 are VERIFIED in dependency order. `IAAS-DOM-ARCH-5` is the current frozen domain architecture. WORK-022 is READY and is the only eligible Work Item.

## WORK-001 — WorkflowOS Specification and Governance Foundation
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: none
Requirements: `GOV-001` through `GOV-008`
Objective: establish persistent governance/specification without changing IAAS production behavior.
Repository Scope: `spec/` governance documents and its executable consistency gate.
Architecture Constraints: frozen governance architecture; no production implementation; architecture changes require ACR.
Out of Scope: domain feature implementation, migrations, runtime changes, vertical networks.
Acceptance Criteria:
- `W001-AC01` frozen governance architecture exists.
- `W001-AC02` every Work Item names exactly one architecture version.
- `W001-AC03` requirements and objective ACs are explicit.
- `W001-AC04` dependencies and out-of-scope boundaries are explicit.
- `W001-AC05` architecture changes require an ACR.
- `W001-AC06` agent claims cannot establish PASS.
- `W001-AC07` verification evidence maps to acceptance criteria.
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
Requirements: truth-classified baseline; canonical `IAAS-DOM-ARCH-1`
Objective: audit repository and establish canonical V1 domain architecture.
Repository Scope: `docs/architecture/` and `spec/` domain architecture layer.
Architecture Constraints: derived from verified baseline; changes require ACR/new version.
Out of Scope: broad refactors and future feature implementation.
Acceptance Criteria: `W002-AC01` through `W002-AC04`.
Required Verification: baseline inspection; specification validation; Architect Review.
Definition of Done: baseline and V1 architecture committed and verified.

## WORK-003 — VerifiedEvidenceContext Implementation
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-002`
Requirements: `DOM-013`, `ACR-001`
Objective: implement the frozen VerifiedEvidenceContext boundary.
Repository Scope: evidence/economic boundary services, VPP adapter, tests.
Architecture Constraints: preserve durable evidence sources and kernel/Data Plane/Economic Pipeline boundaries.
Out of Scope: ledger redesign, Data Plane redesign, Transform/Extension work.
Acceptance Criteria: `W003-AC01` through `W003-AC09`.
Required Verification: static; unit; PostgreSQL; VPP; anti-dependency; CI; Architect Review.
Definition of Done: criteria verified and merged.

## WORK-004 — Runtime Registry Bootstrap Reliability
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-003`
Requirements: `BASE-001` through `BASE-003`
Objective: restore runtime/bootstrap behavior.
Repository Scope: runtime/bootstrap code and tests.
Architecture Constraints: preserve runtime kinds, isolation, singleton behavior, vertical neutrality.
Out of Scope: runtime redesign and unrelated subsystems.
Acceptance Criteria: `W004-AC01` through `W004-AC09`.
Required Verification: runtime resolution; registry stability; integration tests; CI; Architect Review.
Definition of Done: runtime registration verified and merged.

## WORK-005 — Integration Fixture Reliability
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-004`
Requirements: `BASE-004` through `BASE-006`
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
Requirements: `BASE-007` through `BASE-010`
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
Requirements: `BASE-011` through `BASE-014`
Objective: close residual Typecheck failures and establish explicit TS boundaries.
Repository Scope: VPP typing, TS configuration, targeted tests/CI.
Architecture Constraints: no suppression; no architecture redesign.
Out of Scope: new domain/network features.
Acceptance Criteria: `W007-AC01` through `W007-AC10`.
Required Verification: Typecheck; boundary tests; architecture/PG/validator/lint/scope; Architect Review.
Definition of Done: Typecheck clean and residuals classified.

## WORK-008 — Architecture Truth Reconciliation
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-007`
Requirements: `BASE-015`, governance requirements
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
Requirements: `BASE-016`, `ACR-002`
Objective: freeze Transform → Registry → Runtime → Record boundary without implementation.
Repository Scope: architecture/specification/tests only.
Architecture Constraints: V2 immutable; no production Transform implementation.
Out of Scope: production implementation, marketplace, SDK, sandbox, signatures.
Acceptance Criteria: `W009-AC01` through `W009-AC08`.
Required Verification: ACR traceability; V3 consistency; responsibility separation; regression tests; CI; scope; Architect Review.
Definition of Done: V3 frozen and verified.

## WORK-010 — TransformRegistry Implementation
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-009`
Requirements: `DOM-015`
Objective: implement generic service-layer TransformRegistry.
Repository Scope: service, persistence, tests, architecture checks.
Architecture Constraints: tenant-scoped catalog only; no execution; PostgreSQL durable; no kernel/vertical/economic/data-plane coupling.
Out of Scope: Runtime, concrete transforms, marketplace, SDK, sandbox, signatures.
Acceptance Criteria: `W010-AC01` through `W010-AC08`.
Required Verification: unit/PG/tenant/concurrency/anti-dependency; validator; Typecheck; lint; CI; Architect Review.
Definition of Done: Registry verified and merged.

## WORK-011 — TransformRuntime Implementation
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-010`
Requirements: `DOM-016`
Objective: implement service-layer TransformRuntime.
Repository Scope: Runtime service and tests.
Architecture Constraints: resolve only through Registry; immutable TransformRecord; no catalog ownership.
Out of Scope: concrete transforms, marketplace, SDK, sandbox, signatures.
Acceptance Criteria: `W011-AC01` through `W011-AC10`.
Required Verification: unit/PG/idempotency/failure/provenance/anti-dependency; all gates; Architect Review.
Definition of Done: Runtime verified and merged.

## WORK-012 — Transform Stack Truth Synchronization
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-011`
Requirements: truth synchronization; governance requirements
Objective: reconcile V3 specifications with verified Transform Stack reality.
Repository Scope: `spec/` and regression tests only.
Architecture Constraints: V3 remains frozen; no DOM-P04..P08 promotion.
Out of Scope: production behavior and architecture changes.
Acceptance Criteria: `W012-AC01` through `W012-AC06`.
Required Verification: validator; truth-regression tests; architecture/Typecheck/PG/lint/scope gates; Architect Review.
Definition of Done: V3 synchronized and verified.

## WORK-013 — Transform Stack End-to-End Conformance and Integration Hardening
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-012`
Requirements: `DOM-014` through `DOM-017`
Objective: prove Registry → Runtime → Record works as one coherent subsystem.
Repository Scope: conformance tests; architecture regressions; CI/test configuration; evidence.
Architecture Constraints: Registry catalog authority; Runtime executor; Record immutable; PostgreSQL durable; no concrete transform.
Out of Scope: new Transform primitives, architecture changes, concrete transforms, marketplace, SDK, sandbox, economic/data-plane redesign.
Acceptance Criteria: `W013-AC01` through `W013-AC11`.
Required Verification: PG end-to-end; tenant isolation; idempotency; failure/provenance; anti-dependency tests; validator; Typecheck; architecture suite; lint; scope; Architect Review.
Definition of Done: objectively verified; PR merged; Work Item VERIFIED.

## WORK-014 — Extension Stack Architecture and ACR-003
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-013`
Requirements: `ACR-003`; governance requirements; historical `DOM-P04`
Objective: produce, review, and approve Extension Stack architecture proposal that became V4.
Repository Scope: `spec/` architecture/change-control documents, tests, dependency graph, Work Item/Work Order records, evidence.
Architecture Constraints: V3 remained frozen; no production implementation; no Prisma; no sandbox selection.
Out of Scope: Extension production code, sandbox, marketplace, SDK, licensing, economics, cryptographic mechanism, schema redesign, DOM-P05..P08 promotion.
Acceptance Criteria: `W014-AC01` through `W014-AC11`.
Required Verification: ACR completeness; candidate V4 consistency; responsibility/security/lifecycle invariants; anti-dependencies; V3 immutability; DOM-P04 non-promotion; gates; Architect Review.
Definition of Done: ACR-003 approved; candidate V4 complete; merged; VERIFIED.

## WORK-015 — IAAS-DOM-ARCH-4 Freeze and DOM-P04 Truth Promotion
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-014`
Requirements: `ACR-003`; V4 `DOM-018..DOM-022`
Objective: freeze V4 as canonical, promote DOM-P04, preserve V3 immutable.
Repository Scope: governance/specification, Work Item/dependency records, regression tests, CI, evidence.
Architecture Constraints: V4 frozen; V3 immutable; no production implementation; DOM-P05..P08 future.
Out of Scope: Extension production code, Prisma, sandbox, Marketplace, SDK, economics, concrete extensions.
Acceptance Criteria: `W015-AC01` through `W015-AC11`.
Required Verification: ACR/V4 state; V3 immutability; freeze/promotion tests; validator; Typecheck; Architecture Contract Tests; lint; CI; scope; Architect Review.
Definition of Done: V4 frozen/canonical; DOM-P04 promoted; merged; VERIFIED.

## WORK-016 — ExtensionRegistry Implementation
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-015`
Requirements: `DOM-019`
Objective: implement service-layer ExtensionRegistry.
Repository Scope: registry service, tenant-scoped persistence, tests, architecture evidence.
Architecture Constraints: Registry is catalog/lifecycle authority and never executes; PostgreSQL durable; no Runtime/Provenance implementation; no cross-layer coupling.
Out of Scope: ExtensionRuntime, ExtensionProvenance, concrete extensions, sandbox, Marketplace, SDK, economics, DOM-P05..P08.
Acceptance Criteria: `W016-AC01` through `W016-AC08`.
Required Verification: unit; PostgreSQL; tenant isolation; lifecycle/revocation; concurrency/idempotency; anti-dependency; all gates; Architect Review.
Definition of Done: DOM-019 implemented without drift; merged; VERIFIED.

## WORK-017 — ExtensionRuntime Implementation
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-016`
Requirements: `DOM-020`
Objective: implement service-layer ExtensionRuntime.
Repository Scope: Runtime service, capability/resource enforcement, lifecycle/idempotency/failure tests, architecture evidence.
Architecture Constraints: resolve only through Registry; Runtime is execution/isolation authority; durable provenance separate; sandbox remains OPEN/RESEARCH.
Out of Scope: Registry redesign except compliance fixes; durable provenance; sandbox selection/implementation; concrete extensions; Marketplace/SDK; economics.
Acceptance Criteria: `W017-AC01` through `W017-AC11`.
Required Verification: unit; PostgreSQL; lifecycle; capability/resource; failure/provenance; idempotency; tenant isolation; anti-dependency; all gates; Architect Review.
Definition of Done: DOM-020 implemented without drift; merged; VERIFIED.

## WORK-018 — ExtensionProvenance Durable Persistence
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-017`
Requirements: `DOM-022`
Objective: implement immutable durable ExtensionProvenance boundary.
Repository Scope: provenance service/boundary, PostgreSQL persistence, tests, migration, evidence.
Architecture Constraints: service-layer; PostgreSQL durable; tenant-scoped; immutable; Runtime emits but does not persist; V4 frozen.
Out of Scope: sandbox; concrete extensions; Marketplace/SDK; economics; Registry/Runtime redesign; DOM-P05..P08.
Acceptance Criteria: `W018-AC01` through `W018-AC09`.
Required Verification: unit; PostgreSQL; concurrency/idempotency; tenant isolation; immutability; fingerprint; failure provenance; migration; all gates; Architect Review.
Definition of Done: DOM-022 implemented without drift; merged; VERIFIED.

## WORK-019 — Sandbox Architecture and ACR-004
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-018`
Requirements: V4 §2.8; deferred `DOM-P05`
Objective: evaluate sandbox architectures and produce ACR-004.
Repository Scope: ACR/specification, regression tests, evidence, governance metadata.
Architecture Constraints: V4 immutable; ACR only; no sandbox implementation; V5 freeze deferred to WORK-020.
Out of Scope: sandbox runtime implementation, Prisma, ExtensionRuntime changes, concrete extensions, Marketplace/SDK.
Acceptance Criteria: `W019-AC01` through `W019-AC11`.
Required Verification: alternatives evaluation; trust/lifecycle/resource/isolation/fallback semantics; V4 immutability; no implementation; validator; gates; Architect Review.
Definition of Done: ACR-004 approved; decision evidence recorded; merged; VERIFIED.

## WORK-020 — IAAS-DOM-ARCH-5 Freeze and DOM-P05 Promotion
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-019`
Requirements: `ACR-004`; V5 sandbox contract
Objective: freeze approved V5 sandbox architecture as canonical and promote DOM-P05 without implementing a sandbox.
Repository Scope: `spec/` V5 architecture, ACR state, Work Item/dependency records, work order, evidence.
Architecture Constraints: V4 immutable; WASI Component Model/capability-sandbox contract frozen without freezing a concrete runtime/version; distinct resource measurements; deny-by-default fallback; no production implementation.
Out of Scope: WASM runtime code, container/native sandbox, ExtensionRuntime redesign, ExtensionProvenance schema redesign, concrete extensions, Marketplace, SDK, economics, DOM-P06..P08.
Acceptance Criteria: `W020-AC01` through `W020-AC10`.
Required Verification: ACR decision inspection; V5 completeness; V4 immutability; DOM-P05 promotion; dependency/Work Item consistency; regression tests; validator; Typecheck; architecture tests; lint; scope; Architect Review.
Definition of Done: ACR-004 APPROVED; V5 FROZEN; DOM-P05 promoted; no production implementation; evidence committed; PR approved and merged; WORK-020 VERIFIED.

## WORK-021 — WASI Sandbox Host Foundation
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-020`
Requirements: V5 sandbox contract; promoted `DOM-P05`
Objective: implement the first production sandbox slice required by frozen V5: a service-layer WASI Component Model sandbox host for untrusted extensions.
Repository Scope: sandbox host abstraction and concrete WASI runtime adapter; component validation/instantiation; capability/resource enforcement; termination/fallback policy; Runtime integration; unit/architecture/real-WASI/PG provenance tests; evidence.
Architecture Constraints: ExtensionRuntime remains authority; no ambient authority; capability ceiling is `min(declared, approved)`; termination remains an architectural abstraction; sandbox unavailable denies execution; concrete runtime/version is implementation policy, not architecture.
Out of Scope: container/native sandbox; ExtensionRuntime redesign beyond integration; ExtensionProvenance schema redesign; concrete extensions; Marketplace/SDK; licensing/economics; vertical/kernel/data-plane coupling; WORK-022.
Acceptance Criteria: `W021-AC01` through `W021-AC12`.
Required Verification: real WASI module/component execution; capability denial; tenant isolation; independent resource controls; CPU-vs-fuel distinction; termination/revocation; sandbox-unavailable denial; failed provenance/rethrow; anti-dependency; Typecheck; lint; architecture tests; PostgreSQL/integration; spec validator; scope; Architect Review.
Definition of Done: V5 sandbox contract implemented without drift; objective evidence recorded; PR verified and Architect-approved; merged; WORK-021 VERIFIED.

## WORK-022 — Sandbox Lifecycle Completion
Status: `READY`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-021`
Requirements: V5 sandbox contract §2.5 (lifecycle and termination); promoted `DOM-P05`
Objective: complete the frozen V5 §2.5 sandbox lifecycle semantics on the verified WORK-021 foundation — `deactivated` terminates active sandbox execution contexts through the authoritative control path, and `installed` performs module validation without execution.
Repository Scope: extension-registry lifecycle transitions and audit; active-execution registry deactivation semantics; sandbox-host validate-only path; extension-runtime integration where required; unit/architecture/real-WASI/PostgreSQL tests; evidence.
Architecture Constraints: V5 remains FROZEN; ExtensionRegistry remains lifecycle/catalog authority; ExtensionRuntime remains execution/isolation authority; capability ceiling remains `min(declared, approved)`; termination through the architectural abstraction (`SandboxExecutionHandle.revoke()`); termination hook synchronous after the durable update; deactivation is reversible and never uses the terminal revoked ledger; deny-by-default preserved.
Out of Scope: changing IAAS-DOM-ARCH-5; authoritative measurement completion for fuelUnits/cpuTimeNs/peakLinearMemoryBytes (future bounded slice); provenance schema semantics changes; container/native sandbox; concrete extensions; Marketplace/SDK; licensing/economics; vertical/kernel/data-plane coupling; WORK-023.
Acceptance Criteria: `W022-AC01` through `W022-AC10`.
Required Verification: static wiring checks (hook synchronous after durable deactivation update); unit; real WASI integration; PostgreSQL end-to-end golden chains (deactivation, re-activation, install-time validation); tenant isolation; Typecheck; lint; architecture tests; spec validator; CI; scope; Architect Review.
Definition of Done: V5 §2.5 lifecycle semantics fully wired and objectively verified; evidence recorded; PR verified and Architect-approved; merged; WORK-022 VERIFIED.
