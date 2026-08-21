# Phase 13R — Architecture Reconciliation

> Status: FROZEN
> Date: Phase 13R
> Authority: This document is a formal constitutional amendment record.

## 1. Purpose

The Phase 13 Architecture Constitution explicitly classified several concepts
as "NOT YET IMPLEMENTED" or "FUTURE." Subsequent phases (14A through 14F)
implemented those concepts. However, the per-phase contracts unilaterally
declared themselves as "superseding" the Constitution without a formal
amendment process.

The Constitution states: "Changes require explicit architectural review."

This document constitutes that formal architectural review. It explicitly
admits the Phase 14A-F implementations into the constitutional architecture,
classifies each by code compatibility and architectural status, and defines
which constitutional amendments are required.

This is NOT a relabeling exercise. It is a governance reconciliation.

---

## 2. Reconciliation Matrix

### Phase 14A — Node

| Dimension | Classification | Evidence |
|-----------|---------------|----------|
| **Code Compatibility** | CONFORMING | `model Node` implements exactly what Constitution §1 describes: "A protocol participant. Distinct from Asset/Device." Identity boundaries preserved: `Asset ≠ Device ≠ Node ≠ ParticipantIdentity ≠ ResourceIdentity`. Node is tenant-scoped, optionally backed by Device/ParticipantIdentity/ResourceIdentity. No vertical imports. |
| **Architectural Status** | NOT YET CONSTITUTIONALLY ADMITTED → NOW ADMITTED | Constitution §1 line 45 says "Node (FUTURE — not yet implemented)." Phase 14A implemented it. This reconciliation formally admits Node into the constitutional architecture. |
| **Governance Finding** | The Phase 14A contract unilaterally claimed to "supersede" the Constitution's Node placeholder. The Constitution does not authorize per-phase contracts to supersede it. This reconciliation retroactively authorizes the Phase 14A implementation by explicit architectural review. |

**Constitutional Amendment Required:** §1 line 45 must change from "FUTURE — not yet implemented" to "IMPLEMENTED (Phase 14A)."

### Phase 14A — NodeNetworkMembership

| Dimension | Classification | Evidence |
|-----------|---------------|----------|
| **Code Compatibility** | CONFORMING | Follows the established ParticipantMembership pattern (network-scoped, lifecycle). Distinct from NetworkResourceMembership. Network Scope Integrity enforced via `assertNetworkScopeIntegrity`. |
| **Architectural Status** | NOT YET CONSTITUTIONALLY ADMITTED → NOW ADMITTED | The Constitution did not explicitly list NodeNetworkMembership, but the dependency graph shows "NetworkMembership (participation)" below Node. This is the correct companion to Node. |
| **Governance Finding** | Implicitly authorized by the Node contract. Formally admitted by this reconciliation. |

**Constitutional Amendment Required:** §1 should note NodeNetworkMembership as the Node's network-scoped participation model (analogous to ParticipantMembership).

### Phase 14A — NodeAgent

| Dimension | Classification | Evidence |
|-----------|---------------|----------|
| **Code Compatibility** | N/A (not implemented) | Correctly deferred per YAGNI. The Phase 14A contract documents the decision: no evidence requires it. |
| **Architectural Status** | EXPLICITLY FUTURE | The dependency graph shows NodeAgent between Device and Node. It remains future. |

**No amendment required.**

### Phase 14B — Bundle + BundleDelivery

| Dimension | Classification | Evidence |
|-----------|---------------|----------|
| **Code Compatibility** | CONFORMING | `model Bundle` implements the Constitution §8 Bundle contract: immutable identity, source/destination, creation/expiry, priority, payload reference, payload type, integrity (payloadHash), deduplication (@@unique + P2002). `model BundleDelivery` implements delivery records (append-only, idempotent). The "Transform chain" attribute is deferred to Phase 14F (TransformRecord). "Routing constraints" deferred to Phase 14C (Route). No vertical imports. |
| **Architectural Status** | NOT YET CONSTITUTIONALLY ADMITTED → NOW ADMITTED | Constitution §8 line 317 says "Bundle (contract — NOT YET IMPLEMENTED)." Phase 14B implemented it. This reconciliation formally admits Bundle. |
| **Governance Finding** | The Phase 14B contract unilaterally claimed to "supersede" the Constitution's Bundle placeholder. This reconciliation retroactively authorizes it. |

