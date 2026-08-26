# WORK-003 — Verification Evidence (Implementer-Submitted)

- Work Item: `WORK-003`
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN, via ACR-001)
- Architecture Change Request: `ACR-001` (APPROVED)
- Implementer: Z.ai
- Prepared: 2026-08-26 (UTC)
- Status: **submitted for independent verification and Architect Review**

> Per `spec/verification.md`, this document records objective evidence. It is
> implementer-collected and does not establish `VERIFIED` — that decision
> belongs to verification and Architect Review (GOV-003/GOV-004).

## 1. Deliverables (Work Order "Required Implementation")

| # | Required Implementation | Artifact | Status |
|---|---|---|---|
| 1 | Immutable, vertical-neutral `VerifiedEvidenceContext` | `src/lib/domain/verified-evidence-context.ts` | committed |
| 2 | Field/type contract per IAAS-DOM-ARCH-2 §2.2 (no payload duplication) | `verified-evidence-context.ts` `VerifiedEvidenceContext` interface | committed |
| 3 | Generic Economic Pipeline accepts the context (skip evidence/verification) | `src/lib/control-plane/economic-pipeline.ts` `applyVerifiedEvidence()` | committed |
| 4 | VPP migrates handoff to construct the context (preserve baseline/dispatch) | `src/lib/services/vpp.service.ts` (constructs context, calls `applyVerifiedEvidence`) | committed |
| 5 | Validate durable Event/Attestation references + stale/invalid recovery | `applyVerifiedEvidence()` validates tenant/network/policy/version/identity | committed |
| 6 | Architecture tests (no vertical/kernel dependency) | `tests/work-003-verified-evidence-context.test.ts` (17 tests) | committed |
| 7 | PostgreSQL integration tests for durable-reference behavior | `tests/work-003-verified-evidence-pg.test.ts` (6 tests) | committed |
| 8 | Data Plane ↔ Economic Pipeline anti-dependency regression | `tests/work-003-verified-evidence-context.test.ts` + `tests/work-002-baseline.test.ts` (AR-004) | committed |

## 2. VerifiedEvidenceContext Contract (W003-AC01, W003-AC02)

```text
VerifiedEvidenceContext (immutable, frozen at construction)
  ├─ tenantId
  ├─ networkId
  ├─ eventId              (durable Event identity — NOT the payload)
  ├─ attestationId        (durable Attestation identity — NOT the payload)
  ├─ verificationPolicyId
  ├─ verificationPolicyVersion
  ├─ evidenceIdentity     (deterministic externalEventId / idempotency key)
  └─ issuedAt             (provenance: attestation createdAt)
```

- **W003-AC01**: immutable value object at the evidence/economic boundary. `Object.freeze` at construction; unit-tested.
- **W003-AC02**: references durable Event/Attestation identities + verification policy/version; carries NO payload fields (`payloadJson`, `telemetryPayload`, `checksJson`, `quantity`, `unit` are absent — asserted by test).
- **W003-AC06**: NOT a kernel primitive (lives in `src/lib/domain/`, imports nothing from `@/lib/kernel/`); NOT a ledger primitive (imports no ledger/settlement/contribution/reward service); NOT an Event/Attestation replacement (imports no ingestion/verification/attestation service).

## 3. Economic Pipeline Integration (W003-AC03, W003-AC05)

`applyVerifiedEvidence({ executionAssignmentId, context })` in `src/lib/control-plane/economic-pipeline.ts`:

1. Requires the checkpoint to exist (`initEconomicPipeline` must have run).
2. Validates tenant scope (context.tenantId === checkpoint.tenantId).
3. Validates the durable Event reference: exists, same tenant, `externalEventId` matches `context.evidenceIdentity` and the checkpoint's deterministic `eventIdempotencyKey`; network scope matches.
4. Validates the durable Attestation reference: exists on the Event, `verificationPolicyVersion` matches, `status === 'verified'`.
5. Pre-populates the checkpoint (`eventId`, `attestationId`, `stage = VERIFIED`) so `processEconomicPipeline` skips evidence + verification and proceeds to Contribution → Reward → Ledger → Settlement.

Stale/invalid references throw (rejection), forcing the caller to re-establish durable evidence — consistent with `reconcileEconomicPipeline`'s stale/NULL recovery (W003-AC05).

**W003-AC03**: `economic-pipeline.ts` imports the context module but NO vertical service (static-asserted by test).

## 4. VPP Migration (W003-AC04)

`src/lib/services/vpp.service.ts`:
- Constructs a `VerifiedEvidenceContext` after VPP's own evidence + verification + baseline calculation (using `event.id`, `attestation.id`, `programVersion.id`/`.version`, `eventId` deterministic identity, `attestation.createdAt`).
- Calls `applyVerifiedEvidence()` instead of the prior direct `db.economicPipelineState.update({ data: { eventId, attestationId, stage } })`.
- VPP retains its domain-specific baseline calculation (`baselineEngine`, `baselineKwh`, `verifiedPerformanceKwh`) — asserted by test (W003-AC04).
- The prior direct-mutation pattern is gone — asserted by test (regex rejects `economicPipelineState.update(... eventId: event.id)`).

## 5. Validator + Test Evidence

```text
$ bun run spec:validate
SPEC VALIDATION PASSED
architecture=IAAS-GOV-ARCH-1 domain-architecture=IAAS-DOM-ARCH-2 required-files=13 work-items=3 work-item-schema-fields=11 work001-acceptance-criteria=13 dependency-edges=2 checks=20
exit=0

$ bun test tests/spec-consistency-validator.test.ts tests/pr-invariant-check.test.ts tests/work-002-baseline.test.ts tests/work-003-verified-evidence-context.test.ts --timeout 120000
 97 pass / 0 fail / 358 expect() calls / 4 files
```

