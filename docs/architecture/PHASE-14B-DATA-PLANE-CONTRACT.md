# Phase 14B — Data Plane / Bundle Foundation — Contract

> Status: FROZEN
> Date: Phase 14B
> Supersedes: Data Plane contract placeholder in ARCHITECTURE-CONSTITUTION.md §8 (line 302)

This document is the authoritative contract for the Data Plane / Bundle primitive
introduced in Phase 14B. It defines what the DataPlane IS, what the Bundle IS,
what both are NOT, how they relate to the existing control-plane / runtime /
economic substrates, identity rules, tenancy boundary, payload storage boundary,
lifecycle, idempotency/deduplication semantics, delivery semantics, crash
recovery, expiry, priority, security/integrity boundary, Node integration,
ProtocolRuntime integration, what is explicitly NOT implemented, anti-drift rules
binding future phases, future extension points, and the Phase 14B acceptance
gate.

All implementation MUST conform to this document. Changes require explicit
architectural review. The constitution (`ARCHITECTURE-CONSTITUTION.md`) remains
the higher-order source of truth; this document operationalizes the Data Plane
portion of constitution §8 (line 302: "DATA PLANE BOUNDARY (contract — NOT YET
IMPLEMENTED)").

Source of truth for the implementation:

- `prisma/schema.prisma` — `model Bundle` (line 2142), `model BundleDelivery` (line 2186).
- `src/lib/services/data-plane.service.ts` — DataPlane service-layer lifecycle.
- `src/lib/domain/audit.ts` — Bundle audit events (`BundleCreated`,
  `BundleReceived`, `BundleDelivered`, `BundleExpired`).
- `src/lib/services/node.service.ts` — Node identity validation (Phase 14A).
- `tests/phase-14b-architecture-contract.test.ts` — anti-drift enforcement.

---

## 1. Definition

### What the DataPlane IS

The DataPlane is a **generic data-plane substrate** that owns the **Bundle
primitive** — a transport/data-plane envelope capable of carrying arbitrary
protocol payloads. It is the additional substrate BELOW the control plane and
runtime. It is NOT a replacement for any existing control-plane, runtime, or
economic object.

Concretely, the DataPlane is:

- A **service-layer boundary** (`src/lib/services/data-plane.service.ts`), NOT a
  kernel contract (no speculative kernel contract is introduced in Phase 14B).
- Responsible for **receiving, holding, delivering, and expiring** Bundles — the
  minimal data-plane lifecycle (Step 1/3 of the Phase 14B spec).
- **Vertical-neutral**: it carries no awareness of VPP, Compute, TransitNet,
  Cloudlet, or any vertical domain. The same Bundle primitive is reusable by
  TransitNet, Local-first Internet, DTN, and future protocols.
