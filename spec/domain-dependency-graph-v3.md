# IAAS Domain Dependency Graph — IAAS-DOM-ARCH-3

- Domain Architecture: `IAAS-DOM-ARCH-3` (FROZEN)
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Architecture Change Request: `ACR-002`
- Derived by: `WORK-009` from `spec/domain-architecture-v3.md`

> This is the V3 domain-primitive dependency graph. It extends the V2 graph
> with the Transform Stack boundary. V2 remains immutable; this is the current
> canonical graph.

## Transform Stack DAG (frozen direction)

```text
Transform (abstract contract)
    ↓
TransformRegistry (discovery/catalog)
    ↓
TransformRuntime (execution engine)
    ↓
TransformRecord (immutable provenance fact — IMPLEMENTED, Phase 14F)
```

## Transform Stack Anti-Dependencies (MUST NOT depend on)

```text
TransformRegistry  ✗-> VPP | Compute | Storage | Wireless | Manufacturing
TransformRuntime   ✗-> VPP | Compute | Storage | Wireless | Manufacturing

TransformRegistry  ✗-> EconomicPipeline | Contribution | Reward | Ledger | Settlement
TransformRuntime   ✗-> EconomicPipeline | Contribution | Reward | Ledger | Settlement

TransformRegistry  ✗-> Route | TransportExecution | TransportAttempt | DeliveryConfirmation
TransformRuntime   ✗-> Route | TransportExecution | TransportAttempt | DeliveryConfirmation

TransformRegistry  ✗-> RuntimeRegistry | InfrastructureRuntime | ProtocolRuntime | HybridRuntime
TransformRuntime   ✗-> RuntimeRegistry | InfrastructureRuntime | ProtocolRuntime | HybridRuntime

TransformRegistry  ✗-> Kernel (src/lib/kernel/)
TransformRuntime   ✗-> Kernel (src/lib/kernel/)

Kernel             ✗-> TransformRegistry | TransformRuntime
EconomicPipeline   ✗-> TransformRegistry | TransformRuntime
Route/Transport    ✗-> TransformRegistry | TransformRuntime
```

## Inherited V2 Dependency Graph

The V2 graph (including the VerifiedEvidenceContext boundary, the control-plane
pipeline, the runtime kernel, the economic pipeline, the data-plane primitive
direction, and the Data Plane ↔ Economic Pipeline parallel-substrate
independence) remains unchanged. See `spec/domain-dependency-graph-v2.md` and
`spec/domain-dependency-graph.md` (V1) for the inherited graphs.

## Acyclicity

The Transform Stack DAG is acyclic. The frozen direction is:

```text
Transform > TransformRegistry > TransformRuntime > TransformRecord
```

No transform primitive depends on a higher-level primitive. The Transform Stack
is independent of the Economic Pipeline, Data Plane routing/transport, and the
Runtime Kernel — it is a parallel service-layer substrate that operates on
payloads, not on delivery paths or economic outcomes.