Breakdown:
- `tests/spec-consistency-validator.test.ts`: 38 tests (positive + WORK-001/002/SC-20 negatives; SC-04/17 updated for V2 reality).
- `tests/pr-invariant-check.test.ts`: 18 tests.
- `tests/work-002-baseline.test.ts`: 24 tests (incl. AR-004 Data Plane ↔ Economic regression).
- `tests/work-003-verified-evidence-context.test.ts`: 17 tests (construction/immutability, durable-identity references, static import prohibitions, VPP migration evidence).

Deterministic (byte-identical validator output). Lint clean on all changed TS files.

### PostgreSQL integration tests (W003-AC05, W003-AC08)

`tests/work-003-verified-evidence-pg.test.ts` — 6 tests, run in CI `postgres-integration-tests` job:
1. valid durable references → checkpoint pre-populated, stage = VERIFIED.
2. stale (non-existent) Event → rejected.
3. stale (wrong) Attestation → rejected.
4. tenant scope mismatch → rejected.
5. verificationPolicyVersion mismatch → rejected.
6. checkpoint missing → rejected.

These require real PostgreSQL (W003-AC08); no SQLite/in-memory replacement introduced.

## 6. Governance Layer Fix (dependency-graph.md)

The architect's WORK-003 release commits left `spec/dependency-graph.md` with a chained `WORK-001 -> WORK-002 -> WORK-003` notation that the validator's two-node-edge parser couldn't fully parse (it missed `WORK-001->WORK-002`), and the VERIFIED text didn't match SC-11's literal. Corrected within WORK-003 scope ("governance/architecture checks required for the new contract"):
- explicit two-node edges: `WORK-001 -> WORK-002` and `WORK-002 -> WORK-003`.
- text: "WORK-001 is VERIFIED. WORK-002 is VERIFIED."

SC-04/SC-17 negative tests updated to target V2 reality (`IAAS-DOM-ARCH-2` FROZEN; V1 SUPERSEDED). Positive test updated: `work-items=3`, `dependency-edges=2`, `domain-architecture=IAAS-DOM-ARCH-2`.

## 7. Diff Scope (W003-AC09 — no unrelated production refactor)

```text
.github/workflows/ci.yml
spec/dependency-graph.md
src/lib/control-plane/economic-pipeline.ts   (applyVerifiedEvidence added; existing code unchanged)
src/lib/domain/verified-evidence-context.ts  (new)
src/lib/services/vpp.service.ts              (handoff migrated to context; baseline logic unchanged)
tests/spec-consistency-validator.test.ts     (SC-04/17 + positive updated for V2)
tests/work-003-verified-evidence-context.test.ts  (new)
tests/work-003-verified-evidence-pg.test.ts   (new)
```

- No Data Plane, Kernel, Prisma schema, ledger model, or vertical-network changes.
- VPP's baseline/dispatch semantics preserved (only the pre-validated-evidence transport generalized).
- The only typecheck error is the pre-existing `baselineEngine` namespace issue (constitution §15, out of WORK-003 scope per Work Order "Out of Scope: fix unrelated pre-existing TypeScript/architecture/integration failures").

## 8. Acceptance Criterion Evidence Matrix

| Criterion | Evidence |
|---|---|
| W003-AC01 | `createVerifiedEvidenceContext` returns `Object.freeze`'d object; unit test asserts `Object.isFrozen`. |
| W003-AC02 | Interface carries only identity refs (`eventId`, `attestationId`, `verificationPolicyId`, `verificationPolicyVersion`, `evidenceIdentity`); test asserts no payload fields. |
| W003-AC03 | `economic-pipeline.ts` imports context, no vertical service (static test); `applyVerifiedEvidence` is the generic boundary. |
| W003-AC04 | VPP constructs context + calls `applyVerifiedEvidence`; no direct checkpoint mutation; baseline logic retained (3 static tests). |
| W003-AC05 | `applyVerifiedEvidence` validates Event/Attestation/tenant/network/policy/version; 6 PG tests prove valid + stale/invalid/mismatch rejection. |
| W003-AC06 | Context in `src/lib/domain/` (not kernel); imports no ledger/Event/Attestation service (4 static tests). |
| W003-AC07 | `economic-pipeline.ts` imports no data-plane service (static test + AR-004 regression tests in work-002-baseline). |
| W003-AC08 | PG integration tests run in CI `postgres-integration-tests` job; no SQLite/in-memory replacement. |
| W003-AC09 | 97 DB-free tests pass; validator passes; lint clean; diff scope clean (8 files, no unrelated production refactor). |

## 9. Stop-Condition Assessment

No stop-condition triggered:
- implementation is within ACR-001 (no new primitive beyond the context);
- context is NOT kernel-owned;
- Event/VerificationResult/Attestation source-of-truth rules preserved;
- existing reconciliation behavior preserved (stale/invalid → reject/recover);
- VPP migrated without changing baseline semantics;
- no schema change required (context is an in-memory value object; durable refs validated against existing Event/Attestation tables);
- no Data Plane ↔ Economic Pipeline dependency introduced;
- `IAAS-DOM-ARCH-2` not changed.

## 10. Implementer Boundary Statement

- WORK-003 is **not** marked `VERIFIED`.
- PR is **not** merged.
- `IAAS-GOV-ARCH-1` and `IAAS-DOM-ARCH-2` remain FROZEN (not modified).
- No Data Plane / Kernel / Prisma schema / ledger model changes.
- No subsequent Work Item started.

Ready for independent verification and Architect Review.
