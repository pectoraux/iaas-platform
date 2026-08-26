# REPOSITORY BASELINE — IAAS (commit 12c6b6c)

- Work Item: `WORK-002`
- Architecture: `IAAS-DOM-ARCH-1` (derived), governed by `IAAS-GOV-ARCH-1` (FROZEN)
- Audited commit: `12c6b6c` (main, post WORK-001 merge)
- Audit date: 2026-08-25 (UTC)
- Truth classifications: `OBSERVED` / `INFERRED` / `CONFIRMED` / `PROPOSED`

> This baseline records the actual repository state as evidence for
> `IAAS-DOM-ARCH-1`. Every material finding cites a concrete repository
> artifact (file path, line, model, test, or CI run). Per `IAAS-GOV-ARCH-1`
> frozen rule 6, agent narrative is contextual only; the evidence references
> below are the authoritative record.
>
> This document does NOT modify production code. It is a read-only audit
> synthesis. See `docs/architecture/RECONCILIATION-MATRIX.md` for the mapping
> of prior architecture statements to this evidence.

## 1. Repository Inventory (OBSERVED)

| Area | Path | Finding |
|---|---|---|
| Governance spec | `spec/` | 10 governance docs + WORK-001 evidence (FROZEN via WORK-001) |
| Domain architecture corpus | `docs/architecture/` | 10 docs: Constitution, Phase-13 reconciliation/graph/matrix, Phase-14A–14F contracts, FUTURE-NETWORK-COVERAGE |
| Phase specs | `docs/phase-*.md` | 3: phase-11a protocol, phase-12a buyer-capability, phase-12a universal network control-plane |
| Production source | `src/` | 131 files: app (54), components (48), lib (76), hooks (2), instrumentation (1) |
| Kernel | `src/lib/kernel/` | 19 files: runtime (11 incl. protocol/), adapters (2), concurrency (1), execution (1) |
| Control plane | `src/lib/control-plane/` | 8 files |
| Domain | `src/lib/domain/` | 9 files |
| Services | `src/lib/services/` | 34 files |
| API routes | `src/app/api/` | 51 route files (root + admin + auth + internal + v1) |
| Prisma schema | `prisma/schema.prisma` | 67 models, 2632 lines |
| Migrations | `prisma/migrations/` | present (9 migration dirs) |
| Mini-services | `mini-services/` | EMPTY (`.gitkeep` only) — no mini-service implemented |
| Tests | `tests/` | 49 test files (architecture-contract, phase-*, vpp-*, portfolio-*, runtime-*, spec-*, pr-invariant-*) |
| CI | `.github/workflows/ci.yml` | 5 jobs: spec-validation, lint, typecheck, architecture-tests, postgres-integration-tests |
| Scripts | `scripts/` | 3: spec-validator.ts, pr-invariant-check.ts, seed.ts |

## 2. Identity & Resource Models (OBSERVED)

Prisma models confirmed present in `prisma/schema.prisma`:

- Tenant, Organization, Operator
- ParticipantIdentity, ParticipantMembership, ParticipantRole
- ResourceIdentity, NetworkResourceMembership, CapacityResource,
  AssetNetworkAssignment
- Asset, Device, DeviceCredential, Capability
- Node, NodeNetworkMembership (Phase 14A — IMPLEMENTED)
- No `NodeAgent` model exists (FUTURE — confirmed absent)

**OBSERVED count: 67 models** (the `PHASE-13-GAP-MATRIX.md` summary states 54;
that summary is stale — see reconciliation matrix §R-04).

## 3. Runtime Kernel (OBSERVED)

`src/lib/kernel/runtime/`:

- `types.ts` — `NetworkRuntime` interface, `RuntimeKind` =
  `'infrastructure' | 'protocol' | 'hybrid'`, `validateRuntimeKind`.
- `infrastructure-runtime.ts` — `class InfrastructureRuntime implements NetworkRuntime`.
- `protocol-runtime.ts` — `class ProtocolRuntime implements NetworkRuntime`.
- `hybrid-runtime.ts` — `class HybridRuntime implements NetworkRuntime`,
  `DefaultHybridBridge` (the ONLY code importing both InfrastructureRuntime and
  ProtocolRuntime).
- `registry.ts` — `RuntimeRegistry` singleton + `runtimeRegistry`.
- `adapter-registry.ts` — `AdapterRegistry` singleton + `adapterRegistry`.
- `protocol/` — 8 files: `types.ts`, `reconciliation-types.ts`,
  `state-store.ts` (in-memory), `postgres-state-store.ts`, `executor.ts`,
  `validator-consensus.ts` (InMemoryValidatorRegistry +
  SimpleConsensusEngine + computeFinalityCertificate),
  `in-memory-reconciliation-store.ts`, `postgres-reconciliation-store.ts`.

