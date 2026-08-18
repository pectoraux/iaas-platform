# Phase 12A — Buyer Capability Protocol Specification

| Field | Value |
|---|---|
| Phase | 12A — Buyer Capability Protocol Specification |
| Artifact type | Specification (not implementation) |
| Predecessor | Phase 11B (accepted at `713ee10`) |
| Implementation gate | Phase 12B |
| Status | **Draft for audit** |
| Repo HEAD at authoring | `713ee10` (`main`) |

> **Phase 11B is accepted.** The runtime selection, infrastructure boundary,
> generic execution model, adapter registry, protocol runtime, hybrid runtime,
> and reconciliation substrate are present in `main`. This document does NOT
> revisit that work. It specifies the next layer: a buyer-facing capability
> protocol that sits **as an adapter/application boundary** over the existing
> kernel contracts.

---

## 0. How to read this document

This document is a **specification**, not an implementation. It defines:

1. The **actor model** — who participates in the capability protocol.
2. The **canonical objects** — the protocol artifacts and their lifecycles.
3. The **protocol flow** — how the objects relate, end to end.
4. The **invariants** — identity, idempotency, cancellation/expiry,
   verification, and failure/reconciliation semantics.
5. The **architectural boundary** — what the buyer API may and may not do
   relative to the kernel.

Where the repository (`713ee10`) already contains an object or contract that
this spec references, it is marked `[EXISTS]`. Where the spec requires
something new, it is marked `[NEW]`. The `[NEW]` markers are the Phase 12B
implementation work.

---

## 1. Architectural boundary (non-negotiable)

This is the single most important rule in this document. It governs every
subsequent section.

### 1.1 The buyer API is an adapter boundary, not a kernel

The buyer-facing protocol API is an **application/adapter layer** over the
existing kernel contracts. It MUST NOT:

- Redefine execution semantics inside HTTP handlers.
- Redefine settlement semantics inside HTTP handlers.
- Bypass the `NetworkRuntime` to touch `Execution`/`ExecutionAssignment`
  records directly.
- Bypass the `ProtocolRuntime` / `HybridRuntime` to touch protocol state.
- Introduce a second economic pipeline parallel to the existing
  Event → Verification → Attestation → Contribution → Reward → Ledger →
  Settlement chain.

The buyer API translates buyer intent into kernel operations and kernel
results back to buyer-facing representations. It does not own state that the
kernel already owns.

### 1.2 What already exists (do not duplicate)

The repository at `713ee10` already contains:

- **Kernel contracts**: `NetworkRuntime`, `RuntimeExecuteInput`,
  `RuntimeExecuteResult`, `Execution`, `ExecutionAssignment`,
  `AdapterRegistry`, `InfrastructureRuntime`, `ProtocolRuntime`,
  `HybridRuntime`.
- **Economic pipeline**: `Event` → `VerificationResult` → `Attestation` →
  `Contribution` → `Reward` → `LedgerPosting`/`LedgerEntry` → `Settlement`.
- **Capacity lifecycle**: `CapacityResource` → `CapacityReservation` →
  `CapacityCommitment` → `CapacityUsage`.
- **Verticals**: VPP (energy), Compute — both as adapter+service pairs.
- **Protocol runtime**: deterministic state transitions, consensus,
  finality certificates, transition journal, reconciliation.

The buyer protocol spec builds on these. It does not replace them.

### 1.3 What is NOT a marketplace API

This specification is explicitly NOT a marketplace design. It does not
define:

- Pricing discovery, order books, bidding, or matching engines.
- Multi-party negotiation protocols.
- Payment rail integrations (Stripe, etc.) — those are application concerns.
- Catalog/search/discovery UI semantics.

It defines a **protocol object model** for capability reservation, commitment,
assignment, execution, verification, contribution, reward, and settlement —
the same objects the kernel already manages, exposed through a buyer-facing
contract with explicit lifecycle and idempotency semantics. A marketplace
may be built ON TOP of this protocol later, but the protocol itself is
marketplace-neutral.

