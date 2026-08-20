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

## FUTURE: DATA PLANE

```
Control Plane (decides: who, what, where, why, policy)
  ↓
Data Plane Contracts (receive, store, route, forward, deliver)
  ↓
Concrete Data Plane (implementation)

Bundle  →  Transform chain  →  Delivery
Bundle  ✗→  TransitNet-specific semantics
Bundle  ✗→  Any protocol-specific semantics
```

## FUTURE: TRANSFORM

```
Transform
  → TransformRegistry (catalog + versioning + compatibility)
  → TransformRuntime (execution)

TransformRegistry  ✗→  TransformRuntime
TransformRegistry  ✗→  Marketplace
TransformRegistry  ✗→  TransitNet
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

Asset  ≠  Device  ≠  Node (future)  ≠  ParticipantIdentity  ≠  ResourceIdentity

Control Plane  →  ResourceIdentity (via CapacityProvider)
Control Plane  ✗→  Asset (directly)
```

## NODE BOUNDARY (FUTURE — CONTRACT ONLY)

```
Asset (physical thing)
  ↓
Device (technical interface)
  ↓
NodeAgent (software)
  ↓
Node (protocol participant)
  ↓
NetworkMembership (participation)

Node  ≠  Asset
Node  ≠  Device
Node  MAY be backed by Asset+Device
Node  MAY exist without an Asset (pure protocol node)
```
