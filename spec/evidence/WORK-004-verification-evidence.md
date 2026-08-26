# WORK-004 — Verification Evidence (Implementer-Submitted)

- Work Item: `WORK-004`
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
- Implementer: Z.ai
- Prepared: 2026-08-26 (UTC)
- Status: **submitted for independent verification and Architect Review**

> Per `spec/verification.md`, this document records objective evidence. It is
> implementer-collected and does not establish `VERIFIED` — that decision
> belongs to verification and Architect Review (GOV-003/GOV-004).

## 1. Root Cause and Correction

**Defect (BASE-001).** The repository's PG integration tests (Phase 5.1, 5.2,
5.4, 8B/8C, VPP execution-invariants) call `resolveRuntime()` but never call
`initializeBootstrap()`. Per the documented bootstrap boundary
(`src/lib/bootstrap/index.ts` lines 72-73: "Called by: ... tests (directly, as
their own composition root)"), tests are their own composition root and MUST
explicitly call `initializeBootstrap()` to populate the `RuntimeRegistry`. The
DB-free `runtime-resolution.test.ts` already calls it; the PG integration tests
did not, leaving the registry empty and producing:
`No runtime registered for kind 'infrastructure'. Registered kinds: .`

**Correction.** Added `initializeBootstrap()` to the `beforeAll` of the 4
affected PG integration tests. This is the "intended bootstrap path" — no
hidden global side effects, no auto-registration in the kernel (the Phase 7.3
boundary is preserved), no architectural change. The fix is purely test-bootstrap
configuration, exactly within WORK-004's scope ("targeted CI/test bootstrap
configuration only if required for the existing architectural contract").

No production code (`src/`, `prisma/`, `mini-services/`) was modified. The
`bootstrap/index.ts`, `runtime/index.ts`, `registry.ts`, and the three runtime
implementations are unchanged.

## 2. Deliverables

| # | Required Implementation / Test | Artifact | Status |
|---|---|---|---|
| 1 | Restore bootstrap registration in PG integration tests | `initializeBootstrap()` added to `beforeAll` of 4 tests | committed |
| 2 | Phase 5.1 runtime-resolution integration test | `tests/runtime-resolution-integration.test.ts` | committed |
| 3 | Phase 5.2 exec/economics separation test | `tests/phase-5-2-execution-economics-separation.test.ts` | committed |
| 4 | Phase 8B compute economic pipeline test | `tests/phase-8b-compute-economic-pipeline.test.ts` | committed |
| 5 | VPP execution-invariants test | `tests/vpp-4-2-execution-invariants.test.ts` | committed |
| 6 | Dedicated WORK-004 regression test (registry non-empty, resolve, singleton, isolation, scope) | `tests/work-004-runtime-bootstrap.test.ts` (16 tests) | committed |
| 7 | CI: add WORK-004 test to spec-validation step + extend diff-scope allowlist | `.github/workflows/ci.yml` | committed |

## 3. Validator + DB-free Test Evidence

```text
$ bun run spec:validate
SPEC VALIDATION PASSED
architecture=IAAS-GOV-ARCH-1 domain-architecture=IAAS-DOM-ARCH-2 required-files=13 work-items=4 work-item-schema-fields=11 work001-acceptance-criteria=13 dependency-edges=3 checks=20
exit=0

$ bun test tests/work-004-runtime-bootstrap.test.ts tests/runtime-resolution.test.ts tests/spec-consistency-validator.test.ts tests/pr-invariant-check.test.ts tests/work-002-baseline.test.ts tests/work-003-verified-evidence-context.test.ts --timeout 120000
 160 pass / 0 fail / 497 expect() calls / 6 files
```

(16 new WORK-004 tests + 144 existing DB-free tests.) Deterministic
(byte-identical validator output). Lint clean on all changed files.

### Pre-existing failures (OBSERVED, out of WORK-004 scope)

`tests/architecture-contract.test.ts` has 3 pre-existing failures on `main`
(59 pass / 3 fail) — confirmed by running on clean `main` before my changes.
These are source-pattern tests (regex against `vpp.service.ts` and
`infrastructure-runtime.ts` source text) unrelated to runtime bootstrap. Per
the Work Order Out of Scope: "fix unrelated PostgreSQL integration failures
except where they disappear naturally as runtime bootstrap is restored" —
these 3 do not disappear (they're DB-free source-pattern tests, not runtime-
registration failures).

## 4. WORK-004 Regression Test Coverage

`tests/work-004-runtime-bootstrap.test.ts` — 16 DB-free tests:

