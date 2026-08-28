# IAAS Domain Architecture V6 — Architecture Completion Baseline

## Status

- Architecture Version: `IAAS-DOM-ARCH-6`
- Status: **FROZEN / CURRENT CANONICAL**
- Governing Governance Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Change Request: `ACR-005` (APPROVED)
- Supersedes: `IAAS-DOM-ARCH-5` (frozen through ACR-004 / WORK-020; now SUPERSEDED / IMMUTABLE).

> This document is the frozen architecture-completion baseline, approved through ACR-005 and frozen by WORK-024 (the dedicated V6 freeze gate). Historical V1-V5 architecture documents remain immutable and authoritative for their historical scopes.

## 1. Architectural Purpose

V6 completes the generic IAAS domain model needed to make future implementation a realization of already-decided architecture. It freezes responsibilities, boundaries, identity, lifecycle, authority, trust semantics, data ownership, contract semantics, and dependency direction while deliberately leaving concrete vendors, libraries, algorithms, and business models configurable.

## 2. Foundational Invariants Inherited from V1-V5

### 2.1 Identity separation

```text
Asset ≠ Device ≠ Node ≠ ParticipantIdentity ≠ ResourceIdentity
```

These identities may be linked, but none is an alias for another.

### 2.2 Runtime separation

```text
InfrastructureRuntime  ✗→ ProtocolRuntime
ProtocolRuntime       ✗→ InfrastructureRuntime
HybridRuntime          = only intentional bridge
```

Runtime selection occurs through `RuntimeRegistry` rather than control-plane imports of concrete runtimes.

### 2.3 Operations/economics separation

```text
OPERATIONS ≠ ECONOMICS
```

Economic services consume verified operational facts and never become operational source-of-truth.

### 2.4 Data Plane / Economic Pipeline separation

```text
Data Plane ✗→ EconomicPipeline
EconomicPipeline ✗→ Data Plane
```

### 2.5 Extension and Transform authority

```text
Transform
  → TransformRegistry
  → TransformRuntime
  → TransformRecord

Extension
  → ExtensionRegistry
  → ExtensionRuntime
  → ExtensionProvenance
```

Registry is catalog/lifecycle authority; runtime is execution authority; provenance is immutable fact.

### 2.6 Sandbox boundary

V5 sandbox semantics remain unchanged: WASI Component Model/capability sandbox contract, no ambient authority, operation-level enforcement, tenant isolation, resource limits, observable termination, and deny-by-default fallback. V6 does not freeze a particular WASI revision or concrete runtime.

## 3. Universal Domain Model

### 3.1 Identity and resources

The domain includes Tenant, Organization, ParticipantIdentity, ParticipantMembership, ParticipantRole, ResourceIdentity, NetworkResourceMembership, Asset, Device, Capability, DeviceCredential, and Node.

`Node` remains a service-layer protocol participation endpoint. `NodeAgent` is not a mandatory domain primitive; an implementation-specific agent process may sit behind existing execution/runtime contracts.

### 3.2 Network intent

```text
NetworkDefinition
    = declarative network intent
NetworkVersion
    = immutable published network artifact
NetworkTemplate
    = reusable definition blueprint
NetworkManifest
    = serialized/package/API representation of a NetworkDefinition
```

NetworkManifest is not a second source of truth.

### 3.3 Network instance

```text
NetworkInstance
    = one realized deployment of one immutable NetworkVersion
```

Properties:

- tenant-scoped;
- immutable identity;
- exactly one source NetworkVersion;
- lifecycle state independent of NetworkDefinition/Version;
- may be one of many instances derived from the same version;
- retains audit/evidence after termination/archive.

### 3.4 Network lifecycle

The Network Lifecycle subsystem owns instance lifecycle:

```text
PLANNED
  ↓
PROVISIONING
  ↓
VALIDATING
  ↓
ACTIVE ⇌ PAUSED
  ↓
DRAINING
  ↓
TERMINATED
  ↓
ARCHIVED
```

Failure/rollback transitions are explicit and cannot mutate the published NetworkVersion.

