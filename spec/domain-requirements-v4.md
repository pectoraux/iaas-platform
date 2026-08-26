# IAAS Domain Requirements — IAAS-DOM-ARCH-4

- Domain Architecture: `IAAS-DOM-ARCH-4` (FROZEN)
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Architecture Change Request: `ACR-003` (APPROVED)
- Supersedes: `IAAS-DOM-ARCH-3` requirements (historical immutable record)

> V4 requirements inherit all V3 requirements (DOM-013..DOM-017) and all V1/V2 requirements (DOM-001..DOM-012). DOM-018..DOM-022 are now frozen acceptance-bearing requirements under approved ACR-003.

## DOM-018 — Extension Abstract Operation Contract

The platform MUST define a generic `Extension` abstract contract that specifies pluggable operation capabilities, resource requirements, lifecycle hooks, and security properties without owning storage or becoming a concrete service.

Acceptance requirements:
1. `execute(context, input) → output`, optional `reverse(output) → input`, and `verify(input, output) → boolean`.
2. Stable identity: `extensionType` + semver `extensionVersion`.
3. Declared capabilities, dependencies, resource limits, lifecycle hooks, security properties.
4. No storage, registry, or runtime ownership.
5. Vertical-neutral.

Classification: **FROZEN-CONTRACT** by approved ACR-003. Concrete implementations remain future.

## DOM-019 — ExtensionRegistry Discovery and Catalog

The platform MUST define `ExtensionRegistry` as discovery/catalog/version/lifecycle authority without executing extensions or becoming a marketplace.

Acceptance requirements:
1. Lookup by `(extensionType, extensionVersion)`.
2. Version compatibility rules.
3. Certification metadata.
4. Revocation metadata.
5. Registry is authoritative lifecycle-state owner.
6. Tenant-scoped isolation.
7. No execution.
8. Service-layer, not kernel.
9. No vertical/EconomicPipeline/Route/Transport/RuntimeRegistry imports.
10. PostgreSQL durable source of registry metadata.

Classification: **FROZEN-CONTRACT** by approved ACR-003. Production implementation remains future.

## DOM-020 — ExtensionRuntime Execution and Isolation Engine

The platform MUST define `ExtensionRuntime` as execution/isolation authority resolving through `ExtensionRegistry`, enforcing capabilities/resource limits, and emitting immutable `ExtensionProvenance` without owning catalog/lifecycle state or durable provenance storage.

Acceptance requirements:
1. Execute within isolation boundary.
2. Enforce runtime ceiling = minimum of extension-declared and tenant/operator-approved capabilities/resource limits.
3. Invoke reverse/verify.
4. Emit immutable `ExtensionProvenance` after execution.
5. Deterministic idempotency/replay convergence.
6. Explicit failure semantics; failed executions emit failed provenance and re-throw.
7. Resolve through Registry, not vice versa.
8. No catalog/lifecycle ownership.
9. Observe lifecycle and allow execution only while activated.
10. Service-layer, not kernel.
11. No vertical/EconomicPipeline/Route/Transport/RuntimeRegistry imports.
12. Sandbox technology remains OPEN/RESEARCH.

Classification: **FROZEN-CONTRACT** by approved ACR-003. Production implementation remains future.

## DOM-021 — Extension↔Transform Relationship

Extensions MAY invoke Transforms through `TransformRuntime` one-way. Extensions do not own/mutate TransformRegistry or TransformRecord; Transform Stack components do not depend on Extension Stack.

Classification: **FROZEN-CONTRACT** by approved ACR-003.

## DOM-022 — ExtensionProvenance Durable Record

The platform MUST define immutable `ExtensionProvenance` durable provenance for Extension execution.

Acceptance requirements:
1. Fields: tenantId, extensionType, extensionVersion, executionIdempotencyKey, inputHash, outputHash, resultStatus, resourceUsage, capabilitiesExercised, tenantApprovedCeiling, createdAt.
2. Immutable after creation.
3. Tenant-scoped; cross-tenant queries prohibited.
4. Fingerprint: `SHA-256({tenantId, extensionType, extensionVersion, executionIdempotencyKey, inputHash, outputHash, resultStatus})`.
5. Repeated identical attempts converge 1:1 per tenant/idempotency key.
6. Provenance emitted after success/failure; failed execution emits `resultStatus='failed'` and re-throws.
7. Owned by a service-layer provenance boundary, not ExtensionRuntime.
8. PostgreSQL durable source of truth.

Classification: **FROZEN-CONTRACT** by approved ACR-003. Prisma/service implementation remains future.

## Inherited Requirements

- DOM-001..DOM-012 (V1): identity, runtime, network, pipeline, data-plane, PostgreSQL, kernel, reconciliation.
- DOM-013 (V2): VerifiedEvidenceContext (IMPLEMENTED, VERIFIED).
- DOM-014..DOM-017 (V3): Transform Stack (IMPLEMENTED, VERIFIED).
- DOM-P01: SUPERSEDED by DOM-013.
- DOM-P02: SUPERSEDED by DOM-015.
- DOM-P03: SUPERSEDED by DOM-016.
- DOM-P04 (V1): **SUPERSEDED by DOM-018..DOM-022 under approved ACR-003**.
- DOM-P05..DOM-P08: remain FUTURE/OPEN/RESEARCH.
