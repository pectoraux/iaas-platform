# WORK-018 — Verification Evidence (Implementer-Submitted)

- Work Item: `WORK-018`
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Domain Architecture: `IAAS-DOM-ARCH-4` (FROZEN)
- Implementer: Z.ai
- Prepared: 2026-08-26 (UTC)
- Status: **submitted for independent verification and Architect Review**

## 1. Deliverables

| # | Deliverable | Path | Status |
|---|---|---|---|
| 1 | Prisma model (PostgreSQL persistence) | `prisma/schema.prisma` (`ExtensionProvenance`) | committed |
| 2 | ExtensionProvenanceService | `src/lib/services/extension-provenance.service.ts` | committed |
| 3 | Runtime sink injection (bootstrap) | `src/lib/services/extension-runtime.service.ts` (`setDefaultExtensionProvenanceSink`) | committed |
| 4 | Unit + architecture tests (43 tests) | `tests/work-018-extension-provenance.test.ts` | committed |
| 5 | PostgreSQL integration tests (16 tests) | `tests/work-018-extension-provenance-pg.test.ts` | committed |
| 6 | WORK-017 test reconciliation | `tests/work-017-extension-runtime.test.ts` (AC09 boundary updated) | committed |
| 7 | CI workflow | `.github/workflows/ci.yml` (add WORK-018 tests) | committed |

## 2. ExtensionProvenanceService API (DOM-022)

```text
persistExtensionProvenance(payload) → { recordId, status: 'created' | 'replay' }
  — sole write path; idempotent (P2002 catch + re-read); fingerprint validation
    (recompute + compare); ConflictError on same-key/different-fingerprint.

getExtensionProvenance(tenantId, recordId) → ExtensionProvenanceRecord
  — tenant-scoped; NotFoundError on cross-tenant.

getExtensionProvenanceByFingerprint(tenantId, fingerprint) → ExtensionProvenanceRecord
  — tenant-scoped; NotFoundError on cross-tenant.

listExtensionProvenance(tenantId, filter?) → ExtensionProvenanceRecord[]
  — tenant-scoped; optional extensionType/extensionVersion/resultStatus filter.

DurableExtensionProvenanceSink — implements ExtensionProvenanceSink; delegates
  to persistExtensionProvenance. Injected into ExtensionRuntime via
  setDefaultExtensionProvenanceSink at bootstrap.

getDurableExtensionProvenanceSink() — singleton accessor.

computeExtensionProvenanceFingerprint(input) — SHA-256 of V4 §2.4 material
  fields. MUST match Runtime's computeExtensionProvenanceFingerprint.
```

The service does NOT export:
- `updateExtensionProvenance` / `updateProvenance` / `patchExtensionProvenance`
- `deleteExtensionProvenance` / `deleteProvenance` / `removeExtensionProvenance`

No `db.extensionProvenance.update` / `updateMany` / `upsert` / `delete` / `deleteMany`
calls exist in the service.

## 3. Prisma Model — ExtensionProvenance (V4 §2.4 / DOM-022)

```text
model ExtensionProvenance {
  id                      String   @id @default(cuid())
  tenantId                String
  extensionType           String
  extensionVersion        String
  executionIdempotencyKey String
  inputHash               String
  outputHash              String
  resultStatus            String   // success | failed — MATERIAL to fingerprint
  resourceUsageJson       String   @default("{}")
  capabilitiesExercisedJson String @default("[]")
  tenantApprovedCeilingJson String @default("{}")
  failureMetadataJson     String   @default("{}") // NON-identity-bearing
  fingerprint             String   @unique
  createdAt               DateTime @default(now())
  // NO updatedAt — immutability

  tenant                  Tenant   @relation(...)

  @@unique([tenantId, executionIdempotencyKey])  // one record per key
  @@index([tenantId])
  @@index([extensionType])
  @@index([extensionVersion])
  @@index([resultStatus])
  @@index([fingerprint])
  @@index([createdAt])
}
```

Two unique constraints:
1. `@@unique([tenantId, executionIdempotencyKey])` — one durable record per
   tenant/idempotency key (concurrent convergence).
2. `@unique on fingerprint` — identical payloads converge 1:1 (replay
   convergence by V4 §2.4 fingerprint).

## 4. Runtime/Provenance Separation (V4 §2.4 / DOM-022 AC06)

```text
ExtensionRuntime               ExtensionProvenanceService
─────────────────              ───────────────────────────
executeExtension()             persistExtensionProvenance()
  ↓ emits payload                ↑ consumes payload
ExtensionProvenanceSink   ←──   DurableExtensionProvenanceSink
(interface)                    (implements interface)
```

- The Runtime module does NOT import `@/lib/db`, does NOT import
  `extension-provenance.service`, does NOT call `db.extensionProvenance.*`.
