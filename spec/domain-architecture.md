# IAAS Domain Architecture — IAAS-DOM-ARCH-1

- Domain Architecture Version: `IAAS-DOM-ARCH-1`
- Status: **FROZEN** (canonical, immutable; changes require an Architecture Change Request and a new version `IAAS-DOM-ARCH-2`)
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Produced by: `WORK-002` (Repository Baseline and Domain Architecture V1)
- Evidence basis: `docs/architecture/REPOSITORY-BASELINE.md` (truth-classified repository audit) and `docs/architecture/RECONCILIATION-MATRIX.md`

> This document is the canonical Domain Architecture V1. It reconciles the
> existing `docs/architecture/` corpus (Constitution + Phase 13R reconciliation
> + Phase 14A–14F contracts) with actual repository evidence (code, schema,
> tests, CI, history) into a single truth-classified architectural state.
>
> It does NOT overwrite the Constitution. The Constitution
> (`docs/architecture/ARCHITECTURE-CONSTITUTION.md`) and the Phase 13R
> Reconciliation remain repository evidence; this document is the canonical
> synthesis of them. Where this document and a prior phase contract appear to
> disagree, the disagreement is recorded in
> `docs/architecture/RECONCILIATION-MATRIX.md` with a truth classification
> (`OBSERVED`, `INFERRED`, `CONFIRMED`, `PROPOSED`) and an evidence reference.
>
> Per `IAAS-GOV-ARCH-1` frozen rule 4: repository state is evidence, not
> automatically architectural intent. Per frozen rule 10: the implementation
> agent does not choose the architecture. This document records what IS, not
> what any agent proposes should be — `PROPOSED` items are explicitly labelled
> and are NOT architecture.

## 1. Status Legend

Every architectural concept below carries exactly one status:

- **IMPLEMENTED** — directly evidenced by code, schema, tests, and/or CI at the
  audited commit (`12c6b6c`). Source paths are cited. (`OBSERVED` / `CONFIRMED`.)
- **FROZEN-CONTRACT** — an immutable contract published by a prior phase that
  governs an implemented or partially-implemented primitive. Changes require an
  ACR. (`CONFIRMED`.)
- **FUTURE** — acknowledged as not-yet-implemented; a placeholder exists in the
  architecture but no production code realizes it. (`INFERRED` from doc intent;
  NOT `OBSERVED`.)
- **OPEN / RESEARCH** — a design decision explicitly deferred; no commitment to
  a specific approach. (`PROPOSED`.)

No `INFERRED` or `PROPOSED` statement is promoted into historical fact.

## 2. Architectural Substrates

The IAAS platform is organized into four substrates plus a governance layer.
The dependency direction between substrates is frozen and one-way. The Data
Plane and the Economic Pipeline are **parallel substrates**: both are fed by
the Runtime/Control Plane, but neither depends on the other (the Data Plane is
independent of the generic Economic Pipeline in both directions — see §2.2
rules 7–9 and `spec/domain-dependency-graph.md`).

```text
GOVERNANCE (IAAS-GOV-ARCH-1, FROZEN)
    governs
DOMAIN ARCHITECTURE (IAAS-DOM-ARCH-1, FROZEN)   <-- this document
    governs
    |
    v
CONTROL PLANE  -->  RUNTIME KERNEL  -->  ECONOMIC PIPELINE
    |                   |                     ^
    v                   v                     |
  (requests)      (Infrastructure |          (verticals import
                  Protocol | Hybrid)           generic pipeline;
                  + EXECUTION LEASE             pipeline does NOT
                                               import verticals)

DATA PLANE  (parallel substrate; depends on Node/Identity only;
             independent of Economic Pipeline and Runtime kernel,
             except the TransportAdapter contract interface)
```

### 2.1 Generic Kernel Boundary

The kernel (`src/lib/kernel/`) exposes contracts and enforcement boundaries. It
does NOT become a complete networking stack. Kernel contracts are interfaces
only (`InfrastructureAdapter`, `TransportAdapter`, `NetworkRuntime`); concrete
implementations live in the runtime subtree or are injected by bootstrap.

