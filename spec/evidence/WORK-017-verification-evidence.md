# WORK-017 — Verification Evidence (Implementer-Submitted)

- Work Item: `WORK-017`
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Domain Architecture: `IAAS-DOM-ARCH-4` (FROZEN)
- Implementer: Z.ai
- Prepared: 2026-08-26 (UTC)
- Status: **submitted for independent verification and Architect Review**

## 1. Deliverables

| # | Deliverable | Path | Status |
|---|---|---|---|
| 1 | ExtensionRuntime service | `src/lib/services/extension-runtime.service.ts` | committed |
| 2 | Unit + architecture tests (28 tests) | `tests/work-017-extension-runtime.test.ts` | committed |
| 3 | PostgreSQL integration tests (18 tests) | `tests/work-017-extension-runtime-pg.test.ts` | committed |
| 4 | Governance reconciliation | `tests/work-015-v4-freeze.test.ts` (stale assertion fix), `.github/workflows/ci.yml` (add WORK-017 tests) | committed |

## 2. ExtensionRuntime API (DOM-020)

```text
executeExtension          — resolve via ExtensionRegistry → lifecycle gate (activated only)
                            → capability/resource ceiling (min declared, approved) →
                            dispatch through ExtensionContract → emit ExtensionProvenance
                            payload to sink boundary. Failed execution emits failed
                            provenance + re-throws.
reverseExtension          — reverse an output payload (activated gate, provenance emitted)
verifyExtension           — verify (input, output) consistency (read-only, NO provenance)
registerExtensionImplementation — register a concrete ExtensionContract for dispatch
__clearExtensionImplementationsForTesting — test isolation helper
computeExtensionProvenanceFingerprint — SHA-256 of V4 §2.4 material fields
getDefaultExtensionProvenanceSink — module-level default sink accessor
```

## 3. ExtensionContract (DOM-018)

```text
extensionType + extensionVersion  — stable identity
execute(context, input) → output  — operation with ceiling-enforced context
reverse?(output) → input          — optional reverse
verify(input, output) → boolean   — consistency check
```

The runtime does NOT hard-code any concrete extension. It dispatches through
whatever implementations are registered at application bootstrap.

## 4. ExtensionProvenance Boundary (V4 §2.4 / W017-AC09)

The runtime does NOT own durable provenance storage. It emits immutable
`ExtensionProvenancePayload` objects through an `ExtensionProvenanceSink`
boundary contract:

```text
ExtensionProvenanceSink.emit(payload) → { recordId, status: 'created' | 'replay' }
InMemoryExtensionProvenanceSink — default test/no-op sink (deduplicates by fingerprint)
```

Payload identity (V4 §2.4):
```text
tenantId, extensionType, extensionVersion,
executionIdempotencyKey, inputHash, outputHash,
resultStatus, resourceUsage, capabilitiesExercised,
tenantApprovedCeiling, createdAt
```

Fingerprint (V4 §2.4):
```text
SHA-256({tenantId, extensionType, extensionVersion,
         executionIdempotencyKey, inputHash, outputHash, resultStatus})
```

The runtime does NOT import `@/lib/db`. No Prisma model for
`ExtensionProvenance` exists in `prisma/schema.prisma`. Durable PostgreSQL
storage is DOM-022 / future WORK.

## 5. Capability/Resource Ceiling (V4 §2.6 / W017-AC03)

Precedence enforced:
```text
Extension-declared request (registry: declaredCapabilities, declaredResourceLimits)
        ↓
Tenant/operator authorization (input: approvedCapabilities, approvedResourceLimits)
        ↓
Runtime-enforced ceiling = min(declared, approved)
        ↓
Execution allowed / denied (denial emits failed provenance + throws)
```

- Capabilities: effective = intersection(declared, approved). If declared
  capability is not approved → denied (`capability_not_approved`).
- Resource limits: effective = min(declared, approved) per resource. If
  declared > approved → denied (`resource_limit_exceeded`).

## 6. Lifecycle Authority (V4 §2.7 / W017-AC02)

The runtime OBSERVES lifecycle state from ExtensionRegistry; it does NOT own
transitions. Only `activated` extensions may execute. Denial reasons:
- `lifecycle_not_activated` — state is not `activated`
- `revoked` — revocation status is `revoked`

The runtime does NOT export `registerExtension`, `transitionLifecycle`,
`revokeExtension`, or `updateExtensionCertification`.

## 7. Failure Semantics (W017-AC05)

Failed execution (either by denial or by implementation throw):
1. Emits `ExtensionProvenancePayload` with `resultStatus='failed'` and
   `failureMetadata` containing the error/classification.
