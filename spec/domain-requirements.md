# IAAS Domain Requirements — IAAS-DOM-ARCH-1

- Domain Architecture: `IAAS-DOM-ARCH-1` (FROZEN)
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Derived by: `WORK-002` from `docs/architecture/REPOSITORY-BASELINE.md`

> Domain requirements are derived from the canonical domain architecture, not
> invented. Each requirement references the architectural substrate it governs
> and the evidence classification (`OBSERVED` / `CONFIRMED`) that establishes it
> as implemented. `PROPOSED` requirements are explicitly labelled and are NOT
> acceptance-bearing until promoted by a future Work Item + ACR.
>
> Governance requirements `GOV-001`…`GOV-008` continue to govern execution and
> are NOT duplicated here.

## DOM-001 — Identity Boundary Integrity

Every participant, resource, and node identity MUST be a distinct primitive.
`Asset ≠ Device ≠ Node ≠ ParticipantIdentity ≠ ResourceIdentity`. The control
plane MUST NOT read the Asset table directly; the `CapacityProvider` boundary
translates ResourceIdentity → Asset.

- Classification: CONFIRMED (constitution §1, §2; Phase 14A contract; OBSERVED
  in `src/lib/control-plane/capacity-provider.ts`, `node.service.ts`).
- Acceptance: identity models present in `prisma/schema.prisma`;
  `CapacityProvider` interface present; `node.service` does not import
  VPP/Compute (Phase 14A anti-drift rule).

## DOM-002 — Runtime Isolation

`InfrastructureRuntime` MUST NOT import `ProtocolRuntime` and vice versa.
`HybridRuntime` is the ONLY code that bridges both worlds. The control plane
MUST resolve runtimes via `RuntimeRegistry`, never importing concrete runtimes.

- Classification: CONFIRMED (constitution §4; OBSERVED in
  `src/lib/kernel/runtime/`).
- Acceptance: static import inspection confirms isolation; `HybridRuntime` is
  the sole bridge.

## DOM-003 — Network Version Immutability

`NetworkVersion` is IMMUTABLE once `publishedAt` is set. `runtimeKind` is
immutable after publication. A new runtime choice requires a new
`NetworkVersion`.

- Classification: CONFIRMED (constitution §3; OBSERVED in `prisma/schema.prisma`).
- Acceptance: schema enforces immutability; runtime selection via
  `RuntimeRegistry.resolve(kind)`.

## DOM-004 — Control Plane Pipeline Integrity

The frozen control plane pipeline (NetworkRequest → Scheduler → AllocationDecision
→ CapacityReservation → CapacityCommitment → Execution → ExecutionAssignment →
ExecutionLease → NetworkRuntime.executeAssignment → EconomicPipelineState) MUST
be preserved. `ExecutionLease` enforces one active lease per assignment with
ACTIVE → FENCING → FENCED | UNSAFE_TO_RETRY fencing.

- Classification: CONFIRMED (constitution §4; OBSERVED in
  `src/lib/control-plane/`).
- Acceptance: pipeline stages implemented; lease fencing lifecycle present
  (`LEASE_STATUS`, `FenceOutcome`, `UnsafeToRetryError`).

## DOM-005 — Generic Economic Pipeline Vertical-Leakage Prohibition

The generic economic pipeline MUST NOT import VPP, Compute, Storage, Wireless,
Manufacturing, or any vertical service. Verticals import the generic pipeline;
the pipeline does NOT import verticals. `VppDispatchAssignment.economicStage`
is LEGACY and MUST NOT be consulted by generic reconciliation.

- Classification: CONFIRMED (constitution §5, §16 rules 1, 2, 5; OBSERVED in
  `src/lib/control-plane/economic-pipeline.ts`).
- Acceptance: static + dynamic import inspection confirms no vertical imports;
  `economicStage` not read by reconciliation.

## DOM-006 — Data Plane Primitive Direction

The frozen data-plane dependency direction MUST be preserved:
`Node → Bundle → Route → TransportExecution → TransportAdapter →
DeliveryConfirmation` and `→ TransformRecord`. Phase 14 data-plane services
MUST NOT import vertical services, the generic economic pipeline, or
ProtocolRuntime/HybridRuntime. The kernel MUST NOT import Phase 14 data-plane
services except the `TransportAdapter` contract interface.

- Classification: CONFIRMED (constitution §8, §16 rules 10–13; Phase 13R §6;
  OBSERVED in `src/lib/services/` + `src/lib/kernel/`).
