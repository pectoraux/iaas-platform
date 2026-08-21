# Phase 14F — Transform Record Foundation — Contract

> Status: FROZEN
> Date: Phase 14F
> Supersedes: "transform" operation placeholder in ARCHITECTURE-CONSTITUTION.md §8 (DATA PLANE performs: ...transform) and §9 (TRANSFORM BOUNDARY — partially)

---

## 1. Purpose

Phase 14F introduces **TransformRecord** — an immutable provenance record that a specific transform was applied to a Bundle's payload, producing an output. It is the **"transform chain"** from the Phase 13 dependency graph (`Bundle → Transform chain → Delivery`), made real as a durable record. It is the `transform` data-plane operation from ARCHITECTURE-CONSTITUTION.md §8, made real — but **only the provenance half** of it.

Phase 14F does **NOT** introduce:

- a **TransformRegistry** (catalog of available transforms — versioning, compatibility, certification, revocation),
- a **TransformRuntime** (execution engine that calls `execute()` / `reverse()` / `estimateCost()` / `verify()`),
- `execute` / `reverse` / `estimateCost` / `verify` operations,
- a marketplace, pricing, or settlement layer,
- an SDK, DTN custody transfer, or cryptographic signature scheme.

It introduces exactly one primitive: the **provenance record** that future transforms layers consume. The record IS the fact — it records that a transform happened, not how to execute it.

**Architectural rule (frozen):**

> The full Transform stack is three concepts: Transform + TransformRegistry + TransformRuntime. Phase 14F implements **only the smallest** — the provenance record — which unlocks the future TransformRegistry and TransformRuntime without building them. TransformRecord is to the Transform stack what DeliveryConfirmation (Phase 14E) is to the reliability stack: the durable fact on top of which future mechanics are built.

The record captures (constitution §9 Transform Provenance):

```
input hash + output hash + transform identity + transform version
+ parameters + node + result
```

— exactly the seven provenance elements from the constitution, persisted immutably.

---

## 2. Architectural Definition

TransformRecord is a **SERVICE-LAYER primitive**, implemented in `src/lib/services/transform-record.service.ts`. It is **NOT** a kernel contract. The kernel exposes the data-plane boundary (Phase 14B Bundle, Phase 14E DeliveryConfirmation); TransformRecord lives above the kernel data-plane services (`data-plane.service`, `node.service`) and consumes them **read-only** for validation.

TransformRecord is an **IMMUTABLE PROVENANCE RECORD** — it **IS** the transform fact. It is created once and never updated. The existence of the record means "this transform was applied to this Bundle's payload by this Node, producing this output, with this result." The record cannot be amended; corrections require a NEW TransformRecord under a different `idempotencyKey`.

TransformRecord is **distinct** from:

- **TransformRegistry** (future catalog): TransformRecord records that a transform happened; TransformRegistry catalogs which transforms may happen.
- **TransformRuntime** (future execution engine): TransformRecord records the input/output hashes and parameters; TransformRuntime performs the actual execution and verifies the hashes match.
- **Transform** (the abstract concept): Transform is the contract with `execute`/`reverse`/`estimateCost`/`verify` (constitution §9); TransformRecord is the provenance trail a Transform leaves behind.

TransformRecord is **not** a status mutation, **not** a flag on Bundle, **not** a coupling between Bundle and any delivery primitive. It is a separate, durable fact alongside the Bundle's lifecycle.

The record captures the seven constitution §9 provenance elements:

| Provenance element (constitution §9) | TransformRecord field |
|---|---|
| input hash | `inputHash` (SHA-256 of input payload) |
| output hash | `outputHash` (SHA-256 of output payload) |
| transform identity | `transformType` (generic string, e.g. `"compression"`, `"encryption_proxy"`) |
| transform version | `transformVersion` (semantic versioning string) |
| parameters | `parametersJson` (canonical JSON) |
| node / runtime | `nodeId` (optional FK — the Node that applied the transform) |
| result | `resultStatus` (`success` \| `failed`) + `resultMetadataJson` |