**Constitutional Amendment Required:** §8 line 317 must change from "contract — NOT YET IMPLEMENTED" to "IMPLEMENTED (Phase 14B)."

### Phase 14B — DataPlane (service)

| Dimension | Classification | Evidence |
|-----------|---------------|----------|
| **Code Compatibility** | CONFORMING | `data-plane.service.ts` implements: receive (createBundle), store (BundleDelivery), deliver (deliverBundle), expire (expireBundle, expiry enforcement), deduplicate (@@unique + P2002). No vertical imports. No economic pipeline imports. |
| **Architectural Status** | NOT YET CONSTITUTIONALLY ADMITTED → NOW ADMITTED | Gap Matrix lists "DataPlane — MISSING." Phase 14B implemented it as a service-layer primitive. This reconciliation formally admits it. |
| **Governance Finding** | The Constitution §8 says "DATA PLANE BOUNDARY (contract — NOT YET IMPLEMENTED)." The data-plane is now partially implemented (receive/store/deliver/expire/deduplicate). Route, forward, acknowledge, transform are implemented in 14C-F. Fragmentation, reassembly remain future. |

**Constitutional Amendment Required:** §8 header must change from "NOT YET IMPLEMENTED" to "PARTIALLY IMPLEMENTED (Phase 14B-F)."

### Phase 14C — Route + RouteHop + NodeCapability + NodeReachability

| Dimension | Classification | Evidence |
|-----------|---------------|----------|
| **Code Compatibility** | CONFORMING | `model Route` implements planned path (planned → active → completed/failed/expired). `model RouteHop` implements ordered hops with @@unique([routeId, sequence]). `model NodeCapability` is a generic declaration (CAN_STORE_BUNDLE etc.), not a marketplace. `model NodeReachability` is knowledge (reachable, lastSeen, expiresAt), not physical proof. No vertical imports. |
| **Architectural Status** | NOT YET CONSTITUTIONALLY ADMITTED → NOW ADMITTED | The Constitution §8 lists "route" as a data-plane operation. The dependency graph shows "Data Plane Contracts (receive, store, route, forward, deliver)." Route was not explicitly listed in the Gap Matrix but is implied by the data-plane operations. |
| **Governance Finding** | Route implements the "route" data-plane operation from Constitution §8. Formally admitted by this reconciliation. |

**Constitutional Amendment Required:** §8 data-plane operations should note "route" is now implemented (Phase 14C).

### Phase 14D — TransportExecution + TransportAttempt + TransportCapability + TransportAdapter

| Dimension | Classification | Evidence |
|-----------|---------------|----------|
| **Code Compatibility** | CONFORMING | `model TransportExecution` implements the "forward" data-plane operation with lifecycle (created → started → completed/failed/cancelled). `model TransportAttempt` implements per-hop attempts with deterministic attemptNumber (@@unique). `TransportAdapter` is a kernel contract interface in `kernel/adapters/` (same pattern as InfrastructureAdapter). `MockTransportAdapter` has no network calls. Transport service is wired to the adapter (real execution path). No vertical imports. |
| **Architectural Status** | NOT YET CONSTITUTIONALLY ADMITTED → NOW ADMITTED | Constitution §8 lists "forward" as a data-plane operation. The TransportAdapter interface is authorized by §8: "The kernel exposes contracts/enforcement boundaries." |
| **Governance Finding** | The Constitution says the kernel "exposes contracts/enforcement boundaries" — TransportAdapter is a contract interface, not a networking stack. This is constitutionally authorized. |

