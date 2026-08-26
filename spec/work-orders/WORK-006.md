# WORK ORDER — WORK-006

## Identity

- Work Item: `WORK-006`
- Title: Baseline Typecheck and Architecture Contract Recovery
- Governing Architecture Version: `IAAS-GOV-ARCH-1`
- Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
- Implementer: Z.ai
- Architect / Reviewer: Chief Architect

## Objective

Restore the repository's remaining baseline engineering gates by eliminating the actual TypeScript/compiler failures and the remaining Architecture Contract Test failures, while preserving the frozen IAAS architecture and avoiding unrelated feature work.

## Evidence Basis

After WORK-004 and WORK-005:

- PostgreSQL integration tests are green.
- The dedicated specification validator is green.
- The remaining CI failures are concentrated in `Typecheck` and `Architecture Contract Tests`.
- The Architecture Contract suite currently contains three known failures inherited from the pre-WORK-004 baseline; they must be audited rather than assumed to be obsolete.

## Requirements

- `BASE-007` through `BASE-010`
- inherited boundaries from `IAAS-GOV-ARCH-1` and `IAAS-DOM-ARCH-2`

## Required Implementation

1. Capture the exact current TypeScript failure set on clean `main` before modification.
2. Classify each TypeScript failure as one of:
   - stale test/tooling assumption;
   - incorrect type contract;
   - missing/incorrect declaration;
   - genuine production implementation defect;
   - unrelated baseline issue requiring a new Work Item.
3. Capture the exact current Architecture Contract Test failures and classify each similarly.
4. Correct only failures that belong to this Work Item.
5. Where a test encodes a stale architectural expectation, update the test to match the frozen architecture rather than weakening production behavior.
6. Where production code violates a frozen architecture or has an objectively incorrect type contract, make the minimal production correction and add regression coverage.
7. Do not redesign architecture, introduce new primitives, or broaden the runtime/economic/data-plane boundaries.
8. Produce a residual-baseline report listing every failure that remains after WORK-006 and the reason it is outside scope.

## Acceptance Criteria

### W006-AC01

The TypeScript compiler failure set is captured from clean `main`, classified, and traced to concrete files/errors.

### W006-AC02

Every TypeScript failure within WORK-006 scope is eliminated; `tsc --noEmit` produces no errors attributable to WORK-006.

### W006-AC03

All Architecture Contract Test failures are captured and classified against the frozen architecture.

### W006-AC04

Every Architecture Contract Test failure within WORK-006 scope is eliminated without weakening a frozen architecture rule.

### W006-AC05

If production code changes are necessary, they are minimal, directly justified by a frozen contract or real type defect, and covered by regression tests.

### W006-AC06

No change introduces vertical-specific imports into generic kernel/runtime code, weakens runtime isolation, or couples Data Plane and Economic Pipeline layers.

### W006-AC07

PostgreSQL integration tests remain green after the changes.

### W006-AC08

The repository's specification validator, architecture tests, typecheck, lint, and targeted regression tests provide objective evidence for the final state.

### W006-AC09

Every residual failure not fixed by WORK-006 is documented with evidence and a reason it belongs in a later Work Item rather than being silently ignored.

### W006-AC10

No frozen architecture version is modified in place and no Architecture Change Request is required unless the implementer proves a genuine architectural contradiction.

## Repository Scope

Expected areas:

- `src/` only where an actual compiler/type/architecture defect is demonstrated;
- `tests/architecture-contract.test.ts` and directly related tests when their assertions are stale or incorrect;
- targeted test files required for regression coverage;
- CI/test configuration only where required to execute the corrected gates;
- `spec/evidence/WORK-006-verification-evidence.md`;
- governance/specification test updates required solely because WORK-006 is issued.

## Architecture Constraints

- `IAAS-GOV-ARCH-1` remains FROZEN.
- `IAAS-DOM-ARCH-2` remains FROZEN.
- Preserve InfrastructureRuntime / ProtocolRuntime / HybridRuntime boundaries.
- Preserve Data Plane ↔ Economic Pipeline independence.
- Generic kernel/runtime code remains vertical-neutral.
- PostgreSQL remains canonical.
- Do not introduce silent runtime registration or production-only test fixtures.

## Out of Scope

Do not:

- implement new domain primitives or network features;
- redesign the runtime, economic, data-plane, transform, extension, marketplace, or SDK architecture;
- change Prisma schema unless a genuine existing type contract proves unavoidable (stop and escalate first);
- fix unrelated business logic or product defects;
- suppress compiler errors with `any`, `@ts-ignore`, `skipLibCheck`, or equivalent weakening unless explicitly proven necessary and architect-approved;
- modify frozen architecture documents;
- start WORK-007 or any other Work Item.

## Required Tests

- clean-main baseline TypeScript capture;
- `bunx tsc --noEmit` on final tree;
- complete Architecture Contract Test suite;
- targeted regression tests for every production/type-contract correction;
- existing PostgreSQL integration suite;
- governance specification validator;
- lint;
- exact diff/scope verification.

## Stop Conditions

Stop and report to the Architect if:

- a compiler failure requires changing a frozen architecture rule;
- a schema change appears necessary;
- an Architecture Contract Test contradicts the frozen architecture itself rather than the implementation/test;
- fixing one failure would require broad refactoring beyond the bounded corrections;
- a remaining failure cannot be objectively classified.

## Definition of Done

1. Typecheck is clean or every residual failure is explicitly classified and assigned to a later Work Item.
2. Architecture Contract Tests are clean or every residual failure is explicitly classified and assigned to a later Work Item.
3. PostgreSQL integration tests remain green.
4. No frozen architecture changed.
5. Regression evidence exists for every production correction.
6. Residual-baseline evidence is recorded.
7. PR is submitted for independent Architect Review.
8. Z.ai does not mark WORK-006 VERIFIED or start another Work Item.
