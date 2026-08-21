# Phase 14C — Data Plane Routing Foundation — Contract

> Status: FROZEN
> Date: Phase 14C
> Supersedes: Routing portion of ARCHITECTURE-CONSTITUTION.md §8 (future routing)

This document is the authoritative contract for the Data Plane Routing
substrate introduced in Phase 14C. It defines what a Route IS, what it is NOT,
how it relates to the Bundle (Phase 14B) and Node (Phase 14A) primitives, its
lifecycle, hop semantics, tenancy boundary, identity rules, capability and
reachability declarations, failure model, what is explicitly NOT implemented,
anti-drift rules binding future phases, future extension points, and the Phase
14C acceptance gate.

All implementation MUST conform to this document. Changes require explicit
architectural review. The constitution (`ARCHITECTURE-CONSTITUTION.md`) remains
the higher-order source of truth; this document operationalizes the routing
portion of constitution §8 ("DATA PLANE BOUNDARY (contract — NOT YET
IMPLEMENTED)").

Source of truth for the implementation:

- `prisma/schema.prisma` — `model Route`, `model RouteHop`,
  `model NodeCapability`, `model NodeReachability`.
- `src/lib/services/routing.service.ts` — routing service-layer lifecycle
  (`createRoutePlan`, `addRouteHop`, `getRoute`, `listRoutes`,
  `activateRoute`, `completeRoute`, `failRoute`, `expireRoute`,
  `declareNodeCapability`, `updateNodeReachability`).
- `src/lib/domain/audit.ts` — Route audit events (`RoutePlanned`,
  `RouteActivated`, `RouteCompleted`, `RouteFailed`, `RouteExpired`,
  `RouteHopAdded`).
- `src/lib/services/node.service.ts` — Node identity validation (Phase 14A).
- `src/lib/services/data-plane.service.ts` — Bundle identity validation
  (Phase 14B).
- `tests/phase-14c-architecture-contract.test.ts` — anti-drift enforcement.

---

## 1. Purpose

### What Phase 14C Introduces

Phase 14C introduces a **generic, immutable, auditable routing substrate** that
future connectivity protocols can consume. It introduces four primitives:

- **Route** — a planned path from a source Node to a destination Node, attached
  to a specific Bundle.
- **RouteHop** — an ordered hop within a Route (Node A → Node B → Node C →
  Destination).
- **NodeCapability** — the smallest declaration of what a Node can do on the
  data plane (`CAN_STORE_BUNDLE | CAN_FORWARD_BUNDLE | CAN_RECEIVE_BUNDLE` or
  generic).
- **NodeReachability** — knowledge of whether a Node is reachable, with a
  TTL-style `expiresAt` after which the knowledge is stale and must be
  re-checked.

### What Phase 14C Is NOT

Phase 14C is **NOT**:

- **NOT connectivity.** A Route is a plan; it carries no packets, opens no
  sockets, and sends no bytes.
- **NOT a network.** There is no network graph, no topology discovery, no
  routing algorithm execution.
- **NOT a transport.** A Route references Node endpoints; it does not know
  about TCP/UDP/Bluetooth/WiFi/satellite or any transport address.
- **NOT a routing engine that executes forwarding.** There is no
  `forwardBundle()`, no `sendPacket()`, no `openConnection()`, no
  `selectRadio()`. Execution belongs to a LATER phase.

### The FINAL RULE

> Do not build a network. Build the primitive that allows future networks to
> exist. The output of Phase 14C is not connectivity. It is a generic,
> immutable, auditable routing substrate that future connectivity protocols
> can consume.

This rule is normative. Every design choice below flows from it.

---

## 2. Routing Boundary

### Service-Layer Primitive

A Route is a **SERVICE-LAYER primitive**
(`src/lib/services/routing.service.ts`), NOT a kernel contract. There is no
`src/lib/kernel/route.ts`. The kernel exposes no routing contract in
Phase 14C — the constitution §8 placeholder for "future routing" is
operationalized here at the service layer only.

### WHERE, Not HOW

A Route represents **WHERE** a Bundle should go (the ordered sequence of Node
endpoints it is planned to traverse), **NOT how** it gets there physically.