### 3.5 Network-as-Code

The canonical launch pipeline is:

```text
Definition
  ↓
Validation
  ↓
Dependency Resolution
  ↓
Capability Resolution
  ↓
Resource Discovery
  ↓
Allocation
  ↓
Reservation
  ↓
Commitment
  ↓
Provisioning
  ↓
Runtime Activation
  ↓
Verification
  ↓
DEPLOYED
```

Every stage has one owner and explicit input/output semantics. A later stage cannot bypass a required earlier authority.

## 4. Network Composition

Composition is a first-class generic domain boundary:

```text
NetworkComposition
├─ NetworkDependency
├─ CapabilityBinding
├─ ResourceBinding
├─ PolicyBinding
├─ NetworkExport
└─ NetworkImport
```

### Rules

1. Composition references stable identities and immutable versions.
2. Exports expose only explicitly exported capabilities, resource references, or policy interfaces.
3. Imports bind to exports; they do not read private runtime state.
4. Composition honors tenant authorization, version immutability, trust, allocation, and lifecycle authority.
5. Composition never becomes a substitute for federation.

## 5. Control Plane Completion

The existing control plane remains:

```text
NetworkRequest
  ↓
Deterministic Scheduler
  ↓
AllocationDecision
  ↓
CapacityReservation
  ↓
CapacityCommitment
  ↓
Execution
  ↓
ExecutionAssignment
  ↓
ExecutionLease
  ↓
NetworkRuntime.executeAssignment()
  ↓
Operational Completion
  ↓
EconomicPipelineState
```

V6 adds a stable `AllocationStrategy` contract and temporal coordination primitives without changing authority:

```text
AllocationStrategy
ReservationWindow
AvailabilityWindow
DemandConstraint
```

`DemandForecast` is advisory. No forecast can create a commitment without a persisted allocation decision.

Concrete strategies such as exclusive, shared, pooled, fair, priority, scheduled, opportunistic, auction, or market are policies/implementations behind the same contract.

## 6. Data Plane Completion

The Data Plane remains:

```text
Node
 ↓
Bundle
 ↓
Route
 ↓
TransportExecution
 ↓
TransportAttempt
 ↓
TransportAdapter
 ↓
DeliveryConfirmation
```

V6 adds optional fragmentation:

```text
Bundle
 ↓
Fragment[]
 ↓
ReassemblyState
```

### Fragment invariants

- Fragment identity is immutable.
- Parent Bundle identity is explicit.
- Sequence/index is explicit.
- Total count is explicit when known.
- Integrity and expiry are explicit.
- Tenant scope is mandatory.
- Duplicate delivery is idempotent.
- Out-of-order delivery is supported within the validity window.
- Expired fragments/reassembly cannot complete.
- Reassembly never changes the semantics of Route/Transport/DeliveryConfirmation.

## 7. Trust Architecture

V6 defines generic trust semantics without freezing one algorithm or PKI implementation:

```text
Identity
  ↓
Credential / KeyBinding
  ↓
SignatureEnvelope
  ↓
TrustPolicy
  ↓
TrustDecision
```

### Trust rules

- credentials are bound to explicit subjects;
- validity and revocation are explicit;
- private/secret material is never persisted as plaintext;
- signatures bind canonical content and signer/key identity;
- verification failure is fail-closed;
- positive trust decisions do not imply execution;
- algorithm selection is implementation/configuration policy.

Attestation remains the durable verified-claim mechanism in the verification architecture.

## 8. Package Architecture

All installable IAAS artifacts use one generic Package architecture:

```text
Package
├─ PackageManifest
├─ PackageDependency
├─ PackageArtifact
├─ PackageCompatibility
├─ PackagePublisher
├─ PackageSignature
├─ capabilities
├─ integrity
└─ version
```

Typed kinds are declarations over the same model:

```text
NetworkPackage
TransformPackage
ExtensionPackage
AdapterPackage
```

No package kind gets an independent packaging architecture.

### Admission boundary

