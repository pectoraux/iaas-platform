# WORK-016 — Verification Evidence (Implementer-Submitted)

- Work Item: `WORK-016`
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Domain Architecture: `IAAS-DOM-ARCH-4` (FROZEN)
- Implementer: Z.ai
- Prepared: 2026-08-26 (UTC)
- Status: **submitted for independent verification and Architect Review**

## 1. Deliverables

| # | Deliverable | Path | Status |
|---|---|---|---|
| 1 | ExtensionRegistry service | `src/lib/services/extension-registry.service.ts` | committed |
| 2 | Prisma model (PostgreSQL persistence) | `prisma/schema.prisma` (`ExtensionRegistryEntry`) | committed |
| 3 | Unit + architecture tests (20 tests) | `tests/work-016-extension-registry.test.ts` | committed |
| 4 | PostgreSQL integration tests (10 tests) | `tests/work-016-extension-registry-pg.test.ts` | committed |
| 5 | Governance reconciliation | `spec/README.md`, `architecture-lock.md`, `work-items.md`, `dependency-graph.md`, `tests/spec-consistency-validator.test.ts` | committed |

## 2. ExtensionRegistry API (DOM-019)

```text
registerExtension              — tenant-scoped, idempotent (P2002 catch + re-read)
getExtension                   — lookup by (extensionType, extensionVersion)
listExtensions                 — tenant-scoped listing with filters
checkExtensionVersionCompatibility — version rules, NO execution
updateExtensionCertification   — certifier identity + status
revokeExtension                — revocation status + reason + revokedAt + lifecycle→revoked
transitionLifecycle            — authoritative lifecycle transitions:
                                  registered → installed → activated ⇌ deactivated → revoked (terminal)
LIFECYCLE_STATE                — state constants
VALID_TRANSITIONS              — transition validation table
```

## 3. Anti-Dependency Evidence (W016-AC08)

| Prohibition | Evidence |
|---|---|
| NO vertical service imports | Static test |
| NO EconomicPipeline import | Static test |
| NO Route/Transport import | Static test |
| NO RuntimeRegistry import | Static test |
| NO kernel import | Static test |
| NO execute/reverse/estimateCost/verify | Static test |
| NO ExtensionRuntime file | Static test (absent) |
| NO ExtensionProvenance import | Static test (no import statements) |
| NO TransformRuntime/TransformRecord import | Static test |

## 4. Lifecycle Authority (W016-AC04)

Registry owns all lifecycle transitions. Revoked is terminal. In-flight on
revocation is documented in V4 arch (runtime responsibility). Invalid
transitions are rejected (ValidationError). Revocation also transitions
lifecycle to revoked.

## 5. Verification Evidence

```text
$ bun run spec:validate → exit 0, domain-architecture=IAAS-DOM-ARCH-4, work-items=16, dependency-edges=15
$ bunx tsc --noEmit → 0 errors
$ bun test (17 DB-free files) → 307 pass / 0 fail / 1017 expect() calls
```

PostgreSQL integration tests (10 tests) run in CI `postgres-integration-tests` job.

## 6. Acceptance Criterion Evidence Matrix

| AC | Evidence |
|---|---|
| W016-AC01 | registerExtension + getExtension + listExtensions; PG tests prove |
| W016-AC02 | checkExtensionVersionCompatibility; PG test proves |
| W016-AC03 | updateExtensionCertification + revokeExtension; PG tests prove |
| W016-AC04 | transitionLifecycle with VALID_TRANSITIONS; PG test proves full lifecycle + terminal revoked |
| W016-AC05 | P2002 catch + re-read; PG concurrent test proves convergence |
| W016-AC06 | Cross-tenant isolation; PG tests prove |
| W016-AC07 | PostgreSQL via db.extensionRegistryEntry |
| W016-AC08 | 10 static anti-dependency tests |

## 7. Governance Reconciliation

The architect's V4 freeze PR (WORK-015) condensed governance docs in a way
that broke the spec validator. Fixed:
- `architecture-lock.md`: restored `Domain Architecture Version:` format + frozen rules 1-13.
- `README.md`: restored document index with all V1-V4 docs.
- `work-items.md`: restored WORK-001 full schema (AC list, Required Verification, DoD).
- `dependency-graph.md`: added "WORK-001 is VERIFIED" for SC-11.
- `work-items.md` WORK-016: added explicit `W016-AC01..AC08` acceptance criteria.
- Positive spec test: updated for work-items=16, dependency-edges=15, V4.
- Cross-doc tests (WORK-008/009/012): updated V3→V4 FROZEN assertions.

## 8. Diff Scope

```text
prisma/schema.prisma                              (+ ExtensionRegistryEntry + Tenant back-relation)
src/lib/services/extension-registry.service.ts   (new — ExtensionRegistry service)
tests/work-016-extension-registry.test.ts         (new — 20 unit/architecture tests)
tests/work-016-extension-registry-pg.test.ts      (new — 10 PostgreSQL integration tests)
spec/README.md                                    (restored document index)
spec/architecture-lock.md                         (restored format + frozen rules)
spec/work-items.md                                (restored WORK-001 schema + WORK-016 ACs)
spec/dependency-graph.md                          (added WORK-001 is VERIFIED)
tests/spec-consistency-validator.test.ts          (positive test + cycle test fix)
tests/work-008-truth-reconciliation.test.ts       (V4 FROZEN assertions)
tests/work-009-transform-arch-freeze.test.ts      (V4 FROZEN assertions)
tests/work-012-truth-sync.test.ts                 (V4 FROZEN assertions)
.github/workflows/ci.yml                          (add WORK-016 tests)
spec/evidence/WORK-016-verification-evidence.md  (this document)
```

No Transform Stack, Economic Pipeline, Data Plane, or runtime kernel changes.
ExtensionRuntime NOT implemented. ExtensionProvenance NOT implemented.

## 9. Implementer Boundary Statement

- WORK-016 is **not** marked `VERIFIED`.
- PR is **not** merged.
- `IAAS-GOV-ARCH-1` + `IAAS-DOM-ARCH-4` remain FROZEN.
- ExtensionRuntime is NOT implemented.
- No subsequent Work Item started.

Ready for independent verification and Architect Review.
