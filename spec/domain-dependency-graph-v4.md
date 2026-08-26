# IAAS Domain Dependency Graph — IAAS-DOM-ARCH-4 (Candidate)

- Domain Architecture: `IAAS-DOM-ARCH-4` (CANDIDATE — pending ACR-003 approval)
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Architecture Change Request: `ACR-003`
- Derived by: `WORK-014` from `spec/domain-architecture-v4.md`

> This is the V4 candidate domain-primitive dependency graph. All edges and
> prohibitions below are **proposed** — they become frozen only upon V4 freeze.
> V3 remains immutable; this is a candidate.

## Extension Stack DAG (proposed)

```text
Extension (abstract contract)
    ↓
ExtensionRegistry (discovery/catalog/lifecycle authority)
    ↓
ExtensionRuntime (execution/isolation engine)
    ↓
ExtensionProvenance (immutable durable provenance record)
```

## Extension → Transform Relationship (one-way, proposed)

```text
ExtensionRuntime → TransformRuntime.executeTransform()
ExtensionRuntime → TransformRegistry (read-only lookup, does not mutate)
```

Transform Stack does NOT import Extension Stack (one-way dependency).

## Extension Stack Anti-Dependencies (proposed — MUST NOT depend on)

```text
ExtensionRegistry  ✗-> VPP | Compute | Storage | Wireless | Manufacturing
ExtensionRuntime   ✗-> VPP | Compute | Storage | Wireless | Manufacturing

ExtensionRegistry  ✗-> EconomicPipeline | Contribution | Reward | Ledger | Settlement
ExtensionRuntime   ✗-> EconomicPipeline | Contribution | Reward | Ledger | Settlement

ExtensionRegistry  ✗-> Route | TransportExecution | TransportAttempt | DeliveryConfirmation
ExtensionRuntime   ✗-> Route | TransportExecution | TransportAttempt | DeliveryConfirmation

ExtensionRegistry  ✗-> RuntimeRegistry | InfrastructureRuntime | ProtocolRuntime | HybridRuntime
ExtensionRuntime   ✗-> RuntimeRegistry | InfrastructureRuntime | ProtocolRuntime | HybridRuntime

ExtensionRegistry  ✗-> Kernel (src/lib/kernel/)
ExtensionRuntime   ✗-> Kernel (src/lib/kernel/)

ExtensionRuntime   ✗-> ExtensionProvenance (runtime emits payload; provenance service owns storage)

Kernel             ✗-> ExtensionRegistry | ExtensionRuntime
EconomicPipeline   ✗-> ExtensionRegistry | ExtensionRuntime
Route/Transport    ✗-> ExtensionRegistry | ExtensionRuntime
TransformStack     ✗-> ExtensionRegistry | ExtensionRuntime (one-way: Extension → Transform only)
```

## Inherited V3 Dependency Graph

The V3 graph (including the Transform Stack DAG, VerifiedEvidenceContext
boundary, control-plane pipeline, runtime kernel, economic pipeline, data-plane
primitive direction, and Data Plane ↔ Economic Pipeline parallel-substrate
independence) remains unchanged. See `spec/domain-dependency-graph-v3.md` and
earlier versions for the inherited graphs.

## Acyclicity

The Extension Stack DAG is acyclic. The Extension → Transform relationship is
one-way (no cycle). The Extension Stack is independent of the Economic Pipeline,
Data Plane routing/transport, and the Runtime Kernel — it is a parallel
service-layer substrate.
