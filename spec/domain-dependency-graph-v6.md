# IAAS Domain Dependency Graph — IAAS-DOM-ARCH-6

- Architecture Version: `IAAS-DOM-ARCH-6` (CANDIDATE / UNDER REVIEW)
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Change Request: `ACR-005` (UNDER_REVIEW)

Edges mean `A depends on B` unless marked otherwise.

## Implemented / retained edges

```text
ParticipantMembership -> ParticipantIdentity -> Tenant
ResourceIdentity -> Tenant
AssetNetworkAssignment -> Asset -> Tenant
NodeNetworkMembership -> Node -> ParticipantIdentity

NetworkVersion -> NetworkDefinition
NetworkTemplate -> NetworkDefinition
NetworkInstance -> NetworkVersion
NetworkManifest -> NetworkDefinition          [representation only]

NetworkComposition -> NetworkInstance
NetworkDependency -> NetworkComposition
CapabilityBinding -> NetworkComposition
ResourceBinding -> NetworkComposition
PolicyBinding -> NetworkComposition
NetworkExport -> NetworkComposition
NetworkImport -> NetworkExport

DeterministicScheduler -> NetworkRequest
AllocationDecision -> DeterministicScheduler
CapacityReservation -> AllocationDecision
CapacityCommitment -> CapacityReservation
Execution -> CapacityCommitment
ExecutionAssignment -> Execution
ExecutionLease -> ExecutionAssignment
NetworkRuntime -> ExecutionLease

InfrastructureRuntime -> InfrastructureAdapter
ProtocolRuntime -> ProtocolStateStore
ProtocolRuntime -> DeterministicTransactionExecutor
ProtocolRuntime -> Consensus
HybridRuntime -> InfrastructureRuntime
HybridRuntime -> ProtocolRuntime

Bundle -> Node
Route -> Bundle
TransportExecution -> Route
TransportAttempt -> TransportExecution
TransportAdapter -> TransportExecution       [contract]
DeliveryConfirmation -> TransportAttempt
Fragment -> Bundle
ReassemblyState -> Fragment
TransformRecord -> Bundle

VerificationResult -> Evidence
Attestation -> VerificationResult
UsageMeasurement -> Attestation
EconomicAttribution -> UsageMeasurement
Contribution -> EconomicAttribution
Reward -> Contribution
LedgerPosting -> Reward
Settlement -> LedgerPosting

CredentialKeyBinding -> Identity
SignatureEnvelope -> CredentialKeyBinding
TrustDecision -> TrustPolicy + SignatureEnvelope
Package -> TrustDecision
PackageVerification -> Package

PackageManifest -> Package
PackageArtifact -> Package
PackageDependency -> Package
PackageCompatibility -> Package
PackageSignature -> Package

OperationalResourceLifecycle -> Resource / NetworkInstance / Node
Telemetry -> Observation source
Metric -> Telemetry
Log -> Observation source
Trace -> Observation source
Evidence -> Observation source

AllocationStrategy -> AllocationDecision
ReservationWindow -> CapacityReservation
AvailabilityWindow -> AllocationDecision
DemandConstraint -> AllocationDecision
```

## Planned edges

```text
NetworkDefinition
    -> NetworkInstance
    -> Network Launch subsystem

Network Composition
    -> Capability/Resource/Policy resolution
    -> Allocation
    -> Runtime activation

Package Verification
    -> Registry Admission
    -> Install
    -> Runtime availability

Observability
    -> Evidence ingestion
    -> Verification

UsageMeasurement
    -> EconomicAttribution
    -> Contribution / Reward / Ledger / Settlement
```

## Optional edges

```text
DemandForecast -> AllocationPolicy
MarketplaceListing -> Package
SDK -> canonical IAAS API contracts
Concrete Transform -> TransformRuntime
Concrete Extension -> ExtensionRuntime
```

Forecast, marketplace listings, SDK clients, and concrete plugin implementations MUST remain non-authoritative consumers/providers of generic contracts.

## Forbidden edges

```text
Kernel ✗-> vertical services
Kernel ✗-> Marketplace
Kernel ✗-> Package distribution
Kernel ✗-> EconomicPipeline
Kernel ✗-> DataPlane services
Kernel ✗-> NetworkInstance implementation

EconomicPipeline ✗-> DataPlane
DataPlane ✗-> EconomicPipeline
EconomicPipeline ✗-> vertical services

InfrastructureRuntime ✗-> ProtocolRuntime
ProtocolRuntime ✗-> InfrastructureRuntime

TransformRegistry ✗-> Marketplace execution
TransformRuntime ✗-> Marketplace lifecycle
ExtensionRegistry ✗-> ExtensionRuntime execution
ExtensionRuntime ✗-> ExtensionRegistry lifecycle mutation

Marketplace ✗-> Extension execution
Marketplace ✗-> operational truth
SDK ✗-> private persistence semantics
PricingPolicy ✗-> operational source-of-truth mutation
EconomicAttribution ✗-> Event / VerificationResult / Attestation mutation

NetworkComposition ✗-> private runtime state
NetworkInstance ✗-> published NetworkVersion mutation

Observability ✗-> automatic attestation
Telemetry ✗-> economic settlement without verification

Federation ✗-> local authority replacement
```

## Acyclicity invariant

The V6 candidate graph is intentionally layered:

```text
Identity / Resource
        ↓
Network Definition / Version / Template
        ↓
Composition / Resolution
        ↓
Allocation / Reservation / Commitment
        ↓
Execution / Lease / Runtime
       ↙                         ↘
Data Plane                  Verification
    ↓                            ↓
Fragment / Transport       Attestation
                                  ↓
                           Economic Attribution
                                  ↓
                           Contribution / Reward
                                  ↓
                            Ledger / Settlement
```

Cross-cutting Trust, Package, Operations, and Observability contracts may be consumed by these layers through explicit interfaces, but do not reverse the arrows.

## Universalism invariant

No generic primitive may require a vertical-specific prerequisite. A reference network may add a network-defined capability, policy, adapter, transform, extension, or package, but it cannot add a kernel dependency or replace a generic authority.