**Constitutional Amendment Required:** §8 data-plane operations should note "forward" is now implemented (Phase 14D). TransportAdapter is a kernel contract (§8 authorized).

### Phase 14E — DeliveryConfirmation

| Dimension | Classification | Evidence |
|-----------|---------------|----------|
| **Code Compatibility** | CONFORMING | `model DeliveryConfirmation` implements the "acknowledge" data-plane operation as an immutable receipt. Identity: @@unique([tenantId, bundleId, receiverNodeId, idempotencyKey]). Fingerprint: confirmationHash includes transportAttemptId + payloadHash. P2002 source distinction handles dual constraints. No vertical imports. |
| **Architectural Status** | NOT YET CONSTITUTIONALLY ADMITTED → NOW ADMITTED | Constitution §8 lists "acknowledge" as a data-plane operation. The dependency graph shows "Bundle → Transform chain → Delivery" — DeliveryConfirmation is the "Delivery" receipt. |
| **Governance Finding** | Formally admitted by this reconciliation. |

**Constitutional Amendment Required:** §8 data-plane operations should note "acknowledge" is now implemented (Phase 14E).

### Phase 14F — TransformRecord

| Dimension | Classification | Evidence |
|-----------|---------------|----------|
| **Code Compatibility** | CONFORMING | `model TransformRecord` implements Constitution §9 Transform Provenance: "input hash + output hash + transform identity + transform version + parameters + node/runtime + resource cost + result." Does NOT implement execute/reverse/estimateCost/verify (those are TransformRuntime — future). Does NOT implement a catalog (TransformRegistry — future). `nodeIdentity` uses namespaced encoding (node:`<id>` / system:__unattributed__). Fingerprint includes resultStatus + canonical parameters. No vertical imports. |
| **Architectural Status** | NOT YET CONSTITUTIONALLY ADMITTED → NOW ADMITTED | Constitution §9 says "TRANSFORM BOUNDARY (contract — NOT YET IMPLEMENTED)." Phase 14F implements the provenance record portion only. TransformRegistry and TransformRuntime remain future. |
| **Governance Finding** | The Phase 14F contract claimed to "supersede" the Constitution's Transform placeholder. This is partially correct — TransformRecord (provenance) is admitted, but TransformRegistry and TransformRuntime remain future. |

**Constitutional Amendment Required:** §9 must change from "NOT YET IMPLEMENTED" to "PARTIALLY IMPLEMENTED (Phase 14F: TransformRecord provenance). TransformRegistry and TransformRuntime remain future."

---

## 3. Concepts Now Officially Admitted

The following Phase 14 primitives are formally admitted into the constitutional architecture by this reconciliation:

| Primitive | Phase | Constitution Section | Data-Plane Operation |
|-----------|-------|---------------------|---------------------|
| Node | 14A | §1 (Identity) | — |
| NodeNetworkMembership | 14A | §1 (Identity) | — |
| Bundle | 14B | §8 (Data Plane) | receive, store, deliver, expire, deduplicate |
| BundleDelivery | 14B | §8 (Data Plane) | deliver (at-least-once + idempotent) |
| DataPlane service | 14B | §8 (Data Plane) | receive, store, deliver, expire |
| Route | 14C | §8 (Data Plane) | route |
| RouteHop | 14C | §8 (Data Plane) | route (ordered hops) |
| NodeCapability | 14C | §8 (Data Plane) | capability declaration |
| NodeReachability | 14C | §8 (Data Plane) | reachability knowledge |
| TransportExecution | 14D | §8 (Data Plane) | forward |
| TransportAttempt | 14D | §8 (Data Plane) | forward (per-hop attempts) |
| TransportCapability | 14D | §8 (Data Plane) | transport capability declaration |
| TransportAdapter | 14D | §8 (Data Plane) | kernel contract boundary |
| DeliveryConfirmation | 14E | §8 (Data Plane) | acknowledge |
| TransformRecord | 14F | §9 (Transform) | transform (provenance only) |

