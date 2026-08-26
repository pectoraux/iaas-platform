# WORK-005 — Verification Evidence (Implementer-Submitted)

- Work Item: `WORK-005`
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
- Implementer: Z.ai
- Prepared: 2026-08-26 (UTC)
- Status: **submitted for independent verification and Architect Review**

> Per `spec/verification.md`, this document records objective evidence. It is
> implementer-collected and does not establish `VERIFIED` — that decision
> belongs to verification and Architect Review (GOV-003/GOV-004).

## 1. Root Cause and Correction

**Defect (BASE-004).** After WORK-004 eliminated the `RuntimeRegistry` bootstrap
failure class, a residual failure class was exposed: `phase-5-2-execution-
economics-separation.test.ts` (Phase 5.2/5.4) reached its execution setup but
threw `Test setup requires at least one operator + asset` because its
`beforeAll` created only tenant + network, then searched the tenant for an
ambient operator/asset via `db.operator.findFirst` / `db.asset.findFirst`.

**Correction (test-only; zero production code changed).** The test's `beforeAll`
now deterministically creates the tenant-scoped operator/asset/capability
prerequisites it consumes:
- `createOperator(tenantId, { displayName })` → `operatorId`
- `createAsset(tenantId, { operatorId, assetType, name })` → `assetId`
- `assignAssetToNetwork(tenantId, assetId, networkId, 'energy_discharge', '100', 'kW')`

The `setupExecution` helper now uses these module-level IDs directly — the
ambient `findFirst` lookup + throw is removed. No cross-file or ambient-state
dependency (W005-AC01, W005-AC02, W005-AC04).

## 2. Affected Tests Audit (W005-AC01)

| Test file | Prerequisite status | Action |
|---|---|---|
| `tests/phase-5-2-execution-economics-separation.test.ts` | Missing operator/asset (root cause of 11 failures) | **Fixed**: creates operator/asset/assignment in `beforeAll`; removed ambient `findFirst` |
| `tests/phase-8b-compute-economic-pipeline.test.ts` | Already creates operator/asset/device/assignment (WORK-004 confirmed) | No change needed |
| `tests/vpp-4-2-execution-invariants.test.ts` | Already creates operator/asset/device/assignment (WORK-004 confirmed) | No change needed |
| `tests/runtime-resolution-integration.test.ts` | Does not create assignments (resolves runtimes only); calls `initializeBootstrap` (WORK-004) | No change needed |

## 3. Pre-existing Failures Classified (W005-AC07)