---

## 2. Actor model

The protocol defines four actor roles. These are **roles**, not
implementation classes — a single operator may fulfill multiple roles, and
the kernel does not prescribe the mapping.

### 2.1 Provider

**Responsibility:** Owns physical assets that expose capabilities. Commits
capacity to the protocol via reservations.

**Maps to:** `Operator` (owns `Asset`s) in the existing schema. The provider
role is the operator's contribution of capacity to a network version.

**Kernel interaction:** Registers assets via `AssetNetworkAssignment`,
resulting in `CapacityResource` records. The provider does NOT execute
directly — execution goes through the `NetworkRuntime`.

### 2.2 Consumer / Buyer

**Responsibility:** Requests capability execution against reserved capacity.
Receives verified contributions and settles.

**Maps to:** A tenant-scoped principal (today: `PlatformUser` with a buyer
role; Phase 12B may introduce a dedicated `Buyer` model if the identity
contract requires it). The buyer role is defined by what it does (request,
receive, settle), not by a specific table.

**Kernel interaction:** The buyer API translates buyer intent into:
- `CapacityReservation` (reserve provider capacity for a window)
- `CapacityCommitment` (commit a specific amount for a specific job)
- `Execution` + `ExecutionAssignment` (via the `NetworkRuntime`)
- `Settlement` (after the economic pipeline completes)

### 2.3 Verifier

**Responsibility:** Verifies physical execution evidence (`Event`s) against
a network version's verification policy. Produces `VerificationResult`s and
`Attestation`s.

**Maps to:** The existing `VerificationService` + the worker that processes
the `Event` queue. This is `[EXISTS]` — the buyer protocol does not redefine
verification. It references verification results as inputs to the
contribution derivation.

**Kernel interaction:** Reads `Event`s, applies the policy from
`NetworkVersion`, writes `VerificationResult` + `Attestation`. The buyer
protocol consumes these as read-only inputs.

### 2.4 Validator

**Responsibility:** For networks using the protocol/hybrid runtime,
validators participate in consensus — ordering and finalizing transactions.

**Maps to:** `ValidatorRegistry` + `ConsensusEngine` in the protocol runtime.
This is `[EXISTS]` — the buyer protocol does not redefine consensus.

**Kernel interaction:** Validators are kernel-level, registered once. The
buyer protocol does not interact with validators directly; it submits
transactions via `HybridRuntime.executeHybrid()` which routes through
consensus internally.

---

## 3. Canonical objects

These are the protocol artifacts. Each has an identity, a lifecycle, and
explicit invariants. Where an object already exists in the schema, the spec
references the existing model and defines the buyer-facing contract on top
of it.

### 3.1 CapabilityAdvertisement

**Responsibility:** A provider's declaration that an asset exposes a
capability with a verified physical capacity.

**Maps to:** `[EXISTS]` as `CapacityResource` (the verified capacity) +
`Capability` (the capability type/schema) + `AssetNetworkAssignment` (the
binding). The buyer protocol does not create a new table; it defines a
buyer-facing read contract over these.

**Fields (buyer-facing view):**

| Field | Source | Meaning |
|---|---|---|
| `capabilityId` | `Capability.id` | The capability type identity |
| `capabilityType` | `Capability.capabilityType` | e.g. `energy_discharge`, `compute` |
| `assetId` | `CapacityResource.assetId` | The physical asset |
| `providerId` | `Asset.operatorId` | The provider (operator) |
| `networkVersionId` | `Capability.networkVersionId` | Protocol scope |
| `physicalCapacity` | `CapacityResource.physicalCapacity` | Verified max |
| `unit` | `CapacityResource.unit` | kW, GPU, TB, Gbps, etc. |
| `status` | `CapacityResource.status` | `active` \| `inactive` |

**Invariants:**