- **IMPLEMENTED**: `src/lib/kernel/runtime/` (`InfrastructureRuntime`,
  `ProtocolRuntime`, `HybridRuntime`, `RuntimeRegistry`, `AdapterRegistry`),
  `src/lib/kernel/adapters/infrastructure-adapter.ts`,
  `src/lib/kernel/adapters/transport-adapter.ts` (incl. `MockTransportAdapter`),
  `src/lib/kernel/concurrency/lease.service.ts`,
  `src/lib/kernel/execution/execution.service.ts`,
  `src/lib/kernel/runtime/protocol/` (state-store, executor, consensus,
  reconciliation stores — in-memory + PostgreSQL).
- **FROZEN-CONTRACT**: `NetworkRuntime` interface (constitution §4); the three
  runtime kinds (`infrastructure` | `protocol` | `hybrid`); the runtime
  isolation rules (constitution §4 — InfrastructureRuntime MUST NOT import
  ProtocolRuntime and vice versa; HybridRuntime is the ONLY code that knows
  both worlds).
- **OPEN / RESEARCH**: kernel-level `Node` contract (`src/lib/kernel/node.ts`)
  is explicitly NOT created (Phase 14A Step 12; asserted absent by
  `tests/phase-13-architecture-contract.test.ts:173`). Node remains a
  service-layer primitive.

### 2.2 Vertical-Leakage Constraints (frozen anti-drift)

The following dependency directions are FROZEN and statically enforced by
`tests/architecture-contract.test.ts`, `tests/phase-12b-slice-7-vpp.test.ts`,
`tests/phase-13r-reconciliation-contract.test.ts`, and the
`tests/phase-14*-architecture-contract.test.ts` suite (constitution §16):

1. Generic economic pipeline imports NO vertical service. **IMPLEMENTED** —
   `src/lib/control-plane/economic-pipeline.ts` imports only generic primitives
   (ingestion, worker, contribution, reward, ledger, settlement), statically and
   dynamically.
2. VPP/Compute import the generic pipeline; the generic pipeline does NOT import
   verticals. **IMPLEMENTED.**
3. `InfrastructureRuntime` does NOT import `ProtocolRuntime`. **IMPLEMENTED.**
4. `ProtocolRuntime` does NOT import `InfrastructureRuntime`. **IMPLEMENTED.**
5. `economicStage` is NOT consulted by generic reconciliation. **IMPLEMENTED.**
6. Phase 14 data-plane services (data-plane, routing, transport,
   delivery-confirmation, transform-record) import NO vertical service.
   **IMPLEMENTED.**
7. Phase 14 data-plane services import NO generic economic pipeline.
   **IMPLEMENTED.**
8. Phase 14 data-plane services import NO `ProtocolRuntime` / `HybridRuntime`.
   **IMPLEMENTED.**
9. The kernel imports NO Phase 14 data-plane service except the `TransportAdapter`
   contract interface. **IMPLEMENTED.**

All nine rules were independently re-verified against source at commit
`12c6b6c` (see `docs/architecture/REPOSITORY-BASELINE.md` §6).

## 3. Identity & Resource Boundaries

```text
Asset ≠ Device ≠ Node ≠ ParticipantIdentity ≠ ResourceIdentity
ResourceIdentity ≠ Asset
```

