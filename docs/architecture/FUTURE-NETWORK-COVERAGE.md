# Future Network Coverage Matrix

> Proves conceptually how the IAAS substrate can support each network type.
> No implementation exists for future networks. This is a coverage proof.

---

## Existing Networks

### Compute

| Domain | Implementation | Notes |
|--------|---------------|-------|
| Identity | ParticipantIdentity + Membership + Role | Standard |
| Resource | ResourceIdentity (resourceKind=compute) → Asset (compute_node) | Via CapacityProvider |
| Capability | gpu_compute / cpu_compute | NetworkVersion-scoped |
| Network | NetworkDefinition + NetworkVersion (runtimeKind=infrastructure) | Via compute-gpu-network template |
| Runtime | InfrastructureRuntime | Resolves ComputeAdapter via AdapterRegistry |
| Execution | NetworkRequest → AllocationDecision → ExecutionAssignment → ExecutionLease | Full control plane |
| Data Plane | N/A (infrastructure runtime) | Compute does not use data plane |
| Verification | Event → VerificationResult → Attestation | Generic, policy-driven |
| Economic Pipeline | EconomicPipelineState → Contribution → Reward → Ledger → Settlement | Migrated (Slice 7) |
| Extensions | N/A | Future |
| Transforms | N/A | Future |

### VPP (Energy)

| Domain | Implementation | Notes |
|--------|---------------|-------|
| Identity | ParticipantIdentity + Membership + Role | Standard |
| Resource | ResourceIdentity (resourceKind=physical) → Asset (battery) | Via CapacityProvider |
| Capability | energy_discharge | NetworkVersion-scoped |
| Network | NetworkDefinition + NetworkVersion (runtimeKind=infrastructure) | Via energy-vpp template |
| Runtime | InfrastructureRuntime | Resolves DERAdapter |
| Execution | VPP dispatch → ExecutionAssignment → ExecutionLease | VPP-specific dispatch + generic execution |
| Data Plane | N/A | Infrastructure runtime |
| Verification | Event → VerificationResult → Attestation | Generic, with VPP-specific baseline |
| Economic Pipeline | EconomicPipelineState → Contribution → Reward → Ledger → Settlement | Migrated (Slice 7) |
| Extensions | N/A | Future |
| Transforms | Baseline calculation (VPP-specific, NOT a generic Transform) | VPP-specific evidence transformation |

### Storage (conceptual — not yet implemented as a vertical)

| Domain | Implementation | Notes |
|--------|---------------|-------|
| Identity | ParticipantIdentity + Membership + Role | Standard |
| Resource | ResourceIdentity (resourceKind=storage) → Asset (storage_server) | Via CapacityProvider |
| Capability | storage_capacity | NetworkVersion-scoped |
| Network | NetworkDefinition + NetworkVersion (runtimeKind=infrastructure) | Via storage template (future) |
| Runtime | InfrastructureRuntime | Resolves StorageAdapter (future) |
| Execution | Full control plane | Same pipeline |
| Data Plane | N/A | Infrastructure runtime |
| Verification | Event → VerificationResult → Attestation | Generic |
| Economic Pipeline | EconomicPipelineState → ... → Settlement | Same generic pipeline |
| Extensions | N/A | Future |
| Transforms | N/A | Future |

### Wireless (conceptual)

| Domain | Implementation | Notes |
|--------|---------------|-------|
| Identity | Standard | |
| Resource | ResourceIdentity (resourceKind=connectivity) → Asset (wifi_ap) | |
| Capability | bandwidth | |
| Network | runtimeKind=infrastructure | |
| Runtime | InfrastructureRuntime | |
| Execution | Full control plane | |
| Verification | Generic | |
| Economic Pipeline | Generic | |

### Manufacturing (conceptual)

| Domain | Implementation | Notes |
|--------|---------------|-------|
| Identity | Standard | |
| Resource | ResourceIdentity (resourceKind=industrial) → Asset (robot) | |
| Capability | production_output | |
| Network | runtimeKind=infrastructure | |
| Runtime | InfrastructureRuntime | |
| Execution | Full control plane | |
| Verification | Generic (may need quality inspection evidence) | |
| Economic Pipeline | Generic | |
| Transforms | Quality inspection (future Transform) | Domain-specific evidence transformation |

### Blockchain (conceptual)

| Domain | Implementation | Notes |
|--------|---------------|-------|
| Identity | Standard | |
| Resource | ResourceIdentity (resourceKind=protocol) | |
| Capability | protocol_transaction | |
| Network | runtimeKind=protocol | |
| Runtime | ProtocolRuntime | |
| Execution | Protocol transaction execution | Different from infrastructure execution |
| Verification | Protocol consensus | Protocol-specific |
| Economic Pipeline | Generic (with protocol receipts as evidence) | |
| Extensions | Consensus algorithms | Future Extension |

---

## New Networks (Future)

### Cloudlet

| Domain | Implementation | Notes |
|--------|---------------|-------|
| Identity | Node (future) + NetworkMembership | Node-based, not just Asset |
| Resource | ResourceIdentity (resourceKind=compute) | Edge compute |
| Capability | edge_compute | |
| Network | runtimeKind=hybrid | Physical execution + protocol coordination |
| Runtime | HybridRuntime | Infra execution + protocol state |
| Execution | Full control plane + protocol transactions | |
| Data Plane | Bundle (future) | Data movement between cloudlets |
| Verification | Generic + protocol finality | |
| Economic Pipeline | Generic | |
| Extensions | Cache strategy, mobility prediction | Future |

### Local-first Internet

