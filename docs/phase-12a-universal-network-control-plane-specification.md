# Phase 12A — Universal Network Control Plane Specification

| Field | Value |
|---|---|
| Phase | 12A — Universal Network Control Plane Specification |
| Artifact type | Specification (not implementation) |
| Predecessor | Phase 11B (accepted at `713ee10`) |
| Supersedes | `docs/phase-12a-buyer-capability-protocol-specification.md` (`fc531b0`) — too narrow |
| Implementation gate | Phase 12B |
| Status | **Draft for audit (revised)** |
| Repo HEAD at authoring | `876a8fa` (`main`) |

> **Supersedes the buyer-protocol spec.** The earlier `fc531b0` document
> defined a buyer-facing API surface. On review, that framing is too narrow:
> it positions the buyer protocol as the next layer, when the actual
> requirement is a **Universal Network Control Plane** where the buyer is one
> participant role among many, and where launching a network feels like
> launching a cloud platform. This document replaces the buyer-only framing
> with the broader control-plane architecture. The canonical objects and
> invariants from `fc531b0` are preserved and generalized; the actor model
> is expanded; the `Asset`-centric model is generalized to `NetworkResource`.

---

## 0. The thesis

> **A network is a programmable infrastructure environment.**

The project should evolve from "a platform with several generic primitives"
into a **Network Operating System control plane** where launching a network
feels like launching an AWS platform — not because the platform is a cloud,
but because the **network** becomes the runtime environment, not merely a
record in the database.

The critical shift is:

```
old:  new vertical → new implementation
new:  new network → network definition + policy + runtime
                  → participants join
                  → participants register resources
                  → resources advertise capabilities
                  → network scheduler/capacity layer coordinates them
                  → execution + verification + contribution + economics
```

The existing repository already has the substrate for this: immutable
`NetworkVersion`, explicit `AssetNetworkAssignment`, generic `Capability`,
generic capacity layers (`CapacityResource` → `CapacityReservation` →
`CapacityCommitment` → `CapacityUsage`), runtime selection, generic execution,
infrastructure adapters, protocol runtime, hybrid runtime, and the Phase 11B
reconciliation substrate.

What is missing is the **network control plane that assembles those pieces
into a complete runnable network**. This document specifies it.

---

## 1. The target architecture (frozen)

```
                    NETWORK CONTROL PLANE
┌─────────────────────────────────────────────────────────────┐
│ Network Definition                                          │
│ Network Version / Policy Bundle                             │
│ Runtime                                                      │
│ Participant Model                                            │
│ Resource Registry                                            │
│ Capability Registry                                          │
│ Capacity Policy                                              │
│ Scheduling / Allocation Policy                               │
│ Verification Policy                                          │
│ Contribution / Reward Policy                                 │
│ Settlement Policy                                            │
│ Network Identity / Membership                                │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
                    RESOURCE CONTROL PLANE
┌─────────────────────────────────────────────────────────────┐
│ Participants                                                 │
│   ├─ Operators (providers)                                   │
│   ├─ Consumers (buyers)                                      │
│   ├─ Validators                                              │
│   ├─ Verifiers                                               │
│   └─ Service providers                                       │
│                                                             │
│ Resources                                                    │
│   ├─ Physical assets                                         │
│   ├─ Compute nodes                                           │
│   ├─ Storage nodes                                           │
│   ├─ Network links                                           │
│   ├─ Industrial equipment                                   │
│   ├─ Human work units                                        │
│   └─ Protocol nodes                                          │
│                                                             │
│ Capabilities                                                 │
│ Capacity → Reservation → Commitment → Assignment             │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
                        EXECUTION
┌─────────────────────────────────────────────────────────────┐
│ InfrastructureRuntime | ProtocolRuntime | HybridRuntime     │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
                 VERIFICATION / ECONOMICS
┌─────────────────────────────────────────────────────────────┐
│ Evidence → Verification → Attestation → Contribution        │
│       → Reward → Ledger → Settlement → Reconciliation        │
└─────────────────────────────────────────────────────────────┘
```

This architecture is **frozen** as the target. Phase 12B implements it; later
phases prove it across verticals.

---

## 2. The non-negotiable rule (thesis preservation)

> **A new vertical must NOT require new vertical-specific kernel primitives.**

**Precise rule (revised):**

> The **control plane** may introduce new **generic** control-plane objects
> (`NetworkResource`, `Participant`, `NetworkResourceMembership`,
> `NetworkLaunch`, `AllocationDecision`). It may NOT introduce
> **vertical-specific** kernel primitives (`StorageService`,
> `WirelessService`, etc.).

The layering is:

```
Network Control Plane   ← may add generic control-plane objects
        ↓
Kernel Contracts        ← frozen (NetworkRuntime, ProtocolRuntime, HybridRuntime,
        ↓                 executor, consensus, economic pipeline — Phase 11B accepted)
Runtime / Adapter boundaries
```

`NetworkResource` and `Participant` live in the **control plane**, above the
frozen kernel. They are generic (not vertical-specific), so they do not
violate the rule.

A new vertical should primarily require:

```
network template
  +
resource adapter
  +
capability definitions
  +
verification policy
  +
economic policy
```

not new kernel services. We explicitly **forbid** solving this by adding
`StorageService`, `WirelessService`, `TelecomService`,
`ConstructionService`, `IndustrialService`, or `BlockchainService` to the
kernel. That would destroy the thesis.

The universal pattern is:

```
Universal Network Kernel (frozen)
        ↓
Network Control Plane (generic: Resource, Participant, Membership, Launch, Scheduler)
        ↓
Network Configuration (per-vertical: template + policies)
        ↓
Resource + Capability model
        ↓
Vertical adapter/policy packages
```

Every vertical (Energy, Compute, Storage, Wireless, Telecom/Edge, Construction,
Industrial, Blockchain) is a **network configuration** running on the same
operating system, not a separate product.

### 2.1 Backward-compatible migration invariant

> Existing VPP and Compute resources must continue to resolve through the
> same operational resource identity after `NetworkResource` is introduced.

Phase 12B must NOT break:
- VPP assignments (VppDispatch → ExecutionAssignment).
- Compute adapters (SimulatedComputeAdapter).
- Device relationships (Asset → Device).
- Existing events (Event → assetId).
- Capacity resources (CapacityResource → assetId).
- Execution assignments (ExecutionAssignment → assetId).

The migration generalizes `Asset` into a `NetworkResource` kind; it does not
replace `Asset` with a different identity. The existing `Asset` becomes one
concrete `resourceKind`. This is the pattern that "generalizes what already
works instead of breaking it."