| Primitive | Status | Evidence |
|---|---|---|
| Tenant (top-level isolation; all data tenant-scoped) | IMPLEMENTED | `prisma/schema.prisma` model Tenant; `src/lib/domain/tenant-context.ts` |
| ParticipantIdentity (global; no networkId; joins via ParticipantMembership) | IMPLEMENTED | `prisma/schema.prisma`; `src/lib/control-plane/types.ts` |
| ParticipantMembership (network-scoped; pending→active→suspended→revoked) | IMPLEMENTED | `prisma/schema.prisma`; `src/lib/control-plane/types.ts` |
| ParticipantRole (provider\|consumer\|verifier\|validator\|orchestrator\|observer) | IMPLEMENTED | `prisma/schema.prisma` |
| Organization (optional grouping) | IMPLEMENTED | `prisma/schema.prisma` |
| ResourceIdentity (universal; no networkId; joins via NetworkResourceMembership) | IMPLEMENTED | `prisma/schema.prisma`; `src/lib/control-plane/types.ts` |
| NetworkResourceMembership (per-network binding to ParticipantMembershipId) | IMPLEMENTED | `prisma/schema.prisma` |
| CapacityResource (platform capacity record; generic) | IMPLEMENTED | `prisma/schema.prisma` |
| AssetNetworkAssignment (authoritative verified physical capacity) | IMPLEMENTED | `prisma/schema.prisma` |
| Asset / Device / Capability / Operator | IMPLEMENTED | `prisma/schema.prisma` |
| Node (service-layer protocol participant; tenant-scoped; distinct from Asset/Device) | IMPLEMENTED | `src/lib/services/node.service.ts`; `prisma/schema.prisma` model Node |
| NodeNetworkMembership (network-scoped participation; distinct from NetworkResourceMembership) | IMPLEMENTED | `prisma/schema.prisma`; `src/lib/services/node.service.ts` |
| NodeAgent | FUTURE | No evidence requires it (Phase 14A Step 3 audit); no code, no schema model |

The control plane MUST NOT read the Asset table directly; the `CapacityProvider`
boundary translates ResourceIdentity → Asset. **IMPLEMENTED** —
`src/lib/control-plane/capacity-provider.ts`.

## 4. Network & Runtime Boundaries

| Primitive | Status | Evidence |
|---|---|---|
| NetworkDefinition (tenant-scoped; vertical: generic\|energy_vpp\|storage\|wireless\|compute\|protocol) | IMPLEMENTED | `prisma/schema.prisma`; `src/lib/services/network.service.ts` |
| NetworkVersion (IMMUTABLE after publishedAt; runtimeKind immutable) | IMPLEMENTED | `prisma/schema.prisma` |
| NetworkTemplate (reusable blueprint; vertical-neutral) | IMPLEMENTED | `prisma/schema.prisma`; `src/lib/domain/templates.ts` |
| NetworkVersion.runtimeKind → RuntimeRegistry.resolve() → NetworkRuntime | IMPLEMENTED | `src/lib/kernel/runtime/registry.ts`; `src/lib/kernel/runtime/types.ts` |
| InfrastructureRuntime (physical asset dispatch via adapters) | IMPLEMENTED | `src/lib/kernel/runtime/infrastructure-runtime.ts` |
| ProtocolRuntime (deterministic state transitions via consensus) | IMPLEMENTED | `src/lib/kernel/runtime/protocol-runtime.ts` + `runtime/protocol/*` |
| HybridRuntime (ONLY code bridging infrastructure + protocol) | IMPLEMENTED | `src/lib/kernel/runtime/hybrid-runtime.ts` (`DefaultHybridBridge`) |
| RuntimeRegistry / AdapterRegistry (singletons) | IMPLEMENTED | `src/lib/kernel/runtime/registry.ts`, `adapter-registry.ts` |
| ProtocolRuntime state machine (ProtocolStateStore, versioned) | IMPLEMENTED | `runtime/protocol/state-store.ts`, `postgres-state-store.ts` |
| DeterministicTransactionExecutor | IMPLEMENTED | `runtime/protocol/executor.ts` |
| Validator registry + consensus (SimpleConsensusEngine, finality certificate) | IMPLEMENTED | `runtime/protocol/validator-consensus.ts` |
| Four-primitive reconciliation (PhysicalExecutionEvidence, ReconciliationAttempt, ProtocolOutcome, ReconciliationState) | IMPLEMENTED | `runtime/protocol/reconciliation-types.ts`, `postgres-reconciliation-store.ts`, `in-memory-reconciliation-store.ts` |

> **Spec/impl note (OBSERVED, non-blocking):** `NetworkRuntime` is an interface
> in `runtime/types.ts`, not a concrete class. The three concrete classes are
> `InfrastructureRuntime`, `ProtocolRuntime`, `HybridRuntime`. Bootstrap
> (`src/lib/bootstrap/`) constructs and registers them; `runtime/index.ts` does
> not auto-register concrete runtimes. This is recorded as OBSERVED and does not
> require an architectural change.

## 5. Control Plane Pipeline (frozen)