- CA1. A capability advertisement is **read-only** from the buyer's
  perspective. Buyers cannot create or modify capacity; they reserve it.
- CA2. The `physicalCapacity` is the verified capacity from
  `AssetNetworkAssignment.verifiedQuantity`, not a self-reported number.

### 3.2 CapabilityReservation

**Responsibility:** A buyer reserves a provider's capacity for a time window.
This is the buyer's claim on capacity, before a specific job is committed.

**Maps to:** `[EXISTS]` as `CapacityReservation`. The buyer protocol defines
the buyer-facing lifecycle on top of it.

**Identity:** `CapacityReservation.id` (existing). `[NEW]` buyer-facing
reservation ID for idempotency (see §4.2).

**Lifecycle:**

```
active → released | expired
```

- `active`: capacity is reserved; commitments may be created against it.
- `released`: the buyer or provider cancelled before consumption; remaining
  capacity returns to the resource.
- `expired`: the time window elapsed without full consumption.

**Invariants:**

- CR1. Reserved amount ≤ `CapacityResource.physicalCapacity` minus
  overlapping reservations (existing invariant, enforced by the capacity
  service).
- CR2. A reservation's `remainingAmount` = `reservedAmount` − sum of active
  commitments. This is `[EXISTS]`.
- CR3. Cancellation (`active → released`) is allowed only before any
  commitment is `consumed`. Once a commitment is consumed, the reservation
  cannot be fully released (the consumed portion is irreversible).

### 3.3 CapabilityCommitment

**Responsibility:** A specific commitment of reserved capacity to a job. This
is the buyer's binding request for execution.

**Maps to:** `[EXISTS]` as `CapacityCommitment`. The buyer protocol defines
the buyer-facing lifecycle.

**Identity:** `CapacityCommitment.id` (existing). `[NEW]` buyer-facing
commitment request ID for idempotency.

**Lifecycle:**

```
active → consumed | released | expired
```

- `active`: capacity is committed; an execution may be dispatched.
- `consumed`: execution completed and was verified; the commitment is
  fulfilled.
- `released`: cancelled before execution (e.g., buyer cancelled the job).
- `expired`: the time window elapsed without execution.

**Invariants:**

- CC1. Committed amount ≤ `CapacityReservation.remainingAmount` (existing).
- CC2. `consumed` is terminal — a consumed commitment cannot be released or
  re-committed. This mirrors the kernel's `ExecutionAssignment` completion
  being irreversible (Phase 5.2 write-once semantics).
- CC3. A commitment has at most one `Execution` linked via `sourceType`/
  `sourceId`. Re-dispatch after failure reuses the same commitment (the
  execution lifecycle handles retries, not the commitment).

### 3.4 Assignment

**Responsibility:** The binding of a commitment to a specific asset for
execution. This is the kernel's `ExecutionAssignment`, exposed to the buyer
as the "your job is assigned to asset X" artifact.

**Maps to:** `[EXISTS]` as `ExecutionAssignment`.

**Lifecycle (existing, Phase 5.2):**

```
assigned → executing → completed | failed
```

**Buyer-facing invariants:**

- A1. An assignment is created by the `NetworkRuntime`, not by the buyer API
  directly. The buyer API calls `runtime.createExecutionAssignment()`.
- A2. `completed` is irreversible (Phase 5.2 CAS guarantee). A failed
  settlement does not revert a completed assignment.
- A3. The buyer API may read assignment status but may not mutate it except
  through the runtime.

### 3.5 ExecutionEvidence

**Responsibility:** The physical evidence that execution occurred — telemetry,
actuals, verified results.

**Maps to:** `[EXISTS]` as `Event` (telemetry) + `VerificationResult` +
`Attestation` (verified claims) + `RuntimeExecuteResult` (the raw execution
output). For hybrid networks, also `PhysicalExecutionEvidence` (Phase 11B).

**Buyer-facing contract:** The buyer receives a **verified contribution
summary**, not raw telemetry. The evidence chain is:

