# WORK-007 — Verification Evidence (Implementer-Submitted)

- Work Item: `WORK-007`
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
- Implementer: Z.ai
- Prepared: 2026-08-26 (UTC)
- Status: **submitted for independent verification and Architect Review**

## 1. Clean-Main Baseline Capture (W007-AC01)

Clean main (`67db52d`): 5 residual typecheck errors.

| # | File | Error | Classification |
|---|---|---|---|
| 1 | `src/lib/services/vpp.service.ts:824` | TS2503: Cannot find namespace 'baselineEngine' | Production type defect (BASE-011) — fixable |
| 2 | `examples/websocket/frontend.tsx` | TS2307: Cannot find module 'socket.io-client' | Auxiliary — project boundary (BASE-012) |
| 3 | `examples/websocket/server.ts` | TS2307: Cannot find module 'socket.io' | Auxiliary — project boundary (BASE-012) |
| 4 | `skills/image-edit/scripts/image-edit.ts` | TS2561: 'images' does not exist in type | Auxiliary — project boundary (BASE-012) |
| 5 | `skills/stock-analysis-skill/src/analyzer.ts` | TS2322: type mismatch | Auxiliary — has own tsconfig (BASE-012) |

## 2. baselineEngine Type Safety Fix (W007-AC02, BASE-011)

**Defect.** `vpp.service.ts` line 824: `type BaselineContext = baselineEngine.BaselineContext` — tried to use a runtime `const` (from `await import(...)`) as a type namespace. TypeScript TS2503: types must be resolved at compile time via a static import, not through a runtime const.

**Correction (no `any`, no `@ts-ignore`, no suppression).**

- Added a static `import type { BaselineContext } from './baseline-engine.service'` at module scope.
- Removed the broken `type BaselineContext = baselineEngine.BaselineContext` line.
- The dynamic import `const baselineEngine = await import('./baseline-engine.service')` is preserved for runtime (getStrategy). Only the type access was moved to the static import.
- `BaselineContext` is still used as a type annotation at `const baselineContext: BaselineContext = {...}` — the type is not erased.

## 3. TypeScript Project Boundaries (W007-AC03, W007-AC04, BASE-012, BASE-013)

**Boundary decision.** The IAAS application compiler (root `tsconfig.json`) now explicitly excludes `examples/` and `skills/`. Each excluded tree has its own explicit project configuration documenting the boundary:

| Tree | Classification | Config |
|---|---|---|
| `examples/` | Auxiliary reference material (not compiled in CI) | `examples/tsconfig.json` — standalone config with `//` field documenting the boundary |
| `skills/stock-analysis-skill/` | Independent TypeScript project (own package.json + tsconfig.json) | `skills/tsconfig.json` excludes it; the skill's own config handles compilation |
| `skills/image-edit/` | Skill definition with auxiliary script (not a maintained TS project) | `skills/tsconfig.json` includes it but documents it as non-compiled reference material |
| `skills/` (top-level) | Explicit boundary config | `skills/tsconfig.json` — standalone config with `//` field documenting the boundary |

**No silent exclusion (BASE-013).** The root `tsconfig.json` exclude entries are paired with dedicated `examples/tsconfig.json` and `skills/tsconfig.json` files that document the boundary decision. The `//` JSON field in each auxiliary tsconfig explains why the tree is excluded from the IAAS application compiler and what its own compilation status is.

## 4. Verification Evidence (W007-AC05, W007-AC06, BASE-014)

```text
$ bunx tsc --noEmit
exit=0 (0 errors — clean IAAS application typecheck)

$ bun run spec:validate
SPEC VALIDATION PASSED
architecture=IAAS-GOV-ARCH-1 domain-architecture=IAAS-DOM-ARCH-2 required-files=13 work-items=7 work-item-schema-fields=11 work001-acceptance-criteria=13 dependency-edges=6 checks=20
exit=0

$ bun test tests/work-007-typecheck-closure.test.ts tests/architecture-contract.test.ts tests/spec-consistency-validator.test.ts tests/pr-invariant-check.test.ts tests/work-002-baseline.test.ts tests/work-003-verified-evidence-context.test.ts tests/work-004-runtime-bootstrap.test.ts tests/work-005-fixture-isolation.test.ts --timeout 120000
 193 pass / 0 fail / 757 expect() calls / 8 files
```

