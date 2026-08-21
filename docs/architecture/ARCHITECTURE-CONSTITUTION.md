# Architecture Constitution

> The authoritative architectural contract for the IAAS platform.
> All implementation MUST conform to this document.
> Changes require explicit architectural review.
>
> Phase 13R Reconciliation: Phase 14A-F implementations are formally admitted
> by explicit architectural review (see docs/architecture/PHASE-13-RECONCILIATION.md).
> Per-phase contracts operationalize constitutional sections but do NOT supersede
> the Constitution without formal amendment.

---

## 1. IDENTITY BOUNDARIES

### Tenant
- The top-level isolation boundary.
- All data is tenant-scoped.
- Tenants cannot access each other's data.

### ParticipantIdentity
- A global identity for a participant in the network economy.
- Has NO networkId — joins networks via ParticipantMembership.
- May control resources (ResourceIdentity).

### ParticipantMembership
- A participant's membership in a specific network.
- Network-scoped: has networkId.
- Lifecycle: pending → active → suspended → revoked.

### ParticipantRole
- A role held by a participant within a specific membership.
- Separate from the membership so roles can change independently.
- Roles: provider | consumer | verifier | validator | orchestrator | observer.

### Organization
- Optional grouping for operators/participants.
- Used for reputation portability and multi-operator entities.

### Explicit Boundary Rules

```
Asset ≠ Device ≠ Node ≠ ParticipantIdentity ≠ ResourceIdentity
```

- **Asset**: A physical/logical thing that provides capability (battery, GPU, storage node).
- **Device**: The technical interface to an asset (controller, smart meter, gateway).
- **ParticipantIdentity**: The economic/network participant identity.
- **ResourceIdentity**: The universal resource abstraction (generalizes Asset).
- **Node** (IMPLEMENTED — Phase 14A): A protocol participant. Distinct from Asset/Device. A Node is a service-layer primitive (`src/lib/services/node.service.ts`), tenant-scoped, optionally backed by Device/ParticipantIdentity/ResourceIdentity. NodeNetworkMembership provides network-scoped participation (analogous to ParticipantMembership). NodeAgent remains future (no evidence requires it).

An Asset MAY have multiple Devices. A ResourceIdentity MAY map to an Asset (via metadata). A Node (future) MAY be backed by an Asset+Device but is a separate concept.

---

## 2. RESOURCE BOUNDARIES

### ResourceIdentity
- Universal resource identity (one per physical/logical resource).
- Has NO networkId — joins networks via NetworkResourceMembership.
- Generalizes Asset for the control plane.
- resourceKind: physical | compute | storage | connectivity | industrial | human | protocol.

### NetworkResourceMembership
- A resource's membership in a specific network.
- Per-network bindings.
- Binds to ParticipantMembershipId (the network-scoped authority).
- Network Scope Integrity enforced at the service layer.

### CapacityResource
- The platform-level capacity record for an asset+network+capability.
- physicalCapacity is the verified limit (from AssetNetworkAssignment).
- Generic — not energy/compute-specific.

### AssetNetworkAssignment
- Explicit assignment of an asset to a network with a capability.
- Authoritative source of verified physical capacity.
- Generic: verifiedQuantity + unit represent ANY capability's physical limit.

### Explicit Boundary Rules

```
ResourceIdentity ≠ Asset
```

- ResourceIdentity is the universal abstraction used by the control plane.
- Asset is the kernel-level physical entity.
- The CapacityProvider boundary translates ResourceIdentity → Asset for the existing capacity service.
- The control plane MUST NOT read the Asset table directly.

---

## 3. NETWORK BOUNDARIES

### NetworkDefinition
- A network definition scoped to a tenant.
- vertical: generic | energy_vpp | storage | wireless | compute | protocol.
- Has a currentVersionId pointing to the active NetworkVersion.

### NetworkVersion
- IMMUTABLE once publishedAt is set.
- Contains the full versioned configuration: asset_types, capabilities, verification_policy, reward_policy.
- runtimeKind: infrastructure | protocol | hybrid (immutable after publication).
- The RuntimeRegistry resolves this to a concrete NetworkRuntime.

### NetworkTemplate
- A reusable template for network instantiation.
- NOT a network — a blueprint.
- Templates are vertical-neutral configurations.

### Explicit Boundary Rules

```
NetworkVersion is immutable after publication.
runtimeKind is immutable after publication.
A new runtime choice requires a new NetworkVersion.
```

---

## 4. EXECUTION BOUNDARIES

### Control Plane Pipeline (frozen)

```
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

### Runtime Selection

```
NetworkVersion.runtimeKind
  → RuntimeRegistry.resolve(kind)
  → NetworkRuntime
