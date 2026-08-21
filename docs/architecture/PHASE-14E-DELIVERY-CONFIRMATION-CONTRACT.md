# Phase 14E — Delivery Confirmation Foundation — Contract

> Status: FROZEN
> Date: Phase 14E
> Supersedes: "acknowledge" operation placeholder in ARCHITECTURE-CONSTITUTION.md §8 (DATA PLANE performs: receive, store, route, forward, deliver, deduplicate, fragment, reassemble, expire, acknowledge, transform)

---

## 1. Purpose

Phase 14E introduces **DeliveryConfirmation** — a durable, immutable receipt that records receiver acknowledgment of a Bundle delivery or a TransportAttempt. It is the **`acknowledge`** data-plane operation from ARCHITECTURE-CONSTITUTION.md §8, made real.

Phase 14E does **not** introduce:

- a retransmission timer,
- a sliding window,
- custody transfer,
- a DTN forwarding implementation,
- a cryptographic signature scheme.

It introduces exactly one primitive: the **receipt** that future reliability layers consume. The receipt is a fact, not a status mutation.

**Architectural rule (frozen):**

> Phase 14B reserved the `acknowledged` delivery status; Phase 14D reserved the attempt `acknowledged` status. Phase 14E makes acknowledgment a durable receipt.

Phase 14B §17.8 stated: *"the `acknowledged` delivery status is reserved but not exercised in Phase 14B. A future receiver-acknowledgement layer will populate it."* Phase 14D §13 stated: *"Per-hop ACK/NACK, retransmission timers, sliding windows — future phase. Phase 14D records attempt outcomes; future phases may build reliability on top."* Phase 14E is that future receiver-acknowledgement layer — but only the **receipt** half of it. Reliability mechanics remain future.

The receipt records:

- **WHO** — `receiverNodeId`, the Node that issued the acknowledgment.
- **WHEN** — `confirmedAt`, deterministic and persisted.
- **WHAT** — `bundleId`, plus optional `transportAttemptId` (the specific attempt being confirmed).
- **PROOF** — `confirmationHash`, an integrity proof derived from the Bundle's `payloadHash` + `receiverNodeId` + `idempotencyKey`.

---

## 2. Architectural Definition

DeliveryConfirmation is a **service-layer primitive**, implemented in `src/lib/services/delivery-confirmation.service.ts`. It is **NOT** a kernel contract. The kernel exposes the data-plane boundary; this primitive lives above the kernel data-plane services (`data-plane.service`, `node.service`, `transport.service`) and consumes them read-only for validation.

DeliveryConfirmation is an **IMMUTABLE RECEIPT** — it **IS** the acknowledgment fact. It is created once and never updated. Metadata may be appended **only** by creating a NEW confirmation (a different `idempotencyKey`), never by mutating an existing row.

DeliveryConfirmation is **distinct** from the existing status flags:

- `TransportAttempt.acknowledged` is a **status flag** — it is **mutated** when an attempt is acknowledged.
- `BundleDelivery.acknowledged` is a **status flag** — reserved in Phase 14B §17.8, not exercised in 14B.
- `DeliveryConfirmation` is the **durable receipt layer** that sits on top of those flags. It does not replace them; it adds a fact.

The receipt captures:

| Field | Records |
|---|---|
| `receiverNodeId` | WHO — the Node that issued the acknowledgment |
| `confirmedAt` | WHEN — deterministic, persisted |
| `bundleId` (+ optional `transportAttemptId`) | WHAT — the Bundle (and optionally the specific attempt) being confirmed |
| `confirmationHash` | PROOF — integrity, derived from the Bundle's `payloadHash` |

---

## 3. Relationship to Node

DeliveryConfirmation references **Node identity** via `receiverNodeId` — the Node that issued the confirmation. The relation is `Node @relation("DeliveryConfirmationReceiver")` (a named relation, so it does not collide with other Node references such as `Bundle.destinationNodeId` or `TransportAttempt.toNodeId`).

Constraints:

