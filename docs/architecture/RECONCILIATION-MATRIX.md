# RECONCILIATION MATRIX — IAAS Architecture Corpus vs Repository Evidence

- Work Item: `WORK-002`
- Architecture: `IAAS-DOM-ARCH-1`, governed by `IAAS-GOV-ARCH-1` (FROZEN)
- Audited commit: `12c6b6c`
- Truth classifications: `OBSERVED` / `INFERRED` / `CONFIRMED` / `PROPOSED`

> This matrix maps material architectural statements in the existing
> `docs/architecture/` corpus to repository evidence, and records how each is
> reconciled into `IAAS-DOM-ARCH-1` (`spec/domain-architecture.md`). Per
> `IAAS-GOV-ARCH-1` frozen rule 4, repository state is evidence; per rule 6,
> discoveries are truth-classified. No `INFERRED` or `PROPOSED` statement is
> promoted into historical fact.
>
> Contradictions are recorded, NOT silently resolved by production changes.
> Where a FROZEN contract has a documentation defect, the defect is flagged for
> Architect adjudication (the implementer does not modify FROZEN contracts).

## Classification Key

- `OBSERVED` — directly evidenced by code, schema, tests, CI, or history.
- `INFERRED` — derived interpretation not directly established by an explicit
  architectural decision.
- `CONFIRMED` — explicitly supported by authoritative architecture decisions
  PLUS repository evidence.
- `PROPOSED` — future design or unresolved recommendation (NOT architecture).

## R — Reconciliation Entries

### R-01 — Node identity boundary

| Field | Value |
|---|---|
| Source statement | Constitution §1: "Node (IMPLEMENTED — Phase 14A): A protocol participant. Distinct from Asset/Device." |
| Phase contract | Phase 14A Node Contract (FROZEN): `Asset ≠ Device ≠ Node ≠ ParticipantIdentity ≠ ResourceIdentity` |
| Repository evidence | `src/lib/services/node.service.ts`; `prisma/schema.prisma` model Node (line ~2005), NodeNetworkMembership (line ~2053); `tests/phase-14a-node.test.ts` |
| Classification | CONFIRMED |
| Reconciliation | Recorded in `IAAS-DOM-ARCH-1` §3 as IMPLEMENTED. No change. |

### R-02 — Runtime isolation (Infrastructure vs Protocol)

| Field | Value |
|---|---|
| Source statement | Constitution §4: "InfrastructureRuntime MUST NOT import ProtocolRuntime. ProtocolRuntime MUST NOT import InfrastructureRuntime." |
| Repository evidence | `src/lib/kernel/runtime/infrastructure-runtime.ts` imports only execution.service, adapter-registry, types. `protocol-runtime.ts` imports only types, protocol/types, validator-consensus. `hybrid-runtime.ts` is the sole file importing both (as type). |
| Classification | CONFIRMED |
| Reconciliation | Recorded in `IAAS-DOM-ARCH-1` §2.2 (rule 3, 4) and §4. No change. |

### R-03 — Generic economic pipeline vertical-leakage prohibition

| Field | Value |
|---|---|
| Source statement | Constitution §5: "Generic economic pipeline MUST NOT import VPP, Compute, Storage, Wireless, Manufacturing." |
| Repository evidence | `src/lib/control-plane/economic-pipeline.ts` static imports: db, crypto, prisma. Dynamic imports: ingestion, worker, contribution, reward, ledger, settlement, domain/crypto. No vertical service (static or dynamic). |
| Classification | CONFIRMED |
| Reconciliation | Recorded in `IAAS-DOM-ARCH-1` §2.2 (rule 1), §6. DOM-005. No change. |

### R-04 — PHASE-13-GAP-MATRIX summary staleness (contradiction)