`src/lib/kernel/adapters/`:
- `infrastructure-adapter.ts` — `InfrastructureAdapter` interface (Phase 4).
- `transport-adapter.ts` — `TransportAdapter` interface (Phase 14D) +
  `MockTransportAdapter` (wired via `registerTransportAdapter()` /
  `getTransportAdapter()` / `executeAttemptViaAdapter()`, NOT dead code).

`src/lib/kernel/concurrency/lease.service.ts` — universal claim/commit/fence.
`src/lib/kernel/execution/execution.service.ts` — generic Execution lifecycle.

## 4. Control Plane Pipeline (OBSERVED)

`src/lib/control-plane/`:

| File | Implements | Constitution stage |
|---|---|---|
| `types.ts` | Identity + Request + Decision contracts; `assertNetworkScopeIntegrity`; `deriveRequestId` | NetworkRequest, AllocationDecision |
| `scheduler.ts` | `schedule()` (pure, no DB, no kernel imports); `SCHEDULER_VERSION` | Deterministic Scheduler |
| `service.ts` | `submitNetworkRequest()`, `computePayloadHash()` | Request submission |
| `capacity-provider.ts` | `CapacityProvider` interface, `AssetCapacityProvider` | ResourceIdentity → Asset boundary |
| `execution-orchestrator.ts` | `commitDecisionToExecution()`, `executeDecision()`, `recoverStuckAssignments()` | Execution, ExecutionAssignment, NetworkRuntime.executeAssignment() |
| `execution-lease.ts` | `acquireExecutionLease()`, `fenceExecutionLease()`; `LEASE_STATUS`, `FenceOutcome`, `UnsafeToRetryError` | ExecutionLease (fencing) |
| `economic-pipeline.ts` | `initEconomicPipeline()`, `processEconomicPipeline()`, `reconcileEconomicPipeline()`, `traceEconomicChain()` | EconomicPipelineState |

CapacityReservation / CapacityCommitment are implemented in
`src/lib/services/capacity.service.ts` (referenced by the orchestrator).

## 5. Services (OBSERVED)

34 service files in `src/lib/services/`. Vertical services present: `vpp.service.ts`,
`compute.service.ts`. No `storage.service.ts` or `wireless.service.ts` (those
verticals are future-contract only).

Phase 14 data-plane services (5): `data-plane.service.ts`,
`routing.service.ts`, `transport.service.ts`,
`delivery-confirmation.service.ts`, `transform-record.service.ts`.

Generic economic services (called by `economic-pipeline.ts` via dynamic
import): `ingestion.service.ts`, `worker.service.ts`,
`contribution.service.ts`, `reward.service.ts`, `ledger.service.ts`,
`settlement.service.ts`.

## 6. Anti-Drift Rule Verification (CONFIRMED)

Constitution §16 rules, independently re-verified against source at `12c6b6c`:

| # | Rule | Verification method | Result |
|---|---|---|---|
| 1 | Generic economic pipeline imports NO vertical service | inspect static + dynamic imports of `src/lib/control-plane/economic-pipeline.ts` | CONFIRMED — imports only ingestion, worker, contribution, reward, ledger, settlement, domain/crypto |
| 2 | VPP/Compute import generic pipeline (not vice versa) | direction established by rule 1 | CONFIRMED |
| 3 | InfrastructureRuntime does NOT import ProtocolRuntime | inspect `infrastructure-runtime.ts` imports | CONFIRMED — imports only execution.service, adapter-registry, types |
| 4 | ProtocolRuntime does NOT import InfrastructureRuntime | inspect `protocol-runtime.ts` imports | CONFIRMED — imports only types, protocol/types, validator-consensus (mentions in comments only) |
| 5 | economicStage NOT consulted by generic reconciliation | `economic-pipeline.ts` does not read `economicStage` | CONFIRMED |
| 6 | Marketplace (future) MUST NOT directly execute extensions | no marketplace code exists | CONFIRMED (vacuously — no implementation) |
| 7 | TransformRegistry (future) MUST NOT depend on TransitNet | no TransformRegistry code exists | CONFIRMED (vacuously) |
| 8 | Protocol contract MUST NOT import TransitNet | no TransitNet code exists | CONFIRMED (vacuously) |
| 9 | Future protocol code MUST NOT be required by kernel | kernel does not import future protocol code | CONFIRMED |
| 10 | Phase 14 data-plane services import NO vertical service | inspect imports of all 5 phase-14 services | CONFIRMED — none import vpp/compute/storage/wireless |
| 11 | Phase 14 data-plane services import NO generic economic pipeline | grep `control-plane` in 5 services | CONFIRMED — no matches |
| 12 | Phase 14 data-plane services import NO ProtocolRuntime/HybridRuntime | grep in 5 services | CONFIRMED — no matches (only TransportAdapter type in transport.service) |
| 13 | Kernel imports NO Phase 14 data-plane service (except TransportAdapter) | grep `data-plane\|routing\|transport\|delivery-confirmation\|transform-record` in `src/lib/kernel/` | CONFIRMED — no matches; only `adapters/transport-adapter.ts` (the allowed contract) |

