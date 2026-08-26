# WORK ORDER — WORK-007

## Identity

- Work Item: `WORK-007`
- Title: Typecheck Residual Closure and TypeScript Project Boundaries
- Governing Architecture Version: `IAAS-GOV-ARCH-1`
- Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
- Implementer: Z.ai
- Architect / Reviewer: Chief Architect

## Objective

Close the five residual Typecheck failures left after WORK-006 without weakening the compiler gate: fix the genuine production `baselineEngine` defect and establish explicit, testable TypeScript project boundaries for `examples/` and `skills/` rather than silently excluding broken code.

## Requirements

- `BASE-011` through `BASE-014`
- inherited frozen runtime, vertical-neutrality, and repository-governance boundaries.

## Required Implementation

1. Reproduce the exact residual Typecheck failures on clean `main`.
2. Fix `src/lib/services/vpp.service.ts` `baselineEngine` namespace typing using a type-safe dynamic-import pattern that preserves the existing runtime semantics and avoids `any`/suppression.
3. Audit `examples/` and `skills/` to determine whether they are first-class TypeScript projects, auxiliary scripts, or intentionally non-compiled repository material.
4. Establish explicit TypeScript project boundaries. If auxiliary trees are intentionally outside the IAAS application compiler, encode that decision explicitly with appropriate tsconfig/project configuration and dedicated validation where applicable; do not merely hide arbitrary errors with broad excludes.
5. For any auxiliary tree intentionally retained as a TypeScript project, make its compiler dependencies/contracts valid or add its own bounded compiler configuration.
6. Add regression coverage for the production `baselineEngine` typing fix and for the TypeScript project-boundary decision.
7. Preserve the existing PostgreSQL, Architecture Contract, runtime, economic, and Data Plane gates.

## Acceptance Criteria

### W007-AC01

The clean-main residual Typecheck failures are reproduced and classified with concrete evidence.

### W007-AC02

The `baselineEngine` production Typecheck failure is eliminated without `any`, `@ts-ignore`, or equivalent suppression, while preserving the existing dynamic-import behavior.

### W007-AC03

The TypeScript compiler scope of the repository is explicit: the IAAS application compiler has a deliberate boundary, and auxiliary TypeScript trees have either their own valid compiler gate or an explicit non-application classification.

### W007-AC04

No broken auxiliary TypeScript code is silently hidden by an unexplained broad exclusion.

### W007-AC05

Final IAAS application `tsc --noEmit` is clean.

### W007-AC06

Architecture Contract Tests, PostgreSQL integration tests, specification validation, and lint remain green.

### W007-AC07

The fix preserves frozen runtime architecture, vertical neutrality, and Data Plane ↔ Economic Pipeline independence.

### W007-AC08

Regression tests objectively prove the `baselineEngine` typing boundary and the intended TypeScript project-boundary behavior.

### W007-AC09

Residual auxiliary-project failures, if any, are explicitly classified and assigned rather than concealed.

### W007-AC10

No frozen architecture version is modified and no ACR is required unless a genuine architectural contradiction is demonstrated.

## Repository Scope

Expected areas:

- `src/lib/services/vpp.service.ts` and directly related production TypeScript types;
- root and auxiliary `tsconfig*.json` / TypeScript project configuration only as required to establish explicit boundaries;
- targeted `examples/` / `skills/` configuration or tests if those trees are declared maintained TypeScript projects;
- targeted regression tests;
- CI/test configuration required to validate the project boundaries;
- `spec/evidence/WORK-007-verification-evidence.md`;
- governance/specification tests required solely because WORK-007 is issued.

## Architecture Constraints

- `IAAS-GOV-ARCH-1` remains FROZEN.
- `IAAS-DOM-ARCH-2` remains FROZEN.
- Do not change RuntimeRegistry, InfrastructureRuntime, ProtocolRuntime, HybridRuntime, Economic Pipeline, Data Plane, ledger, or Prisma schema.
- Generic kernel/runtime code remains vertical-neutral.
- PostgreSQL remains canonical.
- Do not weaken TypeScript strictness or introduce compiler-wide suppression.

## Out of Scope

Do not:

- implement new domain primitives or network features;
- redesign the runtime/economic/data-plane architecture;
- add unrelated dependencies solely to make examples compile unless those examples are explicitly declared maintained project surfaces and the dependency is justified;
- suppress errors with `any`, `@ts-ignore`, `@ts-expect-error`, `skipLibCheck`, or broad unexplained exclusions;
- modify frozen architecture documents;
- start WORK-008 or any other Work Item.

## Required Verification

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

## Stop Conditions

Stop and report to the Architect if:

- the baselineEngine fix requires changing a frozen architecture rule;
- auxiliary-project boundary work would conceal maintained code without an explicit project decision;
- a schema or runtime architecture change appears necessary;
- fixing the residuals requires broad refactoring;
- remaining failures cannot be objectively classified.

## Definition of Done

1. Residual Typecheck failures are objectively classified.
2. Production `baselineEngine` typing defect is fixed with regression evidence.
3. TypeScript project boundaries are explicit and validated.
4. IAAS application Typecheck is clean.
5. Architecture Contract, PostgreSQL, specification validation, and lint remain green.
6. No frozen architecture changes.
7. Evidence is recorded.
8. PR submitted for independent Architect Review.
9. Z.ai does not mark WORK-007 VERIFIED or start another Work Item.