| Field | Value |
|---|---|
| Source statement | `docs/architecture/PHASE-13-GAP-MATRIX.md` SUMMARY: "54 Prisma models exist, ... 15 future concepts are MISSING (Node, DataPlane, Bundle, Transform, ...)" |
| Contradicting evidence | (a) `prisma/schema.prisma` has 67 models (not 54). (b) The same document's body table classifies Node/DataPlane/Bundle as EXISTS (Phase 14x) — contradicting its own summary. (c) Phase 13R reconciliation §3 admits Node/Bundle/etc. as implemented. |
| Classification | OBSERVED (defect) — the summary is stale; the body table + reconciliation are authoritative. |
| Reconciliation | NOT silently resolved by editing the FROZEN corpus. Recorded as baseline finding B-01. `IAAS-DOM-ARCH-1` §1 inventory records 67 models (OBSERVED). The 15 "MISSING" concepts are reconciled: Node/Bundle/Route/TransportExecution/TransportAdapter/DeliveryConfirmation/TransformRecord = IMPLEMENTED (14A–14F); TransformRegistry/Runtime/Extension/Marketplace/SDK = FUTURE. Flagged for Architect adjudication on whether to amend the Gap Matrix. |

### R-05 — FUTURE-NETWORK-COVERAGE staleness (contradiction)

| Field | Value |
|---|---|
| Source statement | `docs/architecture/FUTURE-NETWORK-COVERAGE.md`: treats Node, Bundle, Transform as future contracts "requiring new contracts"; conditions substrate support on "once the Node, DataPlane/Bundle, Transform, and Extension contracts are defined." |
| Contradicting evidence | Phase 14A–14F contracts are FROZEN and implemented (R-01, R-06, R-08). Node, Bundle, TransformRecord exist in code + schema. |
| Classification | OBSERVED (defect) — the coverage doc was not updated by the Phase 13R reconciliation. |
| Reconciliation | NOT silently resolved. Recorded as baseline finding B-02. `IAAS-DOM-ARCH-1` §7 classifies the implemented data-plane primitives. The coverage doc's conceptual analysis remains valid for the still-FUTURE primitives (Extension, Marketplace, SDK). Flagged for Architect adjudication. |

### R-06 — Bundle generality

| Field | Value |
|---|---|
| Source statement | Constitution §8: "Bundle must be reusable by: TransitNet, Local-first Internet, DTN, future protocols." Phase 14B contract (FROZEN). |
| Repository evidence | `src/lib/services/data-plane.service.ts`; `prisma/schema.prisma` Bundle, BundleDelivery. No vertical-specific fields. `tests/phase-14b-architecture-contract.test.ts`. |
| Classification | CONFIRMED |
| Reconciliation | Recorded in `IAAS-DOM-ARCH-1` §7. DOM-007. No change. |

### R-07 — Phase 14F TransformRecord partial implementation

| Field | Value |
|---|---|
| Source statement | Constitution §9: "TRANSFORM BOUNDARY (PARTIALLY IMPLEMENTED — Phase 14F: TransformRecord provenance. TransformRegistry and TransformRuntime remain future.)" |
| Repository evidence | `src/lib/services/transform-record.service.ts` (provenance: createTransformRecord, getTransformRecord, listTransformRecords, computeTransformFingerprint). No TransformRegistry or TransformRuntime code or schema. |
| Classification | CONFIRMED (partial) |
| Reconciliation | Recorded in `IAAS-DOM-ARCH-1` §7 as PARTIALLY IMPLEMENTED. DOM-008. TransformRegistry/Runtime = FUTURE (DOM-P02, DOM-P03). No change. |

### R-08 — Phase 14F nodeIdentity documentation contradiction (defect)

| Field | Value |
|---|---|
| Source statement | `docs/architecture/PHASE-14F-TRANSFORM-RECORD-CONTRACT.md` §14: one subsection states `nodeIdentity = 'system:__unattributed__'` (namespaced); another states the service computes `nodeIdentity = '__system__'` (old sentinel). Mutually inconsistent. |
| Repository evidence | `src/lib/services/transform-record.service.ts:131`: `const nodeIdentity = input.nodeId ? \`node:${input.nodeId}\` : 'system:__unattributed__'`. `tests/phase-14f-transform-record.test.ts:822`: `expect(record.nodeIdentity).not.toBe('__system__')`. |
| Classification | OBSERVED — the CODE is consistent (namespaced encoding). The DOCUMENT has an internal contradiction (stale subsection). |
| Reconciliation | NOT silently resolved. The implementer does not modify the FROZEN Phase 14F contract (WORK-002 Out of Scope). Recorded as baseline finding B-03. `IAAS-DOM-ARCH-1` §7 records the OBSERVED code behavior as canonical. Flagged for Architect adjudication: the stale `'__system__'` subsection should be amended via ACR or doc correction. This is a documentation defect, NOT an architectural contradiction requiring production change — stop-condition NOT triggered. |