---

## 3. What "launch a network" should mean

Launching a network becomes analogous to creating a cloud platform:

```
Launch "West Africa GPU Network"
  ↓
Network created
  ↓
NetworkVersion published (runtimeKind, capability defs, policies)
  ↓
Participants onboarded (providers, consumers, verifiers, validators)
  ↓
Providers register resources (GPU clusters)
  ↓
Resources advertise capabilities (compute, with capacity in GPU)
  ↓
Network is ACTIVE — participants can reserve/commit/execute
  ↓
Consumer requests 200 GPU-hours
  ↓
Network coordinates: reserve → commit → assign → execute → verify → contribute → settle
```

The network becomes the **runtime environment**, not merely a record in the
database. The `NetworkVersion` is the immutable policy bundle that defines
what the network IS; everything else is participants and resources operating
within that bundle.

---

## 4. The missing abstraction: ResourceIdentity + NetworkResourceMembership

The current `Asset` model is too infrastructure-oriented to be the ultimate
abstraction. Today:

```
Asset → AssetNetworkAssignment → Capability → CapacityResource
```

This works for DERs and compute, but doesn't generalize to storage nodes,
network links, industrial equipment, human work units, or protocol nodes.

### 4.1 The multi-network resource model (revised — the biggest correction)

The original draft of this spec put `networkId` directly on the resource
identity, scoping a resource to exactly one network. That conflicts with the
existing `AssetNetworkAssignment` model, which explicitly supports the same
asset being assigned to multiple networks. A GPU cluster, a fiber link, or a
battery may participate in several networks simultaneously.

**The correct abstraction is:**

```
ResourceIdentity (global, one per physical/logical resource)
      ↓
NetworkResourceMembership (per-network — one resource, many memberships)
      ↓
Network
```

This preserves the existing `Asset` + `AssetNetworkAssignment` architecture
while generalizing it. Phase 12B generalizes what already works; it does not
break it.

### 4.2 ResourceIdentity (the universal resource identity)

**`[NEW]`** The global resource identity. An `Asset` becomes one concrete
kind of `ResourceIdentity`.

```typescript
interface ResourceIdentity {
  resourceId          // global identity (one per physical/logical resource)
  controllerId        // the participant that controls/contributes it

  resourceKind        // physical | compute | storage | connectivity |
                      // industrial | human | protocol | ...

  lifecycleStatus     // registering → active → suspended → decommissioned

  location?           // geographic/topological (global, not per-network)
  metadata            // vertical-specific, opaque to the kernel
}
```

**Key point:** `ResourceIdentity` has NO `networkId`. It is a global thing
that a participant makes available. Network membership is a separate
relationship (§4.3).

**Kinds** (NOT separate kernel models — just a discriminator on
`ResourceIdentity`):

| Kind | Example resources | Existing mapping |
|---|---|---|
| `physical` | DER, battery, generator | `Asset` (VPP) |
| `compute` | GPU cluster, CPU node | `Asset` (Compute) |
| `storage` | storage node, disk array | `[NEW]` adapter |
| `connectivity` | access point, router, fiber link | `[NEW]` adapter |
| `industrial` | turbine, pump, PLC, robot | `[NEW]` adapter |
| `human` | crew, inspection team, operator | `[NEW]` adapter |
| `protocol` | validator node, sequencer, RPC node | `[NEW]` adapter |

The control plane does NOT have seven different resource models. It has ONE
`ResourceIdentity` with a `resourceKind` discriminator. Each kind's specifics
live in its adapter + capability definitions + verification policy.

### 4.3 NetworkResourceMembership (the per-network binding)

**`[NEW]`** A resource's membership in a specific network. This is the
generalization of `AssetNetworkAssignment`. A resource can have multiple
memberships (one per network it participates in).

```typescript
interface NetworkResourceMembership {
  membershipId              // per-network membership identity
  resourceId                // FK to ResourceIdentity
  networkId                 // the network this membership is in
  participantMembershipId   // FK to ParticipantMembership (§5.2) — the
                            // network-scoped authority that authorizes
                            // this resource's participation in THIS network
  // Per-network bindings (these can differ across networks):
  capabilities[]      // what this resource can DO in THIS network
  verifiedCapacity[]  // how MUCH (verified per-network)
  controlMode         // adapter selection for THIS network
  verificationProfile // how evidence is verified in THIS network
  availability?       // time windows for THIS network

  membershipStatus    // registering → active → suspended → withdrawn
}
```

**Why per-network bindings:** a GPU cluster might offer `gpu_compute` in
Network A but `ai_inference` in Network B, with different verified capacities
and different verification profiles. The resource identity is the same; the
network membership differs. This mirrors the existing
`AssetNetworkAssignment` pattern where the same asset has different
capability bindings per network.

### 4.4 The separation: Participant vs. Resource

> **Participant = who controls/contributes. Resource = what the participant
> makes available.**

This separation is critical for blockchain, construction, and industrial
networks, where the distinction between "who" and "what" is load-bearing.

### 4.5 Multi-network resource sharing invariant

> A single `ResourceIdentity` may participate in multiple networks via
> separate `NetworkResourceMembership` records. Suspending or withdrawing a
> resource from Network A must NOT affect its membership in Network B.

This is the multi-network resource sharing guarantee. It is the generalization
of the existing `AssetNetworkAssignment` multi-network pattern.

### 4.6 Resource withdrawal safety invariant

> Removing or suspending a resource from a network cannot invalidate
> historical executions, contributions, or settlements in that network.

Historical records reference the resource identity at the time of execution.
Withdrawal changes future availability, not past records. This mirrors the
kernel's existing write-once discipline (Phase 5.2).

---

## 5. The participant model (revised — roles separated from membership)

Participants are first-class network entities, not merely "operators." A
network contains participants with roles.

**Correction from the original draft:** `roles[]` and membership state
represent different concepts and must be separated. A participant can hold
multiple roles simultaneously (e.g., Provider + Validator), and a participant
can change roles without creating a new participant identity. The original
draft conflated these into one model; the revised model separates them.

### 5.1 ParticipantIdentity (global)

**`[NEW]`** The global participant identity (one per real-world org/principal).
Maps to the existing `Organization` model.

```typescript
interface ParticipantIdentity {
  participantId     // global identity (one per org/principal)
  organizationId    // the real-world org (maps to existing Organization)
  metadata
}
```

