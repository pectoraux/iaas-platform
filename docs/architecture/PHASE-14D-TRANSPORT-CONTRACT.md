# Phase 14D — Transport Execution Foundation — Contract

> Status: FROZEN
> Date: Phase 14D
> Supersedes: Transport execution portion of ARCHITECTURE-CONSTITUTION.md §8 (future transport)

This document is the authoritative contract for the Transport Execution
substrate introduced in Phase 14D. It defines what TransportExecution IS, what
it is NOT, how it relates to the Bundle (Phase 14B), Route (Phase 14C), and
Node (Phase 14A) primitives, the adapter boundary that future network
implementations plug into, the attempt and capability models, lifecycle and
failure semantics, idempotency, security boundary, what is explicitly NOT
implemented, future extension points, the Phase 14D acceptance gate, and the
anti-drift rules binding future phases.

All implementation MUST conform to this document. Changes require explicit
architectural review. The constitution (`ARCHITECTURE-CONSTITUTION.md`) remains
the higher-order source of truth; this document operationalizes the transport
execution portion of constitution §8 ("DATA PLANE BOUNDARY (contract — NOT YET
IMPLEMENTED)") by introducing the minimal generic transport execution
abstraction that allows Routes and Bundles to be executed by future network
implementations, without implementing any actual network protocol.

Source of truth for the implementation:

- `prisma/schema.prisma` — `model TransportExecution` (line 2402),
  `model TransportAttempt` (line 2440), `model TransportCapability`
  (line 2475).
- `src/lib/services/transport.service.ts` — transport service-layer lifecycle
  (`createTransportExecution`, `getTransportExecution`,
  `listTransportExecutions`, `startTransportExecution`,
  `completeTransportExecution`, `failTransportExecution`,
  `cancelTransportExecution`, `createTransportAttempt`, `markAttemptSent`,
  `acknowledgeAttempt`, `failAttempt`, `declareTransportCapability`,
  `listTransportCapabilities`).
- `src/lib/kernel/adapters/transport-adapter.ts` — the kernel `TransportAdapter`
  interface + `MockTransportAdapter` (the boundary future networks implement).
- `src/lib/domain/audit.ts` — Transport audit events
  (`TransportExecutionCreated`, `TransportExecutionStarted`,
  `TransportExecutionCompleted`, `TransportExecutionFailed`,
  `TransportExecutionCancelled`, `TransportAttemptCreated`,
  `TransportAttemptAcknowledged`, `TransportAttemptFailed`).
- `src/lib/services/node.service.ts` — Node identity validation (Phase 14A).
- `src/lib/services/data-plane.service.ts` — Bundle identity validation
  (Phase 14B).
- `src/lib/services/routing.service.ts` — Route identity validation
  (Phase 14C).
- `tests/phase-14d-architecture-contract.test.ts` — anti-drift enforcement.

---

## 1. Purpose

### What Phase 14D Introduces

Phase 14D introduces the **minimal generic transport execution abstraction**
that allows Routes and Bundles to be executed by future network
implementations, without implementing any actual network protocol.

Phase 14D introduces four primitives:

- **TransportExecution** — the durable record of an attempt to move a Bundle
  along a Route. Service-layer primitive, immutable identity, deterministic
  idempotency.
- **TransportAttempt** — an individual transport attempt within an execution.
  An execution may have multiple attempts (retries), append-only ordering.
- **TransportCapability** — a Node's transport capability declaration.
  Generic, NOT transport-protocol-specific.
- **TransportAdapter** — the kernel interface future network implementations
  plug into. A `MockTransportAdapter` proves the contract is usable without
  making any network calls.

### What Phase 14D Is NOT

Phase 14D is **NOT**:

- **NOT a network.** There is no TCP/UDP/Bluetooth/WiFi/LoRa/satellite. No
  sockets, no packets, no bytes are moved.
- **NOT a network protocol.** There is no congestion control, no
  retransmission timer, no sliding window, no MTU negotiation.
- **NOT a forwarding engine.** The platform does not execute
  `forwardBundle()`, `sendPacket()`, `openConnection()`, `selectRadio()`.
- **NOT a DTN.** There is no custody transfer, no spray routing, no epidemic
  forwarding, no store-carry-forward algorithm.
- **NOT a TransitNet.** There is no vehicle-to-vehicle implementation.
- **NOT a cloudlet.** There is no edge relay implementation.
- **NOT a Local-first Internet.** There is no local-first delivery
  implementation.
- **NOT an adapter marketplace.** There is no provider discovery, no pricing,
  no settlement, no SLA negotiation.
- **NOT an SDK.** There is no external developer API.

### The FINAL RULE

> Routing decides where a Bundle should go. Transport executes the attempt.
> Networks implement adapters later. Do not build the network. Build the
> execution primitive that allows networks to exist.

This rule is normative. Every design choice below flows from it. The output of
Phase 14D is not connectivity. It is the execution primitive that allows future
networks to exist.

---

## 2. Transport Definition

### TransportExecution Is a SERVICE-LAYER Primitive