Resource cost (mentioned in constitution §9 as `resource cost`) is deferred to the future TransformRuntime, which would record it in `resultMetadataJson` if it tracks it. Phase 14F does not formalize a resource-cost field.

---

## 3. Architectural Ownership

TransformRecord is **service-layer only** (`src/lib/services/transform-record.service.ts`).

- **No kernel contract.** The kernel (`src/lib/kernel/*`) does not contain a transform primitive. TransformRecord is service-layer, like DeliveryConfirmation (Phase 14E).
- **No TransformRegistry.** The catalog of available transforms is a future phase; Phase 14F does not implement it. `transformType` is a generic string, not a registry reference.
- **No TransformRuntime.** The execution engine is a future phase; Phase 14F does not implement `execute` / `reverse` / `estimateCost` / `verify`.
- **The service imports only `getBundle`** (from `data-plane.service`) for Bundle validation, **and `getNode`** (from `node.service`) for Node validation — both **read-only**, no mutations.
- **No vertical imports.** The service does not import VPP / Compute / Storage / Wireless / TransitNet services. It is vertical-neutral.
- **No runtime imports.** The service does not import ProtocolRuntime / HybridRuntime / InfrastructureRuntime / economic pipeline. It is runtime-neutral.

This places TransformRecord squarely in the data-plane service tier alongside the Phase 14B–14E primitives, with the same dependency discipline: it reads the kernel data-plane substrate for validation and writes only its own immutable record.

---

## 4. Dependency Direction

```
Bundle
  ↓
TransformRecord (provenance)
  ↓
[future: TransformRegistry consumes records to catalog available transforms]
[future: TransformRuntime consumes records to verify execution]
[future: economic attribution consumes records for value accounting]
```

TransformRecord references **Bundle** (via `bundleId` FK, `onDelete: Cascade`) and **optionally Node** (via `nodeId` FK, `onDelete: SetNull`). It does **NOT** reference Route, TransportExecution, TransportAttempt, or DeliveryConfirmation — it sits **between Bundle and the delivery chain**, exactly as the Phase 13 dependency graph depicts.

```
Bundle  →  TransformRecord  →  [future delivery chain consumption]
Bundle  ✗→  TransformRegistry (future)
Bundle  ✗→  TransformRuntime (future)
TransformRecord  ✗→  Route
TransformRecord  ✗→  TransportExecution
TransformRecord  ✗→  TransportAttempt
TransformRecord  ✗→  DeliveryConfirmation
```

The dependency is one-directional: TransformRecord reads Bundle (and Node) for validation; Bundle does not read TransformRecord. The future TransformRegistry and TransformRuntime will read TransformRecord (to verify execution, attribute value, catalog history); they will not modify it.

---

## 5. Relationship to Node

TransformRecord **optionally** references Node via `nodeId` (FK to `Node`, named relation `"TransformRecordNode"`, `onDelete: SetNull`). The Node is **the Node that applied the transform**.

Constraints:

- The Node **must be active** if provided (T4 — `getNode` must succeed and `status === 'active'`). Inactive Nodes cannot apply transforms.
- The Node reference is **optional** because some transforms may be system-applied (e.g. a platform-level compression applied before routing, with no specific Node attributable). A null `nodeId` means "applied by the platform / unspecified actor."
- The relation is named (`"TransformRecordNode"`) to avoid colliding with other Node references on the same table or with other relations on Bundle / TransportAttempt / DeliveryConfirmation.

TransformRecord does **NOT** create or modify Nodes. Node remains the protocol endpoint identity boundary established in Phase 14A. TransformRecord reads Node identity; it never writes it. A future security layer may constrain `nodeId` to the Node that currently holds custody of the Bundle; Phase 14F does not enforce custody — it only validates that the Node exists and is active.

---

## 6. Relationship to Bundle