```text
Package
  ↓
Integrity verification
  ↓
Signature / trust verification
  ↓
Compatibility + dependency resolution
  ↓
Registry admission
  ↓
Install
  ↓
Runtime availability
```

Install never means execute.

## 9. Registry / Distribution / Marketplace

The technical Registry remains the catalog/lifecycle authority.

Marketplace is a product/distribution boundary:

```text
Registry / Trust Verification
          ↓
  optional Marketplace listing
          ↓
       discovery
          ↓
      installation
          ↓
  technical registry
          ↓
       runtime
```

Marketplace MAY own listing, discovery, licensing, commercial terms, and ordering. It MUST NOT:

- execute extensions;
- activate runtime contexts;
- replace technical Registry authority;
- mutate operational source-of-truth;
- become a second package registry.

A concrete commercial model is not frozen.

## 10. Economic Architecture

The generic economic boundary is:

```text
Operational Fact
  ↓
Verification / Attestation
  ↓
UsageMeasurement
  ↓
EconomicAttribution
  ↓
Contribution / Reward
  ↓
LedgerPosting
  ↓
Settlement instruction
```

`MeteringRule` and `PricingPolicy` are versioned policies.

Rules:

- only verified facts can drive economic attribution;
- measurements identify units and sources;
- unmeasurable quantities are not fabricated from enforcement limits;
- economic attribution does not rewrite operational facts;
- pricing policy is not operational policy;
- the existing ledger/settlement authorities remain authoritative;
- no second generic ledger is introduced.

## 11. Operational Lifecycle

Operational lifecycle is distinct from workflow lifecycle and NetworkRequest/Execution state machines.

```text
PROVISION
VALIDATE
ACTIVATE
PAUSE
RESUME
SCALE
DRAIN
UPGRADE
ROLLBACK
TERMINATE
ARCHIVE
```

Operations owns these transitions. A resource type declares which transitions it supports. Operational termination preserves required audit/evidence.

## 12. Observability and Evidence

These concepts remain separate:

```text
Telemetry  = raw measurement/signal
Metric     = derived/aggregated numerical observation
Log        = structured diagnostic record
Trace      = causal execution/span record
Event      = immutable domain occurrence
Evidence   = submitted observation package for verification
Verification = policy-driven determination
Attestation = durable verified claim
```

The canonical direction is:

```text
Observation → Evidence → Verification → Attestation
```

Raw observation is never self-attesting.

## 13. SDK Boundary

The SDK is an external consumer of canonical IAAS service contracts:

```text
SDK → canonical APIs/contracts
```

The SDK MUST NOT create alternate authorization, lifecycle, identity, versioning, persistence, or execution semantics.

Local and remote clients may share the same semantic contract family.

## 14. Federation Boundary

Federation is explicitly `OPEN / RESEARCH` in V6.

The future seam is:

```text
Local IAAS
   ↕
Federation Gateway / Trust Boundary
   ↕
Remote IAAS
```

Candidate concepts such as FederatedIdentity, RemoteResource, RemoteNetwork, RemoteCapability, TrustAnchor, CrossDomainExecution, and CrossDomainSettlement are not frozen. Any production implementation requires ACR-006+.

## 15. Cross-Cutting Authority Matrix

| Responsibility | Authoritative owner | Forbidden alternative |
|---|---|---|
| identity | Identity/Participant services | SDK, Marketplace, Economics |
| resource truth | Resource/Capacity | Economics, Marketplace |
| network definition/version | Network service | Runtime, Marketplace |
| network instance/lifecycle | Network Lifecycle | Workflow engine, Runtime |
| composition | Network Composition | Runtime internals |
| allocation | Scheduler/Allocation | Marketplace, Economics |
| reservation/commitment | Capacity | Forecast provider |
| execution | Execution subsystem | Registry/Marketplace |
| runtime resolution | RuntimeRegistry | Control-plane concrete imports |
| node lifecycle | Node service | Kernel speculative NodeAgent |
| routing/transport | Data Plane | Economics |
| transform catalog | TransformRegistry | Marketplace |
| transform execution | TransformRuntime | Registry |
| extension catalog/lifecycle | ExtensionRegistry | Runtime/Marketplace |
| extension execution/isolation | ExtensionRuntime + Sandbox | Registry/Marketplace |
| package admission | Package/Trust subsystem | Marketplace |
| operational lifecycle | Operations | Workflow state machine |
| verification | Verification subsystem | Economics/Telemetry |
| economic attribution | Economics Attribution | Operations/Data Plane |
| ledger | Ledger subsystem | Marketplace/Operations |
| settlement | Settlement subsystem | Data Plane |
| distribution/commerce | Marketplace | Runtime/Registry |
| observability | Observability subsystem | Verification authority |

