# WORK-014 — Verification Evidence (Implementer-Submitted, AR-014 correction round)

- Work Item: `WORK-014`
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Domain Architecture: `IAAS-DOM-ARCH-3` (FROZEN) — V4 is CANDIDATE
- Architecture Change Request: `ACR-003` (UNDER_REVIEW)
- Implementer: Z.ai
- Prepared: 2026-08-26 (UTC)
- Updated: 2026-08-26 (UTC) — AR-014-01..04 correction round
- Status: **submitted for independent Architect Review**

## AR-014 Corrections

### AR-014-01 — ExtensionProvenance persistence/ownership specified

Added §2.6 "ExtensionProvenance — Durable Provenance Record (proposed)" to V4 arch:
- **Ownership**: owned by the provenance boundary (a service-layer provenance service), NOT by ExtensionRuntime. Runtime emits payload; provenance service owns storage. Runtime does NOT directly write to the database.
- **Minimum identity/fingerprint**: tenantId, extensionType, extensionVersion, executionIdempotencyKey, inputHash, outputHash, resultStatus, resourceUsage, capabilitiesExercised, tenantApprovedCeiling, createdAt. Deterministic fingerprint: SHA-256 of the identity tuple.
- **Idempotency**: 1:1 with idempotency key per tenant.
- **Failure ordering**: emitted AFTER execution (success or failure). Failed = resultStatus='failed' + re-throw. No silent success.
- **Tenant binding**: cross-tenant queries prohibited.
- Added DOM-022 to V4 requirements.

### AR-014-02 — Capability authority + resource-limit precedence

Added §2.9 "Capability Authority and Resource-Limit Policy" with four-layer chain:
1. Extension-declared request (what the extension wants)
2. Tenant/operator authorization (approved ceiling — MAY be lower, MUST NOT be higher)
3. Runtime-enforced ceiling (min of declared ∩ approved)
4. Execution allowed/denied (denied → failure provenance)
Precedence: tenant authorization is authoritative; extension cannot self-authorize.

### AR-014-03 — Lifecycle authority + transition semantics

Expanded §2.10 with:
- Registry-owned transitions table (registered→installed→activated⇌deactivated→revoked)
- Runtime-observed/enforced table (execution gate, in-flight on revocation)
- Revoked is terminal (cannot transition back)
- In-flight on revocation: completes current execution if within limits, then refuses all future; if exceeds time limit → terminated + failure provenance
- Installation/uninstall: `installed` is a lifecycle state; `uninstall` is an administrative action (NOT a lifecycle state); provenance remains durable

### AR-014-04 — CANDIDATE vs FROZEN-CONTRACT status consistency

- All Extension classifications changed from `FROZEN-CONTRACT` to `PROPOSED CONTRACT`
- V4 arch opening note: "All contracts, DAGs, and classifications below are **proposed** — they become frozen only upon V4 freeze"
- V4 requirements: "PROPOSED CONTRACT by ACR-003 (candidate); becomes FROZEN-CONTRACT only upon V4 freeze"
- V4 dependency graph: "(proposed)" labels throughout
- No `FROZEN-CONTRACT` classification remains in V4 candidate documents

## Verification Evidence

```text
$ bun run spec:validate → exit 0, work-items=14, dependency-edges=13
$ bunx tsc --noEmit → 0 errors
$ bun test (15 DB-free files) → 334 pass / 0 fail / 1151 expect() calls
```

Zero production files. V3 untouched. DOM-P04 NOT promoted.

## Diff Scope

```text
spec/architecture-change-requests/ACR-003.md
spec/domain-architecture-v4.md        (rewritten: AR-014-01..04 corrections)
spec/domain-requirements-v4.md        (rewritten: DOM-022 added, PROPOSED CONTRACT)
spec/domain-dependency-graph-v4.md    (rewritten: proposed language)
tests/work-014-extension-arch.test.ts (rewritten: 34 tests covering AR-014-01..04)
```

Plus unchanged from first submission: architecture.md, architecture-lock.md, README.md, work-items.md, ci.yml, spec-consistency-validator.test.ts, evidence doc.

## Implementer Boundary Statement

- WORK-014 is **not** marked `VERIFIED`.
- PR is **not** merged.
- `IAAS-GOV-ARCH-1` + `IAAS-DOM-ARCH-3` remain FROZEN.
- V4 is CANDIDATE — pending Architect approval of ACR-003.
- DOM-P04 is NOT promoted until ACR-003 is approved.
- No subsequent Work Item started.

Ready for independent Architect Review.
