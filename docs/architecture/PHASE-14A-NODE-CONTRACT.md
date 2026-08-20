# Phase 14A — Node Registration & Participation Foundation — Contract

> Status: FROZEN
> Date: Phase 14A
> Supersedes: Node contract placeholder in ARCHITECTURE-CONSTITUTION.md §1 (line 45)

This document is the authoritative contract for the Node abstraction introduced
in Phase 14A. It defines what a Node IS, what it is NOT, how it relates to the
existing identity/resource/network models, its lifecycle, authorization rules,
concurrency semantics, audit behavior, ProtocolRuntime integration,
compatibility posture, and the anti-drift rules that bind future phases.

All implementation MUST conform to this document. Changes require explicit
architectural review. The constitution (`ARCHITECTURE-CONSTITUTION.md`) remains
the higher-order source of truth; this document operationalizes the Node portion
of constitution §1 (line 45: "Node (FUTURE — not yet implemented)").

Source of truth for the implementation:
- `prisma/schema.prisma` — `model Node` (line 2005), `model NodeNetworkMembership` (line 2053).
- `src/lib/services/node.service.ts` — service-layer lifecycle.
- `src/lib/domain/audit.ts` — Node audit events.

---

## 1. Definition

### What Node IS

A Node is a **protocol participation endpoint** — a protocol participant
identity/endpoint capable of participating in network protocols.

- **Tenant-scoped**: every Node belongs to exactly one Tenant (`tenantId` is
  non-nullable; `onDelete: Cascade` from `Tenant`).
- **Backed optionally** by a Device/Asset/ResourceIdentity. Bindings are
  mutable; the Node identity is not.
- **Optionally associated** with a ParticipantIdentity (the economic actor
  controlling the Node). `participantId` is required at registration for
  deterministic idempotency, but the FK itself is nullable in schema
  (`onDelete: SetNull`) so the Node survives participant deletion.

### What Node is NOT

A Node is NOT any of the following — this list is normative and tested:

1. NOT a replacement for **Asset** (the physical/logical thing providing
   capability). `Asset` continues to exist as a first-class model.
2. NOT a replacement for **Device** (the technical interface to an Asset).
   `Device` continues to exist; `Node.deviceId` is an optional FK.
3. NOT a replacement for **ParticipantIdentity** (the economic/network
   participant identity). `ParticipantIdentity` continues to exist as a
   global, non-tenant-scoped model.
4. NOT a replacement for **ResourceIdentity** (the universal resource
   abstraction). `ResourceIdentity` continues to exist; `Node.resourceId` is
   an optional FK.
5. NOT a network. A Node joins networks via `NodeNetworkMembership`; it is not
   itself a network or a network definition.
6. NOT a routing or data-plane primitive. It does not own bundles, routes,
   forwarding state, or transport sessions. (See constitution §8.)
7. NOT a new Resource model. It does not duplicate ResourceIdentity; it
   references it optionally.
8. NOT vertical-specific. There is no `VppNode`, `ComputeNode`,
   `TransitNode`, `CloudletNode`, or any vertical-specialized Node subtype.
   `nodeKind` is a free-form generic string (e.g. `"protocol_endpoint"`).

This boundary is the Phase 14A operationalization of constitution §1's
frozen identity rule: `Asset ≠ Device ≠ Node ≠ ParticipantIdentity ≠ ResourceIdentity`.

---

## 2. Identity Semantics

### Immutable cuid identity

- A Node's identity is an **immutable cuid** (`id String @id @default(cuid())`).
- The cuid is **random** and is NEVER derived from device name, IP, MAC,
  network membership, hostname, or runtime process ID.
- The cuid is stable for the lifetime of the Node row. It survives every
  mutable transition (binding changes, network joins/leaves, lifecycle
  transitions, location/transport changes if such metadata were ever stored).

### What a Node survives

A Node survives changes of:
- IP address (not stored on Node).
- Network membership (joins/leaves are rows in `NodeNetworkMembership`, not
  mutations of `Node`).
- Location (not stored on Node).
- Transport (not stored on Node).
- Protocol membership (a Node may join/leave multiple protocols across its
  lifetime without identity change).

### Idempotent registration

Registration is deterministic and idempotent. The idempotency key is the
compound:

```
(tenantId, participantId, nodeKind, idempotencyKey)
```

This is enforced by the schema constraint:

```
@@unique([tenantId, participantId, nodeKind, idempotencyKey])
```

- The same key always resolves to the same durable Node (concurrent callers
  converge — see §10).