```
RuntimeExecuteResult (raw)
    ↓
Event (signed, queued)
    ↓
VerificationResult (policy-checked)
    ↓
Attestation (verified claim)
    ↓
Contribution (economically valid work)
```

**Invariants:**

- EE1. The buyer API does NOT expose raw `Event` payloads. It exposes
  `Attestation`-level verified claims.
- EE2. For hybrid networks, the `PhysicalExecutionEvidence` (Phase 11B) is
  the durable proof; the buyer-facing view references it by ID, not by
  contents.

### 3.6 Contribution

**Responsibility:** The economically valid work derived from verified
evidence. This is the unit the buyer pays for.

**Maps to:** `[EXISTS]` as `Contribution`.

**Invariants (existing):**

- CO1. A contribution is linked to an `ExecutionAssignment` (write-once,
  Phase 5.4).
- CO2. A contribution has a verified quantity (from attestations) and a
  reward-eligible quantity.
- CO3. The buyer API reads contributions; it does not create them. The
  economic pipeline (worker service) creates them from attestations.

### 3.7 Reward

**Responsibility:** The economic credit assigned to a contribution per the
network's reward rules.

**Maps to:** `[EXISTS]` as `Reward`.

**Buyer-facing contract:** The buyer sees the reward as the "price" of the
contribution — but the reward is computed by the `RewardService` from
`RewardRule`s, not negotiated by the buyer. The buyer protocol is
marketplace-neutral (§1.3); pricing is a network-version policy, not a
buyer-seller negotiation.

### 3.8 Settlement

**Responsibility:** The final settlement of a buyer's obligation for a
contribution/reward — ledger postings + settlement record.

**Maps to:** `[EXISTS]` as `Settlement` + `LedgerPosting`/`LedgerEntry`.

**Lifecycle (existing):**

```
pending → settled | reconciliation_required
```

**Buyer-facing invariants:**

- SE1. Settlement is triggered by the economic pipeline after the assignment
  is `completed`, not by the buyer API directly.
- SE2. `reconciliation_required` is a terminal-ish state for the settlement
  (not the assignment) — the assignment stays `completed`; the settlement
  layer recovers separately. This mirrors the Phase 5.2
  execution/economics separation.
- SE3. The buyer API may retry settlement (existing `retry-settlement`
  endpoint) but may not bypass the ledger.

---

## 4. Protocol flow (end to end)

This is the canonical flow a buyer-facing capability request follows. Each
step references the kernel contract that owns it.

```
1. Buyer requests capability advertisement (read)
   → reads CapacityResource + Capability + Asset [EXISTS]

2. Buyer reserves capacity
   → creates CapacityReservation [EXISTS] via capacity.service
   → [NEW] buyer-facing reservation ID for idempotency

3. Buyer commits to a job
   → creates CapacityCommitment [EXISTS] via capacity.service
   → [NEW] buyer-facing commitment request ID for idempotency

4. Buyer dispatches execution
   → runtime.createExecution() + runtime.createExecutionAssignment()
     [EXISTS — NetworkRuntime contract]
   → runtime.beginAssignmentExecution() + runtime.executeAssignment()
     [EXISTS]
   → For hybrid networks: HybridRuntime.executeHybrid() [EXISTS — Phase 11B]
     which records PhysicalExecutionEvidence + ReconciliationAttempt [EXISTS]

5. Physical execution produces telemetry
   → RuntimeExecuteResult [EXISTS]
   → Event (signed, queued) [EXISTS]
   → Worker processes the event queue [EXISTS]

6. Verification
   → VerificationResult [EXISTS] (policy from NetworkVersion)
   → Attestation [EXISTS] (verified claim)

7. Contribution derivation
   → Contribution [EXISTS] (from attestations, via worker service)
   → linked to ExecutionAssignment (write-once) [EXISTS]

8. Reward computation
   → Reward [EXISTS] (from RewardRule, via reward.service)

9. Settlement
   → LedgerPosting + LedgerEntry [EXISTS]
   → Settlement [EXISTS]
   → buyer-facing settlement status [NEW — buyer-facing view]
```

