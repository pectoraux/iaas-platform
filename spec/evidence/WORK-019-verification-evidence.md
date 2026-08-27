# WORK-019 — Verification Evidence (Implementer-Submitted)

- Work Item: `WORK-019`
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Domain Architecture: `IAAS-DOM-ARCH-4` (FROZEN)
- Implementer: Z.ai
- Prepared: 2026-08-27 (UTC)
- Status: **submitted for independent verification and Architect Review**

## 1. Deliverables

| # | Deliverable | Path | Status |
|---|---|---|---|
| 1 | ACR-004 — Sandbox Architecture and Isolation Semantics | `spec/architecture-change-requests/ACR-004.md` | committed |
| 2 | Regression tests (42 tests) | `tests/work-019-sandbox-architecture.test.ts` | committed |
| 3 | Governance fix (WORK-019 Architecture Version) | `spec/work-items.md` | committed |
| 4 | Evidence document | `spec/evidence/WORK-019-verification-evidence.md` | committed |

## 2. ACR-004 Summary

**Status:** `DRAFT` (Architect decides APPROVE / REQUEST_CHANGES / ARCHITECTURE_CHANGE_REQUIRED)

**Recommendation:** WASM/WASI Preview 2 as the preferred sandbox technology, with container isolation as a documented fallback.

**Key decisions documented:**
- **Trust boundary:** the WASM instance boundary (code inside = untrusted; host = trusted).
- **Capability/resource authority:** `ExtensionRuntime` (unchanged from V4 §2.6 `min(declared, approved)`).
- **Lifecycle integration:** `registered → installed → activated ⇌ deactivated → revoked` maps to compile → instantiate → execute → drop.
- **Revocation/termination:** `instance.drop()` (trap); failed provenance with `denialReason: 'revoked_mid_execution'`.
- **Authoritative metering:** fuel consumed (cpuMs), peak memory (memoryBytes), wall-clock (timeMs) — all host-measured. This is a contract change to `ExtensionProvenancePayload` semantics (ceiling → measured), requiring IAAS-DOM-ARCH-5.
- **Tenant isolation:** structural (no shared address space).
- **Compromise containment:** trapped inside the sandbox; escape requires a WASM runtime vulnerability.
- **Fallback:** deny-by-default (`denialReason: 'sandbox_unavailable'`); no silent degradation.
- **V4 impact:** V4 remains FROZEN; IAAS-DOM-ARCH-5 is a CANDIDATE (not frozen by this ACR); no implementation authorized by ACR approval alone.

## 3. Evaluation Coverage (W019-AC01, AC07)

All three required alternatives evaluated across all 10 required dimensions:

| Dimension | WASM/WASI | Container | Native/Plugin |
|---|---|---|---|
| Capability enforcement | **Strong** | Moderate | Weak |
| Resource metering | **Strong** | Moderate | Weak-Moderate |
| Tenant isolation | **Strong** | **Strong** | Moderate |
| FS/network/device access | **Strong** | Moderate | Weak |
| Compromise containment | **Strong** | Moderate | Weak |
| Lifecycle integration | **Clean** | Complex | Moderate |
| Provenance authoritativeness | **Best** | Moderate | Weak |
| Portability | **Best** | Moderate | Poor |
| Operational complexity | **Low** | High | High |
| Failure/termination | **Clean** | Moderate | Poor |

## 4. Architectural Questions Resolved (W019 Required Analysis)

1. **Trust boundary:** WASM instance boundary.
2. **Capability/resource authority:** ExtensionRuntime (V4 §2.6 unchanged).
3. **Grant/revoke:** WASI handles at instantiation; drop instance to revoke.
4. **In-flight revocation:** trap → failed provenance → re-throw.
5. **Authoritative measurements:** fuel, peak memory, wall-clock.
6. **Minimum tenant isolation:** structural (no shared address space).
7. **Fallback:** deny-by-default (`sandbox_unavailable`).
8. **New architecture version required:** Yes (provenance semantics change → IAAS-DOM-ARCH-5 candidate).

## 5. V4 Immutability Proof (W019-AC10)

- `spec/domain-architecture-v4.md` is NOT modified. It still says "Sandbox technology (WASM/container/native) remains OPEN/RESEARCH and is not frozen by V4."
- `spec/domain-requirements-v4.md` is NOT modified. `DOM-P05..DOM-P08` remain FUTURE/OPEN/RESEARCH.
- No production code changes. No sandbox runtime imports. No sandbox service files. No Prisma sandbox models.
- `ExtensionRuntime` and `ExtensionProvenanceService` do NOT import any sandbox module.

## 6. No Sandbox Implementation Proof (W019-AC10)

Static tests verify:
- No `wasmtime`/`wasmer`/`wasm-edge` imports in `src/lib/services/`.
- No `dockerode`/`containerd` imports.
- No `child_process`/`worker_threads` imports (native plugin process).
- No `sandbox`/`wasm`/`container`/`isolation` service files.
- No Prisma `Sandbox`/`WasmModule`/`ContainerImage` models.
- `ExtensionRuntime` and `ExtensionProvenanceService` do not import sandbox modules.

## 7. Governance Reconciliation

- `spec/work-items.md`: fixed pre-existing regression from PR #29 — WORK-019 had `Architecture Version: IAAS-DOM-ARCH-4` (validator SC-05 requires `IAAS-GOV-ARCH-\d+`). Changed to `IAAS-GOV-ARCH-1` (matching all other work items). CI didn't catch this because GitHub Actions didn't start for PR #29.
- `.github/workflows/ci.yml`: added `tests/work-019-sandbox-architecture.test.ts` to spec-validation job.

## 8. Verification Evidence (local)

```text
$ bunx tsc --noEmit → 0 errors
$ bun run spec:validate → SPEC VALIDATION PASSED
    architecture=IAAS-GOV-ARCH-1 domain-architecture=IAAS-DOM-ARCH-4
    work-items=19 dependency-edges=18 checks=20
$ bun run lint → clean
$ bun test tests/work-019-sandbox-architecture.test.ts → 42 pass, 0 fail
$ bun test (20 non-PG suites) → 480 pass, 0 fail
```

No PostgreSQL integration tests required (this is an architecture/research slice — no production code).

## 9. Diff Scope

```text
spec/architecture-change-requests/ACR-004.md              (new — ACR-004 document)
spec/work-items.md                                         (fix: WORK-019 Architecture Version IAAS-GOV-ARCH-1)
tests/work-019-sandbox-architecture.test.ts                (new — 42 regression tests)
.github/workflows/ci.yml                                   (add WORK-019 test to spec-validation job)
spec/evidence/WORK-019-verification-evidence.md            (this document)
```

No production code changes. No Prisma schema changes. No ExtensionRegistry/Runtime/Provenance changes. No V4 architecture/requirements modifications. No sandbox implementation.

## 10. Implementer Boundary Statement

- WORK-019 is **not** marked `VERIFIED`.
- PR is **not** merged.
- `IAAS-GOV-ARCH-1` + `IAAS-DOM-ARCH-4` remain FROZEN.
- ACR-004 is `DRAFT` — the Architect decides APPROVE / REQUEST_CHANGES / ARCHITECTURE_CHANGE_REQUIRED.
- No sandbox technology is implemented.
- No new architecture version is frozen (IAAS-DOM-ARCH-5 is a candidate proposed by the ACR, not frozen).
- WORK-020 is NOT started.

Ready for independent verification and Architect Review.