- The receiver **must** be an active Node in the tenant (**D4** — `getNode` must succeed and `status === 'active'`).
- The receiver **must** be the Bundle's destination (**D5** — only the destination can confirm delivery; `bundle.destinationNodeId === input.receiverNodeId`).
- Transport does **NOT** create Nodes. Node remains the protocol endpoint identity boundary established in Phase 14A. DeliveryConfirmation reads Node identity; it never writes it.

---

## 4. Relationship to Bundle

DeliveryConfirmation references **Bundle** via `bundleId` FK (`onDelete: Cascade`). It does **NOT** modify Bundle identity, payload, destination, expiry, or status. The Bundle is read-only during confirmation creation.

The `confirmationHash` is derived from:

```
sha256(JSON.stringify({
  bundleId,
  payloadHash: bundle.payloadHash,
  receiverNodeId,
  idempotencyKey,
}))
```

This binds the receipt to **THIS specific Bundle content** — the receiver is acknowledging the bytes whose hash is `bundle.payloadHash`. Any tampering with the Bundle's payload would invalidate the hash on `verifyDeliveryConfirmation()`.

A Bundle **MAY** have multiple DeliveryConfirmations. Phase 14E is single-destination per Bundle (one `destinationNodeId`), so in practice each Bundle has at most one receiver that may confirm. However, the schema does not enforce a single confirmation per Bundle — it enforces a single confirmation per `(tenantId, bundleId, receiverNodeId, idempotencyKey)`. A future multi-recipient phase (see §13) may extend this without schema breakage.

---

## 5. Relationship to Route

DeliveryConfirmation does **NOT** directly reference Route. It references the Bundle (which has a Route) and optionally a TransportAttempt (which executes a Route). The Route is reachable transitively through those relations; it is never read or modified directly by the confirmation service.

Route remains **immutable** — DeliveryConfirmation does not modify Route identity, constraints, hops, or status.

---

## 6. Relationship to TransportExecution

DeliveryConfirmation does **NOT** reference TransportExecution directly. The granular fact is the TransportAttempt, not the execution; the confirmation links to an attempt (1:1 optional), and the attempt belongs to an execution. When the confirmation service validates a `transportAttemptId`, it traverses `attempt.execution` to verify tenant and Bundle ownership — but the execution itself is not the confirmation's reference.

TransportExecution remains **immutable** from the confirmation's perspective — DeliveryConfirmation does not modify execution state, status, or outcome.

---

## 7. Relationship to TransportAttempt

DeliveryConfirmation **optionally** links to a TransportAttempt via `transportAttemptId` (1:1: `@unique` on the column). The link is optional because:

- A Bundle may be confirmed even if no TransportAttempt was recorded (e.g. direct local delivery), and
- A Bundle may have multiple attempts but only the destination's confirmation matters as the durable receipt.

If `transportAttemptId` is provided:

- The attempt must belong to the same Bundle's execution (`attempt.execution.bundleId === input.bundleId`).
- The attempt's `toNodeId` must match the `receiverNodeId` (the receiver confirms the attempt that was addressed **to them**).

`TransportAttempt.acknowledged` is a **status flag** that is mutated when an attempt is acknowledged. DeliveryConfirmation does **NOT replace** that flag — it **ADDS** a durable receipt layer on top. A future phase may choose to mutate `TransportAttempt.acknowledged` when a DeliveryConfirmation is created for that attempt; Phase 14E does not do so automatically (the receipt is independent of the flag).

---

## 8. Lifecycle/State Model

DeliveryConfirmation has **NO lifecycle**. It is **immutable**. It is created once; it is never updated.

There is **no `status` field** on DeliveryConfirmation. The existence of the receipt **IS** the confirmation fact. A receipt that exists means "this receiver acknowledged this Bundle at this time with this proof."

Creation semantics:

- A duplicate confirmation (same `(tenantId, bundleId, receiverNodeId, idempotencyKey)`) returns the **existing** receipt — idempotent replay.
- `confirmedAt` is `@default(now())` — persisted, deterministic per-insert. It records when the confirmation was issued.
- `createdAt` and `updatedAt` exist for schema hygiene (Prisma convention); `updatedAt` is `@updatedAt` but the service never calls `update()` on DeliveryConfirmation, so it is effectively immutable in practice. The `updatedAt` field is not a lifecycle signal — it is a schema invariant.

There is no "expired," "revoked," or "superseded" state. Once issued, the receipt is permanent for the lifetime of the Bundle. When the Bundle is deleted (`onDelete: Cascade` from Bundle), the confirmation is removed with it — the receipt outlives only the attempt, not the Bundle.

---

## 9. Invariants

1. **Immutability.** DeliveryConfirmation is never updated. The service exposes `createDeliveryConfirmation`, `getDeliveryConfirmation`, `listDeliveryConfirmations`, and `verifyDeliveryConfirmation` — there is no `updateDeliveryConfirmation` or `deleteDeliveryConfirmation`. Only created or read.
2. **Tenant isolation.** All queries filter by `tenantId` (D1). The `@@index([tenantId])` and the `@@unique([tenantId, bundleId, receiverNodeId, idempotencyKey])` enforce this at the data layer.
3. **Receiver authorization.** The receiver must be (a) the Bundle's `destinationNodeId` (D5) and (b) an active Node in the tenant (D4).
4. **Integrity.** `confirmationHash` links the receipt to the specific Bundle content via `payloadHash`. `verifyDeliveryConfirmation()` recomputes the expected hash and compares — read-only.
5. **Idempotency.** Same `(tenantId, bundleId, receiverNodeId, idempotencyKey)` → same receipt. Concurrent creations converge via `P2002` catch + re-read (D6).
6. **No mutation of Bundle / Route / Node / TransportExecution / TransportAttempt.** The confirmation service reads these for validation; it never writes them.

---

## 10. Tenant/Security Boundary

- **Tenant isolation (D1):** all queries filter by `tenantId`. The service accepts `tenantId` as its first argument on every function; it never trusts a `tenantId` from a request body.
- **Receiver must be active (D4):** `getNode(tenantId, receiverNodeId)` must succeed and `status === 'active'`. Inactive Nodes cannot issue confirmations.
- **Receiver must be the destination (D5):** `bundle.destinationNodeId === receiverNodeId`. Only the destination can confirm delivery.
- **No encryption/authentication in DeliveryConfirmation itself.** The `confirmationHash` is an **integrity proof**, not a cryptographic signature. It is a deterministic SHA-256 over public fields (`bundleId`, `payloadHash`, `receiverNodeId`, `idempotencyKey`); it proves the receipt matches the Bundle content, not that the receiver is who they claim to be. **Future security/transform layers** may add signatures (see §13).
- **The receipt is the security seam.** Future reliability layers (retransmission, custody transfer, settlement) consume DeliveryConfirmation as proof-of-delivery. Phase 14E provides the seam; it does not implement the consumers.

---

## 11. Failure Semantics

- **A failed confirmation creation throws `ValidationError`** — e.g. wrong receiver (`receiverNodeId !== bundle.destinationNodeId`), inactive Node, attempt/Bundle mismatch. No receipt is created; no audit event is emitted.
- **A conflict (same identity key, different `confirmationHash`) throws `ConflictError`** — idempotency conflict detection. This indicates the caller attempted to register a different confirmation under an already-used identity key. The existing receipt is **not** modified; the conflict is reported.
- **The confirmation does NOT fail the TransportAttempt or TransportExecution.** It is a separate fact. A failed confirmation does not roll back the attempt; a successful confirmation does not advance the execution.
- **If the Bundle is expired, the confirmation is still permitted.** The receipt records that the receiver acknowledged, even if late — the fact is preserved. Phase 14E does not gate on Bundle expiry. A future reliability layer may use Bundle expiry to decide whether to accept a confirmation (e.g. for retransmission decisions); Phase 14E records the fact unconditionally.
- **`NotFoundError`** is thrown when `getDeliveryConfirmation` or `verifyDeliveryConfirmation` cannot find the receipt in the tenant — tenant-scoped lookup failure.