- The Route records: sourceNodeId, destinationNodeId, ordered hops of
  (fromNodeId, toNodeId) pairs.
- The Route does NOT record: IP addresses, MAC addresses, ports, radio
  selections, link-layer parameters, congestion windows, retransmission
  counters, packet queues, or any forwarding state.

### No Execution State Overload

A Route does **NOT** overload execution state. The `status` field on Route and
RouteHop is a **lifecycle status** (planned | active | completed | failed |
expired), NOT forwarding/packet/connection state. The Route never holds:

- in-flight packet counters,
- per-hop ACK/NACK tracking,
- congestion-control state,
- retransmission timers,
- connection/socket handles.

### Allowed Operations

The routing service exposes exactly these operations:

- `createRoutePlan(tenantId, { bundleId, expiresAt, metadata? }, actorId?)`
- `addRouteHop(tenantId, { routeId, sequence, fromNodeId, toNodeId, metadata? }, actorId?)`
- `getRoute(tenantId, routeId)`
- `listRoutes(tenantId, filter?)`
- `activateRoute(tenantId, routeId, actorId?)`
- `completeRoute(tenantId, routeId, actorId?)`
- `failRoute(tenantId, routeId, actorId?)`
- `expireRoute(tenantId, routeId, actorId?)`
- `declareNodeCapability(tenantId, nodeId, capability, actorId?)`
- `updateNodeReachability(tenantId, nodeId, reachable, latencyHint, expiresAt, actorId?)`

### NOT Allowed (Execution Belongs to a LATER Phase)

The following operations are explicitly **NOT** introduced in Phase 14C:

- `forwardBundle()` — bundle forwarding is a transport/DLN concern.
- `sendPacket()` — packet sending is a transport concern.
- `openConnection()` — connection establishment is a transport concern.
- `selectRadio()` — radio/link selection is a transport concern.
- Any operation that moves bytes, opens sockets, or selects a physical link.

Introducing any of these in Phase 14C would violate the FINAL RULE.

---

## 3. Route Identity

### Identity Is a cuid (Immutable, Random)

Route identity is a **cuid** (`@id @default(cuid())`). It is:

- **Immutable** — the Route's `id` never changes after creation.
- **Random** — the `id` is NOT derived from the Bundle identity, the Node
  identity, the source/destination pair, or any user-supplied key.

This is distinct from the Phase 14B Bundle identity (deterministic
SHA-256-derived) and the Phase 14A Node identity (cuid). A Route is a planning
artifact; revision of a plan produces a NEW Route with a NEW cuid rather than
mutating the old one.

### A Distinct Planning Artifact

A Route is a **distinct planning artifact**. It may be revised by creating a
NEW Route (the old one is NOT mutated). This is the immutable-after-creation
principle:

- The old Route retains its original `id`, `status`, `expiresAt`, hops, and
  audit trail.
- The new Route has its own `id`, `status`, `expiresAt`, hops, and audit
  trail.
- Both Routes reference the same Bundle via `bundleId` FK.

### Immutable After Creation; Lifecycle Transitions Are Status Changes

A Route is **immutable after creation** with respect to its defining fields:

- `id`, `tenantId`, `bundleId`, `sourceNodeId`, `destinationNodeId`,
  `createdAt`, `expiresAt` — these never change after `createRoutePlan`.
- `status`, `completedAt`, `metadataJson`, `updatedAt` — these may change via
  explicit lifecycle operations (`activateRoute`, `completeRoute`,
  `failRoute`, `expireRoute`).

Lifecycle transitions (`planned → active → completed | failed | expired`) are
**status changes**, NOT identity mutations. The Route identity remains
stable across the entire lifecycle.

### Route Does NOT Modify Bundle

A Route **does NOT modify the Bundle** it is attached to (Step 7). The Bundle's
`id`, `payloadType`, `payloadHash`, `payloadRef`, `payloadBytesJson`,
`sourceNodeId`, `destinationNodeId`, `priority`, `nonce`, `expiryTime`,
`idempotencyKey`, and `status` are all unchanged by Route creation, hop
addition, or Route lifecycle transitions. The Route **attaches** information
(plan + hops) to the Bundle via the `bundleId` FK; it does NOT redefine the
Bundle.

