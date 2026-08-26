# WORK ORDER — WORK-005

## Identity

- Work Item: `WORK-005`
- Title: Integration Test Fixture and Prerequisite Reliability
- Governing Architecture Version: `IAAS-GOV-ARCH-1`
- Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
- Implementer: Z.ai
- Architect / Reviewer: Chief Architect

## Objective

Restore the remaining PostgreSQL integration-test baseline by making tenant-scoped operator/asset prerequisites explicit and deterministic in the affected tests, without changing IAAS production behavior or architecture.

## Evidence Basis

WORK-004 eliminated the `RuntimeRegistry` bootstrap failure class. The residual PostgreSQL failures are a different class: affected tests reach their execution setup but fail because required operator/asset fixtures are absent from the tenant when the test attempts to construct generic execution assignments or related capacity state.

Observed evidence includes the existing Phase 5.2 helper, which searches the test tenant for an operator and asset and throws when either is absent, while its `beforeAll` currently creates only the tenant/network. The Phase 8B/8C and related integration tests must likewise establish every prerequisite they consume rather than assuming global/shared fixture state.

## Requirements

- `BASE-004`
- `BASE-005`
- `BASE-006`
- inherited PostgreSQL, tenant isolation, generic Execution, and runtime boundaries from `IAAS-DOM-ARCH-2`

## Required Implementation

1. Audit every affected PostgreSQL integration test named by the residual failure evidence (Phase 5.2/5.4, Phase 8B/8C, and any directly-cascading fixture failures) and identify the exact missing prerequisite.
2. Ensure each affected test creates or deterministically provisions the operator/asset/device/capability fixtures it requires inside its own tenant scope, or uses an existing shared fixture helper if one already exists and is proven deterministic.
3. Preserve test isolation: one test file must not depend on records created by another test file.
4. Preserve the existing production service contracts. Do not add production fallbacks that silently create operators/assets for real callers.
5. Add regression coverage proving the affected tests pass from a clean PostgreSQL database and proving tenant isolation.
6. Update CI only as necessary to execute the new fixture regression tests.

## Acceptance Criteria

### W005-AC01

Every affected integration test explicitly establishes the operator/asset/device/capability prerequisites it consumes, or uses an existing deterministic fixture helper.

### W005-AC02

The affected PostgreSQL integration tests pass from a clean PostgreSQL database without relying on execution order or state created by another test file.

### W005-AC03

No production IAAS service is changed solely to compensate for missing test fixtures.

### W005-AC04

Tenant-scoped fixture isolation is mechanically tested; a fixture from another tenant cannot satisfy an affected test's prerequisite lookup.

### W005-AC05

The fix does not weaken runtime, execution, capacity, economic, Data Plane, or vertical-boundary contracts.

### W005-AC06

The residual `operator + asset` setup-failure class identified after WORK-004 is eliminated for the affected tests.

### W005-AC07

All unrelated pre-existing failures remain explicitly classified and are not silently modified.

### W005-AC08

Objective evidence is complete: targeted PostgreSQL tests, fixture-isolation regression tests, CI evidence, and exact diff scope.

## Repository Scope

Expected areas:

- affected PostgreSQL integration tests under `tests/`
- existing test fixture utilities/helpers under `tests/` only if a deterministic shared helper is warranted
- targeted CI test selection if required
- WORK-005 evidence document
- governance/specification test updates required by the new Work Item

## Architecture Constraints

- `IAAS-GOV-ARCH-1` remains FROZEN.
- `IAAS-DOM-ARCH-2` remains FROZEN.
- PostgreSQL remains the canonical integration-test database.
- Tenant isolation remains mandatory.
- Do not add production auto-fixture behavior.
- Do not alter RuntimeRegistry bootstrap semantics.
- Do not modify Data Plane, Economic Pipeline, ledger, runtime boundaries, or network architecture.

## Out of Scope

Do not:

- change production services merely to satisfy tests;
- redesign the fixture model globally without evidence;
- introduce a new persistence abstraction;
- modify Prisma schema unless an already-existing test-only schema fact proves unavoidable (stop and escalate before schema work);
- fix unrelated TypeScript or architecture-contract failures;
- implement a new network feature;
- start WORK-006 or any other Work Item;
- change frozen architecture documents.

## Required Tests

- affected Phase 5.2/5.4 PostgreSQL tests;
- affected Phase 8B/8C PostgreSQL tests;
- fixture-isolation test proving tenant A fixtures cannot satisfy tenant B lookups;
- clean-database execution test or equivalent CI evidence proving no cross-file fixture dependency;
- full governance specification validator;
- scope/diff verification.

## Stop Conditions

Stop and report to the Architect if:

- a production code change appears necessary to make the tests pass;
- the residual failure is actually architectural rather than fixture-related;
- the test suite requires global/shared mutable fixture state that conflicts with tenant isolation;
- a Prisma/schema modification appears necessary;
- an affected failure cannot be reproduced or objectively classified.

## Definition of Done

1. Affected integration tests establish their own prerequisites deterministically.
2. Residual operator/asset fixture failures are eliminated.
3. Tenant isolation is regression-tested.
4. No production behavior or frozen architecture changes.
5. Targeted PostgreSQL and fixture tests pass on clean CI.
6. Evidence is recorded.
7. PR is submitted for independent Architect Review.
8. Z.ai does not mark WORK-005 VERIFIED or start another Work Item.