`TransportExecution` is a **SERVICE-LAYER primitive**
(`src/lib/services/transport.service.ts`), NOT a kernel contract. There is no
`src/lib/kernel/transport-execution.ts`. The service layer is the only place
where the `TransportExecution` lifecycle is implemented.

### TransportAdapter Is a KERNEL INTERFACE

`TransportAdapter` IS a **KERNEL INTERFACE**
(`src/lib/kernel/adapters/transport-adapter.ts`). This is the boundary that
future network implementations (DTN, TransitNet, Cloudlet, Local-first
Internet) plug into. Phase 14D exposes the `TransportAdapter` interface and a
`MockTransportAdapter` implementation; it does NOT introduce any real network
adapter.

### DISTINCTION from InfrastructureAdapter

`TransportAdapter` (Phase 14D) is **distinct** from `InfrastructureAdapter`
(Phase 4):

| Adapter | Phase | Domain | Methods |
|---|---|---|---|
| `InfrastructureAdapter` | Phase 4 | Physical infrastructure execution | `discover`, `readTelemetry`, `execute`, `health` on assets (batteries, GPUs, storage) |
| `TransportAdapter` | Phase 14D | Data-plane transport execution | `executeTransportAttempt`, `getCapabilities`, `validate` on Bundles along Routes |

The two adapters do NOT overlap. The InfrastructureAdapter acts on physical
assets (telemetry, execute, health). The TransportAdapter acts on data-plane
transport attempts (move Bundles along Routes). A future implementation MAY
compose both, but the contracts remain separate.

### Records Execution STATE, Not Network Behavior

Transport records **execution STATE**, not network behavior. The transport
substrate does NOT:

- open sockets, send packets, or move bytes;
- perform congestion control;
- maintain retransmission timers;
- select radios or links;
- measure bandwidth or latency;
- negotiate transport-layer parameters.

It records FACTS: an execution was created, started, completed, failed, or
cancelled; an attempt was created, sent, acknowledged, or failed. These are
durable, auditable facts. The connectivity that produced them is a future
adapter's concern.

---

## 3. Relationship to Bundle

### TransportExecution References Bundle

`TransportExecution` references `Bundle` via a `bundleId` foreign key
(`prisma/schema.prisma` line 2406). The reference is read-only: the
TransportExecution **does NOT modify Bundle identity, payload, or destination**
(T2). Specifically, the following Bundle fields remain unchanged by any
transport operation:

- `id`, `payloadType`, `payloadHash`, `payloadRef`, `payloadBytesJson`
- `sourceNodeId`, `destinationNodeId`
- `priority`, `nonce`, `expiryTime`
- `idempotencyKey`, `status`, `createdAt`, `updatedAt`

The Phase 14B Bundle immutability guarantee is preserved.

### A Bundle MAY Have Multiple TransportExecutions

A Bundle MAY have multiple TransportExecutions. Retries, re-routes, and
successor executions produce **NEW** TransportExecutions, each with its own
immutable `id` and its own audit trail. The old executions are NOT mutated;
they retain their original `id`, `status`, `failureReason`, and audit trail.
This is the immutable-after-creation principle: a failed execution is a FACT
(audit `transport.execution_failed`); a successor execution is another FACT
(audit `transport.execution_created`).

### Bundle Remains Immutable

The Bundle is a separate execution artifact. TransportExecution **attaches**
execution information to the Bundle via the `bundleId` FK; it does NOT redefine
the Bundle. The Bundle identity, payload, and destination remain stable across
the entire transport lifecycle.

---

## 4. Relationship to Route

### TransportExecution References Route

`TransportExecution` references `Route` via a `routeId` foreign key
(`prisma/schema.prisma` line 2405). The reference is read-only: the
TransportExecution **does NOT modify Route** (T3). The Route's `id`,
`bundleId`, `sourceNodeId`, `destinationNodeId`, `expiresAt`, hops, and
lifecycle status (`planned | active | completed | failed | expired`) remain
unchanged by any transport operation.

The Phase 14C Route immutability guarantee is preserved.

### Bundle Must Match the Route's BundleId

At `createTransportExecution` time, the service performs a **consistency
check**: the supplied `bundleId` MUST match the Route's `bundleId`. If they do
not match, the service raises `ValidationError` and no execution is created.
This prevents an execution from being attached to an inconsistent (Bundle,
Route) pair. The check is enforced in `transport.service.ts`
`createTransportExecution`:

```ts
if (route.bundleId !== input.bundleId) {
  throw new ValidationError(
    `Bundle ${input.bundleId} does not match Route ${input.routeId}'s bundle ${route.bundleId}`,
  )
}
```

### Route Remains Immutable

`TransportExecution` **executes** the planned path; it does NOT redefine it.
The Route remains the authoritative plan; the TransportExecution is the
authoritative execution record. Route revision (creating a NEW Route for the
same Bundle) is a Phase 14C concern and is NOT performed by the transport
service.

---

## 5. Relationship to Node

### TransportAttempt References Node Identity

`TransportAttempt` references Node identity via `fromNodeId` and `toNodeId`
foreign keys (`prisma/schema.prisma` lines 2443-2444). These are the **hop
endpoints**: the source Node and the destination Node of the hop being
attempted.

A `TransportAttempt` is per-hop. A multi-hop Route produces multiple attempts
(one per hop), each with its own `(fromNodeId, toNodeId)` pair.

### Node Lifecycle Enforcement

The transport service enforces **Node lifecycle** at attempt creation:

- `createTransportAttempt` fetches `fromNode = getNode(tenantId, fromNodeId)`
  and `toNode = getNode(tenantId, toNodeId)`.
- Both Nodes MUST have `status === 'active'`. A suspended or revoked Node
  cannot be a transport endpoint. The service raises `ValidationError`
  otherwise:
  ```
  From Node <id> is <status>; only active Nodes can be transport endpoints
  To Node <id> is <status>; only active Nodes can be transport endpoints
  ```
- `createTransportAttempt` also rejects `fromNodeId === toNodeId` (a hop must
  traverse two distinct Nodes).

### Transport Does NOT Create Nodes

`TransportExecution` and `TransportAttempt` do NOT create Nodes (T8). The
Node remains the protocol endpoint identity boundary (Phase 14A contract).
The dependency direction is one-way: `transport.service.ts` →
`node.service.ts` (transport imports node, never the reverse). The Phase 14A
Node contract is preserved.

---

## 6. Execution Lifecycle

### States

A `TransportExecution` has the following states:

```
created → started → completed | failed | cancelled
```

- **`created`** — initial state. The execution was created (audit
  `transport.execution_created`) but has not yet started. The execution is
  NOT in progress.
- **`started`** — the execution is in progress (audit
  `transport.execution_started`). Attempts may be created, sent,
  acknowledged, or failed within this state.
- **`completed`** — the execution successfully completed (audit
  `transport.execution_completed`). **Terminal.** `completedAt` is set.
- **`failed`** — the execution failed (audit `transport.execution_failed`).
  **Terminal.** `completedAt` is set; `failureReason` is recorded.
- **`cancelled`** — the execution was cancelled (audit
  `transport.execution_cancelled`). **Terminal.** `cancelledAt` is set.

### Lifecycle Enforcement (T4)

The transport service enforces lifecycle transitions (T4):

- `created → started` — valid. `startTransportExecution` requires
  `status === 'created'`.
- `started → completed` — valid. `completeTransportExecution` requires
  `status === 'started'`.
- `started → failed` — valid. `failTransportExecution` requires
  `status === 'started'` and a `failureReason` argument.
- `created | started → cancelled` — valid. `cancelTransportExecution`
  rejects any execution whose status is `completed`, `failed`, or
  `cancelled` (terminal).
- `completed → started` — **INVALID.** Terminal states cannot transition
  back. `startTransportExecution` raises `ValidationError` if
  `status !== 'created'`.
- `failed → started` — **INVALID.** Terminal states cannot transition back.
  The recovery path is to create a NEW execution (T5).

### Failed Is Recoverable (T5)

A `failed` execution is **terminal**, but failure is **recoverable** (T5).
Recovery is NOT a transition back to `started`; recovery is the creation of a
NEW `TransportExecution` (with a new immutable `id`, a new audit trail, and a
new `attemptNumber`). The old `failed` execution is preserved as a FACT.

---

## 7. Attempt Model

### TransportAttempt: An Individual Transport Attempt Within an Execution

A `TransportAttempt` is an **individual transport attempt** within an
execution. An execution MAY have multiple attempts (retries). Attempts are
recorded as separate durable rows, NOT as a counter on the execution.

### Deterministic Ordering (T7)

Attempts maintain **deterministic ordering** via `attemptNumber` (1-based,
scoped to `executionId`, with `@@unique([executionId, attemptNumber])`). Under
concurrency, `attemptNumber` is allocated via `count + 1` with P2002 catch +
retry (up to 3 times), so two concurrent attempts NEVER share the same
`attemptNumber`. The transport service queries attempts with
`orderBy: { createdAt: 'asc' }` when returning an execution; the
`attemptNumber` field provides the deterministic, concurrency-safe ordering.
The `createdAt` timestamp is informational only — it is NOT the primary
ordering key because same-millisecond concurrent inserts can collide.

### Each Attempt References the Hop Endpoints

Each attempt references `fromNodeId` + `toNodeId` (the hop being attempted).
A multi-hop Route produces multiple attempts per execution; each attempt
records the specific hop it tried to traverse. The attempt is the granular
FACT: "on this execution, at this time, we tried to move the Bundle from
Node A to Node B."

### Attempt Lifecycle

A `TransportAttempt` has the following lifecycle:

```
created → sent → acknowledged | failed
```

**Strict transitions (adversarial audit correction):**

- `created → acknowledged` is **REJECTED** — an attempt MUST go through `sent`
  first (the adapter must be invoked before the attempt can be acknowledged).
- `created → failed` is **REJECTED** — an attempt MUST be `sent` before it can
  fail (an unsent attempt cannot fail because nothing was attempted yet).
- `acknowledged → sent` is **REJECTED** — `acknowledged` is terminal.
- `acknowledged → failed` is **REJECTED** — `acknowledged` is terminal.
- `failed → sent` is **REJECTED** — `failed` is terminal.
- `failed → acknowledged` is **REJECTED** — `failed` is terminal.

- **`created`** — the attempt was created (audit
  `transport.attempt_created`) but not yet sent.
- **`sent`** — the attempt was handed off to the transport adapter (audit
  implied; `markAttemptSent` or `executeAttemptViaAdapter` transitions
  `created → sent`).
- **`acknowledged`** — the attempt was acknowledged by the destination
  (audit `transport.attempt_acknowledged`). **Terminal.** `completedAt` is
  set. Only reachable from `sent`.
- **`failed`** — the attempt failed (audit `transport.attempt_failed`).
  **Terminal.** `completedAt` is set; `errorCode` is recorded. Only
  reachable from `sent`.

### A Failed Attempt Does NOT Fail the Execution (T5)

A `failAttempt` operation marks a single attempt as `failed` and records an
`errorCode`. It does **NOT** transition the execution to `failed` (T5). The
execution can create ANOTHER attempt (`createTransportAttempt`) and try
again. The execution transitions to `failed` only via explicit
`failTransportExecution`, which is a separate, deliberate decision by the
caller (typically after exhausting retries).

This separation preserves the FACT of an attempt failure alongside the FACT
of an execution failure. A failed attempt is a per-hop FACT; a failed
execution is a whole-execution FACT.

---

## 8. Capability Model

### TransportCapability: Node Capability Declaration for Transport

`TransportCapability` is a **node capability declaration for transport**. It
is similar to `NodeCapability` (Phase 14C, which declares routing-oriented
capabilities like `CAN_STORE_BUNDLE | CAN_FORWARD_BUNDLE | CAN_RECEIVE_BUNDLE`)
but **transport-oriented**.

### Allowed Capabilities (Generic, NOT Transport-Protocol-Specific)

The allowed capabilities are **generic**, NOT transport-protocol-specific:

```
STORE_AND_FORWARD    — the Node can durably store and forward Bundles.
BUNDLE_TRANSFER      — the Node can transfer Bundles to another Node.
TRANSPORT_EXECUTION  — the Node can execute transport attempts.
generic              — open namespace for future generic capabilities.
```

### NOT Allowed (Future Adapter Details)

The following are **NOT allowed** as `TransportCapability` values — they are
future adapter implementation details that belong inside the adapter, not in
the generic capability declaration:

```
WIFI | BLUETOOTH | LTE | SATELLITE | TCP | UDP | QUIC
```

A future phase MAY define protocol-specific capability surfaces; Phase 14D
deliberately does not. The capability remains generic so that the substrate
remains network-agnostic.

### Capability Isolation (T8)

`TransportCapability` is a **declaration**, NOT network ownership,
bandwidth, pricing, or connectivity (T8). It carries:

- no price, no SLA, no capacity reservation, no availability window;
- no bandwidth number, no latency number, no radio identifier;
- no connectivity proof — declaring `STORE_AND_FORWARD` does NOT prove the
  Node can currently store and forward, only that it declares the
  capability.

Future marketplace layers MAY consume this declaration, but Phase 14D does
NOT introduce a marketplace.

### Idempotent Declaration

`declareTransportCapability` is **idempotent**: the same `(nodeId, capability)`
pair resolves to the same declaration. The Prisma schema enforces this via
`@@unique([nodeId, capability])`. The service implementation performs a
find-or-create:

```ts
const existing = await db.transportCapability.findUnique({
  where: { nodeId_capability: { nodeId, capability } },
})
if (existing) return existing
return db.transportCapability.create({ ... })
```

A Node MAY have multiple capability declarations (one per capability). The
`status` field (`active | suspended | revoked`) records the declaration
lifecycle; Phase 14D creates declarations as `active` and does not
transition them.

---

## 9. Adapter Boundary

### TransportAdapter Interface

The `TransportAdapter` interface
(`src/lib/kernel/adapters/transport-adapter.ts`) exposes exactly three
methods:

- **`executeTransportAttempt(input: TransportAttemptInput): Promise<TransportAttemptResult>`**
  — attempt to move the Bundle from `fromNodeId` to `toNodeId` for the
  given execution. Returns a result (`success`, `status`, `errorCode?`,
  `metadata?`); does NOT throw on transport failure.
- **`getCapabilities(): Promise<TransportAdapterCapabilities>`** — return
  the generic capabilities this adapter supports
  (`STORE_AND_FORWARD | BUNDLE_TRANSFER | TRANSPORT_EXECUTION`, plus
  `adapterType` and `supportsCancellation`).
- **`validate(input: TransportAttemptInput): Promise<boolean>`** —
  pre-flight check: can this adapter attempt this transport? Does NOT
  execute the attempt.

### The `TransportAttemptInput` Is Transport-Neutral

`TransportAttemptInput` is **transport-neutral**: it carries only
`executionId`, `bundleId`, `routeId`, `fromNodeId`, `toNodeId`, and
`attemptNumber`. There are NO TCP/UDP/Bluetooth/WiFi/satellite fields, NO
IP/MAC/port, NO radio, NO congestion-window, NO socket handles. The input
is the same shape regardless of which adapter executes it.

### The `TransportAttemptResult` Does NOT Throw on Failure

`executeTransportAttempt` returns a `TransportAttemptResult`
(`{ success, status, errorCode?, metadata? }`). It does **NOT throw** on
transport failure. A failed transport returns
`{ success: false, status: 'failed', errorCode: '...' }`. The caller
records the attempt and decides whether to retry. This is the failure
semantics contract (§10).

### Future Network Implementations Implement This

Future network implementations implement `TransportAdapter`:

- **`DTNTransportAdapter`** — store-carry-forward (future phase).
- **`TransitNetTransportAdapter`** — vehicle-to-vehicle (future phase).
- **`CloudletTransportAdapter`** — edge relay (future phase).
- **`LocalInternetTransportAdapter`** — local-first delivery (future phase).

Phase 14D does NOT implement any of these. They are listed here as future
extension points (§13).

### MockTransportAdapter

`MockTransportAdapter` is a **null/mock implementation** for Phase 14D. It
always succeeds (or always fails if constructed with `{ failMode: true }`).
It makes NO TCP/UDP/sockets/network calls — it records execution STATE
only. Its purpose is to prove the contract is usable, not to provide real
connectivity.

### The Adapter Is Wired (Not Dead Code)

**Adversarial audit correction:** the `TransportAdapter` is NOT dead code.
`transport.service.ts` imports the `TransportAdapter` contract and
`MockTransportAdapter`, and exposes `registerTransportAdapter()` /
`getTransportAdapter()`. The service invokes the adapter via
`executeAttemptViaAdapter()`, which:
1. transitions the attempt `created → sent`,
2. calls `adapter.executeTransportAttempt(input)`,
3. transitions the attempt to `acknowledged` or `failed` based on the result.

The dependency direction `Bundle → Route → TransportExecution →
TransportAdapter` is therefore REAL, not aspirational. Future network
implementations call `registerTransportAdapter(myAdapter)` to plug in.

### The Adapter NEVER

The `TransportAdapter` contract explicitly forbids the adapter from:

- **making routing decisions** — routing is Phase 14C; the adapter receives
  an already-decided hop and executes it;
- **modifying Bundle identity/payload (T2)** — the adapter receives
  `bundleId` as a reference; it MUST NOT modify the Bundle;
- **modifying Route (T3)** — the adapter receives `routeId` as a reference;
  it MUST NOT modify the Route;
- **creating Nodes (T8)** — the adapter receives `fromNodeId` /
  `toNodeId` as references; it MUST NOT create or modify Nodes;
- **touching the economic kernel** — economics is a separate substrate;
  the adapter has no economic responsibility and MUST NOT call into
  `economic*` services, the ledger, or settlement;
- **becoming a network protocol** — the adapter is a contract boundary,
  not a protocol specification.

---

## 10. Failure Semantics

### Transport Failure Is Recoverable (T5)

Transport failure is **recoverable**: a `failed` execution can be succeeded
by a NEW execution (with a new `id`, new audit trail). Recovery is NOT a
transition back to `started`; recovery is creation. The old `failed`
execution is preserved as a durable FACT.

### A Failed Attempt Does NOT Cascade to the Execution

A failed `TransportAttempt` does **NOT** cascade to the execution. The
`failAttempt` operation marks a single attempt as `failed` and records an
`errorCode`; the execution's `status` is unchanged. The execution can create
ANOTHER attempt (`createTransportAttempt`) and try again. Only an explicit
`failTransportExecution` transitions the execution to `failed` — this is a
caller decision, typically after exhausting retries.

### Terminal States Cannot Transition Back (T4)

The terminal states (`completed`, `failed`, `cancelled`) **cannot
transition back** (T4). The service enforces this:

- `startTransportExecution` rejects any execution whose `status !== 'created'`.
- `completeTransportExecution` rejects any execution whose
  `status !== 'started'`.
- `failTransportExecution` rejects any execution whose
  `status !== 'started'`.
- `cancelTransportExecution` rejects any execution whose `status` is
  terminal (`completed | failed | cancelled`).

A terminal execution's only valid successor is a NEW execution.

### The Transport Substrate Preserves FACTS

The transport substrate preserves **FACTS** (`created`, `started`,
`completed`, `failed`, `cancelled`) rather than making connectivity
guarantees:

- A `created` execution is a FACT: someone requested transport at this time.
- A `started` execution is a FACT: transport began at this time.
- A `completed` execution is a FACT: transport completed at this time.
- A `failed` execution is a FACT: transport failed at this time, for this
  reason.
- A `cancelled` execution is a FACT: transport was cancelled at this time.

The substrate does NOT guarantee that a `started` execution will be
`completed`. It does NOT guarantee that a `created` execution will become
`started`. It records facts; future adapters make guarantees (or, more
honestly, record their own facts).

### `executeTransportAttempt` Returns a Result, Does NOT Throw

`executeTransportAttempt` returns a `TransportAttemptResult`
(`{ success, status, errorCode?, metadata? }`). It does **NOT throw** on
transport failure. The caller (typically the transport service or a future
execution orchestrator) records the attempt via `markAttemptSent`,
`acknowledgeAttempt`, or `failAttempt`, and decides whether to retry. This
separation keeps transport failure inside the result channel, not the
exception channel — failure is a normal outcome, not an abnormal one.

---

## 11. Idempotency

### TransportExecution Identity

`TransportExecution` identity is a **cuid** (`@id @default(cuid())`). It is:

- **Immutable** — the `id` never changes after creation.
- **Random** — the `id` is NOT derived from the Route, Bundle, or any
  user-supplied key.

### Idempotent Creation via Deterministic Key

Idempotent creation is achieved via a **deterministic key**:
`(tenantId, routeId, bundleId, idempotencyKey)`. The Prisma schema enforces
this via
`@@unique([tenantId, routeId, bundleId, idempotencyKey])`
(`prisma/schema.prisma` line 2423). Two calls with the same tuple resolve
to the same durable execution.

### Concurrent Calls Converge (T6)

Concurrent `createTransportExecution` calls converge (T6) via the
`P2002`-catch-and-re-read pattern:

```ts
try {
  const execution = await db.transportExecution.create({ data: { ... } })
  await appendAudit({ ... })
  return execution
} catch (err) {
  if (isPrismaUniqueConstraintError(err)) {
    const existing = await db.transportExecution.findFirst({
      where: { tenantId, routeId, bundleId, idempotencyKey },
    })
    if (!existing) throw err
    return existing  // idempotent replay
  }
  throw err
}
```

The loser of the insert race re-reads the winner's row and returns it as
the idempotent result. No duplicate audit events; no duplicate executions;
no caller-visible error.

### TransportCapability Declaration Is Idempotent

`TransportCapability` declaration is idempotent: the same
`(nodeId, capability)` pair resolves to the same declaration. The Prisma
schema enforces `@@unique([nodeId, capability])`. The service performs
find-or-create. Re-declaring an existing capability is a no-op.

---

## 12. Security Boundary

### Transport References Node Identity

`TransportAttempt` references Node identity via `fromNodeId` and `toNodeId`.
Both Nodes are validated against the tenant (via `getNode(tenantId, ...)`)
and against lifecycle (`status === 'active'`) at attempt creation time
(§5). A suspended or revoked Node cannot be a transport endpoint.

### TransportCapability Declares Transport Capabilities

`TransportCapability` declares transport capabilities — **NOT** network
ownership, bandwidth, pricing, or connectivity (T8). The declaration is
knowledge ("this Node declares it can do X"), not proof. Future security
layers MAY consume this declaration; Phase 14D does not introduce them.

### No Encryption/Authentication in TransportExecution

There is **no encryption or authentication** in the `TransportExecution`
primitive. The execution does NOT carry:

- payload encryption keys,
- per-hop authentication tokens,
- transport-layer security parameters,
- MAC or signature material for transport integrity.

Security belongs in future transform/security layers (Phase 9 contract
boundary, Phase 14B security/integrity boundary). The `TransportExecution`
references Node identity (validated) and capability declarations
(knowledge); it does NOT become a security boundary.

### Tenant Isolation (T1)

All transport queries filter by `tenantId` (T1). This is enforced at every
service operation:

- `createTransportExecution` — `tenantId` is the first argument; the Route
  and Bundle lookups are scoped via `getRoute(tenantId, ...)` and
  `getBundle(tenantId, ...)`.
- `getTransportExecution`, `listTransportExecutions`,
  `startTransportExecution`, `completeTransportExecution`,
  `failTransportExecution`, `cancelTransportExecution` — `tenantId` is the
  first argument; the execution is fetched via
  `getTransportExecution(tenantId, executionId)` which filters by
  `tenantId`.
- `createTransportAttempt`, `markAttemptSent`, `acknowledgeAttempt`,
  `failAttempt` — `tenantId` is the first argument; the execution is
  fetched via `getTransportExecution(tenantId, ...)` and the attempt is
  verified to belong to a tenant-scoped execution.
- `declareTransportCapability`, `listTransportCapabilities` — `tenantId`
  is the first argument; the Node is fetched via
  `getNode(tenantId, nodeId)`.

Cross-tenant transport access is impossible via the service layer. The
schema further enforces this with `@@index([tenantId])` on
`TransportExecution` and `TransportCapability`.

### The Adapter Boundary Is the Security Seam

The `TransportAdapter` boundary is the **security seam**: future network
implementations are responsible for their own transport security. The
adapter contract is transport-neutral; it does not specify encryption,
authentication, or integrity. A real adapter (DTN, TransitNet, Cloudlet,
Local-first Internet) MUST define its own security model. Phase 14D's
`MockTransportAdapter` makes no security claims because it makes no
network calls.

---

## 13. Future Extensions

Phase 14D is deliberately minimal. The following are **future extension
points**, NOT Phase 14D deliverables:

- **`DTNTransportAdapter`** — store-carry-forward (future phase). Custody
  transfer, spray routing, epidemic forwarding, store-carry-forward
  algorithms. The Phase 14D `TransportCapability` value
  `STORE_AND_FORWARD` is the hook; the adapter is the implementation.
- **`TransitNetTransportAdapter`** — vehicle-to-vehicle (future phase).
  Vehicle mobility, opportunistic contact, inter-vehicle bundle relay.
- **`CloudletTransportAdapter`** — edge relay (future phase). Edge compute
  nodes as transport relays; cloudlet handoff.
- **`LocalInternetTransportAdapter`** — local-first delivery (future
  phase). Local-first connectivity, peer-to-peer delivery.
- **Adapter marketplace** — provider discovery, pricing, settlement
  (future phase — NOT in 14D). The `TransportCapability` declaration is
  the hook; the marketplace is the consumer.
- **Congestion control / routing algorithms requiring telemetry** —
  future phase. Phase 14D records facts; future phases may consume them
  to drive algorithms.
- **Per-hop ACK/NACK, retransmission timers, sliding windows** — future
  phase. Phase 14D records attempt outcomes; future phases may build
  reliability on top.

These extensions consume the Phase 14D contract; they do NOT modify it. The
contract is FROZEN.

---

## 14. Explicit Non-goals

The following are **explicitly NOT implemented** in Phase 14D (Step 5):

- **DTN.** No custody transfer, no spray routing, no epidemic forwarding,
  no store-carry-forward algorithms. The `STORE_AND_FORWARD` capability is
  a declaration hook, not an algorithm.
- **Real networking.** No UDP, no WebRTC, no QUIC, no Bluetooth, no WiFi
  Direct, no LoRa, no satellite. No sockets, no packets, no bytes moved.
- **Adapter marketplace.** No provider discovery, no pricing, no
  settlement, no SLA negotiation, no capacity reservation.
- **SDK.** No external developer API. The `TransportAdapter` interface is
  internal; future SDK layers MAY expose it, but Phase 14D does not.
- **TransitNet.** No vehicle-to-vehicle implementation.
- **Congestion control / routing algorithms requiring production network
  telemetry.** No congestion window, no retransmission timer, no sliding
  window, no MTU negotiation.
- **Radio selection, bandwidth marketplace.** No radio identifier, no
  bandwidth number, no bandwidth trading.

Any of these introduced in Phase 14D would violate the FINAL RULE.

---

## 15. Acceptance Gate

The Phase 14D acceptance criteria are grouped into four categories. ALL
criteria MUST pass for Phase 14D to be considered complete.

### Architecture

- TransportExecution exists as a service-layer primitive
  (`src/lib/services/transport.service.ts`).
- Transport does NOT become a network protocol — no TCP/UDP/QUIC/Bluetooth/
  WiFi/LoRa/satellite, no sockets, no packets, no bytes moved.
- Bundle identity remains immutable (T2) — transport operations do NOT
  modify any Bundle field (Phase 14B contract preserved).
- Route remains immutable (T3) — transport operations do NOT modify any
  Route field (Phase 14C contract preserved).
- Node identity remains separate (T8) — transport references Node identity;
  Node service does NOT import transport service (Phase 14A contract
  preserved).
- No future phases are implemented early — no DTN forwarding, no TransitNet,
  no cloudlet, no Local-first Internet, no adapter marketplace, no
  transforms, no extensions, no SDK.

### Implementation

- Transport service exists (`src/lib/services/transport.service.ts`) with
  all allowed operations: `createTransportExecution`,
  `getTransportExecution`, `listTransportExecutions`,
  `startTransportExecution`, `completeTransportExecution`,
  `failTransportExecution`, `cancelTransportExecution`,
  `createTransportAttempt`, `markAttemptSent`, `acknowledgeAttempt`,
  `failAttempt`, `declareTransportCapability`,
  `listTransportCapabilities`.
- TransportExecution persistence exists (`model TransportExecution` in
  `prisma/schema.prisma`).
- TransportAttempt persistence exists (`model TransportAttempt` in
  `prisma/schema.prisma`).
- TransportCapability persistence exists (`model TransportCapability` in
  `prisma/schema.prisma`).
- TransportAdapter interface exists
  (`src/lib/kernel/adapters/transport-adapter.ts`).
- MockTransportAdapter exists
  (`src/lib/kernel/adapters/transport-adapter.ts`).
- Audit events exist: `TransportExecutionCreated`,
  `TransportExecutionStarted`, `TransportExecutionCompleted`,
  `TransportExecutionFailed`, `TransportExecutionCancelled`,
  `TransportAttemptCreated`, `TransportAttemptAcknowledged`,
  `TransportAttemptFailed` (in `src/lib/domain/audit.ts`).

### Testing

- Transport tests pass against Neon PostgreSQL (T1-T8: tenant isolation,
  Bundle immutability, Route immutability, lifecycle enforcement, failure
  recovery, idempotency convergence, attempt ordering, capability
  isolation, no Node creation).
- Architecture contract tests pass
  (`tests/phase-14d-architecture-contract.test.ts`) — 12 anti-drift rules.
- Phase 13 architecture contract tests pass.
- Phase 14A architecture contract tests pass.
- Phase 14B architecture contract tests pass.
- Phase 14C architecture contract tests pass.

### Quality

- ESLint clean (0 errors).
- TypeScript clean except the known `baselineEngine` namespace issue at
  `src/lib/services/vpp.service.ts:820-822` (PRE-EXISTING, confirmed at
  commit `f614659`; not in scope for Phase 14D).
- Working tree clean (single descriptive commit).
- Push to `origin/main`.

---

## 16. Anti-Drift Rules

The following anti-drift rules are **enforced by tests**
(`tests/phase-14d-architecture-contract.test.ts`). They bind future phases
to the Phase 14D contract. Violation of any rule is an architectural defect
that MUST be corrected before merge.

1. **Transport exists.** The TransportExecution implementation lives at
   `src/lib/services/transport.service.ts` and `prisma/schema.prisma`
   (`model TransportExecution`, `model TransportAttempt`,
   `model TransportCapability`). The `TransportAdapter` interface lives at
   `src/lib/kernel/adapters/transport-adapter.ts`.

2. **Transport is service-layer.** `TransportExecution` is a service-layer
   primitive. There MUST NOT be a `src/lib/kernel/transport-execution.ts`
   (no speculative kernel contract beyond the `TransportAdapter`
   interface). The kernel exposes the adapter boundary; the service owns
   the execution lifecycle.

3. **No kernel transport primitive exists beyond the TransportAdapter
   interface.** No file under `src/lib/kernel/` implements transport
   execution, transport state, or transport forwarding. The
   `TransportAdapter` interface and `MockTransportAdapter` are the only
   transport artifacts under `src/lib/kernel/`.

4. **Transport does not import routing internals.**
   `src/lib/services/transport.service.ts` imports
   `src/lib/services/routing.service.ts` only for `getRoute` (Route
   identity validation). It does NOT import routing internals, routing
   algorithms, or routing state. The dependency direction is one-way:
   transport → routing (for `getRoute` only). Routing does NOT import
   transport.

5. **Transport does not implement network protocols.** No file under
   `src/lib/` implements TCP, UDP, QUIC, Bluetooth, WiFi, WiFi Direct,
   LoRa, satellite, WebRTC, sockets, packets, congestion control,
   retransmission timers, sliding windows, or MTU negotiation. The
   `MockTransportAdapter` makes no network calls.

6. **Transport does not modify Bundle.** Transport operations
   (`createTransportExecution`, `startTransportExecution`,
   `completeTransportExecution`, `failTransportExecution`,
   `cancelTransportExecution`, `createTransportAttempt`, `markAttemptSent`,
   `acknowledgeAttempt`, `failAttempt`) do NOT modify any Bundle field
   (`id`, `payloadType`, `payloadHash`, `payloadRef`, `payloadBytesJson`,
   `sourceNodeId`, `destinationNodeId`, `priority`, `nonce`, `expiryTime`,
   `idempotencyKey`, `status`). The Phase 14B Bundle immutability guarantee
   is preserved.

7. **Transport does not modify Route.** Transport operations do NOT modify
   any Route field (`id`, `bundleId`, `sourceNodeId`, `destinationNodeId`,
   `expiresAt`, `status`, hops). The Phase 14C Route immutability guarantee
   is preserved.

8. **Transport does not create Nodes.** Transport operations reference
   Node identity via `fromNodeId` / `toNodeId` foreign keys; they do NOT
   call `node.service.ts` mutation operations (`registerNode`,
   `activateNode`, `suspendNode`, `revokeNode`, `joinNetwork`,
   `leaveNetwork`). The dependency direction is one-way:
   `transport.service.ts` → `node.service.ts` (for `getNode` only). Node
   remains the protocol endpoint identity boundary (Phase 14A contract).

9. **Transport capability remains generic.** The `TransportCapability`
   values remain in the generic set
   (`STORE_AND_FORWARD | BUNDLE_TRANSFER | TRANSPORT_EXECUTION | generic`).
   No transport-protocol-specific values (`WIFI | BLUETOOTH | LTE |
   SATELLITE | TCP | UDP | QUIC`) are introduced. The capability is a
   declaration, NOT network ownership/bandwidth/pricing/connectivity.

10. **No DTN implementation exists.** No file implements custody transfer,
    spray routing, epidemic forwarding, or store-carry-forward algorithms.
    The `STORE_AND_FORWARD` capability is a declaration hook; the DTN
    adapter is a future extension point.

11. **No adapter marketplace exists.** No file implements provider
    discovery, pricing, settlement, SLA negotiation, or capacity
    reservation for transport adapters. The adapter marketplace is a
    future extension point.

12. **No SDK exposure exists.** No file under `src/sdk/`, no exported
    external developer API, no public surface for transport execution.
    The `TransportAdapter` interface is internal; future SDK layers MAY
    expose it, but Phase 14D does not.

These rules are **normative and test-bound**. They ensure that future
phases (DTN, TransitNet, Cloudlet, Local-first Internet, marketplace,
transforms, extensions, SDK) consume the Phase 14D transport execution
substrate as a stable foundation, rather than leaking their concerns back
into the transport layer.