**Key point:** `ParticipantIdentity` has NO `networkId`. A participant joins
networks via `ParticipantMembership` (§5.2). One participant can be a member
of multiple networks.

### 5.2 ParticipantMembership (per-network)

**`[NEW]`** A participant's membership in a specific network. This is the
network-scoped relationship.

```typescript
interface ParticipantMembership {
  membershipId      // per-network membership identity
  participantId     // FK to ParticipantIdentity
  networkId         // the network this membership is in
  membershipStatus  // pending → active → suspended → revoked
  joinedAt
  metadata
}
```

**Lifecycle:**

```
pending → active → suspended → revoked
```

- `pending`: a participant has requested to join; awaiting network policy
  approval (open network = auto-approve; gated network = orchestrator
  approval).
- `active`: the participant can register resources and transact.
- `suspended`: temporarily unable to transact (policy violation, payment
  failure, etc.).
- `revoked`: permanently removed (terminal).

### 5.3 ParticipantRole (per-membership, independently lifecycle-managed)

**`[NEW]`** A role held by a participant within a specific network membership.
Separate from the membership so roles can change independently.

```typescript
interface ParticipantRole {
  roleAssignmentId   // unique per role assignment
  membershipId       // FK to ParticipantMembership
  role               // provider | consumer | verifier | validator | orchestrator | observer
  roleStatus         // active | suspended
  assignedAt
  revokedAt?
}
```

**Why separate:** a participant in a network might be:

```
Provider       active
Validator      active
Consumer       suspended
Observer       active
```

Each role has its own status. A participant can be suspended as a consumer
(e.g., payment failure) while remaining an active provider. Roles can be
added/revoked without creating a new participant identity or membership.

### 5.4 Roles

| Role | Responsibility | Existing mapping |
|---|---|---|
| `provider` | Owns resources, commits capacity | `Operator` (generalized) |
| `consumer` | Requests capability execution, receives contributions, settles | `PlatformUser` (buyer role, generalized) |
| `verifier` | Verifies execution evidence | `VerificationService` (existing) |
| `validator` | Participates in consensus (protocol/hybrid networks) | `ValidatorRegistry` (existing) |
| `orchestrator` | Schedules/allocation authority for the network | `[NEW]` — the network scheduler role |
| `observer` | Read-only access (auditors, regulators) | `[NEW]` — read-only role |

One organization may hold multiple roles across networks (and multiple roles
within one network via separate `ParticipantRole` records). The control plane
does not prescribe the mapping; the network's policy bundle defines role
requirements.

### 5.5 Network isolation invariant

> Participant/resource state from Network A cannot leak into Network B.

A participant's membership, roles, resource bindings, and execution history
in Network A are scoped to Network A. Joining Network B is a separate
membership. This is the network isolation guarantee.

---

## 6. Canonical control-plane objects

These are the protocol artifacts. Each has an identity, a lifecycle, and
explicit invariants. Where an object already exists in the schema, the spec
references it and generalizes the contract.

### 6.1 NetworkDefinition + NetworkVersion

**`[EXISTS]`** as `NetworkDefinition` + `NetworkVersion`.

The `NetworkVersion` is the **immutable policy bundle** — the frozen
configuration that defines what the network IS:

| Policy field | Source | Meaning |
|---|---|---|
| `runtimeKind` | existing | infrastructure \| protocol \| hybrid |
| `configurationJson` | existing | capability definitions, capacity rules |
| `baselinePolicyJson` | existing | verification baseline policy |

**`[NEW]`** The spec extends the policy bundle conceptually (not necessarily
new columns — may be in `configurationJson`):

```
NetworkVersion policy bundle:
  - capabilityDefinitions[]   (what capabilities this network supports)
  - capacityPolicy            (reservation/commitment rules)
  - schedulingPolicy          (allocation, priority, fairness)
  - verificationPolicy         (how evidence is verified)
  - contributionPolicy        (how contributions are derived)
  - rewardPolicy              (RewardRules — [EXISTS])
  - settlementPolicy          (ledger/settlement rules)
  - participantOnboardingRules (open vs gated, role requirements)
```

The key invariant: **the policy bundle is immutable once published.** A
new policy = a new `NetworkVersion`. This is the existing immutability
invariant, generalized.

### 6.2 ResourceIdentity + NetworkResourceMembership

**`[NEW]`** (see §4). The universal resource identity + per-network membership,
generalizing `Asset` + `AssetNetworkAssignment`.

**Lifecycle:**

```
registering → active → suspended → decommissioned
```

- `registering`: the resource is being registered; capability/capacity not
  yet verified.
- `active`: verified and available for reservation.
- `suspended`: temporarily unavailable (maintenance, policy violation).
- `decommissioned`: permanently removed (terminal).

**Invariants:**

- NR1. (corrected) A `ResourceIdentity` has **no network scope** — it is a
  globally-scoped resource identity. A `NetworkResourceMembership` binds one
  resource to one network. A resource MAY have many memberships (one per
  network it participates in). Each membership is governed by exactly one
  `ParticipantMembership` (see §6.2.1).
- NR2. A resource's capabilities and capacity are **verified** before
  `active` — self-reported numbers are not trusted (existing pattern:
  `AssetNetworkAssignment.verifiedQuantity`). Verification is per-membership
  (a resource may have different verified capacities in different networks).
- NR3. A resource's `controlMode` (per-membership) determines the adapter
  selection at execution time (existing: `AdapterRegistry.resolve` by
  assetType + capabilityType; generalized to resourceKind + capability).

### 6.2.1 Resource-to-participant-membership binding (corrected)

> **`NetworkResourceMembership` binds to `ParticipantMembershipId`, not to a
> global participant identity.**

**Why:** this prevents a resource in Network A from being accidentally
governed by a participant role that only exists in Network B. It cleanly
enforces the separation:

```
who controls the resource globally (ResourceIdentity.controllerId)
        ≠
which role/membership authorizes the resource in this network
        ≠
which network the resource participates in
```

This is critical for multi-network providers: the same physical resource may
be controlled by the same global participant, but the **network-scoped
authority** that authorizes its participation must be a membership in THAT
network, not a global identity.

**Revised `NetworkResourceMembership` (from §4.3):**

```typescript
interface NetworkResourceMembership {
  membershipId              // per-network membership identity
  resourceId                // FK to ResourceIdentity
  networkId                 // the network this membership is in
  participantMembershipId   // FK to ParticipantMembership (§5.2) — the
                            // network-scoped authority that authorizes
                            // this resource's participation
  capabilities[]            // per-network
  verifiedCapacity[]        // per-network, verified
  controlMode               // per-network adapter selection
  verificationProfile       // per-network
  availability?             // per-network time windows
  membershipStatus          // registering → active → suspended → withdrawn
}
```

