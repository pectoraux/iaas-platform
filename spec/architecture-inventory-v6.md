# IAAS V6 Architectural Inventory — Candidate

- Target: `IAAS-DOM-ARCH-6` (CANDIDATE / UNDER REVIEW)
- Evidence rule: repository facts are classified as `OBSERVED`; prior frozen rules are `CONFIRMED`; conclusions from evidence are `INFERRED`; new architecture is `PROPOSED` until ACR-005 approval.

| Domain | Concept | Truth | Current status | V6 decision | Authority | Key dependencies |
|---|---|---|---|---|---|---|
| Identity | Tenant | OBSERVED/CONFIRMED | implemented | retain foundational primitive | Tenant boundary | none |
| Identity | ParticipantIdentity/Membership/Role | OBSERVED/CONFIRMED | implemented | retain | Identity services | Tenant |
| Identity | ResourceIdentity / NetworkResourceMembership | OBSERVED/CONFIRMED | implemented | retain | Resource subsystem | Tenant |
| Identity | Asset / Device / Credential | OBSERVED/CONFIRMED | implemented | retain, trust clarifies credential semantics | Asset/Device authority | identity |
| Identity | Node | OBSERVED/CONFIRMED | implemented service layer | retain | Node service | participant, optional device/resource |
| Identity | NodeAgent | OBSERVED absence + CONFIRMED historical future | not required | reject as mandatory universal primitive | none; implementation mechanism only | execution lease/adapter |
| Network | NetworkDefinition | OBSERVED/CONFIRMED | implemented | retain as declarative intent | Network service | tenant |
| Network | NetworkVersion | OBSERVED/CONFIRMED | implemented | retain immutable published artifact | Network service | definition |
| Network | NetworkTemplate | OBSERVED/CONFIRMED | implemented | retain blueprint | Network service | definition |
| Network | NetworkManifest | PROPOSED | not canonical today | serialized representation only; no second authority | package/API boundary | definition/version |
| Network | NetworkInstance | INFERRED/PROPOSED | missing | promote | Network Lifecycle | NetworkVersion |
| Network | NetworkComposition | INFERRED/PROPOSED | missing | promote | Composition | instances/versions |
| Network | NetworkDependency | INFERRED/PROPOSED | missing | promote | Composition | composition |
| Network | Capability/Resource/Policy Binding | INFERRED/PROPOSED | missing | promote | Composition | exported contracts |
| Network | NetworkExport/Import | INFERRED/PROPOSED | missing | promote | Composition | bindings |
| Control | NetworkRequest/Scheduler/Allocation | OBSERVED/CONFIRMED | implemented | retain | Control/Allocation | resources/policies |
| Control | CapacityReservation/Commitment | OBSERVED/CONFIRMED | implemented | retain | Capacity | allocation |
| Control | AllocationStrategy | INFERRED/PROPOSED | fragmented/config driven | promote stable interface | Allocation | scheduler |
| Control | ReservationWindow/AvailabilityWindow | INFERRED/PROPOSED | missing | promote | Capacity/Allocation | allocation |
| Control | DemandConstraint | INFERRED/PROPOSED | missing | promote | Allocation policy | request |
| Control | DemandForecast | PROPOSED | optional | advisory input only | forecast provider | demand |
| Runtime | Infrastructure/Protocol/Hybrid Runtime | CONFIRMED/OBSERVED | implemented | retain | RuntimeRegistry | execution |
| Execution | ExecutionAssignment/Lease | CONFIRMED/OBSERVED | implemented | retain | Execution subsystem | commitment |
| Data | Bundle/Route/Transport/Delivery | CONFIRMED/OBSERVED | implemented | retain | Data Plane | Node/identity |
| Data | Fragment | CONFIRMED historical FUTURE + PROPOSED V6 | missing | promote | Data Plane | Bundle |
| Data | ReassemblyState | CONFIRMED historical FUTURE + PROPOSED V6 | missing | promote | Data Plane | Fragment |
| Transform | Transform/Registry/Runtime/Record | CONFIRMED | implemented contract + verified registry/runtime/record | retain | Transform stack | Bundle |
| Extension | Extension/Registry/Runtime/Provenance | CONFIRMED | implemented | retain | Extension stack | package/trust |
| Sandbox | WASI capability sandbox | CONFIRMED | V5 frozen and host foundation implemented | retain unchanged | Sandbox boundary | ExtensionRuntime |
| Trust | Credential/KeyBinding | PROPOSED | partial credential model exists | promote generic contract | Trust | Identity |
| Trust | SignatureEnvelope | PROPOSED | no canonical envelope | promote | Trust | key binding |
| Trust | TrustPolicy/Decision | PROPOSED | distributed policy | promote | Trust/Verification | signature |
| Package | Package + Manifest + Dependency + Artifact | PROPOSED | missing canonical model | promote one generic model | Package subsystem | trust |
| Package | Typed package kinds | PROPOSED | absent | Network/Transform/Extension/Adapter package kinds over same model | Package subsystem | Package |
| Distribution | Technical registry | CONFIRMED | exists for Transform/Extension | retain as technical authority | Registry | package |
| Distribution | Marketplace | CONFIRMED historical future + PROPOSED | absent | boundary only; product layer | Marketplace | package/registry |
| Economics | Event/Verification/Attestation | CONFIRMED | implemented | retain | Verification | runtime/observation |
| Economics | UsageMeasurement | PROPOSED | partial measured fields exist in sandbox provenance | promote generic contract | Economics | attestation |
| Economics | EconomicAttribution | PROPOSED | missing generic authority | promote | Economics | usage |
| Economics | PricingPolicy | PROPOSED | vertical/business rules scattered | promote policy boundary | Economics | attribution |
| Economics | Contribution/Reward/Ledger/Settlement | CONFIRMED | implemented | retain; do not duplicate | respective economic authorities | attribution/reward |
| Operations | Operational lifecycle | PROPOSED | implicit/distributed | promote | Operations | resource/network/node |
| Observability | Telemetry/Metric/Log/Trace | PROPOSED | implementation-specific | promote as distinct contracts | Observability | runtime/execution |
| Evidence | Evidence | CONFIRMED conceptually | distributed | clarify as verification input, not raw telemetry | Verification | observations |
| SDK | SDK | CONFIRMED historical future + PROPOSED | absent | consumer boundary, not core primitive | API/SDK | canonical contracts |
| Federation | Federation | CONFIRMED historical future + PROPOSED | absent | keep OPEN/RESEARCH | future federation boundary | trust/economics/network |
| Reference | Reference networks | OBSERVED docs | conceptual coverage | formalize as conformance fixtures | Conformance suite | generic substrate |