```text
NetworkRequest
  → Deterministic Scheduler
  → AllocationDecision
  → AllocationReservation (CapacityReservation)
  → CapacityCommitment
  → Execution
  → ExecutionAssignment
  → ExecutionLease (ownership/fencing)
  → NetworkRuntime.executeAssignment()
  → Operational Completion
  → EconomicPipelineState
```

| Stage | Status | Evidence |
|---|---|---|
| NetworkRequest + deterministic request id | IMPLEMENTED | `src/lib/control-plane/types.ts`, `service.ts` |
| Deterministic Scheduler (pure, no DB) | IMPLEMENTED | `src/lib/control-plane/scheduler.ts` |
| AllocationDecision | IMPLEMENTED | `src/lib/control-plane/types.ts` |
| CapacityReservation / CapacityCommitment | IMPLEMENTED | `src/lib/services/capacity.service.ts` |
| Execution / ExecutionAssignment | IMPLEMENTED | `src/lib/kernel/execution/execution.service.ts`; `src/lib/control-plane/execution-orchestrator.ts` |
| ExecutionLease (one active per assignment; ACTIVE→FENCING→FENCED\|UNSAFE_TO_RETRY) | IMPLEMENTED | `src/lib/control-plane/execution-lease.ts` |
| NetworkRuntime.executeAssignment() | IMPLEMENTED | `src/lib/control-plane/execution-orchestrator.ts` (resolves via RuntimeRegistry) |
| EconomicPipelineState (cacheable recovery metadata; durable objects = source of truth) | IMPLEMENTED | `src/lib/control-plane/economic-pipeline.ts` |

## 6. Economic Boundary (frozen)

```text
ExecutionResult
  → Event (evidence)
  → VerificationResult (policy-driven)
  → Attestation (verified claim)
  → Contribution (verified economic activity)
  → Reward (economic entitlement)
  → LedgerPosting (double-entry accounting)
  → Settlement (payment instruction)
```

- **IMPLEMENTED**: all stages — `src/lib/services/` ingestion, worker,
  contribution, reward, ledger, settlement, attestation, verification;
  `src/lib/control-plane/economic-pipeline.ts` orchestrates the 7-stage
  pipeline with checkpoint recovery.
- **FROZEN-CONTRACT**: the generic pipeline MUST NOT import VPP / Compute /
  Storage / Wireless / Manufacturing or any vertical service. Verticals import
  the generic pipeline; the pipeline does NOT import verticals. (constitution §5.)
- **FROZEN-CONTRACT**: `VppDispatchAssignment.economicStage` is LEGACY and is NOT
  consulted by generic reconciliation. (constitution §5, §16 rule 5.)
- **VPP pre-pipeline evidence pattern**: VPP performs its own evidence +
  verification + baseline calculation BEFORE the economic pipeline (baseline
  depends on the attestation); the pipeline's evidence/verification stages are
  skipped (eventId + attestationId pre-populated). This is a legitimate
  vertical-specific transformation of verified evidence. **IMPLEMENTED** —
  `src/lib/services/vpp.service.ts`, `baseline-engine.service.ts`,
  `baseline-evaluation.service.ts`.

## 7. Data Plane Boundary (PARTIALLY IMPLEMENTED — Phase 14B–14F)

```text
CONTROL PLANE decides: who, what, where, why, policy, resource, capability, allocation, route constraints
DATA PLANE performs:   receive, store, route, forward, deliver, deduplicate, expire, acknowledge, transform(provenance)
```

Frozen dependency direction (Phase 13R §6):

```text
Node → Bundle → Route → TransportExecution → TransportAdapter → DeliveryConfirmation
                                                                  ↘ TransformRecord
```