- A **payloadHash** (SHA-256 of a canonical JSON of `nodeKind`, `displayName`,
  `deviceId`, `resourceId`, `protocolEligibility`, `metadata`) is stored on
  the row. If the same idempotency key is replayed with a DIFFERENT payload,
  the service raises `ConflictError` — the caller cannot silently mutate an
  existing Node's payload by replaying its idempotency key.

### Bindings are mutable, identity is not

`deviceId`, `resourceId`, `displayName`, `metadataJson`,
`protocolEligibilityJson`, and `status` are all **mutable** fields. They are
**bindings** to other entities or runtime state — they are NOT part of the
Node's identity. Only `id` (and the idempotency compound key) are identity.

---

## 3. Device Relationship

### Direct optional FK

A Node references a Device directly via the optional FK `deviceId`
(`Device? @relation(fields: [deviceId], references: [id], onDelete: SetNull)`).

- The binding is **optional** — a Node may exist with no Device backing (e.g.
  a pure protocol participant with no physical interface).
- The binding is **mutable** — a Node may be re-bound to a different Device
  over its lifetime (though Phase 14A's minimal service does not expose a
  dedicated re-bind operation; callers may update the row directly through
  the lifecycle operations or future extensions).
- `onDelete: SetNull` — if a Device is deleted, the Node survives, unbound.
  The Node is NOT destroyed by Device deletion.

### No NodeAgent abstraction (Step 3 decision)

Phase 14A explicitly did NOT introduce a `NodeAgent` abstraction. Rationale
(Step 3 audit): there is no evidence in the repository that one Node is backed
by multiple independent execution agents, or that one Device hosts multiple
independently managed protocol agents. The minimal implementation was chosen
over a speculative abstraction.

If such evidence emerges in a future phase, a NodeAgent layer MAY be
introduced between Node and Device without disturbing the Node identity
contract — but it is out of scope for 14A. (See §15.)

### One-to-many Device → Node

A Device MAY back multiple Nodes (the relation is one-to-many from Device's
perspective: `Device.nodes Node[]`). The typical case is one-to-one, but the
schema permits one-to-many — for example, a single gateway Device could back
two Nodes participating in two different protocols, each with its own
participant and lifecycle.

### Device ownership enforced (N3)

A participant cannot register a Node against another tenant's Device. The
service validates that the supplied `deviceId` belongs to the same `tenantId`
as the registration call. If the device is not found within the tenant, the
service throws `NotFoundError('device', deviceId)` — NOT a `ForbiddenError` —
so the caller cannot infer the device exists in another tenant (no
cross-tenant information leak).

---

## 4. Asset Relationship

### No direct Asset FK

A Node does NOT directly reference Asset. The schema has no `Node.assetId`
column. The Node reaches the Asset **transitively** via `Device.assetId`:

```
Node ──deviceId──> Device ──assetId──> Asset
```

### No ownership or duplication

The Node does not own or duplicate the Asset. The same Asset (via the same
Device) may participate in another protocol through a different Node, with
no copy of the Asset row and no Node-side denormalization of Asset fields.

This preserves the constitution's frozen boundary
(`Asset ≠ Device ≠ Node ≠ ParticipantIdentity ≠ ResourceIdentity`, §1)
and avoids creating a redundant path from Node to Asset that would have to be
kept in sync.

---

## 5. Resource Relationship

### Optional ResourceIdentity FK

A Node optionally references a ResourceIdentity via the `resourceId` FK
(`ResourceIdentity? @relation(fields: [resourceId], references: [id],
onDelete: SetNull)`).

- The binding is **optional** — a Node may exist without a ResourceIdentity
  backing.
- The binding is **mutable**.
- `onDelete: SetNull` — if a ResourceIdentity is deleted, the Node survives,
  unbound. ResourceIdentity is a globally reusable universal abstraction;
  the Node does not own it.

### No duplication

The Node does not own or duplicate ResourceIdentity. The ResourceIdentity
remains globally reusable — it continues to participate in
`NetworkResourceMembership` rows and other relationships independently of the
Node.

### Worked example

```
Battery Asset
  └─ Device (the battery controller)
       └─ Node A  ── participates in VPP protocol via NodeNetworkMembership
       └─ Node B  ── participates in another protocol via NodeNetworkMembership
  ResourceIdentity (global, reusable, unchanged)
```

The same Device/Asset may participate in another protocol via a different
Node. The ResourceIdentity remains globally reusable across all of these.
Node does not copy any ResourceIdentity state.