## Architecture-Quality Findings

### Finding F1 — Canonical-index lag

`spec/architecture.md` and `spec/architecture-lock.md` currently name V4 as current while `domain-architecture-v5.md` is frozen V5 and main has advanced through WORK-022. This is specification truth drift, not a reason to edit V4/V5.

Decision: update the mutable canonical index/lock in the V6 governance change set only; retain historical V1-V5 files byte-for-byte.

### Finding F2 — V1 derivative documents are historical, not current

`spec/domain-requirements.md` and `spec/domain-dependency-graph.md` preserve V1 planning and contain stale future classifications. They must remain immutable historical records. V6 becomes the first complete current planning layer.

### Finding F3 — Existing network service mixes generic model with vertical publication gates

The current service contains an energy-specific publication-readiness case while otherwise exposing generic network APIs. This does not invalidate V5, but V6 must define publication/launch gates as policy contracts so adding a vertical does not require editing a generic lifecycle owner with vertical behavior.

### Finding F4 — NodeAgent is not justified as a universal primitive

Node already owns participant-backed protocol endpoint identity and joins networks through scoped membership; ExecutionLease supplies worker/fencing semantics. A mandatory NodeAgent would overlap identity/execution responsibilities.

Decision: reject mandatory NodeAgent; permit implementation-specific agent processes behind existing contracts.

### Finding F5 — Marketplace cannot be allowed to become technical authority

The existing architecture already says Marketplace must not execute extensions. V6 strengthens this into a three-way separation: Package/Trust, Technical Registry/Lifecycle, and Marketplace/Commerce.

### Finding F6 — Federation lacks enough evidence for freeze

There is no demonstrated cross-installation trust, failure, jurisdiction, or settlement contract in the live architecture. V6 therefore records the seam and explicitly keeps it research/open instead of inventing semantics.

## Universalism Test Matrix

| Primitive | Compute | Storage | Wireless | DTN/Transit | Manufacturing | Mobility | Energy | Protocol | Community Finance |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| NetworkInstance | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Composition/bindings | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| AllocationStrategy | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ReservationWindow | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Fragment/Reassembly | optional | optional | ✓ | ✓ | optional | ✓ | optional | ✓ | optional |
| Trust/Signature | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Package | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| EconomicAttribution | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| OperationalLifecycle | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Observability/Evidence | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

A checkmark means the primitive can be applied without adding a vertical-specific field or kernel dependency; optional means the network class may not need that capability.
