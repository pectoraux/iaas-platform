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

## VERIFIED historical Work Items

### WORK-001 — WorkflowOS Specification and Governance Foundation

Status: `VERIFIED`

Architecture Version: `IAAS-GOV-ARCH-1`

Dependencies: none

Requirements: `GOV-001` through `GOV-008`; acceptance criteria `W001-AC01` through `W001-AC13`.

Objective: establish persistent governance/specification without changing IAAS production behavior.

Repository Scope: `spec/` governance documents and their executable consistency gate.

Architecture Constraints: frozen governance architecture; no production implementation; no domain feature implementation.

Out of Scope: domain features, migrations, runtime changes, vertical networks.

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

Required Verification: specification validator; negative validator tests; CI evidence; exact diff/scope inspection; independent Architect Review.

Definition of Done: governance specification committed and verified; PR merged; Work Item VERIFIED.

### WORK-002 — Repository Baseline and Domain Architecture V1

Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-001`
Requirements: truth-classified repository baseline; canonical `IAAS-DOM-ARCH-1`.
Objective: audit repository architecture/code/schema/tests/CI/history and establish the canonical V1 domain architecture.
Repository Scope: `docs/architecture/` and `spec/` domain architecture layer.
Architecture Constraints: derived only from verified baseline; architecture changes require ACR/new version.
Out of Scope: broad refactors and future feature implementation.
Acceptance Criteria: `W002-AC01` baseline is truth-classified; `W002-AC02` V1 is published/registered; `W002-AC03` requirements/dependency graph exist; `W002-AC04` scope is bounded.
Required Verification: baseline inspection; specification validation; Architect Review.
Definition of Done: baseline and V1 architecture committed and verified.

### WORK-003 — VerifiedEvidenceContext Implementation

Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
Architecture Change Request: `ACR-001` (APPROVED)
Dependencies: `WORK-002`
Requirements: `DOM-013` and ACR-001.
Objective: implement the frozen VerifiedEvidenceContext boundary.
Repository Scope: evidence/economic boundary services, VPP adapter, tests, governance evidence.
Architecture Constraints: preserve durable evidence sources, kernel boundary, and Data Plane/Economic Pipeline independence.
Out of Scope: ledger redesign, Data Plane redesign, Transform/Extension work.
Acceptance Criteria: `W003-AC01` through `W003-AC09` prove immutable context, durable references, generic acceptance, VPP production, reconciliation, kernel/economic boundaries, PostgreSQL, and regression evidence.
Required Verification: static architecture checks, unit/PG tests, VPP integration, anti-dependency tests, CI, Architect Review.
Definition of Done: W003 criteria verified and merged.

### WORK-004 — Runtime Registry Bootstrap Reliability

Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
Dependencies: `WORK-003`
Requirements: `BASE-001` through `BASE-003`.
Objective: restore runtime registry bootstrap/resolution behavior.
Repository Scope: runtime/bootstrap code and targeted tests.
Architecture Constraints: preserve three runtime kinds, isolation, singleton behavior, vertical neutrality.
Out of Scope: runtime redesign and unrelated subsystems.
Acceptance Criteria: `W004-AC01` through `W004-AC09`.
Required Verification: runtime resolution, registry stability, dependent integration tests, architecture checks, CI, Architect Review.
Definition of Done: runtime registration verified and merged.

### WORK-005 — Integration Test Fixture and Prerequisite Reliability

Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
Dependencies: `WORK-004`
Requirements: `BASE-004` through `BASE-006`.
Objective: make affected PostgreSQL integration fixtures explicit and deterministic.
Repository Scope: affected tests/helpers only.
Architecture Constraints: no production auto-fixtures; PostgreSQL and tenant isolation remain canonical.
Out of Scope: production work and schema redesign.
Acceptance Criteria: `W005-AC01` through `W005-AC08`.
Required Verification: affected PG suites, isolation tests, validator, exact scope, Architect Review.
Definition of Done: fixture failures eliminated and verified.

### WORK-006 — Baseline Typecheck and Architecture Contract Recovery

Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
Dependencies: `WORK-005`
Requirements: `BASE-007` through `BASE-010`.
Objective: eliminate in-scope baseline Typecheck and Architecture Contract failures without redesign.
Repository Scope: minimal production/type-contract corrections and related tests.
Architecture Constraints: preserve runtime, economic, Data Plane, and vertical-neutrality boundaries.
Out of Scope: new primitives, broad refactors, compiler suppression.
Acceptance Criteria: `W006-AC01` through `W006-AC10`.
Required Verification: baseline captures, Typecheck, architecture tests, PG, validator, lint, scope, Architect Review.
Definition of Done: in-scope baseline failures eliminated and verified.

### WORK-007 — Typecheck Residual Closure and TypeScript Project Boundaries

Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
Dependencies: `WORK-006`
Requirements: `BASE-011` through `BASE-014`.
Objective: close residual Typecheck failures and establish explicit TS project boundaries.
Repository Scope: VPP typing defect, TS configuration, targeted tests/CI.
Architecture Constraints: no suppression, no architecture redesign.
Out of Scope: new domain/network features.
Acceptance Criteria: `W007-AC01` through `W007-AC10`.
Required Verification: Typecheck, boundary tests, architecture/PG/validator/lint/scope gates, Architect Review.
Definition of Done: Typecheck clean and residuals classified.

### WORK-008 — Architecture Truth Reconciliation and Verified-Evidence Promotion

Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
Dependencies: `WORK-007`
Requirements: `BASE-015`, governance requirements.
Objective: reconcile verified repository reality into the current domain planning layer.
Repository Scope: specification and reconciliation evidence only.
Architecture Constraints: V2 frozen; unrelated future primitives remain future.
Out of Scope: production code and unrelated promotions.
Acceptance Criteria: `W008-AC01` through `W008-AC08`.
Required Verification: truth inventory, historical preservation, regression tests, full gates, Architect Review.
Definition of Done: truth drift reconciled and verified.

### WORK-009 — Transform Stack Architecture Freeze

Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Domain Architecture: `IAAS-DOM-ARCH-3` (FROZEN)
Dependencies: `WORK-008`
Requirements: `BASE-016`, `ACR-002` (APPROVED).
Objective: freeze the Transform → Registry → Runtime → Record boundary without implementation.
Repository Scope: architecture/specification/tests only.
Architecture Constraints: V2 immutable; no production TransformRegistry/Runtime implementation in this slice.
Out of Scope: production implementation, marketplace, SDK, sandbox, signatures.
Acceptance Criteria: `W009-AC01` through `W009-AC08`.
Required Verification: ACR traceability, V3 consistency, responsibility separation, regression tests, CI, scope, Architect Review.
Definition of Done: V3 frozen and verified.

### WORK-010 — TransformRegistry Implementation

Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Domain Architecture: `IAAS-DOM-ARCH-3` (FROZEN)
Dependencies: `WORK-009`
Requirements: `BASE-017`, `DOM-015`.
Objective: implement the generic service-layer TransformRegistry.
Repository Scope: service, persistence, tests, architecture checks.
Architecture Constraints: tenant-scoped catalog only; no execution; PostgreSQL durable source; no kernel/vertical/economic/data-plane coupling.
Out of Scope: Runtime, concrete transforms, marketplace, SDK, sandbox, signatures.
Acceptance Criteria: `W010-AC01` through `W010-AC08`.
Required Verification: unit/PG/tenant/concurrency/anti-dependency tests, validator, Typecheck, lint, CI, Architect Review.
Definition of Done: Registry verified and merged.

### WORK-011 — TransformRuntime Implementation

Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Domain Architecture: `IAAS-DOM-ARCH-3` (FROZEN)
Dependencies: `WORK-010`
Requirements: `DOM-016`.
Objective: implement the service-layer TransformRuntime.
Repository Scope: Runtime service, tests, architecture evidence.
Architecture Constraints: resolve only through Registry; emit immutable TransformRecord; no catalog ownership; no vertical/economic/data-plane/kernel coupling.
Out of Scope: concrete transforms, marketplace, SDK, sandbox, signatures.
Acceptance Criteria: `W011-AC01` through `W011-AC10`.
Required Verification: unit/PG/idempotency/failure/provenance/anti-dependency tests plus all gates.
Definition of Done: Runtime verified and merged.

### WORK-012 — Transform Stack Truth Synchronization

Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Domain Architecture: `IAAS-DOM-ARCH-3` (FROZEN)
Dependencies: `WORK-011`
Requirements: truth synchronization; governance requirements.
Objective: reconcile V3 specifications with verified Transform Stack reality.
Repository Scope: `spec/` and regression tests only.
Architecture Constraints: V3 remains frozen; no promotion of DOM-P04..P08.
Out of Scope: production behavior and architecture changes.
Acceptance Criteria: `W012-AC01` through `W012-AC06`.
Required Verification: validator, truth-regression tests, architecture/Typecheck/PG/lint/scope gates, Architect Review.
Definition of Done: V3 synchronized and verified.

### WORK-013 — Transform Stack End-to-End Conformance and Integration Hardening

Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Domain Architecture: `IAAS-DOM-ARCH-3` (FROZEN)
Dependencies: `WORK-012`
Requirements: `DOM-014` through `DOM-017`.
Objective: prove Registry → Runtime → Record works as one coherent subsystem.
Repository Scope: conformance tests, architecture regression tests, CI/test configuration, evidence.
Architecture Constraints: Registry is catalog authority; Runtime is executor; Record is immutable provenance; PostgreSQL durable; no vertical/economic/data-plane/kernel coupling; no concrete transform.
Out of Scope: new Transform primitives, architecture changes, concrete transforms, marketplace, SDK, sandbox, economic/data-plane redesign.
Acceptance Criteria: `W013-AC01` through `W013-AC11`.
Required Verification: end-to-end PG tests, tenant isolation, idempotency, failure/provenance, anti-dependency tests, validator, Typecheck, architecture suite, lint, scope, Architect Review.
Definition of Done: W013 objectively verified; PR merged; Work Item VERIFIED by the Architect.

## WORK-014 — Extension Stack Architecture and ACR-003

Status: `READY`

Architecture Version: `IAAS-GOV-ARCH-1`

Domain Architecture: `IAAS-DOM-ARCH-3` (FROZEN)

Architecture Change Request: `ACR-003` (DRAFT)

Dependencies: `WORK-013`

Requirements: `ACR-003`; `GOV-001`, `GOV-003`, `GOV-005`, `GOV-006`, `GOV-008`; historical `DOM-P04`.

Objective: produce a complete, reviewable Extension Stack architecture proposal for Extension, ExtensionRegistry, and ExtensionRuntime and prepare candidate `IAAS-DOM-ARCH-4` without implementing extensions or silently promoting DOM-P04.

Repository Scope: `spec/` architecture/change-control documents, regression tests, dependency graph, Work Item/Work Order records, and validation evidence.

Architecture Constraints: V3 remains FROZEN until an explicit ACR approval and new architecture freeze; DOM-P04 remains FUTURE/OPEN/RESEARCH; no production implementation; no Prisma changes; no sandbox technology selection; no marketplace/SDK/concrete extensions; no Transform Stack boundary changes.

Out of Scope: Extension production code, sandbox implementation/selection, marketplace, SDK, licensing, economic attribution, cryptographic certification mechanism, schema redesign, and DOM-P05..P08 promotion.

Acceptance Criteria:
- `W014-AC01` ACR-003 has explicit scope, non-goals, questions, and promotion rule.
- `W014-AC02` Extension identity/versioning, capability, compatibility, lifecycle, revocation, and failure semantics are explicit.
- `W014-AC03` Registry is discovery/catalog/lifecycle authority and never executes.
- `W014-AC04` Runtime is execution/isolation authority and never owns catalog state.
- `W014-AC05` tenancy, capabilities, resource limits, and security/isolation are explicit without premature sandbox selection.
- `W014-AC06` anti-dependencies to vertical/economic/data-plane/runtime/kernel layers are explicit and testable.
- `W014-AC07` Extension and Transform responsibilities remain distinct.
- `W014-AC08` DOM-P04 remains future until ACR-003 is approved and V4 is frozen.
- `W014-AC09` no production/Prisma/V3 mutation is introduced by the proposal.
- `W014-AC10` specification/architecture/lint/typecheck/scope gates pass.
- `W014-AC11` Architect explicitly approves or returns ACR-003; no implementation Work Item is released automatically.

Required Verification: ACR completeness; candidate V4 consistency; responsibility separation; security/tenant/lifecycle invariants; anti-dependencies; V3 immutability; DOM-P04 non-promotion; validator; Typecheck; Architecture Contract Tests; lint; scope; Architect Review.

Definition of Done: ACR-003 and candidate V4 are complete and reviewable; no production implementation; gates green; Architect issues the explicit ACR/architecture verdict; no subsequent implementation starts automatically.