---

## 4. Route Lifecycle

### States

```
planned → active → completed
                  ↘ failed
planned → expired (cannot become active)
active  → expired (cleanup / explicit expireRoute)
```

- **planned**: initial state. The Route has been created via
  `createRoutePlan` but is not yet active. Hops MAY be added to a `planned`
  Route via `addRouteHop`.
- **active**: the Route has been activated via `activateRoute` (after the
  expiry check passed). Hops MAY still be added to an `active` Route.
- **completed**: terminal. The Route successfully reached its destination.
  Set via `completeRoute` (only valid from `active`).
- **failed**: terminal. The Route failed (e.g., a hop failed, a Node was
  lost, the destination was unreachable). Set via `failRoute` (only valid
  from `active`).
- **expired**: terminal-equivalent for activation purposes. The Route's
  `expiresAt` has passed OR `expireRoute` was called explicitly. An expired
  Route **cannot become active** (R8).

### Terminal States

`completed`, `failed`, and `expired` are terminal for hop addition and
activation. `addRouteHop` rejects a Route in `completed`, `failed`, or
`expired` status with a `ValidationError`.

### Expiry

Expiry is **persisted** as the `expiresAt` timestamp on the Route. This is
**deterministic, NOT an in-memory timer**:

- No background sweeper is required for correctness in Phase 14C.
- `activateRoute` enforces the expiry check at activation time (R8): if
  `route.expiresAt <= now`, the Route is marked `expired` (if not already),
  `RouteExpired` is audited, and the activation is rejected with a
  `ValidationError`.
- `expireRoute` provides an explicit cleanup/recovery path: any caller may
  mark a Route `expired` at any time; the transition is idempotent.

### Lifecycle Transitions (Reference)

| From        | To          | Operation      | Notes                                                |
|-------------|-------------|----------------|------------------------------------------------------|
| planned     | active      | activateRoute  | Expiry check (R8).                                   |
| planned     | expired     | expireRoute    | Explicit cleanup; also auto-set on failed activation. |
| active      | completed   | completeRoute  | Terminal.                                            |
| active      | failed      | failRoute      | Terminal.                                            |
| active      | expired     | expireRoute    | Explicit cleanup.                                    |
| completed   | (none)      | (terminal)     | No further transitions.                              |
| failed      | (none)      | (terminal)     | No further transitions.                              |
| expired     | (none)      | (terminal)     | No further transitions.                              |

---

## 5. Hop Semantics

### RouteHop

A RouteHop is **an ordered hop in a Route**. A Route consists of a sequence
of hops:

```
Node A → Node B → Node C → Destination
  hop 0    hop 1    hop 2
```

Each hop is a directed edge `(fromNodeId → toNodeId)` belonging to a single
Route.

### Deterministic Ordering via `sequence`

Hop ordering is **deterministic** via the `sequence` field (`Int`). Hops are
always returned ordered by `sequence ASC`. The schema enforces uniqueness:

```
@@unique([routeId, sequence])
```

This guarantees no two hops in the same Route can share the same `sequence`
number. The service rejects `sequence < 0` with a `ValidationError`.

### Hop Fields

- `id` (cuid) — hop identity.
- `routeId` (FK) — the Route this hop belongs to.
- `sequence` (Int) — deterministic ordering.
- `fromNodeId` (FK to Node) — the Node this hop starts from.
- `toNodeId` (FK to Node) — the Node this hop goes to.
- `status` (String) — `planned | active | completed | failed`.
- `createdAt`, `metadataJson`.

### Node Lifecycle Enforcement (R6)

Both `fromNodeId` and `toNodeId` must reference **active Nodes in the tenant**.
Suspended/revoked Nodes cannot be added to new Routes. The service validates
both endpoints via `getNode(tenantId, nodeId)` and rejects the operation with
a `ValidationError` if either Node is not `active`.

A hop MAY NOT be a self-loop: `fromNodeId === toNodeId` is rejected with a
`ValidationError`.

### Hop Status

A RouteHop has its own lifecycle, independent of the Route lifecycle:

- `planned` — initial state.
- `active` — the hop is being traversed (future semantics; Phase 14C records
  the value but does not execute forwarding).