- **Tenant-isolated**: every query filters by `tenantId`. A Bundle belongs to
  exactly one tenant (the source Node's tenant).

### What Bundle IS

A Bundle is a **generic data-plane primitive** with:

- **Immutable identity** (`bundleId` = deterministic SHA-256).
- **Source / destination Node endpoints** (`sourceNodeId`, `destinationNodeId`).
- **Creation / expiry time** (`createdAt`, `expiryTime`).
- **Priority** (generic `Int`, vertical-neutral).
- **Payload reference** (`payloadType`, `payloadHash`, `payloadRef`,
  `payloadBytesJson`).
- **Integrity metadata** (`payloadHash`, `nonce`).
- **Delivery records** (append-only `BundleDelivery` records — separate from the
  Bundle identity).

### What the DataPlane / Bundle is NOT

This list is normative and tested by `tests/phase-14b-architecture-contract.test.ts`:

1. NOT a replacement for **NetworkRequest** (the protocol state-transition
   request, owned by the control plane).
2. NOT a replacement for **AllocationDecision** (the resource-allocation
   control-plane decision).
3. NOT a replacement for **CapacityReservation** (the capacity-hold
   control-plane primitive).
4. NOT a replacement for **CapacityCommitment** (the durable capacity
   commitment control-plane primitive).
5. NOT a replacement for **ExecutionAssignment** (the runtime-execution
   control-plane primitive).
6. NOT a replacement for **ExecutionLease** (the runtime-execution lease
   primitive).
7. NOT a replacement for **InfrastructureRuntime** (the infrastructure-side
   runtime).
8. NOT a replacement for **ProtocolRuntime** (the protocol-side runtime that
   executes `ProtocolTransaction`s).
9. NOT a replacement for **HybridRuntime** (the bridge runtime).
10. NOT a replacement for **EconomicPipelineState** (the economic-side
    accounting state).
11. NOT a **TransitNet packet** (TransitNet is a vertical; Phase 14B has no
    TransitNet code).
12. NOT a **local-internet packet** (Local-first Internet is a future vertical;
    Phase 14B has no such code).
13. NOT an **HTTP request** (HTTP is a transport implementation detail; Bundle
    is a transport-envelope primitive, not a request/response binding).
14. NOT a **blockchain transaction / ProtocolTransaction**. `ProtocolTransaction`
    is a deterministic state-transition request (consensus-bound, ordered,
    replay-protected via nonce+sender). A Bundle is a transport/data-plane
    envelope that may CARRY a payload that includes a ProtocolTransaction, but
    the two primitives are distinct and not interchangeable.
15. NOT a **compute job** (compute is a different substrate; Bundle does not
    execute).
16. NOT a **routing engine** (no routing, multi-hop forwarding, or DTN routing
    is implemented in Phase 14B).
17. NOT a **DTN (Delay-Tolerant Networking) implementation**. Bundle is
    DELAY-tolerant in spirit (deterministic identity, expiry, append-only
    delivery records) but no DTN custody-transfer, bundle protocol (BP), or
    LTP implementation exists.
18. NOT **vertical-specific**. The Bundle primitive carries no
    `TransitNetPriority` / `CloudletPriority` / `LocalInternetPriority` types,
    no VPP fields, no Compute fields.

---

## 2. Architectural Relationship

The platform decomposes into four distinct substrates. The DataPlane is ONE of
them — an ADDITIONAL substrate, NOT a replacement for any other.

```
CONTROL PLANE → decides/authorizes:
  identity, resource, capability, allocation, policy, authorization,
  route constraints.

RUNTIME → executes protocol or infrastructure behavior:
  ProtocolRuntime (ProtocolTransaction state transitions),
  InfrastructureRuntime (physical execution),
  HybridRuntime (bridging).

DATA PLANE → moves/processes protocol data:
  receive, hold, deliver, expire Bundles (this service).
  Future: route, forward, fragment, reassemble, transform.

ECONOMICS → verifies/attributes/settles contribution:
  EconomicPipelineState, Contribution, Reward, Ledger, Settlement.
```

Key invariants:

- The DataPlane **does NOT replace** any existing control-plane primitive
  (`NetworkRequest`, `AllocationDecision`, `CapacityReservation`,
  `CapacityCommitment`, `ExecutionAssignment`, `ExecutionLease`).
- The DataPlane **does NOT replace** any runtime (`InfrastructureRuntime`,
  `ProtocolRuntime`, `HybridRuntime`).
- The DataPlane **does NOT replace** the economic pipeline
  (`EconomicPipelineState`).
- The DataPlane is **an ADDITIONAL substrate** that sits BELOW the control plane
  and runtime, providing a generic transport envelope for protocol data.

The DataPlane is referenced by:
- `Control plane` (future) may emit Bundles to authorize transport.
- `ProtocolRuntime` (future, via an explicit DataPlane interface) may emit
  Bundles to transport `ProtocolTransaction` payloads across Nodes.
- `Economics` (future, protocol-specific) may consume Bundle delivery facts.

None of these couplings exist in Phase 14B (see §14, §15, §17).

---

## 3. Bundle Identity

Bundle identity is **DETERMINISTIC and IMMUTABLE**:

```
bundleId = SHA-256(tenantId, sourceNodeId, payloadHash, idempotencyKey)
```

### Properties

- **Immutable**: once computed, the `bundleId` never changes for the lifetime
  of the Bundle. The Bundle row's primary key IS the deterministic `bundleId`.
- **Deterministic**: any caller that supplies the same
  `(tenantId, sourceNodeId, payloadHash, idempotencyKey)` tuple derives the same
  `bundleId`, regardless of when or where the call is made.
- **Survives replication / crash / retry / forwarding**: a duplicate copy of
  the same Bundle retains the same logical identity. This enables
  deduplication, retries, forwarding, replication, and crash recovery.
- **Exported**: `deriveBundleId()` is exported from
  `src/lib/services/data-plane.service.ts` so callers (including future routing
  and DTN layers) can pre-compute identities.

### What identity is NOT derived from

The `bundleId` is NOT derived from:

- The Prisma/DB row ID (the deterministic hash IS the row's `@id`).
- A timestamp alone (timestamps are advisory metadata, not identity).
- The route (routes do not exist in Phase 14B).
- The storage Node (storage is a future content-addressed concern; see §5).
- Network membership (the Bundle is tenant-scoped, not network-scoped).

This follows the `NetworkRequest.deriveRequestId` and `Node.deriveNodeId`
conventions established in earlier phases: deterministic identity → P2002
convergence → idempotent operations.

---

## 4. Tenancy / Network / Node Boundary

### Tenancy

- A Bundle is **tenant-scoped** to the source Node's tenant. A Bundle belongs
  to exactly one tenant (`tenantId` is non-nullable; `onDelete: Cascade` from
  `Tenant`).
- **Cross-tenant transport is a FUTURE routing concern** — NOT in Phase 14B.
  Phase 14B does not implement any cross-tenant forwarding, custody, or
  delivery.

### Node validation

Both endpoints reference Node identity (Phase 14A):

- **`sourceNodeId`** must be an **active Node** in the tenant (audit identifier
  `B4`/`B11`). A suspended/revoked/pending Node cannot source a Bundle.
- **`destinationNodeId`** must be a **Node in the same tenant**, not revoked
  (audit identifier `B5`/`B11`). A revoked destination Node is a terminal
  rejection.
- **Self-delivery is rejected**: `sourceNodeId === destinationNodeId` throws
  `ValidationError` in Phase 14B. (Self-delivery is a no-op semantically and
  has no utility in the Phase 14B minimal lifecycle.)

### What Bundle does NOT duplicate

- The DataPlane uses the existing **Node** model from Phase 14A
  (`src/lib/services/node.service.ts::getNode()`). It does NOT duplicate Node
  state inside the Bundle.
- The DataPlane does NOT own or shadow Node lifecycle transitions
  (registered → active → suspended → revoked). Node lifecycle remains the
  responsibility of `node.service.ts`.
- The DataPlane does NOT introduce a new identity primitive alongside Node.

---

## 5. Payload Storage Boundary

Phase 14B implements **Option B (payload reference) + inline small payload**.
The future Option C (threshold-based content-addressed storage) is deferred.

### Bundle payload fields

| Field              | Type     | Required | Purpose                                                          |
| ------------------ | -------- | -------- | ---------------------------------------------------------------- |
| `payloadType`      | `String` | yes      | Generic content type (e.g. `"application/json"`, `"opaque"`).    |
| `payloadHash`      | `String` | yes      | SHA-256 of the payload bytes — integrity.                         |
| `payloadRef`       | `String?` | no       | Opaque reference for external content-addressed storage (future). |
| `payloadBytesJson` | `String?` | no       | Optional inline small payload stored as a JSON string.            |

### Boundary invariants

- **Bundle metadata ≠ payload storage implementation**. The Bundle row records
  payload METADATA (type, hash, optional ref, optional inline bytes). It does
  NOT implement the storage system itself.
- A **future content-addressed storage system is NOT built in Phase 14B**.
  `payloadRef` is an opaque string; its semantics are deferred to whatever
  future storage system populates it.
- `payloadHash` is ALWAYS computed (`sha256(input.payload)`) regardless of
  whether the payload is stored inline or referenced externally. The hash is
  the integrity contract; the storage is an implementation detail.

### What is NOT in scope

- No threshold-based routing of payloads to inline vs external storage.
- No content-addressed storage system (CAS), no Merkle tree, no
  chunking/fragmentation/reassembly in Phase 14B (see §15).
- No payload encryption (see §12).

---

## 6. Lifecycle

The Bundle lifecycle is a persisted state machine:

```
created → received → stored → delivered
                            ↘ expired (terminal)
```

### States

- **`created`**: Bundle identity persisted, not yet received by destination.
  Initial state on `createBundle()`.
- **`received`**: destination has acknowledged reception (may be stored).
- **`stored`**: persisted at an intermediate or final location.
- **`delivered`**: delivered to destination (at-least-once, idempotent — see
  §8). `deliveredAt` records the FIRST delivery time.
- **`expired`**: past `expiryTime`; no new delivery permitted. Terminal.

### Delivery facts are SEPARATE

Delivery lifecycle is recorded in **`BundleDelivery`** — an **append-only**,
**separately-deduplicated** model. Each delivery fact is a distinct record,
distinguished by `status`:

```
stored | forwarded | delivered | acknowledged | failed
```

These are **distinct lifecycle facts**, NOT conflated:

- `stored` ≠ `forwarded` (storage at a node is not the same as forwarding to
  another node).
- `forwarded` ≠ `delivered` (forwarding is not final delivery).
- `delivered` ≠ `acknowledged` (delivery is the transport fact;
  acknowledgement is the receiver's confirmation).
- All of the above ≠ `failed` (failure is a distinct terminal state).

For Phase 14B, the primary statuses exercised are `stored` (initial delivery
record on `createBundle()`) and `delivered` (terminal delivery on
`deliverBundle()`). The other statuses are reserved for future routing,
forwarding, and acknowledgement layers (see §17).

### Audit events

Each lifecycle transition emits an audit event
(`src/lib/domain/audit.ts`):

| Transition           | Audit event          | Resource type   |
| -------------------- | -------------------- | --------------- |
| Bundle created       | `bundle.created`     | `bundle`        |
| Bundle received      | `bundle.received`    | `bundle`        |
| Bundle delivered     | `bundle.delivered`   | `bundle_delivery` |
| Bundle expired       | `bundle.expired`     | `bundle`        |

Audit is best-effort at the application layer (no transactional coupling in
Phase 14B). The Bundle row itself is the source of truth for lifecycle state.

---

## 7. Idempotency / Deduplication

### Bundle identity deduplication

- **`@@unique` on the deterministic `bundleId`** (the row's primary key) →
  concurrent inserts converge via the P2002 catch + re-read pattern (same
  pattern as `Node.registerNode`).
- **Same Bundle received twice → ONE logical Bundle**. The losing concurrent
  caller re-reads the winning row and returns it.
- **Same `idempotencyKey` + different `payloadHash` → `ConflictError`**.
  This is idempotency-conflict detection: the caller reused a key but supplied
  a different payload. The service refuses to silently overwrite.

### Delivery record deduplication

- **`@@unique([bundleId, receiverNodeId])`** on `BundleDelivery` → same Bundle
  delivered to the same receiver twice converges to ONE delivery record.
- The `deliveryId` is deterministic: `SHA-256(bundleId, receiverNodeId)`.
  `deriveDeliveryId()` is exported from `data-plane.service.ts`.

### Economics

- **Economics are NOT created per duplicate reception.** Economics is a future
  protocol-specific concern. The DataPlane records delivery FACTS (attempts,
  first-received, last-received, delivered-at); it does not attribute economic
  value to those facts. Attribution is the responsibility of future
  protocol-specific economic layers (see §17).

---

## 8. Delivery Semantics

Phase 14B implements **at-least-once + idempotent** delivery.

### What this means

- **at-least-once**: a Bundle MAY be delivered more than once to the same
  receiver (network retries, crash recovery, concurrent calls). The receiver
  MUST tolerate duplicates.
- **idempotent**: the (bundleId, receiverNodeId) tuple resolves to exactly ONE
  `BundleDelivery` record. Duplicate deliveries increment `attemptCount` and
  update `lastReceivedAt`, but they do NOT create new delivery records and do
  NOT change `deliveredAt` (the first-delivery time is preserved).
- **NOT exactly-once**. The Bundle layer does not claim exactly-once
  delivery — that would require consensus and end-to-end acknowledgement
  semantics that Phase 14B does not provide.

### Distinguishing the three semantics

| Semantics                          | Definition                                          | Phase 14B? |
| ---------------------------------- | --------------------------------------------------- | ---------- |
| at-most-once                       | May deliver zero or one time; duplicates dropped.   | No         |
| at-least-once                      | May deliver one or more times; duplicates possible. | Yes        |
| effectively-once-idempotent        | at-least-once + idempotent records (dedup by key).  | **Yes**    |

Phase 14B implements **at-least-once + idempotent** (the third row). The
distinction matters: the Bundle layer preserves FACTS (delivery attempts,
first-delivery time, last-received time) rather than making unsupported
guarantees.

### Delivery record fields

- `attemptCount`: incremented on each duplicate reception (P2002 path).
- `firstReceivedAt`: when the delivery record was first created.
- `lastReceivedAt`: `@updatedAt` — refreshed on each reception.
- `deliveredAt`: set when the delivery first transitioned to `delivered`.
  Preserved across retries (NOT overwritten on subsequent receptions).

### Retry semantics

- `deliverBundle()` is safe to call repeatedly with the same
  `(bundleId, receiverNodeId)`. Each call after the first increments
  `attemptCount` and returns the existing delivery record.
- If the Bundle has not yet been delivered, a retry will deliver it (status →
  `delivered`, `deliveredAt` set).
- If the Bundle is already delivered, a retry returns the existing record
  unchanged (other than `attemptCount`/`lastReceivedAt`).

---

## 9. Crash Recovery

### Invariants

- **Bundle persisted in PostgreSQL** → process terminates → restart → Bundle
  remains recoverable (audit identifier `B8`).
- **Bundle delivered → process crashes → retry → no duplicate delivery beyond
  the explicit delivery record** (audit identifier `B10`).
- **The database is the source of truth**, NOT in-memory state. There is no
  in-memory Bundle cache; every read goes through `db.bundle.findFirst` /
  `findUnique` / `findMany`.

### What this guarantees

- A crash between `createBundle()` and the audit append cannot lose the Bundle
  row (the row is committed first; the audit is best-effort).
- A crash between the Bundle row insert and the initial `BundleDelivery`
  insert is recoverable: `deliverBundle()` will create the missing delivery
  record on first delivery. The Bundle row's `created` status remains valid.
- A crash during `deliverBundle()` after the delivery record insert but before
  the Bundle row status update is recoverable: the next `deliverBundle()`
  retry will see the existing delivery record, increment `attemptCount`, and
  ensure the Bundle row is marked `delivered`.

### What this does NOT guarantee

- The audit row MAY be missing if the process crashed between the primary
  operation and the best-effort audit append. This is acceptable: the
  Bundle/Delivery rows are the source of truth; audit is an observation
  surface, not the canonical record.
- Distributed consensus across multiple DataPlane instances is NOT provided.
  Phase 14B assumes a single primary database (PostgreSQL/Neon); multi-writer
  convergence relies on the deterministic identity + P2002 pattern, not on
  distributed locking.

---

## 10. Expiry

### Invariants

- `expiryTime` is a **persisted timestamp** on the Bundle row. After expiry,
  new delivery is rejected (audit identifier `B9`).
- Expiry is **deterministic**, NOT an in-memory timer. There is no `setTimeout`
  or background sweeper that transitions Bundles to `expired` automatically.

### Enforcement

- `createBundle()` validates `expiryTime > now()` at creation. An expired or
  past-dated `expiryTime` is rejected with `ValidationError`.
- `deliverBundle()` checks `bundle.expiryTime <= now()` on every call:
  - If expired and status is not already `expired`, the Bundle's status is set
    to `expired`, a `bundle.expired` audit event is appended, and the
    delivery is rejected with `ValidationError`.
  - If already `expired`, the delivery is rejected without re-emitting audit.
- `expireBundle()` provides an explicit expiry transition for cleanup and
  recovery paths (e.g. a future sweeper job). It is idempotent: calling it on
  an already-expired Bundle is a no-op.

### What expiry is NOT

- NOT a TTL on storage (the Bundle row remains in the database after expiry;
  expiry only blocks new delivery).
- NOT a timer-based callback (no `setTimeout`).
- NOT a background sweep (no sweeper job in Phase 14B — `expireBundle()` is
  available for future sweepers to call).

---

## 11. Priority

- A **generic `Int` priority field** on the Bundle row.
- **Higher = more urgent.** Default is `0`.
- **No vertical-specific priority types** — no `TransitNetPriority`,
  `CloudletPriority`, `LocalInternetPriority`, or any vertical enum.
- **No complex scheduler** in Phase 14B. Priority is recorded as a fact on the
  Bundle; no priority queue, no weighted fair queuing, no QoS class. Future
  routing/scheduling layers MAY consume `priority` as an input (see §17).

### Why this matters

The generic priority field is the anti-drift surface that prevents vertical
leakage. A future TransitNet/Cloudlet/Local-first-Internet layer must NOT
introduce a parallel priority enum on Bundle; it must use the generic `Int`
field (or wrap it in a vertical-specific transform, see §17).

---

## 12. Security / Integrity Boundary

The Bundle carries **security METADATA/contracts**, not crypto implementations.

### Integrity / identity fields

| Field               | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `payloadHash`       | Payload integrity (SHA-256). Verifies payload was not corrupted.     |
| `sourceNodeId`      | Source identity (Node — protocol endpoint).                          |
| `destinationNodeId` | Destination identity (Node — protocol endpoint).                     |
| `idempotencyKey`     | Caller-supplied key for deterministic identity + replay detection.   |
| `nonce`             | Replay detection nonce (default `0`; callers may supply a per-Bundle value). |

### What is NOT in the Bundle

- **NO encryption algorithms**. There is no `encrypt()`, `decrypt()`,
  `cipher`, `keyId`, or `algorithm` field on Bundle. Encryption belongs in a
  future **transform/security layer** (constitution §9), not in the Bundle
  primitive.
- **NO signature field**. Bundle is not signed; the source Node's identity is
  the (validated) `sourceNodeId`. If payload-level signatures are required,
  they live in the payload, not in Bundle metadata.
- **NO access control lists**. Phase 14B enforces tenant isolation via
  `tenantId` filtering; finer-grained ACLs are a future concern.

### Boundary statement

The Bundle carries the **necessary security METADATA/contracts** (hashes,
identities, nonces) to enable a future transform/security layer to enforce
confidentiality, authenticity, and non-repudiation. It does NOT implement
those properties itself.

---

## 13. Node Integration

### Identity boundary

- Bundle references **Node identity** (`sourceNodeId`, `destinationNodeId`),
  NOT `Device` / `Asset` / `ResourceIdentity`. The Node is the protocol
  endpoint identity boundary established in Phase 14A.
- The Bundle's source and destination are Nodes because Bundles transport
  protocol data, and protocol participants are Nodes.

### Validation

- `getNode()` from `src/lib/services/node.service.ts` is used for validation
  in `createBundle()` (source must be active, destination must not be revoked).
- The DataPlane does NOT duplicate Node state inside Bundle. The Node row's
  `status`, `tenantId`, `participantId`, etc. remain owned by
  `node.service.ts`.

### Lifecycle coupling

- A Node transition (e.g. `active` → `suspended`) does NOT cascade into the
  Bundle layer in Phase 14B. Existing Bundles retain their `sourceNodeId` /
  `destinationNodeId` references; only NEW Bundle creation is gated by Node
  lifecycle (via `createBundle()` validation).
- Node remains the **protocol endpoint identity boundary** (Phase 14A, §13 of
  `PHASE-14A-NODE-CONTRACT.md`).

---

## 14. ProtocolRuntime Integration

### Current state

- **ProtocolRuntime uses string-based sender/executor identity** (Phase 9A /
  14A). A `ProtocolTransaction` carries `sender: string` and `executor: string`
  fields; these are opaque strings, not foreign keys.
- A **Node's cuid can serve as the `sender` string** when a Node participates
  in protocol transactions. This is a convention, not a coupling — the
  ProtocolRuntime accepts any string.

### Phase 14B scope

- **ProtocolRuntime is NOT modified** in Phase 14B. No new field, no new
  import, no new dependency on `data-plane.service.ts`.
- **Bundle is a SEPARATE data-plane substrate.** ProtocolRuntime does NOT
  depend on the Bundle service. ProtocolRuntime continues to execute
  `ProtocolTransaction`s via the existing deterministic state-transition
  path.

### Future relationship (NOT coupled in Phase 14B)

The future relationship — if and when ProtocolRuntime needs to emit Bundles
to transport transactions across Nodes — is:

```
ProtocolRuntime → DataPlane interface (future) → Bundle
```

This interface is **NOT defined in Phase 14B**. No speculative kernel contract
is introduced. Phase 14B ships the Bundle primitive and the DataPlane service;
the ProtocolRuntime → DataPlane integration is a future phase (see §17).

### Why no coupling now

Introducing a ProtocolRuntime → DataPlane interface in Phase 14B would
either (a) force a premature interface design before the Bundle primitive's
usage patterns are understood, or (b) couple two substrates that should
evolve independently. The Phase 14B audit (`Task ID: 14B-audit`) explicitly
deferred this coupling.

---

## 15. What is Explicitly NOT Implemented

This is the hard-stop list from Step 16 of the Phase 14B spec. None of the
following exist in Phase 14B:

1. **Routing algorithms** — no routing, no DTN, no multi-hop forwarding, no
   custody transfer, no bundle protocol (BP), no LTP.
2. **Transforms** — no `Transform`, no `TransformRegistry`, no
   `TransformRuntime`. Constitution §9 remains a contract placeholder.
3. **Extensions** — no `Extension`, no `ExtensionRegistry`. Constitution §10
   remains a contract placeholder.
4. **Marketplace** — no `Marketplace`, no discovery/publishing/licensing.
5. **SDK** — no client SDK, no language bindings, no developer tooling beyond
   the existing service API.
6. **Cloudlet / TransitNet / Local-first Internet** — no vertical-specific
   code, no vertical-specific Bundle fields, no vertical-specific priority
   types.
7. **Fragmentation / reassembly** — not needed for the Bundle identity
   contract in Phase 14B. Bundles are atomic envelopes; large payloads are
   referenced via `payloadRef` (future CAS).
8. **Content-addressed payload storage** — `payloadRef` is an opaque
   reference; no storage system is built in Phase 14B.
9. **ProtocolRuntime → DataPlane interface** — see §14. No coupling.
10. **Cross-tenant transport** — see §4. Single-tenant only in Phase 14B.
11. **Multi-writer distributed consensus** — single primary database
    (PostgreSQL/Neon); multi-writer convergence relies on deterministic
    identity + P2002.
12. **Background expiry sweep** — `expireBundle()` is available for future
    sweepers to call, but no sweeper is implemented in Phase 14B.

---

## 16. Anti-Drift Rules

Enforced by `tests/phase-14b-architecture-contract.test.ts`. These rules bind
all future phases; violations are test failures, not stylistic preferences.

1. **DataPlane does not import VPP.** No `import` of `vpp.service` or any VPP
   symbol in `data-plane.service.ts`.
2. **DataPlane does not import Compute.** No `import` of compute services in
   `data-plane.service.ts`.
3. **DataPlane does not import TransitNet.** No `import` of any TransitNet
   symbol.
4. **DataPlane does not import Cloudlet.** No `import` of any Cloudlet symbol.
5. **Bundle does not contain vertical-specific fields.** No
   `transitNetPriority`, `cloudletAffinity`, `vppResourceType`, or similar.
6. **Bundle does not own Asset/Device/ResourceIdentity.** Bundle references
   `Node` (source/destination), not Asset/Device/ResourceIdentity.
7. **Bundle references Node identity for protocol endpoints.** `sourceNodeId`
   and `destinationNodeId` are FKs to `Node`.
8. **Generic economic pipeline does not import Bundle/DataPlane.** The
   economic pipeline remains vertical-neutral and does not couple to the
   Bundle primitive.
9. **Marketplace does not exist in this milestone.** No `Marketplace` model,
   no marketplace service.
10. **Transform does not exist in this milestone.** No `Transform` model, no
    `TransformRegistry`.
11. **Routing implementation does not exist in this milestone.** No routing
    service, no forwarding logic, no DTN code.
12. **ProtocolRuntime depends on a generic DataPlane boundary, not a vertical
    implementation.** ProtocolRuntime does not import `data-plane.service.ts`
    in Phase 14B; the future interface (if any) must remain vertical-neutral.
13. **Node remains the protocol endpoint identity boundary.** Bundle does not
    introduce a parallel endpoint identity primitive alongside Node.
14. **Control Plane does not become a packet-processing engine.** Control
    plane primitives (`NetworkRequest`, `AllocationDecision`, etc.) do not
    acquire packet-processing fields or methods.

---

## 17. Future Extension Points

The following are EXPLICITLY deferred to future phases. Each is a known
extension surface; Phase 14B does NOT implement any of them.

1. **Routing**: multi-hop forwarding, DTN routing, mobility prediction,
   custody transfer, bundle protocol (BP), LTP. Future phase.
2. **Transforms**: data transformation with provenance (input hash + output
   hash + transform identity + transform version + parameters + node/runtime
   + resource cost + result). Constitution §9; future phase.
3. **Extensions**: pluggable routing strategy, scheduling, mobility
   prediction, cache strategy, deduplication, protocol algorithms, security
   behavior, transforms. Constitution §10; future phase. Extension security
   (publisher identity, signature, version, permissions, sandbox) is OPEN /
   RESEARCH REQUIRED.
4. **Content-addressed payload storage**: a separate storage system that
   resolves `payloadRef` to bytes, with chunking, dedup, and integrity
   verification. Future phase.
5. **Cross-tenant transport**: routing Bundles across tenants, including
   tenant-boundary policy, federated trust, and cross-tenant delivery
   semantics. Future phase.
6. **ProtocolRuntime → DataPlane interface**: if ProtocolRuntime needs to emit
   Bundles (e.g. to transport `ProtocolTransaction`s across Nodes), a
   vertical-neutral interface will be defined. Future phase; no speculative
   kernel contract in Phase 14B.
7. **Sweepers / cleanup**: a background sweeper that calls `expireBundle()`
   on past-expiry Bundles, and a delivery-retry sweeper for stuck
   `created`/`received` Bundles. Future phase.
8. **Acknowledgement layer**: the `acknowledged` delivery status is reserved
   but not exercised in Phase 14B. A future receiver-acknowledgement layer
   will populate it.
9. **Economic attribution**: protocol-specific economic layers that consume
   Bundle delivery facts to attribute value. Future phase; the DataPlane
   records facts, it does not attribute economics (see §7).
10. **Multi-writer / distributed consensus**: if multi-region or multi-writer
    DataPlane deployments are required, a consensus layer (or a
    conflict-free replicated data type) will be added. Future phase.

---

## 18. Acceptance Gate

Phase 14B acceptance requires ALL of the following criteria to pass. These
are the 28 acceptance criteria from the Phase 14B spec.

### Architecture / boundary (criteria 1–6)

1. **DataPlane boundary is generic.** `data-plane.service.ts` imports only
   `db`, `errors`, `audit`, `crypto`, and `node.service`. No vertical imports.
2. **Bundle primitive is generic.** No vertical-specific fields on the Bundle
   model; priority is a generic `Int`.
3. **Bundle identity is immutable.** `bundleId` = deterministic SHA-256; not
   derived from DB row ID, timestamp, route, storage, or network membership.
4. **Bundle is tenant-isolated.** Every query filters by `tenantId`;
   `tenantId` is non-nullable; cross-tenant transport is rejected/not
   implemented.
5. **Bundle uses Node.** `sourceNodeId` and `destinationNodeId` are FKs to
   `Node`; validated via `getNode()`.
6. **Bundle does not duplicate Node state.** No `Node`-like fields on Bundle;
   Node lifecycle remains owned by `node.service.ts`.

### Concurrency / recovery (criteria 7–10)

7. **Deduplication proven.** Same `(tenantId, sourceNodeId, payloadHash,
   idempotencyKey)` → same `bundleId` → same Bundle row. Conflicting payload
   under same key → `ConflictError`.
8. **Concurrent convergence.** Concurrent `createBundle()` calls with the
   same identity tuple converge to ONE Bundle row (P2002 catch + re-read).
   Concurrent `deliverBundle()` calls converge to ONE delivery record.
9. **Crash recovery.** Bundle persisted in PostgreSQL; process restart does
   not lose the Bundle. Delivery retry does not create duplicate delivery
   records.
10. **Expiry persisted.** `expiryTime` is a persisted timestamp; after
    expiry, `deliverBundle()` rejects and sets status=`expired`.
    `expireBundle()` is idempotent.

### Delivery / payload / security (criteria 11–13)

11. **Delivery retry semantics defined.** at-least-once + idempotent;
    `attemptCount` tracks duplicates; `deliveredAt` preserved on retry.
12. **Payload boundary explicit.** `payloadType`, `payloadHash`,
    `payloadRef` (optional), `payloadBytesJson` (optional inline). Bundle
    metadata ≠ payload storage implementation.
13. **Security boundary explicit.** `payloadHash`, `sourceNodeId`,
    `destinationNodeId`, `idempotencyKey`, `nonce` provide integrity, identity,
    and replay-detection metadata. NO encryption in Bundle.

### Anti-leakage (criteria 14–16)

14. **No routing.** No routing algorithm, no DTN, no multi-hop forwarding.
15. **No transform.** No `Transform`, no `TransformRegistry`.
16. **No extension/marketplace.** No `Extension`, no `ExtensionRegistry`, no
    `Marketplace`. No vertical-specific code (no Cloudlet/TransitNet/Local-
    first-Internet/VPP/Compute fields).

### Integration (criteria 17–18)

17. **ProtocolRuntime generic boundary.** ProtocolRuntime is NOT modified;
    does not import `data-plane.service.ts`. Future interface deferred.
18. **Node remains protocol endpoint identity boundary.** Bundle references
    Node, not Asset/Device/ResourceIdentity.

### Test gates (criteria 19–23)

19. **Phase 13 tests green.** No regression in Phase 13 dependency graph /
    gap matrix tests.
20. **Phase 14A tests green.** Node contract tests remain green; Bundle
    integration with Node is additive.
21. **Existing tests green.** Full pre-Phase-14B test suite remains green.
22. **Slice 5/6/Compute/VPP tests green.** VPP and Compute slices are not
    broken by the DataPlane addition (no vertical imports → no breakage).
23. **Phase 14B architecture contract test green.**
    `tests/phase-14b-architecture-contract.test.ts` enforces all anti-drift
    rules in §16.

### Platform / tooling (criteria 24–26)

24. **PostgreSQL/Neon passes.** Schema migration applies cleanly on
    PostgreSQL/Neon; `Bundle` and `BundleDelivery` tables created; indexes
    created; `@@unique` constraints enforced.
25. **TypeScript / lint accurate.** `tsc --noEmit` passes; ESLint passes; no
    new warnings.
26. **Clean tree.** No leftover debug code, no `.bak` files, no
    `console.log` in production paths.

### Release (criteria 27–28)

27. **Pushed.** All changes committed and pushed to the working branch.
28. **Worklog appended.** Phase 14B work record appended to `worklog.md`
    (this document's authorship task is `14B-doc`).

---

End of Phase 14B Data Plane / Bundle contract.