## 7. Data Plane Primitives (OBSERVED)

Phase 14A–14F primitives confirmed present (schema models + service files):

- 14A: `Node`, `NodeNetworkMembership` (`prisma/schema.prisma`);
  `src/lib/services/node.service.ts`.
- 14B: `Bundle`, `BundleDelivery`; `src/lib/services/data-plane.service.ts`
  (exports `deriveBundleId()`, `deriveDeliveryId()`).
- 14C: `Route`, `RouteHop`, `NodeCapability`, `NodeReachability`;
  `src/lib/services/routing.service.ts`.
- 14D: `TransportExecution`, `TransportAttempt`, `TransportCapability`;
  `src/lib/services/transport.service.ts`;
  `src/lib/kernel/adapters/transport-adapter.ts`.
- 14E: `DeliveryConfirmation`; `src/lib/services/delivery-confirmation.service.ts`.
- 14F: `TransformRecord`; `src/lib/services/transform-record.service.ts`.

## 8. CI State (OBSERVED)

`.github/workflows/ci.yml` — 5 jobs. At commit `12c6b6c` (main, post WORK-001):

- `spec-validation` (Specification Consistency Validator): `success` (WORK-001
  gate — validator, negative tests, one-active-PR invariant, diff-scope guard).
- `lint`: `success`.
- `typecheck`: `failure` (pre-existing — `baselineEngine` namespace error,
  constitution §15).
- `architecture-tests`: `failure` (pre-existing production baseline).
- `postgres-integration-tests`: `failure` (pre-existing production baseline).

The three pre-existing failures are production baseline issues predating
WORK-001, confirmed identical on `main` run `32511416648` (commit `db61a940`).
They are out of WORK-002 scope ("no unrelated production refactor").

## 9. Stale / Contradictory Documentation (OBSERVED)

These are documentation defects in the existing corpus, recorded for Architect
adjudication (NOT silently resolved):

- **B-01**: `docs/architecture/PHASE-13-GAP-MATRIX.md` header cites commit
  `dcc76df` (stale vs. current `12c6b6c`); its SUMMARY still states "15 future
  concepts are MISSING (Node, DataPlane, Bundle, ...)" while the body table
  classifies them as EXISTS (Phase 14x). The summary was not updated by the
  Phase 13R reconciliation.
- **B-02**: `docs/architecture/FUTURE-NETWORK-COVERAGE.md` treats Node, Bundle,
  and Transform as future contracts requiring definition, contradicting the
  Phase 13R reconciliation which classifies them as implemented (14A/14B/14F).
  Not updated by the reconciliation.
- **B-03**: `docs/architecture/PHASE-14F-TRANSFORM-RECORD-CONTRACT.md` §14
  describes the `nodeIdentity` encoding two inconsistent ways
  (`system:__unattributed__` vs `'__system__'`). The implementation
  (`src/lib/services/transform-record.service.ts:131`) and tests
  (`tests/phase-14f-transform-record.test.ts:822`) are consistent with the
  namespaced encoding. Documentation defect in a FROZEN contract.

These do not require production changes and are not stop-conditions: the
implementation is consistent and the contradictions are reconcilable by
evidence classification (OBSERVED code supersedes stale doc text). They are
flagged for the Architect to decide whether to amend the FROZEN contracts via
ACR.

## 10. API Surface (OBSERVED)

51 API route files under `src/app/api/`:
- root `api/route.ts` (1)
- `admin/` (4): users, waitlist (+ approve/reject)
- `auth/` (4): login, logout, me, signup
- `internal/` (2): health, worker/process
- `v1/` (40): assets, attestations, audit, capabilities, contributions,
  dashboard (e2e, stats), devices, events, funding, ingest/events, ledger
  (accounts, entries, postings), networks (+ versions/publish), operators,
  payouts, rewards, templates, tenants, vpp (dispatches, programs,
  reservations)

## 11. Audit Coverage Confirmation

Per WORK-002 "Repository Audit Coverage", the following were inspected:

- `docs/architecture/` — §1, §3, §7, §9
- `src/` — §1, §3, §4, §5, §10
- `prisma/` — §1, §2, §7
- `tests/` — §1, §6 (anti-drift test suite references)
- `.github/workflows/` — §1, §8
- package/build/runtime config — `package.json` (spec:validate/spec:test/
  spec:pr-invariant scripts), `tsconfig.json`, `next.config.ts`,
  `eslint.config.mjs`, `Caddyfile`, `vercel.json`
- examples and scripts — `scripts/` (§1); `examples/` present
- recent architectural commits — `db61a94` (Phase 13R), `0a882ff` (WORK-001
  merge), `12c6b6c` (WORK-002 handoff)

The audit explicitly accounts for the Phase 13R reconciliation and Phase
14A–14F implementation corpus (§7, §9, reconciliation matrix).