| Primitive | Data-plane op | Status | Evidence |
|---|---|---|---|
| Bundle (immutable identity; generic; reusable by TransitNet/DTN/future) | receive/store/deliver/expire/deduplicate | IMPLEMENTED (14B) | `src/lib/services/data-plane.service.ts`; `prisma/schema.prisma` Bundle, BundleDelivery |
| BundleDelivery (append-only; at-least-once + idempotent) | — | IMPLEMENTED (14B) | `prisma/schema.prisma` |
| Route + RouteHop (service-layer; WHERE not HOW) | route | IMPLEMENTED (14C) | `src/lib/services/routing.service.ts`; `prisma/schema.prisma` Route, RouteHop |
| NodeCapability / NodeReachability (declaration/knowledge; not proof) | — | IMPLEMENTED (14C) | `prisma/schema.prisma` |
| TransportExecution + TransportAttempt (service-layer; per-hop attempts) | forward | IMPLEMENTED (14D) | `src/lib/services/transport.service.ts`; `prisma/schema.prisma` |
| TransportCapability (generic declaration) | — | IMPLEMENTED (14D) | `prisma/schema.prisma` |
| TransportAdapter (KERNEL contract interface; MockTransportAdapter wired, not dead) | — | IMPLEMENTED (14D) | `src/lib/kernel/adapters/transport-adapter.ts` |
| DeliveryConfirmation (immutable receipt; no status field) | acknowledge | IMPLEMENTED (14E) | `src/lib/services/delivery-confirmation.service.ts`; `prisma/schema.prisma` |
| TransformRecord (immutable provenance; 7-element fingerprint) | transform (provenance only) | PARTIALLY IMPLEMENTED (14F) | `src/lib/services/transform-record.service.ts`; `prisma/schema.prisma` |
| Fragmentation / Reassembly | fragment/reassemble | FUTURE | No code, no schema (constitution §8; Phase 14B §15) |
| TransformRegistry (technical catalog) | — | FUTURE | No code (constitution §9) |
| TransformRuntime (execution engine) | transform (execution) | FUTURE | No code (constitution §9) |

> **Recorded contradiction (INFERRED, documentation defect — flagged for
> Architect Review, NOT silently resolved):** `docs/architecture/PHASE-14F-
> TRANSFORM-RECORD-CONTRACT.md` §14 describes the `nodeIdentity` encoding two
> inconsistent ways: one subsection says `system:__unattributed__` (namespaced),
> another says the service computes `'__system__'` (old sentinel). The
> **implementation and tests are consistent** with the namespaced encoding:
> `src/lib/services/transform-record.service.ts:131` computes
> `'system:__unattributed__'`, and
> `tests/phase-14f-transform-record.test.ts:822` asserts
> `nodeIdentity` is NOT `'__system__'`. This is a documentation defect in a
> FROZEN contract, not an architectural contradiction. Per WORK-002 Out of
> Scope, the FROZEN contract is not modified by the implementer; the defect is
> recorded in `docs/architecture/RECONCILIATION-MATRIX.md` for Architect
> adjudication.

## 8. Evidence / Verification Boundary

- **IMPLEMENTED**: current infrastructure evidence adapter —
  `Event (device-signed telemetry) → VerificationResult → Attestation`.
  (`src/lib/services/ingestion.service.ts`, `verification.service.ts`,
  `attestation.service.ts`.)
- **FUTURE**: generic `VerifiedEvidenceContext` (constitution §6). The
  VPP pre-population pattern is accepted as safe in the interim (durable
  PostgreSQL records; checkpoint IDs validated against deterministic
  identities; stale/NULL IDs recovered from durable state).

## 9. Protocol / Extension / Marketplace / SDK Boundaries

| Boundary | Status | Evidence |
|---|---|---|
| Protocol declaration contract (identity, version, capabilities, extensions, security, data-plane requirements) | FROZEN-CONTRACT (constitution §7); ProtocolRuntime owns state machine/executor/consensus only | `src/lib/kernel/runtime/protocol-runtime.ts` |
| Protocol-specific semantics outside kernel services | FROZEN-CONTRACT | — |
| Extension (routing strategy, scheduling, transforms, etc.) | FUTURE (contract only) | No code (constitution §10) |
| Extension security (publisher identity, signature, sandbox, resource limits) | OPEN / RESEARCH | Implementation technology (WASM/containers/native) undecided (constitution §10) |
| Marketplace (resolves/publishes artifacts; MUST NOT execute extensions) | FUTURE (contract only) | No code (constitution §11) |
| SDK/API domains (Identity, Node, Network, Capability, Resource, Execution, Bundle, Transform, Extension, Telemetry, Contribution, Policy) | FUTURE (contract only) | No code (constitution §12) |
| Local SDK vs Remote Fleet API (generic methods: registerNode, advertiseCapability, joinNetwork, provideResource) | FUTURE (contract only) | No code (constitution §12) |
| Network Launch Model (kernel unchanged when a new network launches) | FROZEN-CONTRACT | `src/lib/domain/templates.ts` (NetworkTemplate) |

