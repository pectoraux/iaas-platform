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

## BASE-001 — Runtime Bootstrap Resolution

The intended IAAS bootstrap path MUST register the implemented runtime kinds required by published `NetworkVersion.runtimeKind` values so `RuntimeRegistry.resolve()` can return the canonical runtime implementation.

Acceptance: `W004-AC01` infrastructure resolves; `W004-AC02` protocol resolves; `W004-AC03` registry stability is preserved.

## BASE-002 — Runtime Boundary Preservation

Restoring runtime registration MUST NOT alter the frozen InfrastructureRuntime / ProtocolRuntime / HybridRuntime boundaries or introduce vertical-specific runtime dependencies.

Acceptance: `W004-AC04` and `W004-AC07` pass through static architecture evidence.

## BASE-003 — Baseline Regression Recovery

The repository's existing runtime-resolution dependent tests MUST no longer fail solely because runtime registries are empty at execution time.

Acceptance: `W004-AC05` and `W004-AC06` pass with CI evidence.

## BASE-004 — Deterministic Integration Fixtures

Affected PostgreSQL integration tests MUST explicitly establish the tenant-scoped operator/asset/device/capability fixtures they consume, or use a deterministic helper that does so.

Acceptance: `W005-AC01` and `W005-AC02` pass.

## BASE-005 — Fixture Isolation

Integration-test fixture lookup MUST NOT permit records from another tenant or another test file to satisfy a test's prerequisite lookup.

Acceptance: `W005-AC04` passes through an explicit tenant-isolation regression test and clean-database evidence.

## BASE-006 — Baseline Failure Containment

The fixture correction MUST remain test-only and MUST NOT weaken production runtime, execution, capacity, economic, Data Plane, or vertical-boundary contracts.

Acceptance: `W005-AC03`, `W005-AC05`, `W005-AC06`, and `W005-AC07` pass with exact diff and CI evidence.

## BASE-007 — Typecheck Cleanliness

The repository MUST have no TypeScript compiler errors attributable to the current implementation baseline. Compiler failures MUST be classified before correction, and fixes MUST preserve frozen architectural contracts.

Acceptance: `W006-AC01` and `W006-AC02` pass with clean-main baseline capture and final `tsc --noEmit` evidence.

## BASE-008 — Architecture Contract Integrity

The Architecture Contract Test suite MUST pass without weakening or bypassing its frozen architectural assertions. Stale assertions may be corrected only when repository evidence proves the assertion no longer reflects the frozen architecture.

Acceptance: `W006-AC03` and `W006-AC04` pass with complete architecture-contract evidence.

## BASE-009 — Regression-Safe Corrections

Every production/type-contract correction made under WORK-006 MUST have targeted regression coverage and MUST NOT introduce new vertical, runtime, economic, or Data Plane coupling.

Acceptance: `W006-AC05` and `W006-AC06` pass through targeted tests, architecture checks, and exact diff inspection.

## BASE-010 — Residual Baseline Transparency

Any remaining Typecheck or Architecture Contract failure outside WORK-006 scope MUST be explicitly classified, evidenced, and assigned to a later bounded Work Item rather than silently ignored.

Acceptance: `W006-AC08` and `W006-AC09` pass through the WORK-006 residual-baseline evidence.

## BASE-011 — Baseline Engine Type Safety

Production dynamic imports MUST expose their types through supported TypeScript constructs; namespace-style typing of a runtime import MUST NOT produce compiler errors or require suppression.

Acceptance: `W007-AC01` and `W007-AC02` pass with targeted regression evidence.

## BASE-012 — Explicit TypeScript Project Boundaries

The repository MUST explicitly distinguish the IAAS application TypeScript project from auxiliary TypeScript trees. A project is either compiled by the root application configuration or validated by its own explicit project configuration.

Acceptance: `W007-AC03` passes with configuration inspection and executable compiler evidence.

## BASE-013 — No Silent Auxiliary-Code Exclusion

Auxiliary examples/skills MUST NOT be removed from compiler coverage through unexplained broad exclusions. Any exclusion MUST correspond to an explicit project-boundary decision with its own validation or documented non-project classification.

Acceptance: `W007-AC04` and `W007-AC09` pass.

## BASE-014 — Residual Typecheck Closure

The final IAAS application Typecheck MUST be clean while all other CI gates remain green.

Acceptance: `W007-AC05` through `W007-AC08` pass with Typecheck, Architecture Contract, PostgreSQL, validator, lint, and regression evidence.

## BASE-015 — Architecture Truth Synchronization

The canonical planning/specification layer MUST accurately reflect verified repository reality. When a previously-PROPOSED architectural primitive is promoted via an approved ACR, a frozen new architecture version, and a VERIFIED Work Item, the historical V1-derived requirements MUST mark it as SUPERSEDED (not silently rewritten) and the current canonical requirements MUST classify it as implemented/verified. No unrelated FUTURE/PROPOSED item may be promoted without its own verified architecture decision.

Acceptance: `W008-AC01` through `W008-AC06` pass with truth-drift inventory, cross-document consistency evidence, and regression protection.

## BASE-016 — Transform Stack Architecture Freeze

The TransformRegistry and TransformRuntime boundaries MAY be promoted from FUTURE to a new frozen domain architecture only through an explicit Architecture Change Request and architecture-version Work Item. Their production implementation is prohibited until that architecture version is VERIFIED.

Acceptance: `W009-AC01` through `W009-AC08` pass with an approved ACR-002, explicit IAAS-DOM-ARCH-3 contract, frozen dependency boundaries, and no production implementation changes during the architecture-freeze Work Item.

## WORK-001 Freeze

No production IAAS feature is authorized by these requirements. Domain requirements are derived by WORK-002 after baseline audit.