### 6.3 Capability

**`[EXISTS]`** as `Capability` (the type/schema) + `CapacityResource` (the
verified capacity). Generalized to be resource-kind-neutral.

The capability definition is part of the `NetworkVersion` policy bundle:
"this network supports `energy_discharge`, `compute`, `storage`, `bandwidth`,
`earth_moving`, `block_production`, ..."

### 6.4 Capacity → Reservation → Commitment → Assignment

**`[EXISTS]`** as `CapacityResource` → `CapacityReservation` →
`CapacityCommitment` → `ExecutionAssignment`. These are already generic
(kW, GPU, TB, Gbps, m³, etc.). The spec preserves them and generalizes the
buyer-facing contract (from `fc531b0`):

```
CapacityResource (verified capacity)
    ↓
CapacityReservation (buyer reserves a window)
    ↓
CapacityCommitment (specific job commits an amount)
    ↓
ExecutionAssignment (kernel assigns to a resource for execution)
```

**Lifecycles (existing + buyer-facing):**

| Object | Lifecycle |
|---|---|
| `CapacityReservation` | active → released \| expired |
| `CapacityCommitment` | active → consumed \| released \| expired |
| `ExecutionAssignment` | assigned → executing → completed \| failed |

**Invariants (from `fc531b0`, preserved):**

- CR3. Cancellation allowed only before consumption.
- CC2. `consumed` is terminal — irreversible.
- A2. `completed` is irreversible (Phase 5.2 CAS).

### 6.5 Execution + Evidence + Verification + Contribution + Reward + Settlement

**`[EXISTS]`** — the full economic pipeline, unchanged:

```
Execution (NetworkRuntime)
    ↓
RuntimeExecuteResult (raw evidence)
    ↓
Event (signed, queued)
    ↓
VerificationResult (policy-checked)
    ↓
Attestation (verified claim)
    ↓
Contribution (economically valid work)
    ↓
Reward (from RewardRule)
    ↓
LedgerPosting + LedgerEntry
    ↓
Settlement
```

For hybrid networks, this includes the Phase 11B reconciliation substrate:
`PhysicalExecutionEvidence` → `ReconciliationAttempt` → `ProtocolOutcome`.

The spec does NOT modify this pipeline. It is frozen (Phase 11B accepted).

### 6.6 Scheduler, NetworkRequest, and AllocationDecision (revised — first-class control-plane concept)

The original draft listed scheduling as a policy field inside the versioned
bundle. That is insufficient. A network like AWS is valuable because the
control plane doesn't merely store resources — it **decides placement and
allocation**.

#### 6.6.1 NetworkRequest (the actor-neutral scheduler input)

**`[NEW]`** The control plane needs an explicit generic request abstraction
that causes scheduling. Requests differ radically across verticals:

```
GPU:        8 GPU for 4 hours
Storage:    50 TB for 30 days
Wireless:   500 Mbps + <20ms + 99.9%
Construction: 500 m³ earth movement before deadline with quality constraint
Blockchain: produce N blocks with finality SLA
```

The `NetworkRequest` is the universal input to the scheduler — **actor-neutral**,
not buyer-specific:

```typescript
interface NetworkRequest {
  requestId                // content-addressed or UUID
  requesterMembershipId    // FK to ParticipantMembership (§5.2) — the
                           // network-scoped authority making the request
  networkId                // the network this request is in
  capabilityRequirements[] // what capabilities are needed
  timeWindow               // when the capability is needed
  constraints              // additional SLA/quality constraints (§6.7)
  priority?                // from the scheduling policy
  idempotencyKey           // for idempotent submission
  status                   // pending → scheduled → fulfilled | rejected | expired
  submittedAt
}
```

**Why `requesterMembershipId` (not global participant):** a request is
authorized by the requester's **network-scoped membership**, not by a global
identity. This is the same invariant as `NetworkResourceMembership` binding
to `ParticipantMembershipId` (§6.2.1) — it prevents cross-network authority
leakage.

#### 6.6.2 AllocationDecision (the scheduler's output)

**`[NEW]`** The universal network OS needs a semantic distinction between:

```
Capacity (what exists)
    ↓
NetworkRequest (what is needed — actor-neutral)
    ↓
AllocationDecision (a scheduling decision about who gets what)
    ↓
Reservation / Commitment (the booked capacity)
    ↓
Assignment (the execution binding)
    ↓
Execution
```

**`[NEW]`** `AllocationDecision` — the output of the scheduler:

```typescript
interface AllocationDecision {
  decisionId            // content-addressed or UUID
  networkId             // the network this decision is in
  requestId             // FK to NetworkRequest (§6.6.1) that triggered scheduling
  candidateMemberships[] // the resource memberships the scheduler considered
  selectedMembershipId  // the chosen resource's NetworkResourceMembership
  allocatedCapacity     // how much of which capability
  allocationWindow      // time window
  priority?             // from the scheduling policy
  fairnessScore?        // from the scheduling policy
  schedulerVersion      // for reproducibility (§12 criterion 21)
  decidedAt
  expiresAt             // the decision must be acted on before this or it lapses
}
```

**Flow:**

```
NetworkRequest (actor-neutral — §6.6.1)
    ↓
Scheduler (applies schedulingPolicy from NetworkVersion)
    ↓
Candidate Resource Memberships (filtered by capability, capacity, availability)
    ↓
AllocationDecision (the scheduler's choice)
    ↓
Reservation / Commitment (created from the decision)
    ↓
ExecutionAssignment (the kernel's assignment)
```

**Request isolation invariant:**

> A requester cannot cause an allocation decision outside the permissions/
> constraints of its network membership. The scheduler MUST verify the
> `requesterMembershipId` is `active` and authorized for the requested
> capabilities before producing an `AllocationDecision`.

**Allocation reproducibility invariant:**

> Given the same (`NetworkVersion`, `NetworkRequest`, `ResourceMembership`
> state), the scheduler's decision must either be **deterministic** or
> explicitly **version its non-deterministic policy** (recorded in
> `AllocationDecision.schedulerVersion`). This is critical once fairness/
> priority enters the system — decisions must be auditable and reproducible.

**Why first-class:** without an explicit `AllocationDecision`, "launching a
network" still means registering resources, not actually operating a network.
The scheduler is what makes the network a coordinator, not just a registry.