Lint clean. Deterministic.

## 5. Regression Test Coverage (W007-AC08)

`tests/work-007-typecheck-closure.test.ts` — 9 DB-free tests:

| AC | Test |
|---|---|
| W007-AC02 | vpp.service.ts uses static `import type` for BaselineContext (no runtime namespace) |
| W007-AC02 | baseline-engine.service.ts exports the BaselineContext interface |
| W007-AC02 | no @ts-ignore/@ts-expect-error/any suppression in vpp.service.ts |
| W007-AC03 | root tsconfig.json explicitly excludes examples/ and skills/ |
| W007-AC03 | examples/ has its own tsconfig.json |
| W007-AC03 | skills/ has its own tsconfig.json |
| W007-AC03 | skills/stock-analysis-skill has its own standalone tsconfig + package.json |
| W007-AC04 | the exclusion is explained (not a silent broad exclude) |
| W007-AC05 | `bunx tsc --noEmit` exits 0 with no errors |

## 6. Diff Scope

```text
examples/tsconfig.json                              (new — explicit project boundary)
skills/tsconfig.json                                (new — explicit project boundary)
src/lib/services/vpp.service.ts                     (baselineEngine static type import)
tests/spec-consistency-validator.test.ts            (positive test: work-items=7, edges=6)
tests/work-007-typecheck-closure.test.ts            (new — 9 regression tests)
tsconfig.json                                       (exclude examples/ + skills/)
.github/workflows/ci.yml                            (add WORK-007 test + diff-scope allowlist)
```

- No Prisma schema, Data Plane, Economic Pipeline, ledger, or runtime architecture changes.
- No frozen architecture documents modified.
- No `@ts-ignore`/`any`/`skipLibCheck`/suppression used.

## 7. Residual Classification (W007-AC09)

No residual failures. The IAAS application typecheck is clean (`tsc --noEmit` exits 0). The auxiliary trees (`examples/`, `skills/`) have explicit project boundaries and are not compiled by the IAAS application CI.

## 8. Acceptance Criterion Evidence Matrix

| Criterion | Evidence |
|---|---|
| W007-AC01 | 5 residual errors captured on clean main, classified (§1). |
| W007-AC02 | baselineEngine fixed with static `import type`; no suppression (§2, regression test). |
| W007-AC03 | Root tsconfig excludes examples/skills; each has its own config (§3). |
| W007-AC04 | Exclusions paired with dedicated tsconfig + `//` documentation fields (§3). |
| W007-AC05 | `tsc --noEmit` exits 0 — 0 errors (§4). |
| W007-AC06 | Arch-contract, PG, spec validator, lint all green (§4). |
| W007-AC07 | No runtime/economic/data-plane/vertical changes (diff scope §6). |
| W007-AC08 | 9 regression tests pass (§5). |
| W007-AC09 | No residuals — IAAS typecheck is clean (§7). |
| W007-AC10 | No frozen architecture modified; no ACR required. |

## 9. Stop-Condition Assessment

No stop-condition triggered:
- the baselineEngine fix required no frozen architecture rule change (just a static type import);
- the auxiliary-project boundary work is an explicit project decision, not concealing maintained code;
- no schema or runtime architecture change;
- no broad refactoring;
- all failures objectively classified.

## 10. Implementer Boundary Statement

- WORK-007 is **not** marked `VERIFIED`.
- PR is **not** merged.
- `IAAS-GOV-ARCH-1` and `IAAS-DOM-ARCH-2` remain FROZEN.
- No Prisma schema, Data Plane, Economic Pipeline, ledger, or runtime architecture changes.
- No `@ts-ignore`/`any`/`skipLibCheck`/suppression used.
- No subsequent Work Item started.

Ready for independent verification and Architect Review.