- Acceptance: import inspection confirms all four prohibitions; kernel imports
  only `TransportAdapter`.

## DOM-007 — Bundle Generality

`Bundle` MUST be a generic data-plane primitive (immutable identity, source,
destination, payload reference/hash, integrity, transform chain, routing
constraints, delivery requirements, deduplication). It MUST be reusable by
TransitNet, Local-first Internet, DTN, and future protocols without
vertical-specific fields.

- Classification: CONFIRMED (constitution §8; Phase 14B contract; OBSERVED in
  `src/lib/services/data-plane.service.ts`, `prisma/schema.prisma`).
- Acceptance: Bundle model has no vertical-specific fields; 14B anti-drift rules
  enforced.

## DOM-008 — Transform Provenance (partial)

`TransformRecord` MUST record immutable transform provenance (inputHash,
outputHash, transformType, transformVersion, parameters, nodeId/nodeIdentity,
resultStatus). `TransformRegistry` and `TransformRuntime` (execution) remain
FUTURE and MUST NOT be presented as implemented.

- Classification: PARTIALLY CONFIRMED (constitution §9; Phase 14F contract;
  OBSERVED provenance in `src/lib/services/transform-record.service.ts`;
  TransformRegistry/Runtime CONFIRMED absent).
- Acceptance: TransformRecord model + service present; no TransformRegistry or
  TransformRuntime code exists.

## DOM-009 — Delivery Confirmation Immutability

`DeliveryConfirmation` MUST be an immutable receipt (no status field, never
updated). Existence IS the confirmation fact. It MUST NOT replace
`TransportAttempt.acknowledged` or `BundleDelivery.acknowledged` status flags.

- Classification: CONFIRMED (constitution §8; Phase 14E contract; OBSERVED in
  `src/lib/services/delivery-confirmation.service.ts`).
- Acceptance: model has no status field; service exposes no update/delete.

## DOM-010 — PostgreSQL Persistence

PostgreSQL is the mandatory persistence provider. SQLite is NOT supported for
production or integration tests. All invariants MUST be proven against real
PostgreSQL.

- Classification: CONFIRMED (constitution §14; OBSERVED in `prisma/schema.prisma`,
  `src/lib/db.ts`, CI postgres-integration-tests job).
- Acceptance: schema uses PostgreSQL features; CI runs PostgreSQL service
  container.

## DOM-011 — Kernel Boundary Restraint

The kernel MUST expose contracts and enforcement boundaries only. It MUST NOT
become a complete networking stack. A kernel-level `Node` contract
(`src/lib/kernel/node.ts`) MUST NOT be created (Node is a service-layer
primitive). The kernel MUST remain unchanged when a new network is launched.

- Classification: CONFIRMED (constitution §13; Phase 14A Step 12; OBSERVED —
  `src/lib/kernel/node.ts` absent, asserted by
  `tests/phase-13-architecture-contract.test.ts:173`).
- Acceptance: no `kernel/node.ts` file; NetworkTemplate drives network launch.

## DOM-012 — Reconciliation Anti-Conflation

The four-primitive reconciliation model (PhysicalExecutionEvidence,
ReconciliationAttempt, ProtocolOutcome, ReconciliationState) MUST preserve
precise cause and prevent conflation (no two causes map to the same state).
Cross-assignment and cross-tenant contamination MUST be impossible.

- Classification: CONFIRMED (constitution §7; OBSERVED in
  `src/lib/kernel/runtime/protocol/reconciliation-types.ts` + stores).
- Acceptance: four primitives present; PostgreSQL + in-memory stores
  implemented.

## PROPOSED Requirements (NOT acceptance-bearing)

These are recorded as architecture gaps for future Work Items. They are NOT
implemented and MUST NOT be treated as existing architecture.

- `DOM-P01` — Generic `VerifiedEvidenceContext` (constitution §6 future
  evolution). PROPOSED.
- `DOM-P02` — TransformRegistry (technical catalog). FUTURE.
- `DOM-P03` — TransformRuntime (execution engine). FUTURE.
- `DOM-P04` — Extension + ExtensionRegistry + ExtensionRuntime. FUTURE.
- `DOM-P05` — Marketplace (resolves/publishes; MUST NOT execute extensions).
  FUTURE.
- `DOM-P06` — SDK/API (Local + Remote Fleet). FUTURE.
- `DOM-P07` — Fragmentation / Reassembly. FUTURE.
- `DOM-P08` — Extension sandbox technology selection. OPEN / RESEARCH
  (WASM/container/native undecided).