**Scheduler correctness invariant:**

> Concurrent requests cannot oversubscribe a resource or violate network
> policy. The scheduler must produce `AllocationDecision`s that respect
> capacity limits atomically (using the same OCC/unique-constraint discipline
> as the Phase 11B reconciliation substrate).

### 6.7 ServiceCommitment (multi-dimensional — capacity vs service constraints)

The original draft said the existing scalar `Capability.fieldsJson` plus
policy are sufficient for multi-dimensional commitments (e.g., Telecom/Edge:
bandwidth + latency + availability). That is **not proven**.

The existing capacity model is fundamentally scalar:

```
physicalCapacity, unit, reservedAmount, committedAmount, remainingAmount
```

This works for `100 TB`, `16 GPU`, `1 Gbps`, `500 kW` — single dimensions.
It does NOT directly represent:

```
500 Mbps
AND <20 ms latency
AND 99.9% availability
AND 4 hours duration
```

These are different dimensions with partly different semantics. Critically,
**not every constraint consumes capacity.** A bandwidth constraint is a
capacity constraint; a latency or quality constraint is a service-level
constraint that does not deplete `CapacityResource.remainingAmount`.

**`[NEW]`** The spec defines:

> **Scalar capacity remains the kernel primitive. Multi-dimensional service
> commitments are composed from multiple constraints, distinguished into
> CapacityConstraints (which deplete capacity) and ServiceConstraints
> (which are SLA-level and do not deplete capacity).**

```typescript
interface ServiceCommitment {
  commitmentId
  networkId
  constraints[]     // multiple CommitmentConstraint entries
  durationWindow    // time window
  status            // active → fulfilled | violated | expired
}

// Common base for all constraints:
interface CommitmentConstraint {
  constraintId
  commitmentId      // FK to ServiceCommitment
  kind              // 'capacity' | 'service'
  verificationMethod // how this constraint is verified
  status            // pending → verified | violated
}

// A capacity constraint depletes CapacityResource (bandwidth, GPU, TB, kW).
interface CapacityConstraint extends CommitmentConstraint {
  kind: 'capacity'
  capabilityType    // bandwidth | compute | storage | energy | ...
  operator          // >= | <= | ==
  threshold         // the capacity value
  unit              // Mbps | GPU | TB | kW | ...
  capacitySourceId  // FK to the CapacityResource this depletes
}

// A service constraint is SLA-level and does NOT deplete capacity
// (latency, availability, quality grade, jitter, etc.).
interface ServiceConstraint extends CommitmentConstraint {
  kind: 'service'
  serviceType       // latency | availability | quality | jitter | ...
  operator          // >= | <= | ==
  threshold         // the SLA value
  unit              // ms | % | grade | ...
  slaPolicyRef      // reference to the SLA verification policy
}
```

**Example:**

```
ServiceCommitment
 ├── CapacityConstraint: bandwidth >= 500 Mbps  (depletes CapacityResource)
 ├── ServiceConstraint:  latency <= 20 ms       (SLA, no capacity depletion)
 ├── ServiceConstraint:  availability >= 99.9%  (SLA, no capacity depletion)
 └── duration = 4h                             (the commitment window)
```

This preserves kernel neutrality (the scalar `CapacityResource`/`CapacityCommitment`
models are unchanged) without pretending a scalar capacity record can represent
an SLA — and without forcing latency or quality into `CapacityResource`, which
would incorrectly deplete capacity for non-capacity constraints.

**Verification:** each constraint has its own `verificationMethod`. The
overall `ServiceCommitment` is `fulfilled` only if ALL constraints are
verified. This is critical for Telecom/Edge, Construction (quality
requirements), and Industrial (multi-parameter SLAs).

### 6.8 NetworkLaunch (first-class atomic control-plane operation)

**`[NEW]`** The original draft's completeness criteria did not include launch
atomicity. If the AWS analogy is serious, the network launch operation must
be atomic — no half-launched networks.

```
Draft configuration
    ↓
validate (all policies are well-formed)
    ↓
compile policy bundle (produce the NetworkVersion's configurationJson)
    ↓
materialize capabilities/policies (create the Capability records, RewardRules, etc.)
    ↓
publish NetworkVersion (immutable)
    ↓
initialize control-plane state (the network is ACTIVE)
```

**`[NEW]`** `NetworkLaunch` — the atomic control-plane operation:

```typescript
interface NetworkLaunch {
  launchId            // UUID
  networkId           // the network being launched
  draftConfig         // the draft configuration (pre-validation)
  validationStatus    // pending → valid | invalid
  compiledBundle      // the compiled NetworkVersion configurationJson
  launchStatus        // drafting → validating → compiling → materializing → published → active | failed
  startedAt
  publishedAt?        // when NetworkVersion was published
  activatedAt?        // when the network became ACTIVE
  failureReason?      // if failed, why
}
```

**Atomicity invariant (with control-plane boundary):**

> The launch either succeeds as a valid network environment (ACTIVE) or
> remains a draft. A network cannot become ACTIVE with incomplete
> policy/runtime/resource configuration.

**Scope of atomicity (corrected — control-plane boundary):**

The `NetworkLaunch` transaction can atomically create **control-plane
configuration** inside one database transaction:

```
Network
NetworkVersion
Capability records
RewardRules
Participant policy
Scheduling policy
```

It **cannot** atomically make external participants, physical resources, or
adapters operational. Those are a **separate lifecycle**:

```
NetworkLaunch transaction
    ↓
control-plane configuration becomes ACTIVE atomically

External resource onboarding (participants join, resources register,
adapters connect)
    ↓
separate lifecycle, not part of the launch transaction
```

This keeps the network-launch guarantee physically realistic: the control
plane is active and consistent, but external onboarding happens after, via
the participant/resource membership lifecycles (§5, §6.2).

If any control-plane step fails (e.g., reward policy is invalid), the entire
launch fails and the network stays in `draft` status. No partial control-plane
configurations. This is central to the "launch a platform on AWS" objective.

---

## 7. The verticals as network configurations

This is where the architecture proves itself. Each vertical is a network
configuration, not a kernel extension.

### 7.1 Energy (VPP) — `[EXISTS]`

```
Network: "West Africa VPP"
  runtimeKind: infrastructure
  capabilities: energy_discharge, energy_charge
  capacity: kW
  verification: baseline + telemetry
  reward: per-kWh rules
  resources: DERs, batteries (physical kind)
```

Already implemented. No kernel change.

### 7.2 Compute — `[EXISTS]`

