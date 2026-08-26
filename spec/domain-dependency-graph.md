# IAAS Domain Dependency Graph — IAAS-DOM-ARCH-1

- Domain Architecture: `IAAS-DOM-ARCH-1` (FROZEN)
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Derived by: `WORK-002` from `spec/domain-architecture.md`

> This is the domain-primitive dependency graph (NOT the Work-Item graph in
> `spec/dependency-graph.md`). Edges read as "depends on" (left depends on
> right). The graph is a DAG: acyclic, with a frozen canonical direction.
> Per `IAAS-GOV-ARCH-1`, the detailed domain DAG is derived from
> `IAAS-DOM-ARCH-1`, not from a guessed chronological roadmap.

## Notation

```text
A -> B      A depends on B (B is lower-level / more fundamental)
A ✗-> B     A MUST NOT depend on B (frozen anti-drift prohibition)
```

## Domain Primitive DAG (frozen direction)

```text
GOVERNANCE (IAAS-GOV-ARCH-1)
    |
    v  (governs)
DOMAIN ARCHITECTURE (IAAS-DOM-ARCH-1)
    |
    v  (governs)
    |
    |   IDENTITY & RESOURCE (foundational)
    |       Tenant
    |         -> ParticipantIdentity
    |         -> ResourceIdentity
    |         -> Asset
    |         -> Device
    |       ParticipantIdentity -> ParticipantMembership -> ParticipantRole
    |       ResourceIdentity -> NetworkResourceMembership -> CapacityResource
    |       Asset -> AssetNetworkAssignment
    |       Device -> DeviceCredential
    |       Node -> NodeNetworkMembership
    |
    |   NETWORK
    |       NetworkDefinition -> NetworkVersion
    |       NetworkVersion (runtimeKind) -> RuntimeRegistry -> NetworkRuntime
    |       NetworkTemplate -> NetworkDefinition
    |
    |   CONTROL PLANE PIPELINE (sequential, left depends on right)
    |       NetworkRequest -> DeterministicScheduler -> AllocationDecision
    |       AllocationDecision -> CapacityReservation -> CapacityCommitment
    |       CapacityCommitment -> Execution -> ExecutionAssignment
    |       ExecutionAssignment -> ExecutionLease
    |       ExecutionLease -> NetworkRuntime.executeAssignment()
    |       NetworkRuntime -> EconomicPipelineState
    |
    |   RUNTIME KERNEL
    |       NetworkRuntime (interface)
    |         -> InfrastructureRuntime
    |         -> ProtocolRuntime
    |         -> HybridRuntime
    |       InfrastructureRuntime -> InfrastructureAdapter
    |       ProtocolRuntime -> ProtocolStateStore
    |       ProtocolRuntime -> DeterministicTransactionExecutor
    |       ProtocolRuntime -> SimpleConsensusEngine
    |       ProtocolRuntime -> Reconciliation (4 primitives)
    |       HybridRuntime -> InfrastructureRuntime
    |       HybridRuntime -> ProtocolRuntime   (ONLY bridge)
    |
    |   ECONOMIC PIPELINE (sequential)
    |       Event -> VerificationResult -> Attestation
    |       Attestation -> Contribution -> Reward
    |       Reward -> LedgerPosting -> Settlement
    |       EconomicPipelineState -> (Event ... Settlement)
    |
    |   DATA PLANE (frozen direction — Phase 13R §6)
    |       Node -> Bundle
    |       Bundle -> BundleDelivery
    |       Bundle -> Route -> RouteHop
    |       Route -> TransportExecution -> TransportAttempt
    |       TransportExecution -> TransportAdapter (kernel contract)
    |       TransportAttempt -> DeliveryConfirmation
    |       Bundle -> TransformRecord
    |
    v
```

## Frozen Anti-Drift Edges (MUST NOT depend on)

These prohibitions are statically enforced by the architecture-contract test
suite (constitution §16). All CONFIRMED OBSERVED at commit `12c6b6c`.

```text
EconomicPipelineState ✗-> VPP
EconomicPipelineState ✗-> Compute
EconomicPipelineState ✗-> Storage
EconomicPipelineState ✗-> Wireless
EconomicPipelineState ✗-> Manufacturing
EconomicPipelineState ✗-> economicStage (VppDispatchAssignment)

InfrastructureRuntime ✗-> ProtocolRuntime
ProtocolRuntime ✗-> InfrastructureRuntime

DataPlaneService    ✗-> VPP | Compute | Storage | Wireless
RoutingService      ✗-> VPP | Compute | Storage | Wireless
TransportService    ✗-> VPP | Compute | Storage | Wireless
DeliveryConfirmation ✗-> VPP | Compute | Storage | Wireless
TransformRecord     ✗-> VPP | Compute | Storage | Wireless

DataPlaneService    ✗-> EconomicPipelineState
RoutingService      ✗-> EconomicPipelineState
TransportService    ✗-> EconomicPipelineState
DeliveryConfirmation ✗-> EconomicPipelineState
TransformRecord     ✗-> EconomicPipelineState

DataPlaneService    ✗-> ProtocolRuntime | HybridRuntime
RoutingService      ✗-> ProtocolRuntime | HybridRuntime
TransportService    ✗-> ProtocolRuntime | HybridRuntime
DeliveryConfirmation ✗-> ProtocolRuntime | HybridRuntime
TransformRecord     ✗-> ProtocolRuntime | HybridRuntime

Kernel              ✗-> DataPlaneService | RoutingService | TransportService
                       | DeliveryConfirmation | TransformRecord
                       (exception: TransportAdapter contract interface)
```

## Acyclicity

The domain primitive DAG is acyclic. The frozen direction is:

```text
Identity/Resource (lowest) > Network > ControlPlane > Runtime > Economic > DataPlane
```

Within the data plane:

```text
Node > Bundle > Route > TransportExecution > TransportAdapter > DeliveryConfirmation
                                                                  > TransformRecord
```

No primitive depends on a higher-level primitive. No vertical service is
depended-upon by a generic primitive. This is verified by the anti-drift test
suite (`tests/architecture-contract.test.ts`,
`tests/phase-13r-reconciliation-contract.test.ts`,
`tests/phase-14*-architecture-contract.test.ts`).

## Unresolved Dependencies

None. Every domain primitive in the DAG resolves to an implemented source
artifact (OBSERVED) or is explicitly marked FUTURE/PROPOSED and excluded from
the implemented-edge set. FUTURE primitives (TransformRegistry,
TransformRuntime, Extension, Marketplace, SDK) have no incoming implemented
edges and do not create cycles.
