# BASE-017 — TransformRegistry Implementation

The frozen `IAAS-DOM-ARCH-3` TransformRegistry contract MUST be implemented as a service-layer, tenant-scoped discovery and catalog boundary without executing transforms or importing vertical, economic, route/transport, runtime-registry, or kernel code.

Acceptance:

- `W010-AC01` through `W010-AC08` pass with PostgreSQL and static architecture evidence.