```
Network: "GPU Compute Network"
  runtimeKind: infrastructure
  capabilities: gpu_compute, cpu_compute
  capacity: GPU, CPU
  verification: job completion telemetry
  reward: per-GPU-hour rules
  resources: GPU clusters, CPU nodes (compute kind)
```

Already implemented. No kernel change.

### 7.3 Storage — `[NEW]` network config, `[NEW]` adapter

```
Network: "Distributed Storage Network"
  runtimeKind: infrastructure
  capabilities: storage_capacity
  capacity: TB
  verification: proof of stored capacity / availability
  reward: per-TB-day rules
  resources: storage nodes (storage kind)
  commitment: 50 TB / 30 days
  execution: storage placement / retention
  usage: TB-days
```

**No kernel change.** Requires: a storage network template, a storage
resource adapter, storage capability definitions, storage verification
policy, storage economic policy.

### 7.4 Wireless / Bandwidth — `[NEW]` network config, `[NEW]` adapter

```
Network: "Wireless Access Network"
  runtimeKind: infrastructure
  capabilities: bandwidth
  capacity: Mbps / Gbps
  verification: throughput evidence
  reward: per-Mbps-hour rules
  resources: access points, routers, links (connectivity kind)
  commitment: 50 Mbps for 4 hours
  execution: traffic routing
  usage: Mbps-hours / GB transferred
```

**No kernel change.** Requires: a wireless network template, a connectivity
resource adapter, etc.

### 7.5 Telecom / Edge — `[NEW]` network config, `[NEW]` adapter

```
Network: "Edge Compute Network"
  runtimeKind: infrastructure (or hybrid)
  capabilities: compute, bandwidth, latency, availability, storage, coverage
  capacity: multi-dimensional (Mbps, ms, %, GB)
  verification: service-level verification (latency, availability SLAs)
  reward: per-SLA-unit rules
  resources: edge nodes, base stations, routers, 5G slices, MEC workloads
  commitment: 50 Mbps + <20ms latency + 99.9% availability + 4 hours
  execution: service execution (not just physical measurement)
```

This is where the capability/commitment model becomes much more powerful
than today's VPP-derived assumptions: a commitment is multi-dimensional
(bandwidth + latency + availability), and verification verifies the
**service**, not just a physical quantity.

**No kernel change.** The `Capability` model already supports multi-field
definitions (`fieldsJson`). The `CapacityCommitment` already separates
capacity (committed amount) from usage. The multi-dimensional aspect is a
policy/adapter concern.

### 7.6 Construction / Physical Work — `[NEW]` network config, `[NEW]` adapter

```
Network: "Construction Work Network"
  runtimeKind: infrastructure
  capabilities: earth_moving, lifting, transport, welding, inspection, installation
  capacity: m³, tons, items, hours
  verification: machine telemetry + GPS + operator attestation + inspection records + photos
  reward: per-verified-work-unit rules
  resources: excavators, cranes, trucks, crews, robots, inspection teams (industrial + human kinds)
  commitment: move 500 m³ within 3 days with quality requirement X
  execution: work assignment
  usage: verified work completed
```

This is where the architecture proves it is truly generic. A construction
network is a **work execution network**, not an asset marketplace.

**No kernel change.** Requires: a construction network template, industrial +
human resource adapters, construction capability definitions, construction
verification policy (multi-source evidence), construction economic policy.

### 7.7 Industrial — `[NEW]` network config, `[NEW]` adapter

```
Network: "Industrial Asset Network"
  runtimeKind: infrastructure
  capabilities: generation, throughput, cooling, compression, machining, storage
  capacity: MW, units/hour, BTU, m³/min, parts/hour, m³
  verification: sensor measurements + PLC telemetry
  resources: turbines, pumps, generators, robots, PLCs, production lines, warehouses
```

**No kernel change.**

### 7.8 Blockchain — `[NEW]` network config, `[NEW]` adapter (revised — ProtocolResourceAdapter, not InfrastructureAdapter)

```
Network: "Validator Network"
  runtimeKind: protocol (existing ProtocolRuntime)
  capabilities: block_production, validation, execution, data_availability, storage, RPC
  capacity: blocks/s, tx/s, GB, queries/s
  verification: finality certificates (existing — Phase 9C/11B)
  resources: validator nodes, sequencers, execution nodes, DA nodes, RPC/indexing nodes (protocol kind)
  commitment: produce N blocks/hour with <Xs finality
  execution: protocol transaction execution (existing)
  usage: finalized transactions / blocks
```

This fits the existing `ProtocolRuntime` rather than requiring a separate
blockchain kernel. The repository already has protocol runtime selection
and consensus/finality primitives (Phase 9C) + the reconciliation substrate
(Phase 11B).

**Adapter boundary correction (Defect from audit):** the original draft said
blockchain multi-node transport "plugs in via the protocol resource adapter."
That terminology is too close to `InfrastructureAdapter`. The existing
`InfrastructureAdapter` contract is explicitly about physical resources:

```
discover, getCapabilities, readTelemetry, execute, health
```

A blockchain validator network needs different operations:

```
peer discovery, message propagation, proposal reception,
vote emission, block propagation, validator membership,
state synchronization
```

Those are NOT `InfrastructureAdapter.execute()` operations.

**The correct architectural target:**

```
ResourceAdapter (generic control-plane contract)
        ├── InfrastructureAdapter (physical resources — [EXISTS])
        └── ProtocolResourceAdapter (protocol nodes — [NEW])
```

`ProtocolResourceAdapter` is a `[NEW]` adapter contract for protocol-kind
resources. It is NOT an `InfrastructureAdapter` specialization. The control
plane selects the adapter based on `resourceKind`: physical/compute/storage/
connectivity/industrial/human → `InfrastructureAdapter`; protocol →
`ProtocolResourceAdapter`.

What remains later (Phase 12E) is a **true multi-node network layer**: peer
discovery, node-to-node transport, validator membership, distributed
consensus, block propagation. That is a network-transport concern, not a
kernel concern — it plugs in via `ProtocolResourceAdapter`.

---

## 8. Invariants (preserved + generalized from `fc531b0`)

### 8.1 Identity

- **Content-addressed where it matters:** `PhysicalExecutionEvidence`,
  `ProtocolTransaction`, `ProtocolOutcome` (Phase 11B) are content-addressed.
- **Operational UUIDs:** `NetworkResource`, `Participant`,
  `CapacityReservation`, `CapacityCommitment` use operational UUIDs with
  buyer/participant-supplied idempotency keys layered on top.