---

## 6. Participant Relationship

### Optional ParticipantIdentity FK

A Node optionally references a ParticipantIdentity via the `participantId` FK
(`ParticipantIdentity? @relation(fields: [participantId], references: [id],
onDelete: SetNull)`).

- The binding is **mutable** in schema and survives ParticipantIdentity
  deletion (`onDelete: SetNull`).
- However, `participantId` is **required at registration** by the service
  layer — it is part of the deterministic idempotency key
  `(tenantId, participantId, nodeKind, idempotencyKey)`. Without it, the
  idempotency guarantee cannot hold.

### The participant is the economic actor

The ParticipantIdentity is the economic/network actor who **controls** the
Node. The participant authorizes the Node's network participation through a
`ParticipantMembership` (network-scoped). The Node itself does not carry
economic identity — it borrows the participant's identity through this
binding.

### Network participation is authorized by ParticipantMembership

When a Node joins a network via `NodeNetworkMembership`, the row stores a
`participantMembershipId` (FK to `ParticipantMembership`). That membership is
the network-scoped authority under which the Node participates. See §7 and §9.

### Deletion semantics

- `onDelete: SetNull` from ParticipantIdentity: if the ParticipantIdentity is
  deleted, the Node survives with `participantId = null`. (In practice, the
  service still required it at registration; subsequent unbinding is permitted
  by the schema.)
- From ParticipantMembership: `NodeNetworkMembership.participantMembershipId`
  is `onDelete: Cascade` — if the authorizing membership is deleted, the
  NodeNetworkMembership row is removed. (This is a stronger coupling than the
  Node ↔ ParticipantIdentity relation, because the membership IS the
  authority for that specific network participation; without it the
  participation has no legal basis.)

---

## 7. Network Membership

### Distinct model (Step 4 decision)

`NodeNetworkMembership` is a **distinct** model from `NetworkResourceMembership`.
This is the Step 4 design decision and it is normative.

| Aspect | NetworkResourceMembership | NodeNetworkMembership |
|---|---|---|
| Binds | `resourceId` (ResourceIdentity) | `nodeId` (Node) |
| Participates as | CAPACITY PROVIDER | PROTOCOL ENDPOINT |
| Authority | `participantMembershipId` | `participantMembershipId` |
| Unique key | `@@unique([resourceId, networkId])` | `@@unique([nodeId, networkId])` |
| Schema location | existing (Phase 13) | new (Phase 14A) |

These are **separate relationships** and MUST NOT be conflated. A Node and a
Resource MAY both participate in the same network via their respective
memberships without duplicating either. The schema comment in
`prisma/schema.prisma` (lines 2035–2051) records this distinction in code.

### Schema fields

```
model NodeNetworkMembership {
  id                      String   @id @default(cuid())
  nodeId                  String   // FK to Node
  networkId               String   // plain String (same convention as NetworkResourceMembership)
  participantMembershipId String   // FK to ParticipantMembership — network-scoped authority
  protocolRole            String   @default("participant") // generic protocol role
  status                  String   @default("active") // active | suspended | revoked
  joinedAt                DateTime @default(now())
  ...
  @@unique([nodeId, networkId]) // one membership per node per network
}
```

- `networkId` is a **plain String**, not a typed FK to `NetworkDefinition`.
  This follows the existing `NetworkResourceMembership` convention, which
  treats `networkId` as an opaque string identifier. (The service layer
  enforces tenant ownership of the network explicitly — see §9.)
- `participantMembershipId` is the network-scoped authority under which the
  Node participates. Required.
- `protocolRole` is a generic free-form string with default `"participant"`.
  It is NOT a vertical-specific role enum.
- `status` is `active | suspended | revoked`. `active` is the default at
  creation. `leaveNetwork` sets it to `revoked` (history-preserving).

### Unique constraint

`@@unique([nodeId, networkId])` enforces **one membership per node per
network**. Concurrent `joinNetwork` calls for the same `(nodeId, networkId)`
converge to the same membership row (see §10).

### Network Scope Integrity (§8.6)

Network Scope Integrity is enforced at the service layer via the existing
`assertNetworkScopeIntegrity(relationship, referencedMembership, context)`
helper from `src/lib/control-plane/types.ts`. The call site is
`node.service.ts:joinNetwork`:

```
assertNetworkScopeIntegrity(
  { networkId: input.networkId },
  { networkId: membership.networkId },
  'NodeNetworkMembership',
)
```