## 10. Persistence Contract

- **FROZEN-CONTRACT**: PostgreSQL is the mandatory persistence provider. SQLite
  is NOT supported for production or integration tests. All invariants must be
  proven against real PostgreSQL. (constitution §14.)
- **IMPLEMENTED**: `prisma/schema.prisma` (67 models at commit `12c6b6c`);
  `src/lib/db.ts`; PostgreSQL-backed protocol state + reconciliation stores;
  CI `postgres-integration-tests` job (pre-existing, out of WORK-002 scope).

## 11. Known Issues (OBSERVED, carried forward)

- `baselineEngine` TypeScript namespace error at
  `src/lib/services/vpp.service.ts:820-822` (`TS2503: Cannot find namespace
  'baselineEngine'`). Pre-existing (confirmed at commit `f614659`, before VPP
  migration). TypeScript type-check error only; runtime behavior is correct.
  Out of scope for WORK-002 (no production refactor). Recorded in constitution
  §15 and acknowledged by Phase 14A/14C/14D/14E.
- Pre-existing CI failures: `Typecheck`, `Architecture Contract Tests`,
  `PostgreSQL Integration Tests` fail on `main` (run `32511416648`,
  commit `db61a940`). These are production baseline failures predating WORK-001,
  unrelated to the governance/domain-architecture layer. They are repository
  evidence for a future production-hardening Work Item, explicitly out of
  WORK-002 scope.

## 12. Domain Architecture V1 Rules (Work Order compliance)

This document satisfies the WORK-002 "Domain Architecture V1 Rules":

- **Preserves the frozen governance architecture boundary**: `IAAS-GOV-ARCH-1`
  rules 1–13 are untouched; this document is governed BY them, not a replacement.
- **Reconciles, not overwrites, the constitutional architecture**: the
  Constitution and Phase 13R/14A–14F contracts remain repository evidence;
  differences are recorded in the reconciliation matrix with truth
  classifications.
- **Explicitly distinguishes implemented, frozen-contract, future, and
  open/research**: the status legend (§1) and per-primitive statuses (§3–§9).
- **Identifies contradictions**: the Phase-14F `nodeIdentity` documentation
  defect (§7) and the stale `PHASE-13-GAP-MATRIX.md` summary /
  `FUTURE-NETWORK-COVERAGE.md` (see reconciliation matrix).
- **Identifies incomplete implementations and missing verification**: Phase 14F
  TransformRecord is PARTIALLY IMPLEMENTED (provenance only); future
  TransformRegistry/Runtime; pre-existing CI failures.
- **Defines generic kernel boundaries and vertical-leakage constraints**: §2.1,
  §2.2 (nine frozen anti-drift rules, all OBSERVED-confirmed).
- **Defines the canonical dependency direction for major domain primitives**:
  §2 substrate direction + §7 frozen data-plane direction
  (Node → Bundle → Route → TransportExecution → TransportAdapter →
  DeliveryConfirmation / TransformRecord).
- **Avoids introducing new production abstractions**: no new production code or
  abstraction is introduced; this is an architecture-synthesis document only.

## 13. What This Document Is NOT

- It is NOT a production implementation. No `src/`, `prisma/`, or
  `mini-services/` file is changed by WORK-002.
- It is NOT a roadmap. `FUTURE` and `OPEN / RESEARCH` items are recorded as
  architecture gaps, not commitments.
- It is NOT self-verified. WORK-002 is submitted for independent verification
  and Architect Review; `VERIFIED` is decided by the Architect, not the
  implementer.
- It does NOT modify `IAAS-GOV-ARCH-1`. Domain architecture changes require an
  ACR and a new version (`IAAS-DOM-ARCH-2`).