---

## 4. Concepts Remaining Future

The following concepts remain explicitly future and are NOT admitted by this reconciliation:

| Concept | Constitution Section | Status | Reason |
|---------|---------------------|--------|--------|
| NodeAgent | Dep Graph | EXPLICITLY FUTURE | No evidence requires it (YAGNI). |
| Fragmentation / Reassembly | §8 data-plane ops | EXPLICITLY FUTURE | Not needed for Bundle identity. Bundles are atomic envelopes. |
| TransformRegistry | §9 | EXPLICITLY FUTURE | Catalog of available transforms — not yet needed. |
| TransformRuntime | §9 | EXPLICITLY FUTURE | execute/reverse/estimateCost/verify — not yet needed. |
| Extension | §10 | EXPLICITLY FUTURE | Pluggable behavior — not yet needed. |
| ExtensionRegistry | §10 | EXPLICITLY FUTURE | Publisher identity, signature, permissions — not yet needed. |
| ExtensionRuntime | §10 | EXPLICITLY FUTURE | Sandboxed execution — technology OPEN. |
| Marketplace | §11 | EXPLICITLY FUTURE | Discovery/publishing/licensing — not yet needed. |
| SDK | §12 | EXPLICITLY FUTURE | Generic API domains — not yet needed. |
| RemoteAPI | Gap Matrix | EXPLICITLY FUTURE | Fleet management API — not yet needed. |
| Sandbox | Gap Matrix | EXPLICITLY FUTURE | Resource-limited extension execution — not yet needed. |
| Content-addressed payload storage | §8 (Bundle) | EXPLICITLY FUTURE | payloadRef is an opaque reference; no CAS built. |
| Cross-tenant transport | §8 (Bundle) | EXPLICITLY FUTURE | Single-tenant only. |
| Retransmission / sliding windows | 14E contract | EXPLICITLY FUTURE | Reliability layer — future phase. |
| Custody transfer / DTN | 14D contract | EXPLICITLY FUTURE | DTN forwarding — future phase. |

---

## 5. Constitutional Amendments

The following amendments to the Architecture Constitution are enacted by this reconciliation:

### Amendment 1 — §1 Identity Boundaries (Node)

**Before:** "Node (FUTURE — not yet implemented): A protocol participant. Distinct from Asset/Device."

**After:** "Node (IMPLEMENTED — Phase 14A): A protocol participant. Distinct from Asset/Device. A Node is a service-layer primitive (`src/lib/services/node.service.ts`), tenant-scoped, optionally backed by Device/ParticipantIdentity/ResourceIdentity. NodeNetworkMembership provides network-scoped participation (analogous to ParticipantMembership). NodeAgent remains future (no evidence requires it)."

### Amendment 2 — §8 Data Plane Boundary (header)

**Before:** "## 8. DATA PLANE BOUNDARY (contract — NOT YET IMPLEMENTED)"

**After:** "## 8. DATA PLANE BOUNDARY (PARTIALLY IMPLEMENTED — Phase 14B-F)"

### Amendment 3 — §8 Bundle

**Before:** "### Bundle (contract — NOT YET IMPLEMENTED)"

**After:** "### Bundle (IMPLEMENTED — Phase 14B)"

### Amendment 4 — §8 Data-Plane Operations Status

Add status annotations to the data-plane operations list:
- receive: IMPLEMENTED (14B)
- store: IMPLEMENTED (14B)
- route: IMPLEMENTED (14C)
- forward: IMPLEMENTED (14D)
- deliver: IMPLEMENTED (14B)
- deduplicate: IMPLEMENTED (14B, @@unique + P2002)
- fragment: FUTURE
- reassemble: FUTURE
- expire: IMPLEMENTED (14B)
- acknowledge: IMPLEMENTED (14E)
- transform: PARTIALLY IMPLEMENTED (14F: TransformRecord provenance only; TransformRegistry/Runtime future)