This guarantees that the `networkId` of the join request matches the
`networkId` of the authorizing `ParticipantMembership`. A membership scoped to
network A cannot authorize a Node's participation in network B.

### Multi-network participation

A single Node can hold **multiple** `NodeNetworkMembership` rows — one per
network/protocol — WITHOUT duplicating Device/Asset/ResourceIdentity rows.
This is the core value proposition: one durable Node, many protocol
participations, all sharing the same backing physical/logical substrate.

---

## 8. Lifecycle

### States

```
registered → active → suspended | revoked
```

- **registered**: initial state at creation. A `registered` Node CANNOT join
  networks (N5). It must be activated first.
- **active**: the Node can join and leave networks.
- **suspended**: the Node cannot join NEW networks. Existing memberships are
  preserved (not auto-revoked). Can be re-activated.
- **revoked**: terminal state. Cannot join new networks. Cannot transition
  out (the service throws `ValidationError` if `activateNode` or
  `suspendNode` is invoked on a revoked Node).

### Lifecycle operations

| Operation | Pre-state | Post-state | Audit event |
|---|---|---|---|
| `registerNode` | (none) | `registered` | `node.registered` |
| `activateNode` | `registered` / `suspended` | `active` | `node.activated` |
| `suspendNode` | `registered` / `active` | `suspended` | `node.suspended` |
| `revokeNode` | any non-revoked | `revoked` | `node.revoked` |
| `joinNetwork` | requires `active` | (creates/updates `NodeNetworkMembership`) | `node.joined_network` |
| `leaveNetwork` | any | (sets membership `status='revoked'`) | `node.left_network` |

### Lifecycle enforcement (N5)

Only `active` Nodes can join networks. The `joinNetwork` service operation
checks `node.status === 'active'` and throws `ValidationError` otherwise.
This is the lifecycle enforcement for network participation.

### Membership lifecycle (distinct from Node lifecycle)

`NodeNetworkMembership.status` is `active | suspended | revoked`. It tracks
the membership's lifecycle within a network, independent of the Node's own
lifecycle. A revoked Node may still have `active` memberships (left over
from before revocation); those memberships cannot be re-joined through the
Node (because the Node itself is revoked and `joinNetwork` rejects it).

### leaveNetwork (N6)

`leaveNetwork` sets the membership's `status` to `revoked`. It does NOT
delete the membership row (history is preserved). It does NOT delete the
Node, Device, Asset, ResourceIdentity, or any other memberships (N6 —
multi-network participation is not disrupted by leaving one network).

---

## 9. Authorization

### No Node-specific authorization engine

Node authorization reuses existing infrastructure. There is NO new
Node-specific authorization engine, NO new policy DSL, NO new permission
model. All checks are explicit, in-code, and reuse:

- the `assertNetworkScopeIntegrity` helper from `src/lib/control-plane/types.ts`,
- the `DomainError` hierarchy (`NotFoundError`, `ValidationError`,
  `ConflictError`, `ForbiddenError`) from `src/lib/domain/errors`.

### N1 — Tenant isolation

All Node queries (`getNode`, `listNodes`, lifecycle operations, `joinNetwork`,
`leaveNetwork`) filter by `tenantId`. A query for a Node in tenant A cannot
return a Node owned by tenant B; the row is simply not found
(`NotFoundError`).

### N3 — Device ownership

If a `deviceId` is supplied at registration, it MUST belong to the same
`tenantId`. Cross-tenant device use is rejected with `NotFoundError('device',
deviceId)` (not `ForbiddenError`) — no cross-tenant information leak.

### N8 — Network authorization

`joinNetwork` requires that the supplied `ParticipantMembership`'s
`participantId` equals the Node's `participantId`. Concretely, the service
checks:

```
membership.participantId !== node.participantId → ForbiddenError
```

This guarantees that only the Node's own participant can authorize the
Node's network participation. Another participant's membership in the same
network cannot be used to bind this Node.

### Network scope integrity

`assertNetworkScopeIntegrity` enforces `membership.networkId ===
input.networkId`. A membership scoped to network A cannot authorize a join to
network B.

### Network tenancy

`joinNetwork` validates that the target `networkId` belongs to the calling
`tenantId` via `db.networkDefinition.findFirst({ where: { id: input.networkId,
tenantId } })`. A `NotFoundError('network', networkId)` is raised otherwise —
again, no cross-tenant information leak.

### Membership state

`joinNetwork` requires the supplied `ParticipantMembership` to be in
`active` status. A `pending`/`suspended`/`revoked` membership cannot
authorize Node participation (`ValidationError`).