- `completed` — the hop was successfully traversed.
- `failed` — the hop failed.

Hop-level status changes are recorded via the hop's own metadata; Phase 14C
does NOT introduce hop-level transition operations beyond `addRouteHop` (the
hop is created in `planned` status). Hop-level `active/completed/failed`
transitions belong to future execution phases.

### Concurrent `addRouteHop` Convergence (R7)

Concurrent `addRouteHop` calls targeting the same `(routeId, sequence)` are
handled via the **P2002 catch + re-read** pattern (the same pattern used by
`Node.registerNode` in Phase 14A and `DataPlane.createBundle` in Phase 14B):

1. Attempt `db.routeHop.create({...})`.
2. If the call throws a Prisma `P2002` (unique-constraint violation on
   `(routeId, sequence)`), re-read the existing hop via
   `db.routeHop.findFirst({ where: { routeId, sequence } })` and return it.
3. The audit event (`RouteHopAdded`) is recorded only on the winning insert;
   the re-read path returns the existing hop WITHOUT emitting a duplicate
   audit event.

This guarantees that concurrent adders converge to a single durable hop per
`(routeId, sequence)`.

---

## 6. Relationship with Bundle

### Route ATTACHES to a Bundle

A Route attaches to a Bundle via the `bundleId` foreign key. It does **NOT**
modify Bundle identity/payload/destination (Step 7):

- The Bundle's `id`, `payloadType`, `payloadHash`, `payloadRef`,
  `payloadBytesJson`, `priority`, `nonce`, `expiryTime`, `idempotencyKey`,
  and `status` are all unchanged by Route creation or any Route lifecycle
  transition.
- The Route is a **separate planning artifact**, persisted in a separate
  table (`Route`) with its own identity (cuid).

### Source and Destination Are Derived from the Bundle

The Route's `sourceNodeId` and `destinationNodeId` are **derived from the
Bundle** at `createRoutePlan` time:

```
route.sourceNodeId      = bundle.sourceNodeId
route.destinationNodeId = bundle.destinationNodeId
```

A Route plans for a **SPECIFIC Bundle's journey**. The service calls
`getBundle(tenantId, input.bundleId)` and reads the source/destination from
the Bundle; the caller does NOT supply `sourceNodeId` or `destinationNodeId`
directly to `createRoutePlan`. This guarantees the Route's endpoints match the
Bundle's endpoints.

### A Bundle MAY Have Multiple Routes

A Bundle MAY have multiple Routes. Re-routing creates a **NEW Route**; the
old one is NOT mutated:

- The old Route retains its original status, hops, expiry, and audit trail.
- The new Route has its own identity (cuid), status, hops, expiry, and audit
  trail.
- `listRoutes(tenantId, { bundleId })` returns all Routes for a Bundle,
  ordered by `createdAt DESC` (newest first).

This is the immutable-after-creation principle applied across re-routings:
the platform preserves the FACT that a Route was planned, even after a
re-routing decision supersedes it.

### Bundle Remains Immutable

The Bundle (Phase 14B) remains **immutable** with respect to Route operations.
The `Route.bundle` relation is a read-side include
(`route.bundle`), never a write-side mutation. The Phase 14B contract's
"Bundle identity is immutable" guarantee is preserved.

---

## 7. Relationship with Node

### Route References Node Identity

A Route references **Node identity** (Phase 14A), NOT Device/Asset/Resource
identity:

- `Route.sourceNodeId` (FK to Node, relation `RouteSourceNode`).
- `Route.destinationNodeId` (FK to Node, relation `RouteDestinationNode`).
- `RouteHop.fromNodeId` (FK to Node, relation `RouteHopFromNode`).
- `RouteHop.toNodeId` (FK to Node, relation `RouteHopToNode`).

Node remains the **protocol endpoint identity boundary** (Phase 14A).
Routing does NOT redefine Node. A Node may be a Route endpoint, a RouteHop
endpoint, a NodeCapability holder, and a NodeReachability subject — all
without altering its identity, lifecycle, or ownership semantics.

### Node Lifecycle Enforcement (R6)

Suspended/revoked Nodes cannot be added to new Routes. The routing service
enforces this at:

- `addRouteHop` — both `fromNodeId` and `toNodeId` must be `active` Nodes in
  the tenant (verified via `getNode(tenantId, nodeId)`).
- `declareNodeCapability` — the Node must be `active` to declare a
  capability.
- `updateNodeReachability` — the Node must exist in the tenant (reachability
  knowledge may be recorded for non-active Nodes, since the knowledge itself
  is valid even if the Node is currently suspended).

Note: the Route's `sourceNodeId` and `destinationNodeId` are derived from the
Bundle at creation time; they are not re-validated on every subsequent
operation. If a Route's source or destination Node is suspended/revoked after
the Route is created, the Route remains valid as a historical planning
artifact — but new hops referencing that Node are rejected by `addRouteHop`.

### Node Remains Lower-Level Than Routing

Node is **lower-level** than routing. The dependency direction is:

```
routing.service.ts  →  node.service.ts   (routing imports node)
routing.service.ts  →  data-plane.service.ts  (routing imports data-plane, for getBundle)
```

The Node service (`node.service.ts`) does **NOT** import the routing service
(`routing.service.ts`). This is enforced as Anti-Drift Rule 6 below. The
absence of a reverse dependency guarantees that Node remains a stable,
lower-level primitive — adding Routing in Phase 14C does not perturb the
Phase 14A Node contract.

### No Lifecycle Coupling Beyond Validation

Routing does NOT change Node lifecycle. The routing service reads Node state
(via `getNode`) for validation purposes only; it never calls
`suspendNode`, `revokeNode`, or any other Node lifecycle mutation. Node
lifecycle transitions remain the exclusive responsibility of
`node.service.ts` (Phase 14A).

---

## 8. Non-goals

The following are explicitly **NOT implemented** in Phase 14C (Step 5 hard
stop). Each is deferred to a future phase; none is introduced here even as a
placeholder.

- **Transport protocols** — TCP, UDP, Bluetooth, WiFi mesh, satellite links.
  Route references Node endpoints, NOT transport addresses.
- **DTN forwarding engine** — no custody transfer, no Bundle Protocol (BP)
  framing, no Licklider Transmission Protocol (LTP) implementation.
- **Relay scheduling** — no relay selection, no relay-time-slot allocation, no
  relay throughput optimization.
- **Bandwidth markets** — no bandwidth pricing, no bandwidth reservation, no
  bandwidth auction.
- **Network marketplace** — no marketplace for routes, hops, capabilities, or
  reachability knowledge. `NodeCapability` is a declaration, NOT a listing.
- **Transforms** — no payload transformation, no compression/encryption, no
  content-addressed storage.
- **Extensions** — no routing-strategy extensions, no scheduling extensions,
  no mobility-prediction extensions.
- **SDK** — no Node/Bundle/Route SDK domain. The service layer is the API in
  Phase 14C.
- **Cloudlets** — no edge-compute cloudlet abstraction.
- **TransitNet** — no transit-network vertical implementation.
- **Routing algorithms requiring production network telemetry** — no
  link-state routing, no distance-vector routing, no path computation
  requiring real-time bandwidth/loss/latency measurements. Phase 14C stores
  `NodeReachability` as best-effort KNOWLEDGE; it does NOT compute optimal
  paths from it.

This list is normative. Introducing any of these in Phase 14C would violate
the FINAL RULE.

---

## 9. Future DTN Compatibility

### Delay-Tolerant in Spirit

A Route is **delay-tolerant in spirit**:

- **Immutable** — a Route plan does not change after creation; revisions are
  new Routes.
- **Expiry** — a Route has a persisted `expiresAt`; stale plans expire
  deterministically, not via in-memory timers.
- **Append-only hops** — hops are added via `addRouteHop`; the sequence is
  the ordered custody chain.

### No DTN Implementation in Phase 14C

There is **NO** DTN custody-transfer, Bundle Protocol (BP), or LTP
implementation in Phase 14C. A future DTN layer may consume the
Route/RouteHop primitives to represent custody paths, but Phase 14C itself
does not implement DTN semantics (no custody-transfer acknowledgements, no
bundle fragmentation/reassembly, no LTP sessions).

### RouteHop Sequence Supports Multi-Hop Paths

