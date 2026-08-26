# WORK-014 — Verification Evidence (Implementer-Submitted)

- Work Item: `WORK-014`
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Domain Architecture: `IAAS-DOM-ARCH-3` (FROZEN) — V4 is CANDIDATE
- Architecture Change Request: `ACR-003` (UNDER_REVIEW)
- Implementer: Z.ai
- Prepared: 2026-08-26 (UTC)
- Status: **submitted for independent Architect Review (ACR-003 + V4 candidate)**

## 1. Deliverables

| # | Deliverable | Path | Status |
|---|---|---|---|
| 1 | ACR-003 (Extension Stack promotion) | `spec/architecture-change-requests/ACR-003.md` | committed |
| 2 | Candidate IAAS-DOM-ARCH-4 architecture | `spec/domain-architecture-v4.md` | committed |
| 3 | V4 candidate domain requirements (DOM-018..021) | `spec/domain-requirements-v4.md` | committed |
| 4 | V4 candidate dependency graph | `spec/domain-dependency-graph-v4.md` | committed |
| 5 | Governance registration (architecture.md, lock, README) | updated | committed |
| 6 | Regression tests (22 tests) | `tests/work-014-extension-arch.test.ts` | committed |

## 2. Extension Stack Contract (W014-AC02..AC04)

```text
Extension (abstract pluggable operation contract)     → FROZEN-CONTRACT
    ↓
ExtensionRegistry (discovery/catalog/lifecycle)       → FROZEN-CONTRACT
    ↓
ExtensionRuntime (execution/isolation/provenance)     → FROZEN-CONTRACT
    ↓
ExtensionProvenance (immutable record — future)       → FUTURE
```

- Non-overlapping: Registry does NOT execute; Runtime does NOT own catalog; neither owns durable storage.
- Security/isolation: capability scoping, resource limits, tenant isolation, provenance, failure containment — without selecting sandbox technology (OPEN/RESEARCH).
- Extension→Transform: one-way (Extension may call TransformRuntime; Transform does NOT import Extension).

## 3. DOM-P04 Non-Promotion (W014-AC08)

- V1 `domain-requirements.md` DOM-P04 remains FUTURE (not SUPERSEDED).
- V4 candidate `domain-requirements-v4.md` marks DOM-P04 as SUPERSEDED pending ACR-003 approval.
- `architecture.md` registers V3 as FROZEN, V4 as CANDIDATE.
- DOM-P05..P08 remain FUTURE.

## 4. V3 Immutability (W014-AC09)

- V3 `domain-architecture-v3.md` is not modified (still FROZEN).
- V4 candidate is explicitly CANDIDATE (not FROZEN).
- Zero production files (spec + tests only).

## 5. Verification Evidence

```text
$ bun run spec:validate → exit 0, work-items=14, dependency-edges=13, checks=20
$ bunx tsc --noEmit → 0 errors
$ bun test (15 DB-free files) → 316 pass / 0 fail / 1101 expect() calls
```

## 6. Acceptance Criterion Evidence Matrix

| AC | Evidence |
|---|---|
| W014-AC01 | ACR-003 has problem, scope, non-goals, questions, alternatives, decision gate |
| W014-AC02 | Extension contract: execute/reverse/verify, capabilities, lifecycle, security |
| W014-AC03 | ExtensionRegistry: discovery/catalog/lifecycle, does NOT execute |
| W014-AC04 | ExtensionRuntime: execution/isolation, does NOT own catalog |
| W014-AC05 | Tenant isolation, capability scoping, resource limits, provenance, sandbox OPEN |
| W014-AC06 | Anti-dependencies explicit in V4 arch + V4 dependency graph |
| W014-AC07 | Extension→Transform one-way; Transforms do NOT import Extension |
| W014-AC08 | DOM-P04 remains FUTURE in V1; V4 candidate marks SUPERSEDED pending approval |
| W014-AC09 | V3 immutable; V4 CANDIDATE; zero production files |
| W014-AC10 | 316 DB-free tests pass; validator passes; typecheck 0; lint clean |
| W014-AC11 | Submitted for Architect Review — ACR-003 decision pending |

## 7. Diff Scope

```text
spec/architecture-change-requests/ACR-003.md          (new)
spec/domain-architecture-v4.md                        (new)
spec/domain-requirements-v4.md                        (new)
spec/domain-dependency-graph-v4.md                    (new)
spec/architecture.md                                  (V4 CANDIDATE row)
spec/architecture-lock.md                             (V4 CANDIDATE line)
spec/README.md                                        (V4 + ACR-003 index)
spec/work-items.md                                    (heading fix + WORK-001 text restoration)
tests/spec-consistency-validator.test.ts              (positive test + SC-06 fix)
tests/work-014-extension-arch.test.ts                 (new — 22 regression tests)
.github/workflows/ci.yml                              (add WORK-014 test)
spec/evidence/WORK-014-verification-evidence.md      (this document)
```

Zero production files. No Prisma schema. No frozen V3 architecture modified.

## 8. Implementer Boundary Statement

- WORK-014 is **not** marked `VERIFIED`.
- PR is **not** merged.
- `IAAS-GOV-ARCH-1` + `IAAS-DOM-ARCH-3` remain FROZEN.
- V4 is CANDIDATE — pending Architect approval of ACR-003.
- DOM-P04 is NOT promoted until ACR-003 is approved.
- No subsequent Work Item started.

Ready for independent Architect Review.