### Amendment 5 — §9 Transform Boundary (header)

**Before:** "## 9. TRANSFORM BOUNDARY (contract — NOT YET IMPLEMENTED)"

**After:** "## 9. TRANSFORM BOUNDARY (PARTIALLY IMPLEMENTED — Phase 14F: TransformRecord provenance. TransformRegistry and TransformRuntime remain future.)"

### Amendment 6 — §16 Anti-Drift Rules (new rules)

Add the following anti-drift rules:
10. Phase 14 data-plane services (data-plane, routing, transport, delivery-confirmation, transform-record) MUST NOT import vertical services (VPP, Compute, Storage, Wireless).
11. Phase 14 data-plane services MUST NOT import the generic economic pipeline.
12. Phase 14 data-plane services MUST NOT import ProtocolRuntime or HybridRuntime.
13. The kernel MUST NOT import Phase 14 data-plane services (except TransportAdapter which is a kernel contract interface).

---

## 6. Dependencies Officially Frozen

The following dependency directions are frozen by this reconciliation:

```
Identity Layer
  ↓
Node (14A) — service-layer, tenant-scoped
  ↓
Bundle (14B) — immutable data-plane primitive
  ↓
Route (14C) — planned path, attaches to Bundle
  ↓
TransportExecution (14D) — forward lifecycle, references Route + Bundle
  ↓
TransportAdapter (14D) — kernel contract interface, invoked by transport service
  ↓
DeliveryConfirmation (14E) — immutable receipt, references Bundle + optional TransportAttempt
  ↓
TransformRecord (14F) — immutable provenance, references Bundle + optional Node
```

**Frozen dependency rules:**
- Node ✗→ Bundle/Route/Transport/DeliveryConfirmation/TransformRecord (identity is lower-level)
- Bundle ✗→ Route/Transport/DeliveryConfirmation/TransformRecord (data-plane object is lower-level)
- Route ✗→ Transport/DeliveryConfirmation/TransformRecord (routing is lower-level than execution)
- Transport ✗→ DeliveryConfirmation/TransformRecord (execution is lower-level than receipt)
- DeliveryConfirmation ✗→ TransformRecord (receipt is independent of transform)
- TransformRecord ✗→ DeliveryConfirmation (provenance is independent of receipt)
- All Phase 14 services ✗→ economic pipeline, vertical services, ProtocolRuntime, HybridRuntime
- Kernel ✗→ Phase 14 services (except TransportAdapter contract interface)

---

## 7. Gap Matrix Update

The Gap Matrix is updated to reflect actual authoritative status:

| Concept | Previous Status | Current Status | Phase |
|---------|----------------|----------------|-------|
| Node | MISSING | EXISTS | 14A |
| NodeAgent | MISSING | FUTURE | — |
| DataPlane | MISSING | EXISTS | 14B |
| Bundle | MISSING | EXISTS | 14B |
| Route | (not listed) | EXISTS | 14C |
| TransportExecution | (not listed) | EXISTS | 14D |
| TransportAdapter | (not listed) | EXISTS (kernel contract) | 14D |
| DeliveryConfirmation | (not listed) | EXISTS | 14E |
| Transform | MISSING | PARTIALLY EXISTS (TransformRecord provenance) | 14F |
| TransformRegistry | MISSING | FUTURE | — |
| TransformRuntime | MISSING | FUTURE | — |
| Extension | MISSING | FUTURE | — |
| ExtensionRegistry | MISSING | FUTURE | — |
| ExtensionRuntime | MISSING | FUTURE | — |
| Marketplace | MISSING | FUTURE | — |
| SDK | MISSING | FUTURE | — |
| RemoteAPI | MISSING | FUTURE | — |
| Sandbox | MISSING | FUTURE | — |