- **Scope:** all objects are scoped to `tenantId` + `networkVersionId` /
  `networkId`. A participant/resource in Network A has no standing in
  Network B.

### 8.2 Idempotency

**`[NEW]`** The control-plane API must support idempotency for all mutating
operations (resource registration, reservation, commitment, assignment). The
existing `IdempotencyRecord` model `[EXISTS]` is the mechanism.

- A participant supplies an `Idempotency-Key` header on mutating requests.
- The API stores the key + resulting object ID in `IdempotencyRecord`.
- A retry with the same key returns the original result, not a duplicate.

### 8.3 Cancellation and expiry

| Object | Cancellation | Expiry |
|---|---|---|
| `Participant` | `active → suspended` (reversible) / `active → revoked` (terminal) | N/A |
| `NetworkResource` | `active → suspended` (reversible) / `active → decommissioned` (terminal) | N/A |
| `CapacityReservation` | `active → released` (before consumption) | `active → expired` |
| `CapacityCommitment` | `active → released` (before execution) | `active → expired` |
| `ExecutionAssignment` | `assigned → failed` (before completion) | kernel-managed |
| `Settlement` | N/A | `pending → reconciliation_required` |

**Invariant:** terminal states are irreversible. `consumed`, `completed`,
`settled`, `decommissioned`, `revoked` cannot be reverted. This is the
kernel's existing write-once discipline (Phase 5.2, 5.4), extended to the
control-plane layer.

### 8.4 Verification

**`[EXISTS]`** and control-plane-neutral:

- The control plane does not verify. It reads `VerificationResult` and
  `Attestation` records.
- The verification policy is bound to `NetworkVersion`.
- A participant cannot override verification — they receive the verified
  result or a rejection.

### 8.5 Failure and reconciliation

**`[EXISTS]`** (layered, from `fc531b0`):

| Layer | Failure | Reconciliation |
|---|---|---|
| Physical execution | adapter throws | `failAssignment` (kernel) |
| Hybrid protocol | consensus rejects / execution fails | `ReconciliationAttempt` (Phase 11B) |
| Economic pipeline | verification rejects | event marked `rejected`; no contribution |
| Settlement | settlement fails | `Settlement → reconciliation_required` (existing) |

The control-plane API surfaces these as participant-facing statuses but
does not own the reconciliation logic. It is a **projection** of kernel
state, not a second source of truth.

---

## 9. What is explicitly out of scope

- **Marketplace mechanics:** pricing discovery, order books, bidding,
  multi-party matching. The control plane is marketplace-neutral.
- **Payment rails:** Stripe, bank transfers. Settlement produces ledger
  entries; external payment integration is an application concern.
- **New kernel work:** this spec does not require changes to `NetworkRuntime`,
  `ProtocolRuntime`, `HybridRuntime`, the executor, consensus, or the
  economic pipeline. Those are frozen (Phase 11B accepted).
- **Vertical-specific kernel services:** `StorageService`, `WirelessService`,
  etc. are FORBIDDEN in the kernel (§2).
- **Multi-node network transport:** peer discovery, node-to-node transport,
  block propagation for blockchain networks. That is Phase 12E, and it plugs
  in via the protocol resource adapter, not the kernel.
- **Implementation:** this is a specification. No code, no schema changes.
  Phase 12B is the implementation gate.

---

## 10. Phase roadmap

This spec is Phase 12A. The subsequent phases prove the architecture across
verticals:

### Phase 12A — Universal Network Control Plane Specification (this document)

Specification only. Defines Network + Participant + NetworkResource +
Capability + Capacity + Reservation + Commitment + Assignment + Execution +
Evidence + Verification + Contribution + Reward + Settlement as the
control-plane object model.

### Phase 12B — Implement the network control plane

- `[NEW]` `NetworkResource` model (generalizing `Asset`).
- `[NEW]` `Participant` model (generalizing operator/buyer roles).
- `[NEW]` Control-plane API endpoints (launch network, register resource,
  reserve, commit, assign, execute, query status).
- `[NEW]` Idempotency for all mutating operations.
- `[NEW]` Architecture tests proving the control plane does NOT bypass the
  kernel runtime/economic pipeline.
- `[NEW]` Lifecycle enforcement (terminal states irreversible).
- `[NEW]` Integration test: launch a network → register resources → reserve
  → commit → execute → verify → contribute → settle, end to end.

### Phase 12C — Prove network portability (physical verticals)

Prove that Energy, Compute, Storage, and Wireless all run on the same control
plane with only adapter/policy differences. No kernel changes. Each is a
network configuration.

### Phase 12D — Prove service networks

Prove Telecom/Edge, Construction, and Industrial as network configurations.
This is where multi-dimensional commitments (latency + availability + bandwidth)
and multi-source verification (telemetry + GPS + attestation + photos) prove
the generality.

### Phase 12E — Protocol/blockchain network support

Prove that a validator network runs on the `ProtocolRuntime` (existing)
via the protocol resource adapter. Includes the multi-node transport layer
(peer discovery, node-to-node, block propagation) as an adapter concern, not
a kernel concern.

### Phase 12F — Network launch experience

The "launch a platform on AWS" experience:

```
Create Network
  ↓
Select network class (energy, compute, storage, wireless, ...)
  ↓
Configure capabilities
  ↓
Configure policies (capacity, verification, contribution, reward, settlement)
  ↓
Register participants
  ↓
Attach resources
  ↓
Publish network version
  ↓
Network becomes ACTIVE
```

This is where the vision becomes tangible.

---

## 11. Relationship to Phase 11B

The Phase 11B reconciliation substrate is a **dependency** of the control
plane for hybrid networks:

- `HybridRuntime.executeHybrid()` is the execution path for hybrid networks.
- `PhysicalExecutionEvidence` + `ReconciliationAttempt` + `ProtocolOutcome`
  are the durable proof + reconciliation records.
- The control-plane failure projection (§8.5) maps the Phase 11B
  `ReconciliationState` values to participant-facing statuses.

The control plane is the first consumer of the Phase 11B contracts outside
the test suite. Phase 11B's acceptance (`713ee10`) is the precondition for
this spec.

---

## 12. Completeness criteria for Phase 12B (strengthened)

Phase 12B (implementation) is complete when:

1. **`[NEW]`** `ResourceIdentity` + `NetworkResourceMembership` models exist,
   generalizing `Asset` + `AssetNetworkAssignment` with a `resourceKind`
   discriminator (no seven separate models). A resource can participate in
   multiple networks.