### Summary of authorization checks (in order, in `joinNetwork`)

1. Node exists in tenant (N1) → else `NotFoundError('node', nodeId)`.
2. Node.status === `active` (N5) → else `ValidationError`.
3. Network exists in tenant (N1) → else `NotFoundError('network', networkId)`.
4. ParticipantMembership exists → else `NotFoundError`.
5. ParticipantMembership.status === `active` → else `ValidationError`.
6. ParticipantMembership.participantId === Node.participantId (N8) → else
   `ForbiddenError`.
7. Network Scope Integrity (membership.networkId === input.networkId) →
   else `ValidationError` (thrown by `assertNetworkScopeIntegrity`).

---

## 10. Concurrency

### registerNode — concurrent registration convergence

`registerNode` uses a **deterministic idempotency key**
`(tenantId, participantId, nodeKind, idempotencyKey)` enforced by the
schema constraint `@@unique([tenantId, participantId, nodeKind,
idempotencyKey])`.

Two concurrent calls with the same key:
1. One call's `db.node.create` wins; the row is persisted.
2. The other call's `db.node.create` fails with Prisma `P2002` (unique
   constraint violation).
3. The losing call catches `P2002`, re-reads the existing row via
   `db.node.findFirst({ where: { tenantId, participantId, nodeKind,
   idempotencyKey } })`, and:
   - If the existing row's `payloadHash` matches the caller's computed
     `payloadHash` → return the existing row (idempotent replay, N4).
   - If the `payloadHash` differs → `ConflictError` (same idempotency key,
     different payload — caller attempted to mutate via replay).
4. Both callers resolve to the same durable Node row (convergence).

### joinNetwork — concurrent membership convergence

`joinNetwork` relies on `@@unique([nodeId, networkId])`. Concurrent calls:

1. The service first does a `findFirst` for the existing membership.
2. If found, it reactivates (if not `active`) or returns as-is (idempotent).
3. If not found, it calls `db.nodeNetworkMembership.create`. If two callers
   race past the `findFirst`, the loser's `create` throws `P2002`. (The
   service does not explicitly catch `P2002` here in 14A; the loser's caller
   sees an error and may retry, at which point the `findFirst` succeeds. The
   uniqueness guarantee is database-enforced regardless of service-layer
   handling.)

In all cases, there is at most ONE membership row per `(nodeId, networkId)`.
Concurrent calls converge to a single membership — there is never a
duplicated membership.

### Proven against real PostgreSQL

Concurrency guarantees are proven against real PostgreSQL (Neon) — no mocks,
no SQLite fallback. (See constitution §14: PostgreSQL is mandatory; SQLite is
NOT supported.)

---

## 11. Audit

### Uses existing appendAudit infrastructure

Node audit reuses the existing `appendAudit({ tenantId, actorId, eventType,
resourceType, resourceId, metadata, tx? })` helper from
`src/lib/domain/audit.ts`. There is NO new NodeEvent subsystem and NO new
audit table.

### Events

The following events were added to the `AuditEvents` const (audit.ts lines
36–41) and are emitted by `node.service.ts`:

| Constant | Event string | Emitted by |
|---|---|---|
| `NodeRegistered` | `node.registered` | `registerNode` (on create) |
| `NodeActivated` | `node.activated` | `activateNode` (on transition to `active`) |
| `NodeSuspended` | `node.suspended` | `suspendNode` (on transition to `suspended`) |
| `NodeRevoked` | `node.revoked` | `revokeNode` (on transition to `revoked`) |
| `NodeJoinedNetwork` | `node.joined_network` | `joinNetwork` (on create or reactivate) |
| `NodeLeftNetwork` | `node.left_network` | `leaveNetwork` (on membership → `revoked`) |

### Audit is best-effort for lifecycle ops

Consistent with `registry.service.ts` conventions, Node lifecycle audit
emissions DO NOT pass a `tx` to `appendAudit`. Audit failures are logged
(`console.error('[audit] failed to append', ...)`) but never throw. This is
the same posture used for ordinary device/asset audit events.

For operations where audit MUST be atomic with the state change (e.g.
NetworkVersion publication, settlement), the codebase passes a `tx` and lets
failures roll back the whole transaction. Phase 14A did NOT require this for
Node lifecycle — a missing audit row on a Node lifecycle op is tolerated
because the durable Node row itself is the source of truth and can be
re-derived.

### resourceType values

