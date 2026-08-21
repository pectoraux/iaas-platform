# Phase 13 — Architectural Dependency Graph

> Shows the dependency direction between all architectural components.
> Arrows point FROM consumer TO provider.
> `→` means "depends on" / "imports from".
> `✗→` means "MUST NOT depend on" / "MUST NOT import from".

---

## CONTROL PLANE

```
NetworkRequest
  → Deterministic Scheduler
  → AllocationDecision
  → CapacityReservation
  → CapacityCommitment
  → Execution
  → ExecutionAssignment
  → ExecutionLease
  → NetworkRuntime (resolved via RuntimeRegistry)
  → Operational Completion
  → EconomicPipelineState
  → Event → Verification → Attestation
  → Contribution → Reward → Ledger → Settlement
```

## RUNTIME SELECTION

```
NetworkVersion.runtimeKind
  → RuntimeRegistry.resolve(kind)
  → NetworkRuntime

InfrastructureRuntime  ✗→  ProtocolRuntime
ProtocolRuntime         ✗→  InfrastructureRuntime
HybridRuntime           →  InfrastructureRuntime + ProtocolRuntime (via bridge)
Control Plane           ✗→  Concrete runtimes (only via RuntimeRegistry)
```

## ECONOMIC PIPELINE

```
Generic Economic Pipeline
  → Event, Verification, Attestation, Contribution, Reward, Ledger, Settlement

VPP            →  Generic Economic Pipeline
Compute        →  Generic Economic Pipeline
Storage (future) →  Generic Economic Pipeline
TransitNet (future) →  Generic Economic Pipeline

Generic Economic Pipeline  ✗→  VPP
Generic Economic Pipeline  ✗→  Compute
Generic Economic Pipeline  ✗→  Storage
Generic Economic Pipeline  ✗→  TransitNet
Generic Economic Pipeline  ✗→  Any vertical service
```

## PROTOCOL / HYBRID

```
ProtocolRuntime
  → ProtocolStateStore
  → ProtocolTransactionExecutor
  → ValidatorRegistry
  → ConsensusEngine

ProtocolRuntime  ✗→  InfrastructureRuntime
ProtocolRuntime  ✗→  InfrastructureAdapter
ProtocolRuntime  ✗→  VPP/Compute services
ProtocolRuntime  ✗→  Generic economic pipeline (economics are infrastructure-shaped)

HybridRuntime
  → InfrastructureRuntime (via constructor)
  → ProtocolRuntime (via constructor)
  → HybridBridge (the ONLY code that knows about both worlds)

PhysicalExecutionEvidence → ReconciliationAttempt → ProtocolOutcome → ReconciliationState
```

## FUTURE: DATA PLANE (PARTIALLY IMPLEMENTED — Phase 14B-F)

```
Control Plane (decides: who, what, where, why, policy)
  ↓
Data Plane Contracts (receive[14B], store[14B], route[14C], forward[14D], deliver[14B])
  ↓
Concrete Data Plane (implementation: data-plane.service, routing.service, transport.service)

Bundle(14B)  →  Transform chain(14F: TransformRecord provenance)  →  Delivery(14B: BundleDelivery + 14E: DeliveryConfirmation)
Bundle  ✗→  TransitNet-specific semantics
Bundle  ✗→  Any protocol-specific semantics

Frozen dependency direction:
  Node(14A) → Bundle(14B) → Route(14C) → TransportExecution(14D) → TransportAdapter(14D) → DeliveryConfirmation(14E) → TransformRecord(14F)

  Node ✗→ Bundle/Route/Transport/DeliveryConfirmation/TransformRecord
  Bundle ✗→ Route/Transport/DeliveryConfirmation/TransformRecord
  Route ✗→ Transport/DeliveryConfirmation/TransformRecord
  Transport ✗→ DeliveryConfirmation/TransformRecord
  DeliveryConfirmation ✗→ TransformRecord
  All Phase 14 services ✗→ economic pipeline, vertical services, ProtocolRuntime, HybridRuntime
  Kernel ✗→ Phase 14 services (except TransportAdapter contract interface)
```

## FUTURE: TRANSFORM (PARTIALLY IMPLEMENTED — Phase 14F: TransformRecord provenance)

```
TransformRecord(14F) — immutable provenance record (input hash + output hash + transform identity + version + parameters + node + result)

TransformRegistry  ✗→  TransformRuntime
TransformRegistry  ✗→  Marketplace
TransformRegistry  ✗→  TransitNet
TransformRegistry  →  FUTURE
TransformRuntime    →  FUTURE
```

## FUTURE: EXTENSION

```
Extension
  → ExtensionRegistry (publisher identity, signature, permissions)
  → ExtensionRuntime (sandboxed execution)

ExtensionRuntime  ✗→  Kernel control plane
ExtensionRuntime  ✗→  Generic economic pipeline

Marketplace  →  ExtensionRegistry (resolves/publishes)
Marketplace  ✗→  ExtensionRuntime (MUST NOT execute)
Marketplace  ✗→  Kernel
```

## FUTURE: SDK/API

```
SDK
  → Identity, Node, Network, Capability, Resource
  → Execution, Bundle, Transform, Extension
  → Telemetry, Contribution, Policy

Local SDK  ✗→  Remote Fleet API (different domains)
Remote Fleet API  ✗→  Local SDK
```

## FUTURE: NETWORK LAUNCH

```
NetworkTemplate
  + Policies
  + Adapters
  + Runtime (runtimeKind)
  + Verification Policy
  + Economic Rules
  + DataPlane capabilities (future)
  + Transforms (future)
  + Extensions (future)

Kernel  ✗→  Network-specific code
```

## IDENTITY / RESOURCE

```
Tenant
  → ParticipantIdentity → ParticipantMembership → ParticipantRole
  → ResourceIdentity → NetworkResourceMembership
  → Asset → Device → DeviceCredential
  → Operator → Asset

Asset  ≠  Device  ≠  Node (IMPLEMENTED — Phase 14A)  ≠  ParticipantIdentity  ≠  ResourceIdentity

Control Plane  →  ResourceIdentity (via CapacityProvider)
Control Plane  ✗→  Asset (directly)
```

## NODE BOUNDARY (IMPLEMENTED — Phase 14A; NodeAgent FUTURE)

```
Asset (physical thing)
  ↓
Device (technical interface)
  ↓
NodeAgent (software) — FUTURE
  ↓
Node (protocol participant) — IMPLEMENTED (Phase 14A)
  ↓
NodeNetworkMembership (participation) — IMPLEMENTED (Phase 14A)

Node  ≠  Asset
Node  ≠  Device
Node  MAY be backed by Asset+Device
Node  MAY exist without an Asset (pure protocol node)
NodeAgent  →  FUTURE (no evidence requires it)
```