**Critical observation:** steps 1–9 are almost entirely `[EXISTS]`. The
`[NEW]` items are:
- Buyer-facing idempotency IDs for reservation and commitment (§4.2).
- Buyer-facing read contracts (views over existing objects).
- The HTTP endpoints that translate buyer intent into kernel operations.

This is why this phase is specification-first: the implementation is mostly
adapter wiring, not new kernel work. The spec must define the contracts
before the wiring, so the wiring doesn't accidentally leak kernel internals.

---

## 4. Invariants

### 4.1 Identity

- **Content-addressed where it matters:** `PhysicalExecutionEvidence`,
  `ProtocolTransaction`, `ProtocolOutcome` (Phase 11B) are content-addressed.
  The buyer-facing objects (`CapabilityReservation`, `CapabilityCommitment`)
  use operational UUIDs (existing `cuid()`), with buyer-supplied idempotency
  keys layered on top (§4.2).
- **Scope:** all objects are scoped to `tenantId` + `networkVersionId`. A
  buyer operating in network version A cannot see or affect version B.

### 4.2 Idempotency

**[NEW]** The buyer API must support idempotency for reservation and
commitment creation. The existing `IdempotencyRecord` model `[EXISTS]` is the
mechanism.

- A buyer supplies an `Idempotency-Key` header on reservation/commitment
  requests.
- The API stores the key + the resulting object ID in `IdempotencyRecord`.
- A retry with the same key returns the original result, not a duplicate.
- This is critical for the buyer protocol because network retries are
  expected (mobile clients, flaky connections).

### 4.3 Cancellation and expiry

| Object | Cancellation | Expiry |
|---|---|---|
| `CapabilityReservation` | `active → released` (before any commitment consumed) | `active → expired` (window elapsed) |
| `CapabilityCommitment` | `active → released` (before execution) | `active → expired` (window elapsed) |
| `ExecutionAssignment` | `assigned → failed` (before completion) | N/A (kernel-managed) |
| `Settlement` | N/A | `pending → reconciliation_required` (timeout) |

**Invariant:** cancellation is never allowed to revert a terminal state.
`consumed` commitments, `completed` assignments, and `settled` settlements
are irreversible. This is the kernel's existing write-once discipline
(Phase 5.2, 5.4), extended to the buyer-facing layer.

### 4.4 Verification

Verification is `[EXISTS]` and buyer-protocol-neutral:

- The buyer API does not verify. It reads `VerificationResult` and
  `Attestation` records.
- The verification policy is bound to `NetworkVersion` (the
  `policyVersion` in `VerificationResult`).
- A buyer cannot override verification — they receive the verified result
  or a rejection.

### 4.5 Failure and reconciliation

Failure handling is layered, mirroring the kernel's existing separation:

| Layer | Failure | Reconciliation |
|---|---|---|
| Physical execution | adapter throws | `failAssignment` (kernel) |
| Hybrid protocol | consensus rejects / execution fails | `ReconciliationAttempt` (Phase 11B) |
| Economic pipeline | verification rejects | event marked `rejected`; no contribution |
| Settlement | settlement fails | `Settlement → reconciliation_required` (existing) |

**The buyer API surfaces these as buyer-facing statuses** but does not own
the reconciliation logic. The buyer sees:
- `execution_failed` → maps to `ExecutionAssignment.status = failed`.
- `reconciliation_required` → maps to `ReconciliationAttempt.status` (hybrid)
  OR `Settlement.status` (economic).

This separation is critical: the buyer API is a **projection** of kernel
state, not a second source of truth.

---

## 5. What is explicitly out of scope

- **Marketplace mechanics:** pricing discovery, order books, bidding,
  multi-party matching. The protocol is marketplace-neutral (§1.3).
