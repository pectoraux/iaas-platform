# IAAS Domain Requirements — IAAS-DOM-ARCH-3

- Domain Architecture: `IAAS-DOM-ARCH-3` (FROZEN)
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Architecture Change Request: `ACR-002`
- Supersedes: `IAAS-DOM-ARCH-2` requirements

> V3 requirements inherit all V2 requirements (DOM-013 VerifiedEvidenceContext)
> and all V1 requirements (DOM-001..DOM-012). Only the new Transform Stack
> requirements (DOM-014..DOM-017) are defined here.

## DOM-014 — Transform Abstract Operation Contract

The platform MUST define a generic `Transform` abstract contract that specifies
the operation interface (`execute`, `reverse`, `estimateCost`, `verify`),
input/output constraints, reversibility, lossiness, and security properties —
without owning storage or becoming a concrete service.

Acceptance requirements:

1. The contract defines `execute(input) → output`, `reverse(output) → input`
   (if reversible), `estimateCost(input) → resource estimate`, and
   `verify(input, output) → boolean`.
2. The contract carries `transformType` (generic string) and `transformVersion`
   (semver) as its stable identity tuple.
3. The contract declares input/output content-type constraints, size limits,
   reversibility, lossiness, and security properties.
4. The contract does NOT own storage, registry, or runtime concerns.
5. The contract is vertical-neutral.

Classification: FROZEN-CONTRACT by ACR-002; implementation pending a future
Work Item after WORK-009 is VERIFIED.

## DOM-015 — TransformRegistry Discovery and Catalog

The platform MUST define a `TransformRegistry` that owns discovery, version
compatibility, certification metadata, and revocation metadata for Transforms —
without executing transforms or becoming a marketplace.

Acceptance requirements:

1. The registry provides lookup by `(transformType, transformVersion)`.
2. The registry enforces version compatibility rules.
3. The registry carries certification metadata (certifier identity, status).
4. The registry carries revocation metadata (status, reason, revokedAt).
5. The registry is tenant-scoped (tenant isolation mandatory).
6. The registry does NOT execute transforms (that is `TransformRuntime`).
7. The registry is service-layer, NOT kernel.
8. The registry imports NO vertical service, NO EconomicPipeline, NO
   Route/Transport, NO RuntimeRegistry.
9. PostgreSQL is the durable source of registry metadata.

Classification: FROZEN-CONTRACT by ACR-002; implementation pending a future
Work Item after WORK-009 is VERIFIED.

## DOM-016 — TransformRuntime Execution Engine

The platform MUST define a `TransformRuntime` that executes Transforms (resolved
via `TransformRegistry`), emits immutable `TransformRecord` provenance, and
provides reverse/cost-estimation/verification — without owning catalog/discovery
or durable record storage.

Acceptance requirements:

1. The runtime executes `Transform.execute()` on payloads.
2. The runtime invokes `Transform.reverse()`, `estimateCost()`, and `verify()`.
3. After execution, the runtime emits an immutable `TransformRecord` with the
   full 7-element provenance.
4. The runtime uses deterministic idempotency keys for replay convergence.
5. The runtime has explicit failure semantics (not silent exceptions).
6. The runtime resolves Transforms via `TransformRegistry` (not vice versa).
7. The runtime does NOT own catalog/discovery (that is `TransformRegistry`).
8. The runtime does NOT own durable record storage (it emits `TransformRecord`).
9. The runtime is service-layer, NOT kernel.
10. The runtime imports NO vertical service, NO EconomicPipeline, NO
    Route/Transport, NO RuntimeRegistry.

Classification: FROZEN-CONTRACT by ACR-002; implementation pending a future
Work Item after WORK-009 is VERIFIED.

## DOM-017 — TransformRecord Provenance Integrity (inherited, unchanged)

`TransformRecord` MUST remain an immutable durable provenance fact with the
7-element fingerprint, service-layer ownership, and no status-field transitions.
This requirement is inherited unchanged from V1/V2 (Phase 14F IMPLEMENTED).

Acceptance requirements:

1. The record carries `inputHash`, `outputHash`, `transformType`,
   `transformVersion`, `parametersJson`, `nodeIdentity`, `resultStatus`.
2. The record is immutable (no status transitions, never updated).
3. The record is service-layer, NOT kernel.
4. The record does NOT become an executor or registry entry.
5. The record has a deterministic fingerprint
   (`SHA-256({bundleId, payloadHash, nodeIdentity, transformType,
   transformVersion, inputHash, outputHash, canonicalize(parameters),
   resultStatus, idempotencyKey})`).

Classification: CONFIRMED (Phase 14F IMPLEMENTED); unchanged from V1/V2.

## Inherited Requirements (unchanged)

- DOM-001..DOM-012 (V1): all identity, runtime, network, pipeline, data-plane,
  PostgreSQL, kernel, and reconciliation requirements.
- DOM-013 (V2): VerifiedEvidenceContext boundary (IMPLEMENTED, VERIFIED by
  WORK-003).
- DOM-P01 (V1): SUPERSEDED by DOM-013 (V2).
- DOM-P02 (V1): SUPERSEDED by DOM-015 (V3) — TransformRegistry promoted.
- DOM-P03 (V1): SUPERSEDED by DOM-016 (V3) — TransformRuntime promoted.
- DOM-P04..DOM-P08 (V1): remain FUTURE/OPEN/RESEARCH (not promoted by V3).