`RouteHop.sequence` supports arbitrary multi-hop paths. This is
**DTN store-carry-forward compatible**: a future DTN layer can map each
`RouteHop` to a custody-transfer hop with its own per-hop custody lifecycle.
The deterministic ordering via `sequence` (and `@@unique([routeId, sequence])`)
ensures a DTN layer can reconstruct the planned path without ambiguity.

---

## 10. Future Transport Compatibility

### Route Is Transport-Neutral

A Route is **transport-neutral**. It references Node endpoints (cuid-based
identity), NOT transport addresses (IP/MAC/port). The Route carries:

- `sourceNodeId`, `destinationNodeId` (Node cuids).
- `RouteHop.fromNodeId`, `RouteHop.toNodeId` (Node cuids).
- No IP addresses, MAC addresses, ports, SSIDs, or any transport-layer
  parameters.

### Future Transports Consume the Route

Future transports (TCP, UDP, Bluetooth, WiFi, satellite, future proprietary
links) can consume the Route to **determine endpoints** (which Node to send
to / receive from), then establish their own transport-layer connections. The
Route does NOT dictate the transport; it identifies the endpoints.

### No Transport Abstraction Introduced

Phase 14C introduces **no transport abstraction**. There is no
`Transport` interface, no `Link` model, no `Connection` model, no
`Radio` abstraction. These belong to future phases. The routing substrate
is explicitly narrower than a transport layer.

---

## 11. Security Considerations

### Route References Node Identity (Validated)

A Route references Node identity. Every Node reference is validated against
both tenant scope (`getNode(tenantId, nodeId)`) and lifecycle (active Nodes
only, per R6). The platform does not trust Node references supplied in
request bodies without re-validation against the durable Node record.

### NodeCapability Is a Declaration, NOT a Marketplace

`NodeCapability` declares data-plane capabilities a Node offers:

```
CAN_STORE_BUNDLE    — the Node can durably store Bundles.
CAN_FORWARD_BUNDLE  — the Node can forward Bundles to other Nodes.
CAN_RECEIVE_BUNDLE  — the Node can be the destination of a Bundle.
```

The capability set is open: a `capability` field is a `String`, allowing
future protocol-specific capabilities to be declared without schema changes.
A Node MAY have multiple capability declarations
(`@@unique([nodeId, capability])` enforces one declaration per capability per
Node).

`NodeCapability` is **NOT a marketplace listing**. It carries no price, no
SLA, no capacity reservation, no availability window. It is knowledge: "this
Node declares it can do X." Future marketplace layers MAY consume this
declaration, but Phase 14C does not introduce a marketplace.

### NodeReachability Is KNOWLEDGE, NOT Proof of Physical Connectivity

`NodeReachability` represents **knowledge** about reachability, NOT proof of
physical connectivity:

- `reachable: Boolean` — best-effort reachability knowledge (NOT a
  measurement, NOT a guarantee).
- `lastSeen: DateTime` — when reachability was last confirmed.
- `latencyHint: Int?` — an optional generic latency hint in milliseconds.
  This is a HINT, NOT a measurement. The platform does not run latency
  measurements in Phase 14C.
- `expiresAt: DateTime` — when this knowledge expires. After `expiresAt`,
  the knowledge is stale and must be re-checked by the caller; the platform
  does NOT auto-expire reachability records via a background sweeper (the
  TTL is a contract field, not an active timer).

One reachability record per Node (`@unique` on `nodeId`). Stale knowledge is
re-checked, not trusted.

### No Encryption/Authentication in Route

There is **no encryption or authentication** in the Route primitive. The
Route does not carry:

- payload encryption keys,
- per-hop authentication tokens,
- transport-layer security parameters,
- MAC or signature material for route integrity.

Security belongs in future transform/security layers (Phase 9 contract
boundary, Phase 14B security/integrity boundary). The Route references Node
identity (validated) and capability declarations (knowledge); it does NOT
become a security boundary.

### Tenant Isolation

All routing queries filter by `tenantId`. This is enforced at every service
operation:

- `createRoutePlan` — `tenantId` is the first argument; the Bundle lookup
  is scoped via `getBundle(tenantId, ...)`.