2. Re-throws the original error to the caller.

The caller does NOT get a silent success. `outputHash` on failure is the
SHA-256 of an empty buffer.

## 8. Idempotent Replay Convergence (V4 §2.4 / W017-AC06)

Identical attempts converge 1:1 per tenant/idempotency key:
- The fingerprint is derived from `(tenantId, extensionType, extensionVersion,
  executionIdempotencyKey, inputHash, outputHash, resultStatus)`.
- The sink deduplicates by fingerprint: first emission returns
  `{ status: 'created' }`, subsequent identical emissions return
  `{ status: 'replay', recordId: <same> }`.
- Divergent outputs (different `outputHash`) produce different fingerprints
  → different records.

## 9. Anti-Dependency Evidence (W017-AC10)

| Prohibition | Evidence |
|---|---|
| NO vertical service imports | Static test |
| NO EconomicPipeline import | Static test |
| NO Route/Transport import | Static test |
| NO RuntimeRegistry import | Static test |
| NO kernel import | Static test |
| NO TransformRuntime/TransformRecord/TransformRegistry import | Static test (Extension→Transform is one-way, not exercised by runtime) |
| NO catalog/lifecycle ownership | Static test (no register/list/transition exports) |
| NO ExtensionRegistryEntry mutation | Static test (no create/update/delete on db) |
| NO db import (no durable provenance) | Static test |
| NO ExtensionProvenance service import | Static test |
| NO concrete extensions hard-coded | Static test (no Compression/Encryption/VPP/Compute/Routing classes) |
| NO Prisma model for ExtensionProvenance | Static test (schema inspection) |

## 10. Verification Evidence (local)

```text
$ bunx tsc --noEmit → 0 errors
$ bun run spec:validate → exit 0, domain-architecture=IAAS-DOM-ARCH-4, work-items=17, dependency-edges=16
$ bun test tests/work-017-extension-runtime.test.ts → 28 pass, 0 fail
$ bun test tests/work-015-v4-freeze.test.ts → 9 pass, 0 fail (stale assertion reconciled)
$ bun test tests/spec-consistency-validator.test.ts → pass (V4 / 17-item specification)
$ bun run lint → clean
```

PostgreSQL integration tests (`tests/work-017-extension-runtime-pg.test.ts`)
require a live PostgreSQL instance and are executed by the CI
`postgres-integration-tests` job (postgres:16-alpine service). Local
execution is not possible in this environment (no PostgreSQL available),
matching the pattern established by WORK-010/011/016.

## 11. Governance Reconciliation

PR #24 (WORK-017 release) updated `spec/dependency-graph.md`,
`spec/work-items.md`, `spec/work-orders/WORK-017.md`, and
`tests/spec-consistency-validator.test.ts` but did NOT update
`tests/work-015-v4-freeze.test.ts`, leaving a stale assertion
(`WORK-016 is READY`). WORK-017 reconciles this:

- `tests/work-015-v4-freeze.test.ts`: updated test name and assertions to
  reflect WORK-015/016 VERIFIED + WORK-017 READY (added WORK-017 release
  assertions and the `WORK-016 -> WORK-017` dependency edge check).

This is a governance test alignment, NOT an architecture change. V4 remains
FROZEN; no production code was modified to satisfy the test.

## 12. Diff Scope

```text
src/lib/services/extension-runtime.service.ts   (new — ExtensionRuntime service)
tests/work-017-extension-runtime.test.ts         (new — 28 unit/architecture tests)
tests/work-017-extension-runtime-pg.test.ts      (new — 18 PostgreSQL integration tests)
tests/work-015-v4-freeze.test.ts                 (stale assertion reconciled for WORK-017 release)
.github/workflows/ci.yml                         (add WORK-017 tests to spec-validation + PG jobs)
spec/evidence/WORK-017-verification-evidence.md  (this document)
worklog.md                                       (WORK-017 entry)
```

No ExtensionRegistry changes. No Transform Stack changes. No Prisma schema
changes. No Economic Pipeline / Data Plane / kernel changes.
ExtensionProvenance durable storage NOT implemented. Sandbox technology NOT
selected. Concrete extensions NOT implemented.

## 13. Implementer Boundary Statement

- WORK-017 is **not** marked `VERIFIED`.
- PR is **not** merged.
- `IAAS-GOV-ARCH-1` + `IAAS-DOM-ARCH-4` remain FROZEN.
- ExtensionProvenance durable storage is NOT implemented.
- Sandbox technology is NOT selected.
- No subsequent Work Item started (WORK-018 is NOT started).

Ready for independent verification and Architect Review.