| Domain | Implementation | Notes |
|--------|---------------|-------|
| Identity | Node (future) + NetworkMembership | |
| Resource | ResourceIdentity (resourceKind=connectivity) | |
| Capability | local_bandwidth | |
| Network | runtimeKind=hybrid | |
| Runtime | HybridRuntime | |
| Execution | Full control plane | |
| Data Plane | Bundle (future) + DTN semantics | Store-carry-forward |
| Verification | Generic + protocol | |
| Economic Pipeline | Generic | |
| Extensions | Routing strategy, deduplication | Future |
| Transforms | Data compression, encryption | Future Transform |

### TransitNet

| Domain | Implementation | Notes |
|--------|---------------|-------|
| Identity | Node (future) + NetworkMembership | Vehicle as Node |
| Resource | ResourceIdentity (resourceKind=connectivity) | |
| Capability | transit_bandwidth | |
| Network | runtimeKind=hybrid | |
| Runtime | HybridRuntime | |
| Execution | Full control plane | |
| Data Plane | Bundle (future) | Vehicle-to-vehicle, vehicle-to-infrastructure |
| Verification | Generic + protocol | |
| Economic Pipeline | Generic | |
| Extensions | Mobility prediction, routing | Future |
| Transforms | Data transforms for bandwidth optimization | Future |

### Compute Exchange

| Domain | Implementation | Notes |
|--------|---------------|-------|
| Identity | Standard + Node (future) | |
| Resource | ResourceIdentity (resourceKind=compute) | |
| Capability | compute_exchange | |
| Network | runtimeKind=infrastructure | |
| Runtime | InfrastructureRuntime | |
| Execution | Full control plane | |
| Data Plane | Bundle (future) | Workload migration |
| Verification | Generic | |
| Economic Pipeline | Generic | |

### Storage Exchange

| Domain | Implementation | Notes |
|--------|---------------|-------|
| Identity | Standard + Node (future) | |
| Resource | ResourceIdentity (resourceKind=storage) | |
| Capability | storage_exchange | |
| Network | runtimeKind=infrastructure | |
| Runtime | InfrastructureRuntime | |
| Execution | Full control plane | |
| Data Plane | Bundle (future) | Data replication |
| Verification | Generic | |
| Economic Pipeline | Generic | |

### Bandwidth Exchange

| Domain | Implementation | Notes |
|--------|---------------|-------|
| Identity | Standard + Node (future) | |
| Resource | ResourceIdentity (resourceKind=connectivity) | |
| Capability | bandwidth_exchange | |
| Network | runtimeKind=infrastructure | |
| Runtime | InfrastructureRuntime | |
| Execution | Full control plane | |
| Data Plane | Bundle (future) | Traffic routing |
| Verification | Generic | |
| Economic Pipeline | Generic | |

### Data Apps

| Domain | Implementation | Notes |
|--------|---------------|-------|
| Identity | Standard + Node (future) | |
| Resource | ResourceIdentity (resourceKind=compute) | |
| Capability | data_processing | |
| Network | runtimeKind=hybrid | |
| Runtime | HybridRuntime | |
| Execution | Full control plane | |
| Data Plane | Bundle (future) + Transform (future) | Data processing pipeline |
| Verification | Generic + protocol | |
| Economic Pipeline | Generic | |
| Extensions | Privacy-preserving transforms | Future |

---

## Coverage Analysis

### What the substrate already supports

1. **Identity**: ParticipantIdentity/Membership/Role — generic, no vertical assumption.
2. **Resources**: ResourceIdentity/NetworkResourceMembership — universal, supports any resource kind.
3. **Networks**: NetworkDefinition/NetworkVersion with immutable policy — supports any vertical.
4. **Execution**: Full control plane (Request → Allocation → Execution → Lease) — generic.
5. **Economics**: Full pipeline (Event → Settlement) with EconomicPipelineState — generic.
6. **Runtimes**: Three runtime kinds (infrastructure, protocol, hybrid) — covers physical, protocol, and mixed.
7. **Verification**: Policy-driven, extensible via CHECK_REGISTRY — generic.

### What requires new contracts (Phase 13+)

1. **Node**: Protocol participant identity. Cannot be expressed by Asset/Device/ParticipantIdentity alone. A Node may be backed by an Asset but is conceptually distinct.
2. **DataPlane**: No existing contract for receive/store/route/forward/deliver. Bundle is the key missing primitive.
3. **Bundle**: Generic data-plane unit. No existing abstraction.
4. **Transform**: No existing contract for data transformation with provenance.
5. **TransformRegistry**: No existing catalog/versioning for transforms.
6. **Extension**: No existing pluggable behavior contract.
7. **ExtensionRegistry**: No existing publisher/signature/permissions model.
8. **Marketplace**: No existing discovery/publishing layer.
9. **SDK**: No existing generic API contract.

### What does NOT require new contracts

1. **Identity** for new networks: ParticipantIdentity/Membership/Role already supports any participant.
2. **Resources** for new networks: ResourceIdentity/NetworkResourceMembership already supports any resource kind.
3. **Networks** for new networks: NetworkDefinition/NetworkVersion already supports any vertical.
4. **Execution** for new networks: The full control plane is generic.
5. **Economics** for new networks: The generic pipeline is proven by Compute + VPP.
6. **Verification** for new networks: Policy-driven, extensible.
7. **Runtime** for new networks: Three runtime kinds cover infrastructure, protocol, and hybrid.

### Conclusion

The existing IAAS substrate can support all future networks WITHOUT kernel modification, once the Node, DataPlane/Bundle, Transform, and Extension contracts are defined. The economic pipeline, identity model, resource model, network model, and execution model are already generic enough.