```

Three runtimes, each implementing the SAME NetworkRuntime contract:

1. **InfrastructureRuntime** — physical asset dispatch via adapters.
2. **ProtocolRuntime** — deterministic state transitions via consensus.
3. **HybridRuntime** — bridges infrastructure + protocol.

### Explicit Boundary Rules

```
InfrastructureRuntime ≠ ProtocolRuntime ≠ HybridRuntime
```

- Each runtime owns its execution model.
- HybridRuntime is the ONLY code that knows about both worlds.
- InfrastructureRuntime MUST NOT import ProtocolRuntime.
- ProtocolRuntime MUST NOT import InfrastructureRuntime.
- The control plane NEVER imports concrete runtimes — only resolves via RuntimeRegistry.

### Execution Lease (frozen — Slice 5)

```
ExecutionAssignment
  → ExecutionLease (one active per assignment)
  → leaseId + leaseVersion + workerIdentity + leaseUntil
  → FENCING lifecycle: ACTIVE → FENCING → FENCED | UNSAFE_TO_RETRY
```

- Adapters that cannot cancel are UNSAFE_TO_RETRY (capacity NOT released).
- The assignment row is the serialization boundary for acquire/fence.

---

## 5. ECONOMIC BOUNDARY (frozen — Slice 6)

### Generic Economic Pipeline

```
ExecutionResult
  → Event (evidence)
  → VerificationResult (policy-driven)
  → Attestation (verified claim)
  → Contribution (verified economic activity)
  → Reward (economic entitlement)
  → LedgerPosting (double-entry accounting)
  → Settlement (payment instruction)
```

### EconomicPipelineState

```
EconomicPipelineState = cacheable recovery metadata
Durable economic objects = source of truth
```

- Reconciliation inspects PostgreSQL durable state.
- Checkpoint IDs are validated against deterministic identities.
- Stale IDs are discarded and rediscovered.
- Cross-assignment contamination is impossible.
- Cross-tenant contamination is impossible.

### Explicit Boundary Rules

```
Generic economic pipeline MUST NOT import:
  - VPP service
  - Compute service
  - Storage service
  - Wireless service
  - Manufacturing service
  - Any vertical-specific service

Verticals import the generic pipeline.
The generic pipeline does NOT import verticals.
```

### VPP/Compute Migration (frozen — Slice 7)

- VPP and Compute delegate economic processing to the generic pipeline.
- VPP retains: baseline calculation, dispatch state, portfolio finalization.
- Compute retains: workload definition, adapter, capacity.
- Neither creates economic primitives directly.
- `VppDispatchAssignment.economicStage` is LEGACY (not authoritative).

---

## 6. EVIDENCE/VERIFICATION BOUNDARY

### Current Infrastructure Evidence Adapter

```
Event (device-signed telemetry) → VerificationResult → Attestation
```

This is the "current infrastructure evidence adapter" — NOT the universal evidence abstraction.

### VPP-Specific Pre-Pipeline Evidence

VPP performs its own evidence + verification + baseline calculation BEFORE the economic pipeline because the baseline depends on the attestation. The pipeline's evidence + verification stages are skipped (eventId + attestationId pre-populated on the checkpoint).

This is a legitimate pattern: a vertical may perform domain-specific transformation of verified evidence BEFORE contribution creation.

### Future: Generic VerifiedEvidenceContext

A future evolution may formalize a generic contract for pre-validated economic inputs. Until then, the pre-population pattern is accepted as safe because:

1. The Event/Attestation are durable PostgreSQL records.
2. The checkpoint records their IDs.
3. Reconciliation validates checkpoint IDs against deterministic identities.
4. Stale/NULL IDs are recovered from durable state.

---

## 7. PROTOCOL BOUNDARY (contract — NOT YET IMPLEMENTED)

### Protocol Definition (contract)

A protocol declares:
- Protocol identity (name, version)
- Runtime kind (protocol | hybrid)
- Capabilities (what it can do)
- Required extensions
- Optional extensions
- Incompatible extensions
- Security requirements
- Data-plane requirements

Protocol-specific semantics MUST remain outside kernel services.

### ProtocolRuntime (existing — Phase 9A)

The ProtocolRuntime already exists in the repository. It owns:
- Protocol state machine (ProtocolStateStore — deterministic, versioned)
- Transaction executor (DeterministicTransactionExecutor)
- Validator registry (InMemoryValidatorRegistry)
- Consensus engine (SimpleConsensusEngine)

It does NOT own:
- Physical infrastructure adapter execution
- Generic economic accounting
- Marketplace logic
- Transform registry ownership

### Hybrid Runtime (existing — Phase 10)

The HybridRuntime bridges:
- InfrastructureRuntime → physical execution → telemetry
- ProtocolRuntime → transactions → state transitions → finality

The HybridBridge is the ONLY code that knows about both worlds.

### Reconciliation (existing — Phase 11B)

Four-primitive model:
1. PhysicalExecutionEvidence — immutable, content-addressed
2. ReconciliationAttempt — attempt-based lifecycle (PENDING → terminal)
3. ProtocolOutcome — append-only, precise cause preservation
4. ReconciliationState — anti-conflation (no two causes map to same state)

---

## 8. DATA PLANE BOUNDARY (PARTIALLY IMPLEMENTED — Phase 14B-F)

### Control Plane vs Data Plane

```
CONTROL PLANE decides:
  who, what, where, why, policy, resource, capability, allocation, route constraints