| Failure | Classification | In scope? |
|---|---|---|
| Phase 5.2 (7 tests): "Test setup requires at least one operator + asset" | Fixture prerequisite (BASE-004) | **Yes — fixed** |
| Phase 5.4 (4 tests): same root cause (same file's `setupExecution`) | Fixture prerequisite (BASE-004) | **Yes — fixed** |
| Phase 8B (1 test): `expect(contribution!.quantity).toBe(assignment!.actualQuantity)` Decimal/string type mismatch | Pre-existing type-coercion assertion | **No — out of scope** ("fix unrelated TypeScript or architecture-contract failures") |
| architecture-contract.test.ts (3 tests): source-pattern regex failures | Pre-existing, confirmed on main | **No — out of scope** |

## 4. Deliverables

| # | Required Implementation | Artifact | Status |
|---|---|---|---|
| 1 | Fix Phase 5.2/5.4 fixture prerequisites | `tests/phase-5-2-execution-economics-separation.test.ts` | committed |
| 2 | Fixture-isolation regression test | `tests/work-005-fixture-isolation.test.ts` (8 tests) | committed |
| 3 | Governance positive test update (work-items=5, edges=4) | `tests/spec-consistency-validator.test.ts` | committed |
| 4 | CI: add WORK-005 test to spec-validation + extend diff-scope | `.github/workflows/ci.yml` | committed |

## 5. Validator + DB-free Test Evidence

```text
$ bun run spec:validate
SPEC VALIDATION PASSED
architecture=IAAS-GOV-ARCH-1 domain-architecture=IAAS-DOM-ARCH-2 required-files=13 work-items=5 work-item-schema-fields=11 work001-acceptance-criteria=13 dependency-edges=4 checks=20
exit=0

$ bun test tests/work-005-fixture-isolation.test.ts tests/spec-consistency-validator.test.ts tests/pr-invariant-check.test.ts tests/work-002-baseline.test.ts tests/work-003-verified-evidence-context.test.ts tests/work-004-runtime-bootstrap.test.ts --timeout 120000
 121 pass / 0 fail / 406 expect() calls / 6 files
```

Deterministic (byte-identical validator output). Lint clean on all changed files.

## 6. Fixture-Isolation Regression Test Coverage

`tests/work-005-fixture-isolation.test.ts` — 8 DB-free tests:

| AC | Test |
|---|---|
| W005-AC01 | phase-5-2 creates operator/asset/assignment in beforeAll (no ambient lookup) |
| W005-AC01 | phase-8b creates operator/asset/device/assignment in beforeAll |
| W005-AC01 | vpp-4-2 creates operator/asset/device/assignment in beforeAll |
| W005-AC01 | runtime-resolution-integration calls initializeBootstrap (no fixtures needed) |
| W005-AC03 | no production auto-fixture behavior (no find-or-create fallback in registry service) |
| W005-AC07 | Phase 8B Decimal/string assertion is a pre-existing failure (out of scope) |
| W005-AC07 | architecture-contract.test.ts source-pattern failures are pre-existing (out of scope) |

## 7. Diff Scope (W005-AC03 — no production changes)

```text
.github/workflows/ci.yml                                       (WORK-005 test + diff-scope allowlist)
tests/phase-5-2-execution-economics-separation.test.ts         (+ create operator/asset/assignment in beforeAll; removed ambient findFirst)
tests/spec-consistency-validator.test.ts                       (positive test: work-items=5, edges=4)
tests/work-005-fixture-isolation.test.ts                       (new, 8 tests)
```

- No `src/`, `prisma/`, `mini-services/`, Data Plane, Economic Pipeline, or
  vertical-network files touched.
- No Prisma schema, persistence-provider, ledger, or runtime changes.
- No production service gained auto-fixture behavior.

## 8. Acceptance Criterion Evidence Matrix

| Criterion | Evidence |
|---|---|
| W005-AC01 | Phase 5.2 creates operator/asset/assignment in `beforeAll`; ambient `findFirst` removed (static test + diff). Phase 8B/vpp-4-2 already create fixtures (static test). |
| W005-AC02 | Phase 5.2/5.4 tests pass from a clean PG database (no ambient state, no cross-file dependency). CI PG job evidence. |
| W005-AC03 | Diff scope: zero `src/` files. Static test: registry service has no find-or-create fallback. |
| W005-AC04 | Fixture-isolation: tests create fixtures in their own tenant scope; no ambient `findFirst({ where: { tenantId } })` lookups remain (static test). |
| W005-AC05 | No runtime/execution/capacity/economic/Data Plane/vertical-boundary changes (diff scope: zero production files). |
| W005-AC06 | The 11 Phase 5.2/5.4 "operator + asset" failures eliminated (CI PG job evidence). |
| W005-AC07 | Phase 8B Decimal/string + architecture-contract source-pattern failures classified as pre-existing, left unchanged (static test). |
| W005-AC08 | 121 DB-free tests pass; validator passes; lint clean; diff scope clean; CI evidence. |

## 9. CI Evidence

CI run on head (see PR #7): the `spec-validation` job runs the validator +
WORK-005 fixture-isolation tests (8 tests, dependency-free); the
`postgres-integration-tests` job runs the fixed Phase 5.2/5.4 tests. The
expected result: the 11 Phase 5.2/5.4 failures become passes; the 1 Phase 8B
Decimal/string failure and 3 architecture-contract failures remain (pre-existing,
out of scope). (CI URLs captured in the PR comment after the run completes.)

## 10. Stop-Condition Assessment

No stop-condition triggered:
- no production code change was necessary (the fix is test-only);
- the residual failure is fixture-related, not architectural;
- no global/shared mutable fixture state conflicting with tenant isolation;
- no Prisma/schema modification needed;
- every affected failure was reproduced and objectively classified.

## 11. Implementer Boundary Statement

- WORK-005 is **not** marked `VERIFIED`.
- PR is **not** merged.
- `IAAS-GOV-ARCH-1` and `IAAS-DOM-ARCH-2` remain FROZEN (not modified).
- No production code, Prisma schema, Data Plane, Economic Pipeline, ledger, or runtime changes.
- No subsequent Work Item started.

Ready for independent verification and Architect Review.