---

## 12. Idempotency/Concurrency Semantics

- **Identity:** DeliveryConfirmation's primary key is a `cuid` (immutable). The idempotent creation key is `(tenantId, bundleId, receiverNodeId, idempotencyKey)` — enforced by `@@unique([tenantId, bundleId, receiverNodeId, idempotencyKey])`.
- **Convergence under concurrency (D6):** two concurrent `createDeliveryConfirmation` calls with the same identity key converge. The loser of the insert race receives a Prisma `P2002` (unique constraint violation); the service catches it, re-reads the existing confirmation, and returns it.
- **Idempotency conflict detection:** if the loser's recomputed `confirmationHash` differs from the persisted one (same key, different Bundle content / receiver / proof), the service throws `ConflictError`. This is the "same key, different fact" failure mode — it cannot silently succeed.
- **`verifyDeliveryConfirmation()`** recomputes the expected hash from the current Bundle state and compares. It is **read-only** — no mutation. It returns `true` if the receipt matches the Bundle's current `payloadHash`, `false` otherwise. (If the Bundle's payload were ever mutated — which Phase 14E never does — verification would fail and surface the inconsistency.)

---

## 13. Future Extensions

Phase 14E is deliberately minimal. The following are **future extension points**, NOT Phase 14E deliverables:

- **Retransmission timers.** A future phase may consume DeliveryConfirmation to decide when to retransmit — if no confirmation arrives within a window, the Bundle is re-issued. The receipt is the input; the timer is the consumer.
- **Sliding windows.** A future phase may use confirmations to advance a sliding window over a sequence of Bundles. The receipt is the advance signal.
- **Custody transfer.** A future DTN phase may use confirmations as custody-transfer receipts — the moment a Node accepts custody, a DeliveryConfirmation is issued.
- **Cryptographic signatures.** A future security layer may add receiver signatures to the confirmation (e.g. sign the `confirmationHash` with the receiver's key). Phase 14E's `confirmationHash` is an integrity proof, not a signature; the signature layer would extend, not replace, it.
- **Multi-recipient delivery.** A future phase may support multiple receivers per Bundle (Phase 14E is single-destination). The schema already permits multiple confirmations per Bundle; the extension is the routing/delivery model, not the confirmation model.
- **Economic attribution.** A future phase may consume confirmations to attribute economic value (e.g. pay-per-delivery settlement). The receipt is the settlement input.
- **Automatic status flag mutation.** A future phase may automatically set `TransportAttempt.acknowledged` / `BundleDelivery.acknowledged` when a DeliveryConfirmation is created. Phase 14E does not do this; the receipt is independent of the flags.

These extensions **consume** the Phase 14E contract; they do **NOT** modify it. The contract is FROZEN.

---

## 14. Explicit Non-goals

The following are **explicitly NOT implemented** in Phase 14E:

- **No retransmission timers or sliding windows** (future phase).
- **No custody transfer or DTN forwarding** (future phase).
- **No congestion control, radio selection, bandwidth marketplace** (future phase).
- **No pricing, settlement, or marketplace** (future phase).
- **No SDK** (future phase).
- **No TransitNet, Cloudlet, Local-first Internet implementations** (future phase).
- **No cryptographic signatures** (future security layer — `confirmationHash` is an integrity proof, not a signature).
- **No modification to Bundle, Route, Node, TransportExecution, or TransportAttempt.**
- **No replacement of `TransportAttempt.acknowledged` or `BundleDelivery.acknowledged` status flags.** Those remain mutated status flags; DeliveryConfirmation adds a durable receipt on top.
- **No automatic coupling between the receipt and the status flags.** Creating a DeliveryConfirmation does not mutate `TransportAttempt.acknowledged` or `BundleDelivery.acknowledged` in Phase 14E.

---

## 15. Acceptance Gate

Phase 14E acceptance requires ALL of the following criteria to pass:

### Architecture

- DeliveryConfirmation exists as a service-layer primitive in `src/lib/services/delivery-confirmation.service.ts`.
- DeliveryConfirmation is immutable (no `update` / `delete` operations exposed by the service).
- DeliveryConfirmation does not modify Bundle, Route, Node, TransportExecution, or TransportAttempt.
- No future phases are implemented early (no retransmission, no sliding windows, no custody transfer, no signatures, no marketplace, no SDK).

### Implementation

- `delivery-confirmation.service.ts` exists with `createDeliveryConfirmation`, `getDeliveryConfirmation`, `listDeliveryConfirmations`, `verifyDeliveryConfirmation`.
- DeliveryConfirmation persistence exists in `prisma/schema.prisma` (the `DeliveryConfirmation` model).
- `confirmationHash` integrity proof exists and is verified by `verifyDeliveryConfirmation`.
- `DeliveryConfirmationCreated` audit event exists in `src/lib/domain/audit.ts`.

### Testing

- D1–D8 (Phase 14E delivery-confirmation functional tests) pass against Neon PostgreSQL.
- Phase 14E architecture contract tests pass (see §16).
- Phase 13 / 14A / 14B / 14C / 14D contracts continue to pass (no regression).

### Quality

- ESLint clean.
- TypeScript clean except the known `baselineEngine` pre-existing issue.
- Working tree clean (no stray changes).
- Single descriptive commit (e.g. `Phase 14E: Delivery Confirmation Foundation — immutable receipt primitive`).
- Pushed to `origin/main`.

---

## 16. Anti-Drift Rules (enforced by `tests/phase-14e-architecture-contract.test.ts`)

The following invariants are enforced statically by the Phase 14E architecture contract test suite. A regression in any rule fails the build.

1. **DeliveryConfirmation exists as a service-layer primitive.** `src/lib/services/delivery-confirmation.service.ts` exists and exports `createDeliveryConfirmation`, `getDeliveryConfirmation`, `listDeliveryConfirmations`, `verifyDeliveryConfirmation`.
2. **No kernel delivery primitive exists.** The kernel (`src/lib/kernel/*`) does not contain a delivery-confirmation or acknowledge primitive. The receipt is service-layer only.
3. **DeliveryConfirmation does not import routing/transport internals.** It imports only `getBundle` (from `data-plane.service`) and `getNode` (from `node.service`) for validation; it does not import `route.service`, `transport.service` internals, or any vertical service.
4. **DeliveryConfirmation does not implement network protocols.** No TCP/UDP/HTTP/DTN/bundle-protocol code in the confirmation service.
5. **DeliveryConfirmation does not modify Bundle.** No `db.bundle.update` / `db.bundle.delete` calls in `delivery-confirmation.service.ts`.
6. **DeliveryConfirmation does not modify Route.** No `db.route.*` write calls in `delivery-confirmation.service.ts`.
7. **DeliveryConfirmation does not modify Node.** No `db.node.update` / `db.node.delete` calls in `delivery-confirmation.service.ts`.
8. **DeliveryConfirmation does not modify TransportExecution or TransportAttempt.** No `db.transportExecution.*` / `db.transportAttempt.update` / `db.transportAttempt.delete` calls in `delivery-confirmation.service.ts`. (Read of `transportAttempt.findUnique` for validation is permitted.)
9. **No retransmission / timer / sliding-window implementation exists.** No `setTimeout` / `setInterval` / `retry` / `window` / `ack-timeout` primitives in the confirmation service.
10. **No DTN / custody-transfer implementation exists.** No custody, spray, epidemic, store-carry-forward algorithms in the confirmation service.
11. **No marketplace / pricing / settlement exists.** No pricing, settlement, or marketplace references in the confirmation service.
12. **No SDK exists.** No `sdk/` directory, no client SDK package, no SDK exports for delivery confirmation.

---

**End of Phase 14E Contract — FROZEN.**
