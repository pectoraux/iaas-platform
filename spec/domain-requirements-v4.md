# IAAS Domain Requirements — IAAS-DOM-ARCH-4 (Candidate)

- Domain Architecture: `IAAS-DOM-ARCH-4` (CANDIDATE — pending ACR-003 approval)
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Architecture Change Request: `ACR-003`
- Supersedes: `IAAS-DOM-ARCH-3` requirements (upon V4 freeze)

> V4 candidate requirements inherit all V3 requirements (DOM-013..DOM-017) and
> all V1/V2 requirements (DOM-001..DOM-012). Only the new Extension Stack
> requirements (DOM-018..DOM-021) are defined here. These are NOT
> acceptance-bearing until ACR-003 is approved and V4 is frozen.

## DOM-018 — Extension Abstract Operation Contract

The platform MUST define a generic `Extension` abstract contract that specifies
pluggable operation capabilities, resource requirements, lifecycle hooks, and
security properties — without owning storage or becoming a concrete service.

Acceptance requirements:

1. The contract defines `execute(context, input) → output`, `reverse?(output) → input`,
   and `verify(input, output) → boolean`.
2. The contract carries `extensionType` (generic string) and `extensionVersion`
   (semver) as its stable identity tuple.
3. The contract declares capabilities, dependencies, resource limits, lifecycle
   hooks, and security properties.
4. The contract does NOT own storage, registry, or runtime concerns.
5. The contract is vertical-neutral.

Classification: FROZEN-CONTRACT by ACR-003 (candidate); implementation pending
a future Work Item after V4 is frozen.

## DOM-019 — ExtensionRegistry Discovery and Catalog

The platform MUST define an `ExtensionRegistry` that owns discovery, version
compatibility, certification metadata, revocation metadata, and lifecycle
metadata for Extensions — without executing extensions or becoming a marketplace.

Acceptance requirements:

1. The registry provides lookup by `(extensionType, extensionVersion)`.
2. The registry enforces version compatibility rules.
3. The registry carries certification metadata (certifier identity, status).
4. The registry carries revocation metadata (status, reason, revokedAt).
5. The registry carries lifecycle metadata (registered/activated/deactivated/revoked).
6. The registry is tenant-scoped (tenant isolation mandatory).
7. The registry does NOT execute extensions (that is `ExtensionRuntime`).
8. The registry is service-layer, NOT kernel.
9. The registry imports NO vertical service, NO EconomicPipeline, NO
   Route/Transport, NO RuntimeRegistry.
10. PostgreSQL is the durable source of registry metadata.

Classification: FROZEN-CONTRACT by ACR-003 (candidate); implementation pending
a future Work Item after V4 is frozen.

## DOM-020 — ExtensionRuntime Execution and Isolation Engine

The platform MUST define an `ExtensionRuntime` that executes Extensions (resolved
via `ExtensionRegistry`), enforces capability scoping and resource limits, emits
immutable provenance, and provides reverse/verify — without owning catalog/
discovery or durable record storage.

Acceptance requirements:

1. The runtime executes `Extension.execute()` within an isolation boundary.
2. The runtime enforces declared capabilities and resource limits.
3. The runtime invokes `Extension.reverse()` and `Extension.verify()`.
4. After execution, the runtime emits an immutable provenance record.
5. The runtime uses deterministic idempotency keys for replay convergence.
6. The runtime has explicit failure semantics (not silent exceptions).
7. The runtime resolves Extensions via `ExtensionRegistry` (not vice versa).
8. The runtime does NOT own catalog/discovery (that is `ExtensionRegistry`).
9. The runtime is service-layer, NOT kernel.
10. The runtime imports NO vertical service, NO EconomicPipeline, NO
    Route/Transport, NO RuntimeRegistry.
11. The concrete sandbox technology (WASM/container/native) remains OPEN/RESEARCH.

Classification: FROZEN-CONTRACT by ACR-003 (candidate); implementation pending
a future Work Item after V4 is frozen.

## DOM-021 — Extension↔Transform Relationship

Extensions MAY invoke Transforms via `TransformRuntime`. The relationship is
one-way: Extension → TransformRuntime (resolve + execute). Extensions do NOT
own or mutate TransformRegistry or TransformRecord. Transforms do NOT import
or depend on ExtensionRegistry or ExtensionRuntime.

Acceptance requirements:

1. Extensions MAY call `TransformRuntime.executeTransform()`.
2. Extensions do NOT import or mutate `TransformRegistry`.
3. Extensions do NOT import or mutate `TransformRecord`.
4. Transforms do NOT import `ExtensionRegistry` or `ExtensionRuntime`.
5. Neither stack becomes the other.

Classification: FROZEN-CONTRACT by ACR-003 (candidate).

## Inherited Requirements (unchanged)

- DOM-001..DOM-012 (V1): all identity, runtime, network, pipeline, data-plane,
  PostgreSQL, kernel, and reconciliation requirements.
- DOM-013 (V2): VerifiedEvidenceContext boundary (IMPLEMENTED, VERIFIED).
- DOM-014..DOM-017 (V3): Transform Stack (all IMPLEMENTED and VERIFIED).
- DOM-P01 (V1): SUPERSEDED by DOM-013 (V2).
- DOM-P02 (V1): SUPERSEDED by DOM-015 (V3).
- DOM-P03 (V1): SUPERSEDED by DOM-016 (V3).
- DOM-P04 (V1): SUPERSEDED by DOM-018..DOM-020 (V4 candidate) — pending ACR-003
  approval. NOT promoted until the Architect freezes V4.
- DOM-P05..DOM-P08 (V1): remain FUTURE/OPEN/RESEARCH (not promoted by V4).