| AC | Test |
|---|---|
| W004-AC01 | infrastructure runtime resolves through the intended bootstrap path |
| W004-AC02 | protocol runtime resolves through the intended bootstrap path |
| — | hybrid runtime resolves through the intended bootstrap path |
| — | resolveRuntime throws for an unregistered kind (no silent fallback) |
| — | the registry is non-empty after initializeBootstrap (BASE-001) |
| W004-AC03 | repeated resolution of the same kind returns the same instance |
| W004-AC03 | each kind resolves to a distinct instance |
| W004-AC03 | initializeBootstrap is idempotent (does not re-register or replace) |
| W004-AC04 | InfrastructureRuntime does NOT import ProtocolRuntime (isolation) |
| W004-AC04 | ProtocolRuntime does NOT import InfrastructureRuntime (isolation) |
| W004-AC04 | HybridRuntime is the ONLY runtime importing both (the bridge) |
| W004-AC07 | generic runtime code imports NO vertical service |
| W004-AC04 | bootstrap registers all three runtime kinds (BASE-001) |
| W004-AC04 | runtime/index.ts does NOT auto-register (no hidden side effects) |
| W004-AC08 | bootstrap does not import Data Plane services |
| W004-AC08 | bootstrap does not import the Economic Pipeline |
| W004-AC08 | bootstrap does not import Prisma/db (no persistence redesign) |

## 5. Diff Scope (W004-AC08 — no unrelated production refactor)

```text
.github/workflows/ci.yml                                        (diff-scope allowlist + WORK-004 test)
tests/phase-5-2-execution-economics-separation.test.ts          (+ initializeBootstrap)
tests/phase-8b-compute-economic-pipeline.test.ts                (+ initializeBootstrap)
tests/runtime-resolution-integration.test.ts                    (+ initializeBootstrap)
tests/spec-consistency-validator.test.ts                        (positive test: work-items=4, edges=3)
tests/vpp-4-2-execution-invariants.test.ts                      (+ initializeBootstrap)
tests/work-004-runtime-bootstrap.test.ts                        (new, 16 tests)
```

- No `src/`, `prisma/`, `mini-services/`, Data Plane, Economic Pipeline, or
  vertical-network files touched.
- No Prisma schema, persistence-provider, or ledger changes.
- No runtime architecture redesign; the three runtimes, their isolation, and
  the HybridRuntime bridge rule are unchanged.

## 6. Acceptance Criterion Evidence Matrix

| Criterion | Evidence |
|---|---|
| W004-AC01 | `resolveRuntime('infrastructure')` returns `InfrastructureRuntime` instance (WORK-004 test). PG: `runtime-resolution-integration.test.ts` "energy-vpp version resolves to InfrastructureRuntime" (runs in CI). |
| W004-AC02 | `resolveRuntime('protocol')` returns `ProtocolRuntime` instance (WORK-004 test). PG: `runtime-resolution-integration.test.ts` "protocol-network version resolves to ProtocolRuntime" (runs in CI). |
| W004-AC03 | Repeated resolution returns the same instance; `initializeBootstrap` is idempotent (WORK-004 tests). |
| W004-AC04 | Static tests: InfrastructureRuntime/ProtocolRuntime isolation; HybridRuntime is the only bridge; `runtime/index.ts` does not auto-register. |
| W004-AC05 | `runtime-resolution-integration.test.ts` now calls `initializeBootstrap()` and resolves correctly (CI PG job). |
| W004-AC06 | `phase-5-2`, `phase-8b`, `vpp-4-2` integration tests now call `initializeBootstrap()` — the runtime-registration failures disappear (CI PG job). |
| W004-AC07 | Static test: generic runtime code (infra/proto/hybrid/index) imports NO vertical service. |
| W004-AC08 | Static tests: bootstrap imports NO Data Plane, NO Economic Pipeline, NO Prisma/db. Diff scope: zero production files. |
| W004-AC09 | 160 DB-free tests pass; validator passes; lint clean; diff scope clean; CI evidence (§7). |

## 7. CI Evidence

CI run on head (see PR #6): the `spec-validation` job runs the validator +
WORK-004 DB-free tests + existing negative tests; the `postgres-integration-
tests` job runs the 4 affected PG integration tests (now with
`initializeBootstrap()`) + the WORK-003 PG tests. (CI URLs captured in the PR
comment after the run completes.)

## 8. Stop-Condition Assessment

No stop-condition triggered:
- the runtime-registration failures were NOT caused by an architectural
  contradiction — they were missing `initializeBootstrap()` calls in tests
  (the documented composition-root boundary);
- no new runtime kind or primitive was needed;
- no vertical-specific imports were added to generic runtime code;
- the documented bootstrap boundary is unchanged (tests are their own
  composition root);
- no Data Plane or Economic Pipeline changes;
- runtime isolation rules are preserved (statically verified).

## 9. Implementer Boundary Statement

- WORK-004 is **not** marked `VERIFIED`.
- PR is **not** merged.
- `IAAS-GOV-ARCH-1` and `IAAS-DOM-ARCH-2` remain FROZEN (not modified).
- No production code, Prisma schema, Data Plane, Economic Pipeline, or ledger changes.
- No subsequent Work Item started.

Ready for independent verification and Architect Review.