2. **`[NEW]`** `ParticipantIdentity` + `ParticipantMembership` +
   `ParticipantRole` models exist (roles separated from membership, per §5).
3. **`[NEW]`** Control-plane API: launch network, register resource, reserve,
   commit, assign, execute, query — all translating to kernel operations
   WITHOUT bypassing the runtime.
4. **`[NEW]`** Idempotency for all mutating operations (via existing
   `IdempotencyRecord`).
5. **`[NEW]`** Architecture tests proving the control plane does NOT import
   kernel internals directly (no `Execution` model manipulation outside the
   runtime; no `ProtocolRuntime.deps` access; no vertical-specific kernel
   services).
6. **`[NEW]`** Lifecycle enforcement: terminal states irreversible.
7. **`[NEW]`** Failure projection: participant-facing statuses correctly
   map to kernel states, including Phase 11B reconciliation states.
8. **`[NEW]`** A control-plane integration test: launch a network →
   register resources → reserve → commit → execute → verify → contribute →
   settle, against the real runtime + economic pipeline, proving the adapter
   boundary holds end to end.
9. **`[NEW]`** A network-portability proof: at least two verticals (e.g.,
   Energy + Compute, both already implemented) run on the control plane
   with only adapter/policy differences, no kernel changes.
10. **`[NEW]`** **Network launch atomicity:** a network cannot become ACTIVE
    with incomplete policy/runtime/resource configuration. The `NetworkLaunch`
    operation is atomic (§6.8).
11. **`[NEW]`** **Multi-network resource sharing:** a single
    `ResourceIdentity` participates in multiple networks via separate
    `NetworkResourceMembership` records. Verified by test.
12. **`[NEW]`** **Resource withdrawal safety:** removing/suspending a
    resource from a network cannot invalidate historical executions or
    contributions. Verified by test.
13. **`[NEW]`** **Scheduler correctness:** concurrent requests cannot
    oversubscribe a resource or violate network policy. The `AllocationDecision`
    respects capacity limits atomically (§6.6).
14. **`[NEW]`** **Policy compilation:** an immutable `NetworkVersion` produces
    a validated, executable policy bundle. Invalid policy bundles fail launch.
15. **`[NEW]`** **Resource lifecycle isolation:** suspending a resource in
    Network A does NOT automatically suspend it in Network B. Verified by test.
16. **`[NEW]`** **Network isolation:** participant/resource state from
    Network A cannot leak into Network B. Verified by test.
17. **`[NEW]`** **Vertical portability:** a new network can be created from
    a configuration package (template + policies) without modifying the
    generic runtime code.
18. **`[NEW]`** **Multi-dimensional service commitment:** a `ServiceCommitment`
    with multiple `CapabilityConstraint`s (e.g., bandwidth + latency +
    availability) is verified correctly — fulfilled only if ALL constraints
    are met (§6.7).
19. **`[NEW]`** **ProtocolResourceAdapter:** a `[NEW]` adapter contract for
    protocol-kind resources, separate from `InfrastructureAdapter` (§7.8).
    Verified by architecture test that protocol-kind resources resolve to
    `ProtocolResourceAdapter`, not `InfrastructureAdapter`.
20. **`[NEW]`** **Request isolation:** a requester cannot cause an allocation
    decision outside the permissions/constraints of its network membership.
    The scheduler verifies `requesterMembershipId` is `active` and authorized
    before producing an `AllocationDecision` (§6.6). Verified by test: a
    requester with a suspended consumer role cannot trigger allocation.
21. **`[NEW]`** **Allocation reproducibility:** given the same
    (`NetworkVersion`, `NetworkRequest`, `ResourceMembership` state), the
    scheduler's decision is either deterministic or explicitly versions its
    non-deterministic policy via `AllocationDecision.schedulerVersion` (§6.6).
    Verified by test: replaying the same request+state produces the same
    decision, or records a different `schedulerVersion` if the policy
    changed.

---

## 13. Summary (revised)

```
Phase 11B (713ee10): runtime + reconciliation substrate ✅ accepted
    ↓
Phase 12A (this document, revised): universal network control plane specification
    ↓
    - Thesis: a network is a programmable infrastructure environment
    - Rule: control plane may add generic objects; may NOT add vertical-specific
      kernel primitives
    - Architecture: Network → Participants → Resources → Capabilities →
      Capacity → NetworkRequest → AllocationDecision → Reservation →
      Commitment → Assignment → Execution → Evidence → Verification →
      Contribution → Reward → Settlement
    - ResourceIdentity + NetworkResourceMembership (multi-network, generalizes
      Asset + AssetNetworkAssignment; binds to ParticipantMembershipId)
    - ParticipantIdentity + ParticipantMembership + ParticipantRole (roles
      separated from membership)
    - NetworkRequest (actor-neutral scheduler input, authorized by
      requesterMembershipId)
    - AllocationDecision (first-class scheduler output, reproducible)
    - ServiceCommitment (CapacityConstraint vs ServiceConstraint — capacity
      depletes; SLA does not)
    - NetworkLaunch (atomic control-plane operation; external onboarding is
      a separate lifecycle)
    - ProtocolResourceAdapter (separate from InfrastructureAdapter)
    - Every vertical is a network configuration, not a product
    - Marketplace-neutral, payment-rail-neutral
    ↓
Phase 12B: implement the control plane (21 completeness criteria)
Phase 12C: prove physical verticals (Energy, Compute, Storage, Wireless)
Phase 12D: prove service networks (Telecom/Edge, Construction, Industrial)
Phase 12E: protocol/blockchain networks (ProtocolRuntime + ProtocolResourceAdapter + multi-node transport)
Phase 12F: network launch experience ("launch a platform on AWS")
```

The next audit target is this document. It should be reviewed for:
- Does the `ResourceIdentity` + `NetworkResourceMembership` abstraction
  correctly generalize `Asset` + `AssetNetworkAssignment` while preserving
  multi-network resource sharing?
- Is the participant model (with roles separated from membership) complete
  enough for the verticals listed (§7)?
- Is the "no vertical-specific kernel services" rule (§2) precise enough
  (control plane may add generic objects; may not add vertical-specific
  kernel primitives)?
- Are the 21 completeness criteria (§12) sufficient to gate Phase 12B,
  including launch atomicity, multi-network sharing, scheduler correctness,
  and multi-dimensional commitments?
- Does the `ProtocolResourceAdapter` vs `InfrastructureAdapter` split (§7.8)
  correctly avoid smuggling blockchain semantics into the physical adapter?