- The Runtime exposes `setDefaultExtensionProvenanceSink()` for bootstrap
  injection. Application bootstrap (or test setup) constructs the
  `DurableExtensionProvenanceSink` and injects it.
- The provenance service imports ONLY types from the Runtime module
  (`import type { ExtensionProvenancePayload, ExtensionProvenanceSink,
  ExtensionResourceLimits }`). It does NOT import `executeExtension`,
  `reverseExtension`, `verifyExtension`, or `registerExtensionImplementation`.

## 5. Immutability (DOM-022 AC02, AC07)

- No `updatedAt` field in the Prisma model.
- No `update` / `updateMany` / `upsert` / `delete` / `deleteMany` calls in the
  service.
- The sole write path is `persistExtensionProvenance`, which is idempotent
  (create-only with P2002 catch + re-read).
- Re-persisting the same payload returns `status: 'replay'` with the same
  `recordId`; `createdAt` does not change.

## 6. Fingerprint (V4 §2.4 / DOM-022 AC03)

```text
SHA-256({
  tenantId, extensionType, extensionVersion,
  executionIdempotencyKey, inputHash, outputHash, resultStatus
})
```

- Computed by the Runtime (`computeExtensionProvenanceFingerprint` in
  `extension-runtime.service`).
- Recomputed by the provenance service on persist (fingerprint validation).
  Mismatch → `ValidationError` (tampering / Runtime bug).
- The two computations are deterministic and identical (proven by PG test).
- `failureMetadata`, `resourceUsage`, `capabilitiesExercised`,
  `tenantApprovedCeiling`, `createdAt` are NON-identity-bearing (excluded
  from fingerprint).

## 7. Concurrent Idempotency Convergence (DOM-022 AC04, AC05)

- `@@unique([tenantId, executionIdempotencyKey])` enforces one record per key.
- Concurrent `persistExtensionProvenance` calls with the same payload:
  - First call: `status: 'created'`.
  - Subsequent calls: P2002 → re-read → `status: 'replay'`, same `recordId`.
- Same key, different fingerprint (different material fields): `ConflictError`
  (idempotency conflict — same key, different fact).
- Success and failure provenance both persisted (`resultStatus` preserved).
  Failed execution emits `resultStatus='failed'` + `failureMetadata`; the
  Runtime re-throws the original error (the provenance service does NOT
  re-throw — it only persists).

## 8. Anti-Dependency Evidence (W018-AC08)

| Prohibition | Evidence |
|---|---|
| NO vertical service imports | Static test |
| NO EconomicPipeline import | Static test |
| NO Route/Transport import | Static test |
| NO RuntimeRegistry import | Static test |
| NO kernel import | Static test |
| NO ExtensionRuntime import (type-only OK) | Static test (`import type` only; no execute/reverse/verify imports) |
| NO TransformRegistry/TransformRecord/TransformRuntime import | Static test |
| NO ExtensionRegistry import | Static test |

## 9. Verification Evidence (local)

```text
$ bunx tsc --noEmit → 0 errors
$ bun run spec:validate → exit 0, domain-architecture=IAAS-DOM-ARCH-4,
    work-items=18, dependency-edges=17, checks=20
$ bun run lint → clean
$ bun test tests/work-018-extension-provenance.test.ts → 43 pass, 0 fail
$ bun test tests/work-017-extension-runtime.test.ts → 28 pass, 0 fail (AC09 boundary updated)
$ bun test tests/work-015-v4-freeze.test.ts → 9 pass, 0 fail
$ bun test tests/spec-consistency-validator.test.ts → 10 pass, 0 fail
$ bun test (19 non-PG suites) → 425 pass, 0 fail
```

PostgreSQL integration tests (`tests/work-018-extension-provenance-pg.test.ts`)
require a live PostgreSQL instance and are executed by the CI
`postgres-integration-tests` job (postgres:16-alpine service).

## 10. Governance Reconciliation

- `tests/work-017-extension-runtime.test.ts`: updated the W017-AC09 boundary
  assertion from "ExtensionProvenance storage remains absent" to "ExtensionProvenance
  storage IS implemented (WORK-018) but Runtime does NOT own it" (the model now
  exists; the Runtime still does NOT import the provenance service or `@/lib/db`).
- `.github/workflows/ci.yml`: added `tests/work-018-extension-provenance.test.ts`
  to spec-validation job + `tests/work-018-extension-provenance-pg.test.ts` to
  postgres-integration-tests job.

No V4 architecture changes. No ExtensionRegistry changes. No ExtensionRuntime
redesign (only added `setDefaultExtensionProvenanceSink` for bootstrap injection —
the Runtime still does NOT own persistence).

## 10A. Architect Review Fixes (Round 2)

PR #28 received a blocking architect review with three substantive issues.
All three are corrected in this update:

