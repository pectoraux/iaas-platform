# IAAS Domain Dependency Graph — IAAS-DOM-ARCH-4

- Domain Architecture: `IAAS-DOM-ARCH-4` (FROZEN)
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Architecture Change Request: `ACR-003` (APPROVED)
- Derived by: `WORK-014`; frozen by `WORK-015`

## Extension Stack DAG

```text
Extension (abstract contract)
    ↓
ExtensionRegistry (discovery/catalog/lifecycle authority)
    ↓
ExtensionRuntime (execution/isolation engine)
    ↓
ExtensionProvenance (immutable durable record / provenance boundary)
```

## Extension → Transform Relationship

```text
ExtensionRuntime → TransformRuntime.executeTransform()
ExtensionRuntime → TransformRegistry (read-only lookup)
```

Transform Stack does not depend on Extension Stack.

## Extension Stack Anti-Dependencies

```text
ExtensionRegistry  ✗-> Vertical services
ExtensionRuntime   ✗-> Vertical services
ExtensionRegistry  ✗-> EconomicPipeline / Contribution / Reward / Ledger / Settlement
ExtensionRuntime   ✗-> EconomicPipeline / Contribution / Reward / Ledger / Settlement
ExtensionRegistry  ✗-> Route / Transport / DeliveryConfirmation
ExtensionRuntime   ✗-> Route / Transport / DeliveryConfirmation
ExtensionRegistry  ✗-> RuntimeRegistry / InfrastructureRuntime / ProtocolRuntime / HybridRuntime
ExtensionRuntime   ✗-> RuntimeRegistry / InfrastructureRuntime / ProtocolRuntime / HybridRuntime
ExtensionRegistry  ✗-> Kernel
ExtensionRuntime   ✗-> Kernel
Kernel             ✗-> ExtensionRegistry / ExtensionRuntime
EconomicPipeline   ✗-> ExtensionRegistry / ExtensionRuntime
Route/Transport    ✗-> ExtensionRegistry / ExtensionRuntime
TransformStack     ✗-> ExtensionRegistry / ExtensionRuntime
```

The Extension Stack remains service-layer and vertical-neutral.

## Inherited V3 Dependency Graph

The V3 graph remains unchanged and is inherited. V4 adds only the approved Extension Stack dependency delta above.

## Acyclicity

The V4 domain dependency graph is acyclic. The Extension→Transform dependency is one-way and cannot create a cycle.