Audit records use `resourceType: 'node'` for Node lifecycle events and
`resourceType: 'node_network_membership'` for join/leave events.

---

## 12. ProtocolRuntime Integration

### ProtocolRuntime already uses string identity

The ProtocolRuntime (Phase 9A) ALREADY uses string-based identity for
transaction senders and executors:

- `ProtocolTransaction.sender: string` — "public key, address, or operator
  ID".
- `ProtocolReceipt.executor: string` — "validator or runtime".

These are deliberately generic string identities; the runtime does not
require a typed Node object or a kernel-level Node contract.

### Node ID as sender/executor

A Node's durable ID (the cuid string) can serve directly as the
`sender`/`executor` string when a Node participates in protocol transactions.
No adapter is required — the ID is already a string, and the runtime already
accepts arbitrary strings.

### No modification to ProtocolRuntime internals

Phase 14A made NO modification to ProtocolRuntime internals. No new kernel
contract was introduced, no new `sender`/`executor` validation was added,
and no ProtocolRuntime file was changed.

### No kernel-level node.ts contract (Step 12)

Per Step 12, NO new kernel-level Node identity contract
(`src/lib/kernel/node.ts`) was created. The existing
`tests/phase-13-architecture-contract.test.ts:173` asserts that
`./src/lib/kernel/node.ts` does NOT exist; this assertion continues to hold.
Creating a kernel-level Node contract speculatively — when ProtocolRuntime
already has string identity indirection — would violate YAGNI and risk
premature freezing of an abstraction that may not need to exist.

---

## 13. Migration / Compatibility

### No migration needed

Phase 14A is **non-breaking**:

- ProtocolRuntime uses string identities; a Node ID is a string. No
  ProtocolRuntime migration is required.
- Historical protocol state (`ProtocolStateSnapshot`, `ProtocolTransition`)
  is unchanged. Existing snapshots reference string sender/executor values;
  those values may now be Node IDs, may continue to be public keys / operator
  IDs / addresses, or may be any other string the protocol accepted
  historically. No data backfill is required.
- Existing protocol execution continues to work without modification.
- The Node and NodeNetworkMembership tables were created via `prisma db push`
  against Neon PostgreSQL (Phase 14A deployment). No destructive migration
  was performed; the new tables are additive.

### Forward compatibility

A future protocol transaction that wants to attribute a sender to a Node
may do so by using the Node's cuid as the `sender` string. The protocol's
state machine will treat it as opaque, just as it treats any other string
identity. If a future phase needs to validate that a `sender` corresponds to
an active Node (e.g. for authorization), that validation will be performed
at the boundary of the future phase, not retrofitted into ProtocolRuntime.

---

## 14. Anti-Drift Rules

These rules are enforced by static tests in
`tests/phase-13-architecture-contract.test.ts` and Phase 14A tests. They are
normative — violating any of them is a contract breach.

1. **Node does not replace Device.** The `Device` model continues to exist
   in `prisma/schema.prisma`. `Node.deviceId` is an optional FK to `Device`,
   not a replacement for it.
2. **Node does not replace Asset.** The `Asset` model continues to exist.
   There is no `Node.assetId` column; the Node reaches Asset transitively
   via `Device.assetId`.
3. **Node does not replace ParticipantIdentity.** The `ParticipantIdentity`
   model continues to exist (global, no tenantId, no networkId). `Node.participantId`
   is an optional FK.
4. **Node does not duplicate ResourceIdentity.** The `ResourceIdentity` model
   continues to exist (globally reusable). `Node.resourceId` is an optional
   FK; no ResourceIdentity fields are duplicated onto Node.
5. **Node membership does not duplicate NetworkResourceMembership.**
   `NodeNetworkMembership` and `NetworkResourceMembership` are distinct
   models with distinct unique keys
   (`@@unique([nodeId, networkId])` vs `@@unique([resourceId, networkId])`).
   They bind different entities (Node vs ResourceIdentity) for different
   purposes (protocol endpoint vs capacity provider).
6. **Generic economic pipeline does NOT import `node.service`.** The generic
   economic pipeline (constitution §5) remains vertical-neutral; it does not
   import the Node service. (The Node service may, in future phases, be
   imported by verticals that consume the generic pipeline — that is
   permitted; the reverse is not.)
7. **`node.service` does NOT import VPP/Compute-specific services.**
   `src/lib/services/node.service.ts` imports only: `@/lib/db`,
   `@/lib/domain/errors`, `@/lib/domain/audit`, `@/lib/domain/crypto`
   (`sha256`), and `@/lib/control-plane/types` (`assertNetworkScopeIntegrity`).
   It does NOT import `vpp.service`, `compute.service`, or any
   vertical-specific module.