- `addRouteHop` — `tenantId` is the first argument; the Route is fetched via
  `getRoute(tenantId, routeId)`; Nodes are fetched via
  `getNode(tenantId, ...)`.
- `getRoute`, `listRoutes`, `activateRoute`, `completeRoute`, `failRoute`,
  `expireRoute` — `tenantId` is the first argument; the Route is fetched
  via `getRoute(tenantId, routeId)` which filters by `tenantId`.
- `declareNodeCapability`, `updateNodeReachability` — `tenantId` is the
  first argument; the Node is fetched via `getNode(tenantId, nodeId)`.

Cross-tenant Route access is impossible via the service layer. The schema
further enforces this with `@@index([tenantId])` on Route, NodeCapability,
and NodeReachability.

---

## 12. Failure Model

### Route Failure Is Terminal

A Route's failure (`failed` status) is **terminal**. A failed Route is **NOT
retried**; a NEW Route is created instead (immutable after creation). This
preserves the FACT that a Route failed, alongside the FACT that a successor
Route was planned. Both are durable, auditable records.

### Expired Routes Cannot Become Active (R8)

Once a Route is `expired` (either because `expiresAt <= now` at activation
time, or via explicit `expireRoute`), it **cannot** become `active`. The
`activateRoute` operation rejects expired Routes with a `ValidationError`,
and `addRouteHop` rejects expired Routes for hop addition. The only valid
path forward is to create a NEW Route.

### NodeReachability Expiry: Stale Knowledge Is Re-checked

`NodeReachability.expiresAt` defines a TTL on reachability knowledge. After
`expiresAt`, the knowledge is stale. Callers MUST re-check reachability
before trusting `reachable = true`. The platform does NOT auto-delete stale
records; the record remains as a historical artifact (with its stale
`expiresAt`), and the caller is responsible for treating it as stale.

### RouteHop Failure Does NOT Cascade

A `RouteHop` failure does **NOT** cascade to other hops automatically. Each
hop has its own `status` (planned | active | completed | failed). Phase 14C
does NOT introduce hop-level transition operations beyond `addRouteHop` (the
hop is created in `planned`); hop-level failure is recorded as a fact by a
future execution layer, not propagated automatically. The platform preserves
the FACT of per-hop status, NOT a guarantee of cascading rollback.

### The Routing Substrate Preserves FACTS

The routing substrate preserves **FACTS** (planned, active, completed,
failed, expired) rather than making connectivity guarantees:

- A `planned` Route is a FACT: someone planned this path at this time with
  this expiry.
- An `active` Route is a FACT: the Route was activated at this time.
- A `completed` Route is a FACT: the Route reached its destination at this
  time.
- A `failed` Route is a FACT: the Route failed at this time.
- An `expired` Route is a FACT: the Route expired at this time.

The substrate does NOT guarantee that an `active` Route will be `completed`.
It does NOT guarantee that a `planned` Route will become `active`. It does
NOT guarantee that a `reachable` Node is currently reachable. It records
facts; future execution layers make guarantees (or, more honestly, record
their own facts).

---

## 13. Acceptance Gate

The Phase 14C acceptance criteria are grouped into four categories. ALL
criteria MUST pass for Phase 14C to be considered complete.

### Architecture

- Route abstraction exists at the service layer
  (`src/lib/services/routing.service.ts`).
- Route does NOT become transport — no transport address fields, no transport
  operations (`forwardBundle`, `sendPacket`, `openConnection`, `selectRadio`).
- Bundle identity remains immutable — Route creation does NOT modify any
  Bundle field (Phase 14B contract preserved).
- Node identity remains separate — Routing references Node identity; Node
  service does NOT import routing service (Phase 14A contract preserved).
- No future phases are implemented early — no transport, DTN forwarding,
  relay scheduling, bandwidth markets, marketplace, transforms, extensions,
  SDK, cloudlets, or TransitNet.

### Implementation

- Routing service exists (`src/lib/services/routing.service.ts`) with all
  allowed operations: `createRoutePlan`, `addRouteHop`, `getRoute`,
  `listRoutes`, `activateRoute`, `completeRoute`, `failRoute`,
  `expireRoute`, `declareNodeCapability`, `updateNodeReachability`.