### R-09 — Execution Lease fencing

| Field | Value |
|---|---|
| Source statement | Constitution §4: "ExecutionLease (frozen — Slice 5): ACTIVE → FENCING → FENCED | UNSAFE_TO_RETRY. Adapters that cannot cancel are UNSAFE_TO_RETRY (capacity NOT released)." |
| Repository evidence | `src/lib/control-plane/execution-lease.ts`: `LEASE_STATUS`, `FenceOutcome`, `UnsafeToRetryError`, `acquireExecutionLease`, `fenceExecutionLease`. |
| Classification | CONFIRMED |
| Reconciliation | Recorded in `IAAS-DOM-ARCH-1` §5. DOM-004. No change. |

### R-10 — PostgreSQL persistence mandate

| Field | Value |
|---|---|
| Source statement | Constitution §14: "PostgreSQL is the mandatory persistence provider. SQLite is NOT supported." |
| Repository evidence | `prisma/schema.prisma` (67 models, PostgreSQL features); `src/lib/db.ts`; CI `postgres-integration-tests` job with `postgres:16-alpine` service; `postgres-state-store.ts`, `postgres-reconciliation-store.ts`. |
| Classification | CONFIRMED |
| Reconciliation | Recorded in `IAAS-DOM-ARCH-1` §10. DOM-010. No change. |

### R-11 — Kernel Node-contract absence

| Field | Value |
|---|---|
| Source statement | Phase 14A contract Step 12: kernel-level Node contract (`src/lib/kernel/node.ts`) explicitly NOT created. |
| Repository evidence | `src/lib/kernel/node.ts` does not exist; `tests/phase-13-architecture-contract.test.ts:173` asserts its absence. |
| Classification | CONFIRMED |
| Reconciliation | Recorded in `IAAS-DOM-ARCH-1` §2.1 (OPEN/RESEARCH — Node is service-layer). DOM-011. No change. |

### R-12 — baselineEngine namespace error (known issue)

| Field | Value |
|---|---|
| Source statement | Constitution §15: `src/lib/services/vpp.service.ts:820-822` `TS2503: Cannot find namespace 'baselineEngine'`. Pre-existing at `f614659`. |
| Repository evidence | Present at `12c6b6c`. Causes `typecheck` CI job failure. |
| Classification | OBSERVED (known issue) |
| Reconciliation | Recorded in `IAAS-DOM-ARCH-1` §11. Out of WORK-002 scope (no production refactor). Carried forward for a future code-quality Work Item. |

### R-13 — Phase 13R reconciliation authority

| Field | Value |
|---|---|
| Source statement | `docs/architecture/PHASE-13-RECONCILIATION.md`: formally admits Phase 14A–F primitives into the constitution via six amendments; per-phase contracts operationalize but do NOT supersede the constitution. |
| Repository evidence | Commit `db61a94` (Phase 13R); constitution header references it; Phase 14A–F contracts exist + implemented. |
| Classification | CONFIRMED |
| Reconciliation | `IAAS-DOM-ARCH-1` reconciles (not overwrites) the constitution + Phase 13R. The reconciliation remains the authoritative amendment record. No change. |

## Summary

| Classification | Count | Meaning |
|---|---|---|
| CONFIRMED | 9 (R-01, R-02, R-03, R-06, R-07, R-09, R-10, R-11, R-13) | Architecture statement + repository evidence agree. |
| OBSERVED (defect) | 3 (R-04, R-05, R-08) | Documentation defect in existing corpus; code is consistent. Flagged for Architect; NOT silently resolved. |
| OBSERVED (known issue) | 1 (R-12) | Pre-existing production issue; out of WORK-002 scope. |
| INFERRED | 0 | No derived interpretation was promoted to fact. |
| PROPOSED | 0 | No future design was presented as existing architecture. |

No stop-condition was triggered. The three documentation defects (R-04, R-05,
R-08) are reconcilable by evidence classification (OBSERVED code supersedes
stale documentation text) and do not require production changes or a new frozen
architectural primitive. They are escalated to the Architect for adjudication
on whether to amend the affected FROZEN documents via ACR or doc correction.