8. **ProtocolRuntime does NOT import concrete VPP/Compute implementations.**
   This is an existing rule (constitution §16 rule 8); Phase 14A did not
   weaken it. Node introduction does not create any new import path between
   ProtocolRuntime and vertical services.
9. **Node lifecycle is generic.** There is no `VppNode`, `ComputeNode`,
   `TransitNode`, `CloudletNode`, or any vertical-specialized Node file. The
   single `node.service.ts` implements the generic lifecycle
   (register/activate/suspend/revoke + join/leave) for all Node kinds.
   Vertical specialization is expressed via `nodeKind` (a string), not via
   subclassing.
10. **No future Data Plane dependency.** `node.service.ts` imports NO
    `data-plane`, `bundle`, `transform`, or `extension` modules. Phase 14A
    does not pre-commit Node to any future data-plane contract; the Node
    remains a control-plane participation primitive.

---

## 15. Future Extension Points

These are explicit MAY-DO extensions, not commitments. They are recorded
here so that future architects know what was deliberately deferred and why.

### NodeAgent

A `NodeAgent` layer MAY be introduced between Node and Device IF evidence
emerges that:
- one Node is backed by multiple independent execution agents, OR
- one Device hosts multiple independently managed protocol agents.

Neither condition holds today (Step 3 audit). Introducing NodeAgent
speculatively would violate YAGNI. If introduced, NodeAgent would sit
between `Node` and `Device` and would not alter the Node identity contract,
the `NodeNetworkMembership` schema, or any anti-drift rule in §14.

### Kernel-level Node identity contract

A kernel-level Node identity contract (`src/lib/kernel/node.ts`) MAY be
introduced IF ProtocolRuntime needs stronger typing than string identity for
`sender`/`executor`. ProtocolRuntime's current string identity is
deliberately generic; until a concrete need emerges for typed Node identity
at the kernel layer, no such contract is created (Step 12).

If introduced, the kernel contract MUST NOT break the existing
`tests/phase-13-architecture-contract.test.ts` assertion (line 173) without
an explicit architectural-review amendment to that test.

### Data Plane, Bundle, Transform, Extension, Marketplace, SDK

All of these remain future-phase boundaries (constitution §§8–12). Phase 14A
does NOT introduce any of them and does NOT pre-commit Node to any specific
data-plane contract. Node remains a control-plane participation primitive.

- **Data Plane** (constitution §8): future.
- **Bundle** (constitution §8): future.
- **Transform** (constitution §9): future.
- **Extension** (constitution §10): future.
- **Marketplace** (constitution §11): future.
- **SDK/API** (constitution §12): future. The SDK's `registerNode()`,
  `joinNetwork()`, etc. (constitution §12) will surface the Node service;
  no SDK is implemented in Phase 14A.

### Vertical-specific Node behavior

Phase 14A deliberately does NOT introduce vertical-specific Node subtypes.
If a future vertical needs Node-specific behavior (e.g. a VPP-specific
activation flow), it should be expressed via:
- `nodeKind` (a free-form string), and/or
- `metadataJson` (structured JSON on the Node row), and/or
- a vertical-owned service that wraps `node.service.ts`.

It MUST NOT be expressed via a new `VppNode` model or a
vertical-specialized Node service file (anti-drift rule 9).

---

## 16. Acceptance Gate

Phase 14A is accepted when ALL of the following criteria hold. These are the
acceptance criteria from the Phase 14A specification; each is testable and
traceable to a code or test artifact.

### Definition & identity

1. **Node has a stable generic definition.** `model Node` exists in
   `prisma/schema.prisma` with the fields specified in §2 and §3 of this
   document. The model is tenant-scoped, has an immutable cuid identity, and
   is generic (no vertical-specific subtype files).
2. **Node identity is immutable.** The cuid `id` is never recomputed and
   never derived from device name, IP, MAC, network membership, or runtime
   process ID. (Verified by Phase 14A tests asserting identity stability
   across binding/network/lifecycle changes.)
3. **Node is distinct from Asset.** No `Node.assetId` column; Asset reached
   transitively via `Device.assetId`. (Anti-drift rule 2.)
4. **Node is distinct from Device.** `Node.deviceId` is an optional FK;
   `Device` continues to exist as a first-class model. (Anti-drift rule 1.)