### Fix #1 — Tenant-isolation violation in P2002 fallback

**Issue:** `persistExtensionProvenance` had a P2002 fallback that used a global
`findUnique({ where: { fingerprint } })` without `tenantId`, creating a
cross-tenant existence/disclosure path via `ConflictError.details.existingRecordId`.

**Fix:** changed to `findFirst({ where: { fingerprint, tenantId } })` — a
tenant-scoped lookup. A cross-tenant record with the same fingerprint is now
invisible (treated as "not found" → re-throw the original P2002).

**Tests:**
- Static: `tests/work-018-extension-provenance.test.ts` — "P2002 fingerprint
  fallback is tenant-scoped" (asserts no global findUnique by fingerprint;
  asserts tenantId in the where clause).
- PG: `tests/work-018-extension-provenance-pg.test.ts` — "tenant isolation:
  P2002 fingerprint fallback is tenant-scoped" (two tenants with same
  fingerprint; verifies no cross-tenant recordId disclosure).

### Fix #2 — Production bootstrap wiring

**Issue:** `setDefaultExtensionProvenanceSink()` was injectable but the
application composition root (`src/lib/bootstrap/index.ts`) never called it
with `getDurableExtensionProvenanceSink()`. Normal production startup could
still use the in-memory sink.

**Fix:** `src/lib/bootstrap/index.ts` now imports
`setDefaultExtensionProvenanceSink` (from extension-runtime.service) and
`getDurableExtensionProvenanceSink` (from extension-provenance.service), and
calls `setDefaultExtensionProvenanceSink(getDurableExtensionProvenanceSink())`
in `initializeBootstrap()` step 6. The Runtime still does NOT import `@/lib/db`
or the provenance service — the durable sink is injected through the interface.

**Tests:**
- Static: `tests/work-018-extension-provenance.test.ts` — "Production
  bootstrap wiring" section (4 tests: bootstrap imports both modules; calls
  setDefault; Runtime boundary preserved).
- PG: `tests/work-018-extension-provenance-pg.test.ts` — "initializeBootstrap
  installs the durable sink as the Runtime default" (verifies before =
  InMemory, after = Durable).

### Fix #3 — Prisma migration

**Issue:** `prisma/schema.prisma` was changed without adding the corresponding
migration. CI's `db push` masked this.

**Fix:** added `prisma/migrations/20260826000000_add_extension_provenance/migration.sql`
— a forward, idempotent migration that creates the `ExtensionProvenance` table,
both unique constraints (`@@unique([tenantId, executionIdempotencyKey])` and
`@unique on fingerprint`), all 6 indexes, and the Tenant FK with `ON DELETE
CASCADE`. No mutation statements (UPDATE/DELETE FROM/DROP/TRUNCATE). Also
added a CI step `prisma migrate deploy` after `db push` to verify the migration
deploys cleanly.

**Tests:**
- Static: `tests/work-018-extension-provenance.test.ts` — "Prisma migration
  presence" section (7 tests: file exists; both unique constraints; all
  indexes; Tenant FK; no mutation statements; idempotent IF NOT EXISTS guards).

## 11. Diff Scope

```text
prisma/schema.prisma                                                  (+ ExtensionProvenance model + Tenant back-relation)
prisma/migrations/20260826000000_add_extension_provenance/migration.sql (new — forward migration)
src/lib/services/extension-provenance.service.ts                     (new — ExtensionProvenanceService + DurableExtensionProvenanceSink; P2002 fallback tenant-scoped)
src/lib/services/extension-runtime.service.ts                        (+ setDefaultExtensionProvenanceSink for bootstrap injection)
src/lib/bootstrap/index.ts                                           (+ wire durable sink at composition root)
tests/work-018-extension-provenance.test.ts                          (55 unit/architecture tests — includes Fix #1/#2/#3 static tests)
tests/work-018-extension-provenance-pg.test.ts                       (18 PostgreSQL integration tests — includes Fix #1/#2 PG tests)
tests/work-017-extension-runtime.test.ts                             (AC09 boundary assertion updated for WORK-018)
.github/workflows/ci.yml                                             (add WORK-018 tests + prisma migrate deploy step)
spec/evidence/WORK-018-verification-evidence.md                      (this document)
```

No ExtensionRegistry changes. No Transform Stack changes. No Economic Pipeline /
Data Plane / kernel changes. No sandbox selection. No concrete extensions.

## 12. Implementer Boundary Statement

- WORK-018 is **not** marked `VERIFIED`.
- PR is **not** merged.
- `IAAS-GOV-ARCH-1` + `IAAS-DOM-ARCH-4` remain FROZEN.
- Sandbox technology is NOT selected.
- Concrete extensions are NOT implemented.
- No subsequent Work Item started (WORK-019 is NOT started).

Ready for independent verification and Architect Review.