TransformRecord references **Bundle** via `bundleId` FK (`onDelete: Cascade`). It does **NOT** modify Bundle identity, payload, destination, expiry, priority, or status. The Bundle is read-only during record creation.

The `inputHash` links to the Bundle's `payloadHash` for integrity proof:

- `inputHash` is the SHA-256 of the input payload that was transformed.
- The Bundle's `payloadHash` is the SHA-256 of the Bundle's own payload.
- For a transform applied **directly to the Bundle payload**, `inputHash` SHOULD equal `bundle.payloadHash` — the service does NOT enforce this equality (Phase 14F records the caller's claim; verification is a future TransformRuntime concern). Phase 14F deliberately leaves this as a caller-asserted field to avoid premature coupling to a specific transform-chain model.

A Bundle **MAY** have multiple TransformRecords — a transform chain. For example:

```
Bundle (payloadHash = H0)
  → TransformRecord #1: compression, inputHash=H0, outputHash=H1
  → TransformRecord #2: encryption_proxy, inputHash=H1, outputHash=H2
  → TransformRecord #3: routing, inputHash=H2, outputHash=H3
  → [Delivery chain]
```

The schema permits N TransformRecords per Bundle. The chain ordering is implicit (by `createdAt`); a future phase may formalize ordered transform sequences with explicit ordering fields. Phase 14F does not model ordering — it records each transform as an independent provenance fact.

---

## 7. Relationship to Route

TransformRecord does **NOT** reference Route. It is **independent of the routing layer** (Phase 14C). Route remains immutable — TransformRecord does not modify Route identity, constraints, hops, or status.

The separation is architectural: routing decides where a Bundle goes; transformation records what happened to its payload. They are orthogonal concerns. A Bundle may be routed (Phase 14C) and transformed (Phase 14F) independently; the two records do not reference each other.

```
Route (Phase 14C)        TransformRecord (Phase 14F)
   ↓                          ↓
TransportExecution (14D)   Bundle (14B)
   ↓                          ↓
TransportAttempt (14D)    [independent fact]
   ↓
DeliveryConfirmation (14E)
```

---

## 8. Relationship to TransportExecution

TransformRecord does **NOT** reference TransportExecution or TransportAttempt. It is **independent of the transport execution layer** — it records transforms applied to the Bundle payload, not transport attempts.

This is a deliberate boundary: transport execution (Phase 14D) is "the Bundle moved from A to B"; transform provenance (Phase 14F) is "the Bundle's payload was transformed." They are separate facts about the same Bundle. A Bundle may be transformed without being transported (e.g. in-place compression at the origin), and a Bundle may be transported without being transformed (e.g. raw passthrough). The two layers do not depend on each other.

TransportExecution remains **immutable** from TransformRecord's perspective — TransformRecord does not modify execution state, status, or outcome. Conversely, TransportExecution does not consult TransformRecord; a future phase may couple them (e.g. "transport only after encryption transform completed"), but Phase 14F introduces no such coupling.

---

## 9. Relationship to TransportAdapter

**No relationship.** TransformRecord does not interact with TransportAdapter (the Phase 14D adapter abstraction that executes transport attempts).

- TransportAdapter **executes** transport attempts (the "how" of moving a Bundle).
- TransformRecord **records** transform provenance (the "what happened to the payload" fact).

They are separate concerns in separate layers. TransformAdapter belongs to the transport execution layer (Phase 14D); TransformRecord belongs to the transform provenance layer (Phase 14F). They do not import each other, reference each other, or share state.

A future TransformRuntime may itself use adapters (e.g. a compression adapter, an encryption adapter) to execute transforms and emit TransformRecords — but Phase 14F does not implement this. TransformRecord is the **output** of such a future runtime, not its consumer.

---

## 10. Lifecycle

TransformRecord has **NO lifecycle**. It is **IMMUTABLE**. It is created once; it is **never updated**.

There is no `status` field that transitions. The `resultStatus` field (`success` | `failed`) is set at creation and **never changed** — it records the transform result, **not a lifecycle state**. `resultStatus='failed'` is still a valid, durable record: it records that the transform was *attempted* and *failed* (e.g. compression error, encryption key unavailable). The provenance fact ("a transform was attempted and produced this result") is preserved regardless of success.

There is no `expired`, `revoked`, `superseded`, or `replayed` state. Once created, the record is permanent for the lifetime of the Bundle. When the Bundle is deleted (`onDelete: Cascade` from Bundle), the TransformRecord is removed with it — the record outlives only the transform event, not the Bundle. If `nodeId` is set and the Node is deleted, the record's `nodeId` becomes null (`onDelete: SetNull`) — the record survives, with the Node reference cleared.

Creation semantics:

- A duplicate record (same `(tenantId, bundleId, nodeId, transformType, idempotencyKey)`) returns the **existing** record — idempotent replay (see §14).
- `createdAt` is `@default(now())` — persisted, deterministic per-insert. It records when the transform was registered.
- `updatedAt` is `@updatedAt` for schema hygiene (Prisma convention); the service never calls `update()` on TransformRecord, so it is effectively immutable in practice. `updatedAt` is not a lifecycle signal — it is a schema invariant.

The service exposes `createTransformRecord`, `getTransformRecord`, `listTransformRecords`, and `computeTransformFingerprint` — there is **no** `updateTransformRecord` or `deleteTransformRecord`.

---

## 11. Invariants

1. **Immutability.** TransformRecord is never updated. The service exposes `createTransformRecord`, `getTransformRecord`, `listTransformRecords`, `computeTransformFingerprint` — there is no `updateTransformRecord` or `deleteTransformRecord`. Only created or read.
2. **Tenant isolation.** All queries filter by `tenantId`. The `@@index([tenantId])` and the `@@unique([tenantId, bundleId, nodeId, transformType, idempotencyKey])` enforce this at the data layer. The service accepts `tenantId` as its first argument on every function; it never trusts a `tenantId` from a request body.
3. **Node authorization.** If `nodeId` is provided, it must be an active Node in the tenant (T4 — `getNode` must succeed and `status === 'active'`). Inactive Nodes cannot apply transforms. A null `nodeId` is permitted (system-applied transform).
4. **Provenance completeness.** `inputHash` + `outputHash` + `transformType` + `transformVersion` + `parameters` are all required (the service throws `ValidationError` on missing `transformType`, `transformVersion`, `inputHash`, `outputHash`, or `idempotencyKey`). `parameters` defaults to `{}` (empty canonical JSON) if not provided.
5. **Idempotency.** Same `(tenantId, bundleId, nodeId, transformType, idempotencyKey)` → same record. Concurrent creations converge via `P2002` catch + re-read (see §14).
6. **No mutation of Bundle / Route / Node / TransportExecution / TransportAttempt / DeliveryConfirmation.** The service reads Bundle (via `getBundle`) and Node (via `getNode`) for validation; it never writes them. It does not import or write to Route, TransportExecution, TransportAttempt, or DeliveryConfirmation.

---

## 12. Security / Tenant Boundary

- **Tenant isolation (T1):** all queries filter by `tenantId`. The service accepts `tenantId` as its first argument on every function; it never trusts a `tenantId` from a request body. The `@@unique([tenantId, bundleId, nodeId, transformType, idempotencyKey])` and `@@index([tenantId])` enforce this at the data layer.
- **Node must be active if provided (T4):** `getNode(tenantId, nodeId)` must succeed and `status === 'active'`. Inactive Nodes cannot apply transforms. The error message is explicit: `Node ${nodeId} is ${node.status}; only active Nodes can apply transforms`.
- **No encryption / authentication in TransformRecord itself.** `inputHash` and `outputHash` are **integrity proofs** (SHA-256 of the input and output payloads), **not cryptographic signatures**. They prove the recorded input/output hashes match the actual payloads at audit time; they do not prove that the Node is who it claims to be, nor that the transform was correctly executed. A future security layer may add signatures.
- **The record is the security seam.** A future TransformRuntime may verify that the recorded `inputHash` → `outputHash` transition matches what the transform actually produces (i.e. re-execute and compare). TransformRecord provides the seam; it does not implement the verifier.
- **Bundle integrity linkage.** `inputHash` SHOULD equal `bundle.payloadHash` for a transform applied directly to the Bundle's payload, but the service does **NOT** enforce this equality in Phase 14F — the caller asserts the input hash. Verification is deferred to the future TransformRuntime.
- **`nodeId` deletion semantics.** `onDelete: SetNull` on the Node FK: if a Node is deleted, the TransformRecord survives with `nodeId = null`. This preserves the provenance fact even when the actor is later removed. A future security layer may constrain Node deletion to prevent provenance gaps; Phase 14F does not.

---

## 13. Failure Semantics

- **A failed record creation (e.g. inactive Node, missing required field) throws `ValidationError`** — no record is created, no audit event is emitted. The Bundle is not modified.
- **A conflict (same identity key, different request fingerprint) throws `ConflictError`** — idempotency conflict detection. This indicates the caller attempted to register a different transform under an already-used identity key. The existing record is **NOT** modified; the conflict is reported with `{ idempotencyKey, recordId }` metadata for caller reconciliation.
- **`NotFoundError`** is thrown when `getTransformRecord` cannot find the record in the tenant — tenant-scoped lookup failure.
- **The record does NOT fail the Bundle or any transport/delivery object.** It is a separate fact. A failed record creation does not roll back the Bundle; a successful record creation does not advance any delivery state. TransformRecord is **decoupled** from Bundle status, Route, TransportExecution, TransportAttempt, and DeliveryConfirmation status transitions.
- **`resultStatus='failed'` records that the transform itself failed** (e.g. compression error, encryption key unavailable, transform timed out). The record **still exists as a provenance fact** — the failure is part of the provenance trail, not a reason to suppress the record. A future reliability layer may consume failed records to drive retries; Phase 14F records the fact unconditionally.
- **Bundle expiry does NOT gate record creation.** A record may be created for an expired Bundle (the transform may have been applied before expiry, and the record is still a fact). Phase 14F does not enforce Bundle-expiry gating.

---

## 14. Idempotency / Concurrency

### Identity Key vs Request Fingerprint

Phase 14F distinguishes two concepts (mirroring the Phase 14E pattern):

- **Identity key** (the database uniqueness tuple): `(tenantId, bundleId, nodeIdentity, transformType, idempotencyKey)`. This is enforced by `@@unique([tenantId, bundleId, nodeIdentity, transformType, idempotencyKey])`. The `nodeIdentity` column is **NON-NULL** and uses **namespaced encoding** to be unambiguously disjoint from real Node IDs:
  - `node:<nodeId>` when a Node is specified (e.g. `node:cmt1u2w8c001ijx1otizncr5v`)
  - `system:__unattributed__` when no Node is attributable (system-applied transform)
  
  This corrects two issues from the initial Phase 14F implementation:
  1. PostgreSQL allows multiple NULL values in a UNIQUE constraint — the nullable `nodeId` in the old `@@unique` broke idempotency for system-applied records. `nodeIdentity` is non-null, so PostgreSQL enforces idempotency even for `nodeId = NULL`.
  2. The old sentinel `'__system__'` could theoretically collide with a future Node ID generator. The namespaced prefix (`node:` / `system:`) guarantees disjointness regardless of the Node ID format.

  The `nodeId` column remains `String?` (nullable FK to Node) — it records which Node applied the transform. `nodeIdentity` is the identity representation used in the unique constraint. The migration is **production-safe**: existing rows are backfilled (not deleted) — Node-backed rows get `node:<nodeId>`, system-applied rows get `system:__unattributed__`.

- **Request fingerprint** (`computeTransformFingerprint`): `SHA-256({bundleId, payloadHash, nodeIdentity, transformType, transformVersion, inputHash, outputHash, canonicalize(parameters), resultStatus, idempotencyKey})`. This is the material content of the record. It includes:
  - `nodeIdentity` (not `nodeId`) — the non-null identity representation.
  - `resultStatus` — MATERIAL (a success record and a failed record are different facts; same identity + different resultStatus → ConflictError).
  - `parameters` — canonicalized via recursive key sort so insertion-order differences do not produce different fingerprints.
  - It does **NOT** include `resultMetadata` — metadata is non-identity-bearing (observational).

### Idempotent Replay vs Idempotency Conflict

- **Idempotent replay:** same identity key + same fingerprint → return the existing record. The caller's request is materially identical to the prior request; the record already exists. No new record is created; no audit event is emitted.
- **Idempotency conflict:** same identity key + DIFFERENT fingerprint → throw `ConflictError`. The caller reused an identity key with a materially different request (e.g. different `transformVersion`, different `inputHash`/`outputHash`, different `resultStatus`, different `parameters` value). This cannot silently converge — the existing record is **NOT** returned, and no new record is created.
- **`resultMetadata` is non-identity-bearing:** the same identity key + same fingerprint but different `resultMetadata` → idempotent replay (returns the existing record). Metadata changes do NOT cause a conflict because metadata is NOT part of the fingerprint. This is a deliberate architectural choice: `resultMetadata` is observational (e.g. compression ratio, error code), not identity.
- **`resultStatus` IS material:** the same identity key + different `resultStatus` (success vs failed) → ConflictError. A success record and a failed record are different provenance facts. Re-attempting a failed transform requires a NEW `idempotencyKey`.

### P2002 Source Distinction

TransformRecord has **only ONE unique constraint** — the idempotency key `@@unique([tenantId, bundleId, nodeIdentity, transformType, idempotencyKey])`. There is no `@unique` on any single column (unlike DeliveryConfirmation's `transportAttemptId @unique`). Therefore:

- Any `P2002` is **unambiguously** an idempotency race — there is no second constraint to disambiguate.
- The handler catches `P2002`, re-reads by the identity key (using `nodeIdentity`), recomputes the fingerprint, and either returns the existing record (replay) or throws `ConflictError` (conflict).
- No `err.meta.target` inspection is required — the source is unambiguous. (The Phase 14E handler must inspect `err.meta.target` because of its two constraints; Phase 14F does not.)

### System-Applied Transforms (nodeId = null)

When `nodeId` is not provided (system-applied transform), the service computes `nodeIdentity = '__system__'`. This sentinel is a non-null string that participates in the `@@unique` constraint. PostgreSQL treats it as a regular value, so two concurrent system-applied records with the same `(tenantId, bundleId, '__system__', transformType, idempotencyKey)` will conflict → P2002 → idempotent convergence. This is the database invariant, not application timing.

### Canonical Parameter Serialization

Parameters are serialized via `canonicalize()` — a recursive key-sort function that produces deterministic JSON. `{a:1, b:2}` and `{b:2, a:1}` produce the same canonical string, so they produce the same fingerprint. This prevents false idempotency conflicts from JavaScript object key-insertion-order differences. The `canonicalize()` helper follows the same pattern as the module-private `canonicalize()` in `src/lib/control-plane/types.ts`; a local copy is introduced to avoid modifying the control-plane module (scope discipline).

### Convergence Under Concurrency

Two concurrent `createTransformRecord` calls with the same identity key + same fingerprint converge. The loser of the insert race receives a Prisma `P2002`; the service catches it, re-reads by the identity key, recomputes the fingerprint, and returns the existing record. This works for both Node-backed records (`nodeIdentity = nodeId`) and system-applied records (`nodeIdentity = '__system__'`).

### Fingerprint Computation

`computeTransformFingerprint` is a **single canonical derivation** — there is ONE function, used both at creation and at conflict check. The fingerprint is computed over a canonical JSON serialization of the material fields. The caller does not have access to this function (it is not exported); the service uses it internally to ensure consistency.

---

## 15. Future Extensions

Phase 14F is deliberately minimal. The following are **future extension points**, NOT Phase 14F deliverables:

- **TransformRegistry.** A future phase may catalog available transforms (`transformType` + `transformVersion` + `compatibility` + `certification` + `revocation`). TransformRecord is the **provenance** (a transform happened); TransformRegistry is the **catalog** (which transforms may happen). TransformRecord's `transformType` is a generic string precisely so the registry can be added later without breaking the provenance record — the registry will validate the string, not replace it.
- **TransformRuntime.** A future phase may implement `execute()` / `reverse()` / `estimateCost()` / `verify()`. TransformRecord records **that** a transform happened; TransformRuntime **executes** it. The runtime would consume the record's `inputHash` / `outputHash` to verify execution, and the `parameters` to re-execute. The runtime may emit TransformRecords as its provenance trail.
- **Economic attribution.** A future phase may consume TransformRecords to attribute economic value (e.g. pay-per-transform settlement, compute-credit accounting). The record's `nodeId` and `transformType` are the settlement inputs.
- **Cryptographic signatures.** A future security layer may add signer identity / signature to the record (e.g. sign the `inputHash` → `outputHash` transition with the Node's key). Phase 14F's `inputHash` / `outputHash` are integrity proofs, not signatures; the signature layer would extend, not replace, them.
- **Transform chains (ordered).** A future phase may formalize ordered transform sequences (multiple TransformRecords per Bundle, with explicit ordering). Phase 14F records each transform as an independent fact; ordering is implicit (by `createdAt`). The future phase may add an explicit `chainIndex` or `previousRecordId` field — non-breaking.
- **Bundle integrity linkage enforcement.** A future phase may enforce `inputHash === bundle.payloadHash` for the first transform in a chain. Phase 14F leaves this as caller-asserted to avoid premature coupling.
- **Resource cost accounting.** A future phase may formalize the constitution §9 `resource cost` element as a dedicated field. Phase 14F defers it to `resultMetadataJson`.
- **Automatic status flag coupling.** A future phase may automatically set a `transformed` flag on Bundle when a TransformRecord is created. Phase 14F does not couple TransformRecord to any status flag.

These extensions **consume** the Phase 14F contract; they do **NOT** modify it. The contract is FROZEN.

---

## 16. Explicit Non-goals

The following are **explicitly NOT implemented** in Phase 14F:

- **No TransformRegistry** (catalog — future phase).
- **No TransformRuntime** (execute / reverse / estimateCost / verify — future phase).
- **No marketplace / pricing / settlement** (future phase).
- **No SDK** (future phase).
- **No DTN / custody transfer** (future phase).
- **No cryptographic signatures** (future security layer — `inputHash` / `outputHash` are integrity proofs, not signatures).
- **No modification to Bundle, Route, Node, TransportExecution, TransportAttempt, or DeliveryConfirmation.**
- **No automatic coupling between TransformRecord and Bundle status flags.** Creating a TransformRecord does not mutate any status field on Bundle, Route, Node, TransportExecution, TransportAttempt, or DeliveryConfirmation in Phase 14F.
- **No transform chain ordering formalization** (future phase — Phase 14F records each transform as an independent fact).
- **No `inputHash === bundle.payloadHash` enforcement** (deferred to future TransformRuntime).
- **No resource cost field** (deferred to future — Phase 14F uses `resultMetadataJson`).
- **No TransitNet, Cloudlet, Local-first Internet implementations** (future phase).
- **No congestion control, radio selection, bandwidth marketplace** (future phase).

---

**End of Phase 14F Contract — FROZEN.**