- **Payment rails:** Stripe, bank transfers, etc. Settlement produces ledger
  entries; the integration of those entries with external payment systems is
  an application concern, not a protocol concern.
- **New kernel work:** this spec does not require changes to `NetworkRuntime`,
  `ProtocolRuntime`, `HybridRuntime`, the executor, consensus, or the
  economic pipeline. Those are frozen (Phase 11B accepted).
- **Vertical-specific semantics:** the protocol is generic. VPP, Compute,
  and future verticals plug in via adapters, not via protocol extensions.
- **Implementation:** this is a specification. No code, no schema changes,
  no endpoints. Phase 12B is the implementation gate.

---

## 6. Completeness criteria for Phase 12B

Phase 12B (implementation) is complete when:

1. **`[NEW]`** Buyer-facing idempotency for reservation and commitment
   creation, using `IdempotencyRecord`.
2. **`[NEW]`** Buyer-facing read contracts (views) over `CapacityResource`,
   `CapacityReservation`, `CapacityCommitment`, `ExecutionAssignment`,
   `Contribution`, `Reward`, `Settlement`.
3. **`[NEW]`** Buyer-facing write endpoints that translate buyer intent into
   `runtime.createExecution()` + `runtime.createExecutionAssignment()` +
   `runtime.executeAssignment()` (or `HybridRuntime.executeHybrid()` for
   hybrid networks), WITHOUT bypassing the runtime.
4. **`[NEW]`** Architecture tests proving the buyer API does NOT import
   kernel internals directly (no `Execution` model manipulation outside the
   runtime; no `ProtocolRuntime.deps` access).
5. **`[NEW]`** Lifecycle enforcement: cancellation respects terminal states
   (§4.3); the buyer API cannot revert a `consumed`/`completed`/`settled`
   object.
6. **`[NEW]`** Failure projection: buyer-facing statuses correctly map to
   kernel states (§4.5), including the hybrid reconciliation states from
   Phase 11B.
7. **`[NEW]`** A buyer-facing integration test that exercises the full flow
   (§3 flow steps 1–9) against the real runtime + economic pipeline,
   proving the adapter boundary holds.

---

## 7. Relationship to the Phase 11A specification

The Phase 11A spec defined the hybrid reconciliation boundary. Phase 12A
builds on it:

- The buyer protocol references `PhysicalExecutionEvidence` and
  `ReconciliationAttempt` (Phase 11B) for hybrid networks.
- The buyer-facing failure projection (§4.5) maps the Phase 11B
  `ReconciliationState` values to buyer-facing statuses.
- The buyer API calls `HybridRuntime.executeHybrid()`, which internally
  handles the crash-safe sequencing and reconciliation — the buyer API does
  not manage reconciliation.

This means the Phase 11B reconciliation substrate is a **dependency** of
the buyer protocol for hybrid networks. The buyer protocol is the first
consumer of the Phase 11B contracts outside the test suite.

---

## 8. Summary

```
Phase 11B (713ee10): runtime + reconciliation substrate ✅ accepted
    ↓
Phase 12A (this document): buyer capability protocol specification
    ↓
    - Actor model: Provider, Consumer/Buyer, Verifier, Validator
    - Canonical objects: Capability, Reservation, Commitment, Assignment,
      ExecutionEvidence, Contribution, Reward, Settlement
    - Most objects [EXISTS]; [NEW] items are idempotency + buyer-facing views
    - Architectural boundary: buyer API is an adapter, not a kernel
    - Marketplace-neutral
    ↓
Phase 12B (implementation, gated): endpoints + idempotency + views + tests
```

The next audit target is this document. It should be reviewed for:
- Does the actor model correctly map to the existing schema?
- Are the lifecycle invariants (§4.3) consistent with the kernel's write-once
  discipline?
- Is the adapter-boundary rule (§1) strong enough to prevent the buyer API
  from becoming a second kernel?
- Are the completeness criteria (§6) sufficient to gate Phase 12B?