5. **Node is distinct from ParticipantIdentity.** `Node.participantId` is an
   optional FK; `ParticipantIdentity` continues to exist as a global model.
   (Anti-drift rule 3.)
6. **Node is distinct from ResourceIdentity.** `Node.resourceId` is an
   optional FK; `ResourceIdentity` continues to exist as a globally reusable
   model. (Anti-drift rule 4.)

### Participation & membership

7. **Multi-network participation.** A single Node can hold multiple
   `NodeNetworkMembership` rows (one per network) without duplicating
   Device/Asset/ResourceIdentity rows. (Verified by Phase 14A tests.)
8. **Node membership is separate from resource membership.**
   `NodeNetworkMembership` and `NetworkResourceMembership` are distinct
   models with distinct unique keys and distinct semantics (protocol endpoint
   vs capacity provider). (Anti-drift rule 5.)

### Authorization

9. **Tenant isolation.** All Node queries and mutations filter by `tenantId`.
   A Node in tenant A is invisible to tenant B. (N1, verified by Phase 14A
   tests.)
10. **Device ownership.** A participant cannot register a Node against
    another tenant's Device; cross-tenant device use is rejected with
    `NotFoundError` (no information leak). (N3, verified by Phase 14A tests.)
11. **Network authorization.** `joinNetwork` requires the
    `ParticipantMembership`'s `participantId` to equal the Node's
    `participantId`. (N8, verified by Phase 14A tests.)
12. **Network scope integrity.** `assertNetworkScopeIntegrity` is enforced
    on every `joinNetwork` call. (Verified by Phase 14A tests.)

### Concurrency

13. **Concurrent registration is safe.** Concurrent `registerNode` calls with
    the same idempotency key converge to the same durable Node. Conflicting
    payloads under the same key raise `ConflictError`. (Verified by Phase
    14A tests against real PostgreSQL/Neon.)
14. **Concurrent membership is safe.** Concurrent `joinNetwork` calls for the
    same `(nodeId, networkId)` converge to a single membership row.
    `@@unique([nodeId, networkId])` is database-enforced. (Verified by Phase
    14A tests against real PostgreSQL/Neon.)

### Lifecycle

15. **Lifecycle enforcement.** Only `active` Nodes can join networks;
    `registered`/`suspended`/`revoked` Nodes are rejected with
    `ValidationError`. `revoked` is terminal — `activateNode` and
    `suspendNode` reject it. (N5, verified by Phase 14A tests.)

### Runtime compatibility

16. **ProtocolRuntime tests are green.** The existing ProtocolRuntime test
    suite passes unchanged — Phase 14A did not modify ProtocolRuntime
    internals.
17. **HybridRuntime tests are green.** The existing HybridRuntime test suite
    passes unchanged — Phase 14A did not modify HybridRuntime internals.
18. **Slice 5 (Execution Lease) tests are green.** Existing Slice 5 tests
    pass unchanged.
19. **Slice 6 (Economic Pipeline) tests are green.** Existing Slice 6 tests
    pass unchanged — the generic economic pipeline does not import
    `node.service` (anti-drift rule 6).
20. **Compute tests are green.** Existing Compute tests pass unchanged.
21. **VPP tests are green.** Existing VPP tests pass unchanged — with the
    known pre-existing `baselineEngine` TypeScript namespace issue at
    `src/lib/services/vpp.service.ts:820-822` (constitution §15), which is
    out of scope for Phase 14A and unchanged by it.

### Persistence

22. **PostgreSQL / Neon passes.** All Phase 14A tests run against real
    PostgreSQL (Neon); no SQLite fallback. (Constitution §14.)

### Anti-drift & constitution consistency

23. **Anti-drift tests pass.** `tests/phase-13-architecture-contract.test.ts`
    and Phase 14A anti-drift tests pass — including the assertion that
    `./src/lib/kernel/node.ts` does NOT exist (rule 12 / Step 12) and the
    ten anti-drift rules in §14 of this document. No future data-plane
    dependency was introduced. The constitution (`ARCHITECTURE-CONSTITUTION.md`)
    remains consistent — Phase 14A operationalizes the Node placeholder at
    §1 line 45 without contradicting any frozen boundary in §§1–16.

### Gate status

All 23 criteria are met as of Phase 14A. The constitution's Node placeholder
(§1 line 45) is now operationalized by this document and by the
implementation in `prisma/schema.prisma` (`model Node`, `model
NodeNetworkMembership`), `src/lib/services/node.service.ts`, and
`src/lib/domain/audit.ts`.