No component may silently acquire a second ownership role for a listed responsibility.

## 16. Forbidden Generic Dependencies

```text
Kernel ✗→ vertical services
Kernel ✗→ EconomicPipeline
Kernel ✗→ Data Plane service implementations
Kernel ✗→ Marketplace
Kernel ✗→ Package distribution

EconomicPipeline ✗→ DataPlane
DataPlane ✗→ EconomicPipeline

InfrastructureRuntime ✗→ ProtocolRuntime
ProtocolRuntime ✗→ InfrastructureRuntime

Marketplace ✗→ Extension execution
Marketplace ✗→ operational truth
SDK ✗→ private persistence semantics
Forecast ✗→ Commitment without AllocationDecision
Telemetry ✗→ Attestation without Verification
Pricing ✗→ operational state mutation
Composition ✗→ private runtime state

Federation ✗→ replacement of local authority
```

## 17. Universal-Network Invariant

A new network type may introduce:

- network-specific capabilities;
- policies;
- adapters;
- transforms;
- extensions;
- packages;
- reference-network fixtures.

It MUST NOT introduce:

- vertical-specific generic kernel code;
- duplicate generic ledgers;
- duplicate workflow/state authorities;
- duplicate registries for the same technical catalog;
- direct dependencies from the generic kernel into a vertical.

## 18. Reference-Network Conformance Set

V6 architecture is considered universal only if the same generic model can express the following without kernel modification:

1. compute;
2. storage;
3. wireless/bandwidth;
4. transit/DTN/local-first;
5. manufacturing/industrial;
6. mobility;
7. energy/VPP;
8. protocol/blockchain-style;
9. community-finance-style.

## 19. Explicitly Non-Frozen Choices

V6 does not freeze:

- cloud vendor/provider;
- payment processor;
- blockchain implementation;
- marketplace business model;
- optimization library;
- package archive format;
- WASI revision or concrete sandbox runtime;
- cryptographic algorithm;
- concrete Transform/Extension implementation;
- storage engine beyond the already established PostgreSQL persistence contract.

## 20. Compatibility and Migration

V6 is additive with respect to V5:

- NetworkDefinition/Version remain authoritative for intent and immutable publication.
- NetworkInstance adds deployment identity; it does not replace Version.
- Composition references published contracts; it does not expose internals.
- Fragment/Reassembly adds Data Plane capability without changing Bundle/Route/Transport authority.
- Trust/package architecture adds verification/admission boundaries without turning verification into execution.
- Economic measurement/attribution adds downstream economic semantics without rewriting operational facts.
- Operational lifecycle adds a distinct operations authority rather than modifying workflow state.
- V5 sandbox semantics remain frozen.

## 21. Architecture Change Rule

After V6 is frozen, discovery of any missing universal primitive, contradictory ownership rule, unsatisfiable lifecycle, or new cross-layer dependency requires `ACR-006+` and a new architecture version. V6 MUST NOT be silently edited in place.

## 22. Freeze Criterion

`IAAS-DOM-ARCH-6` may move from CANDIDATE to FROZEN only after:

```text
ACR-005 APPROVED
        ↓
V6 specification consistency PASS
        ↓
historical V1-V5 immutability PASS
        ↓
authority + dependency + anti-drift PASS
        ↓
reference-network universalism PASS
        ↓
independent Architect Review APPROVED
        ↓
WORK-024 VERIFIED
```