DATA PLANE performs:
  receive (14B), store (14B), route (14C), forward (14D), deliver (14B),
  deduplicate (14B), fragment (FUTURE), reassemble (FUTURE),
  expire (14B), acknowledge (14E), transform (14F: provenance only;
    TransformRegistry/Runtime FUTURE)
```

The kernel exposes contracts/enforcement boundaries. It does NOT become a complete networking stack.

### Bundle (IMPLEMENTED — Phase 14B)

A Bundle is a generic data-plane primitive:
- Immutable identity
- Source, destination
- Creation time, expiry
- Priority
- Payload reference, payload type
- Integrity, authentication
- Transform chain
- Routing constraints
- Delivery requirements
- Deduplication, acknowledgement, resumability

Bundle must be reusable by: TransitNet, Local-first Internet, DTN, future protocols.

---

## 9. TRANSFORM BOUNDARY (PARTIALLY IMPLEMENTED — Phase 14F: TransformRecord provenance. TransformRegistry and TransformRuntime remain future.)

### Transform

Conceptually provides:
- execute(), reverse(), estimateCost(), verify()
- Input constraints, output constraints
- Supported content types
- Resource requirements
- Reversibility, lossiness
- Security properties

### Transform Provenance

```
input hash + output hash + transform identity + transform version
+ parameters + node/runtime + resource cost + result
```

### Transform Registry (contract)

```
TransformRegistry ≠ TransformRuntime ≠ Marketplace
```

- Registry = technical catalog + versioning + compatibility + certification + revocation
- Runtime = execution
- Marketplace = discovery/publishing/licensing/commercial

---

## 10. EXTENSION BOUNDARY (contract — NOT YET IMPLEMENTED)

### Extension

May provide: routing strategy, scheduling, mobility prediction, cache strategy, deduplication, protocol algorithms, security behavior, transforms.

Extensions CANNOT arbitrarily modify kernel behavior.

### Extension Security (contract — OPEN / RESEARCH REQUIRED)

Publisher identity, signature, version, permissions, capability policy, sandbox, resource limits, compatibility, revocation, rollback, audit.

Implementation technology (WASM/containers/native) is OPEN — not yet decided.

---

## 11. MARKETPLACE BOUNDARY (contract — NOT YET IMPLEMENTED)

```
Marketplace resolves/publishes artifacts.
Runtime executes resolved artifacts.
Marketplace MUST NOT directly execute extensions.
```

---

## 12. SDK/API BOUNDARY (contract — NOT YET IMPLEMENTED)

### SDK Domains

Identity, Node, Network, Capability, Resource, Execution, Bundle, Transform, Extension, Telemetry, Contribution, Policy.

### Local SDK vs Remote Fleet API

Generic methods (not vertical-specific):
- registerNode()
- advertiseCapability()
- joinNetwork()
- provideResource()

NOT:
- registerTransitVehicle()

---

## 13. NETWORK LAUNCH MODEL (contract)

```
NetworkTemplate
  + Policies
  + Adapters
  + Runtime
  + Verification
  + EconomicRules
  + DataPlane capabilities
  + Transforms
  + Extensions
```

The kernel MUST remain unchanged when a new network is launched.

---

## 14. PERSISTENCE CONTRACT

```
PostgreSQL is the mandatory persistence provider.
SQLite is NOT supported for production or integration tests.
All invariants must be proven against real PostgreSQL.
```

---

## 15. KNOWN ISSUES

### baselineEngine namespace error

File: `src/lib/services/vpp.service.ts:820-822`
Error: `TS2503: Cannot find namespace 'baselineEngine'`
Status: PRE-EXISTING (confirmed at commit `f614659`, before VPP migration)
Cause: TypeScript dynamic-import namespace issue (`type BaselineContext = baselineEngine.BaselineContext`).
Impact: TypeScript type-check error only. Runtime behavior is correct.
Fix: Not in scope for Phase 13 (architecture contracts). Should be fixed in a future code-quality pass.

---

## 16. ARCHITECTURAL ANTI-DRIFT RULES

These rules are enforced by static tests in `tests/architecture-contract.test.ts`, `tests/phase-12b-slice-7-vpp.test.ts`, and `tests/phase-13r-reconciliation-contract.test.ts`:

1. Generic economic pipeline imports NO vertical service.
2. VPP/Compute import the generic pipeline (not vice versa).
3. InfrastructureRuntime does NOT import ProtocolRuntime.
4. ProtocolRuntime does NOT import InfrastructureRuntime.
5. `economicStage` is NOT consulted by generic reconciliation.
6. Marketplace (future) MUST NOT directly execute extensions.
7. TransformRegistry (future) MUST NOT depend on TransitNet.
8. Protocol contract MUST NOT import TransitNet implementation.
9. Future protocol code MUST NOT be required by kernel code.
10. Phase 14 data-plane services (data-plane, routing, transport, delivery-confirmation, transform-record) MUST NOT import vertical services (VPP, Compute, Storage, Wireless).
11. Phase 14 data-plane services MUST NOT import the generic economic pipeline.
12. Phase 14 data-plane services MUST NOT import ProtocolRuntime or HybridRuntime.
13. The kernel MUST NOT import Phase 14 data-plane services (except TransportAdapter which is a kernel contract interface).