- Route persistence exists (`model Route` in `prisma/schema.prisma`).
- RouteHop persistence exists (`model RouteHop` in `prisma/schema.prisma`).
- NodeCapability representation exists (`model NodeCapability` in
  `prisma/schema.prisma`).
- NodeReachability representation exists (`model NodeReachability` in
  `prisma/schema.prisma`).
- Audit events exist: `RoutePlanned`, `RouteActivated`, `RouteCompleted`,
  `RouteFailed`, `RouteExpired`, `RouteHopAdded` (in
  `src/lib/domain/audit.ts`).

### Testing

- Routing tests pass against Neon PostgreSQL (R1-R8: tenant isolation, Node
  lifecycle enforcement, concurrent route creation, concurrent hop
  convergence, expiry enforcement, lifecycle transitions, multi-route per
  Bundle, capability/reachability helpers).
- Phase 14C architecture contract tests pass
  (`tests/phase-14c-architecture-contract.test.ts`).
- Phase 13 architecture contract tests pass.
- Phase 14A architecture contract tests pass.
- Phase 14B architecture contract tests pass.

### Quality

- ESLint clean (0 errors).
- TypeScript clean except the known `baselineEngine` namespace issue at
  `src/lib/services/vpp.service.ts:820-822` (PRE-EXISTING, confirmed at
  commit `f614659`; not in scope for Phase 14C).
- Working tree clean (single descriptive commit).
- Push to `origin/main`.

---

## 14. Anti-Drift Rules

The following anti-drift rules are **enforced by tests**
(`tests/phase-14c-architecture-contract.test.ts`). They bind future phases
to the Phase 14C contract. Violation of any rule is an architectural defect
that MUST be corrected before merge.

1. **Route exists only in service/data layer.** The Route implementation
   lives at `src/lib/services/routing.service.ts` and `prisma/schema.prisma`.
   There MUST NOT be a `src/lib/kernel/route.ts` (no speculative kernel
   contract — Step 12 of Phase 14C, mirroring Phase 14A/14B service-layer
   placement).

2. **No kernel routing implementation exists.** No file under
   `src/lib/kernel/` imports routing primitives or implements forwarding.
   The kernel exposes no routing contract in Phase 14C.

3. **No transport implementation exists.** No file implements
   `forwardBundle`, `sendPacket`, `openConnection`, `selectRadio`, or any
   transport-layer operation. No file references IP/MAC/port in a routing
   context.

4. **Bundle remains immutable.** Route creation and Route lifecycle
   transitions do NOT modify any Bundle field
   (`id`, `payloadType`, `payloadHash`, `payloadRef`, `payloadBytesJson`,
   `sourceNodeId`, `destinationNodeId`, `priority`, `nonce`, `expiryTime`,
   `idempotencyKey`, `status`). The Phase 14B Bundle immutability guarantee
   is preserved.

5. **Routing does not import: protocol runtime, economic pipeline,
   marketplace, transforms.** `src/lib/services/routing.service.ts` does NOT
   import from `src/lib/services/protocol-runtime*`,
   `src/lib/services/economic*`, `src/lib/services/marketplace*`,
   `src/lib/services/transform*`, or any vertical service (`vpp`, `compute`,
   `storage`, `wireless`, `manufacturing`). The dependency direction is
   one-way: routing → node + data-plane.

6. **Node remains lower-level than routing.** `src/lib/services/node.service.ts`
   does NOT import `src/lib/services/routing.service.ts`. The dependency
   direction is: `routing.service.ts` → `node.service.ts` (routing imports
   node, never the reverse). This preserves the Phase 14A Node contract.

7. **DataPlane remains independent.** `src/lib/services/data-plane.service.ts`
   does NOT import `src/lib/services/routing.service.ts`. The dependency
   direction is: `routing.service.ts` → `data-plane.service.ts` (routing
   imports data-plane for `getBundle`, never the reverse). This preserves
   the Phase 14B Data Plane contract.

These rules are **normative and test-bound**. They ensure that future
phases (transport, DTN, marketplace, transforms, extensions) consume the
Phase 14C routing substrate as a stable foundation, rather than leaking
their concerns back into the routing layer.
