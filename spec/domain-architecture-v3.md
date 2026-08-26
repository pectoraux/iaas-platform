# IAAS Domain Architecture — IAAS-DOM-ARCH-3

- Domain Architecture Version: `IAAS-DOM-ARCH-3`
- Status: **FROZEN**
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Supersedes: `IAAS-DOM-ARCH-2` (FROZEN — immutable historical record)
- Architecture Change Request: `ACR-002` (APPROVED)
- Produced by: `WORK-009` (Transform Stack Architecture Freeze)

> This document is the canonical Domain Architecture V3. It preserves every
> rule and primitive of `IAAS-DOM-ARCH-2` except the explicit Transform Stack
> boundary addition defined below. V2 remains immutable historical architecture;
> this document is the current canonical domain architecture.
>
> Per `IAAS-GOV-ARCH-1` frozen rule 3: domain architecture changes require an
> Architecture Change Request and a new version. `ACR-002` authorized this
> version; `WORK-009` freezes it. No production implementation of
> TransformRegistry or TransformRuntime is authorized by this architecture —
> only the contract is frozen. Implementation requires a separate Work Item
> that becomes eligible only after WORK-009 is VERIFIED.

## 1. Version Relationship

`IAAS-DOM-ARCH-3` preserves every rule and primitive of `IAAS-DOM-ARCH-2` except
the explicit Transform Stack boundary defined in §2. The V2 document remains
immutable historical architecture; this document is the current canonical.

V2 inherited from V1: the `VerifiedEvidenceContext` boundary (ACR-001/WORK-003).
V3 inherits from V2: the `VerifiedEvidenceContext` boundary + all V1/V2 rules.
V3 adds: the Transform Stack boundary (Transform → TransformRegistry →
TransformRuntime → TransformRecord).

## 2. Transform Stack Boundary

### 2.1 Purpose

The Transform Stack is the generic, vertical-neutral contract for defining,
discovering, executing, and recording data-plane transforms. It promotes the
currently-FUTURE `TransformRegistry` and `TransformRuntime` concepts from V2
into frozen architectural primitives, while preserving the already-implemented
`TransformRecord` provenance primitive (Phase 14F / WORK-002).

### 2.2 Transform Stack Pipeline

```text
Transform (abstract operation contract)
    ↓
TransformRegistry (discovery, version compatibility, certification/revocation)
    ↓
TransformRuntime (execution, reverse, cost estimation, verification)
    ↓
TransformRecord (immutable durable provenance fact)
```

### 2.3 Transform — Abstract Operation Contract

`Transform` is the abstract contract for a data-plane operation that can be
applied to a Bundle's payload. It is NOT a concrete service, NOT a registry
entry, and NOT a runtime — it is the interface that registry entries describe
and the runtime executes.

Contract:

```text
Transform
  ├─ identity: transformType (generic string) + transformVersion (semver)
  ├─ execute(input): output
  ├─ reverse(output): input   (if reversible)
  ├─ estimateCost(input): resource estimate
  ├─ verify(input, output): boolean
  ├─ inputConstraints: content types, size limits
  ├─ outputConstraints: content types, size limits
  ├─ reversibility: boolean
  ├─ lossiness: boolean
  └─ securityProperties: declared, not enforced by the contract itself
```

Classification: **FROZEN-CONTRACT** — the abstract operation contract is frozen;
concrete Transform implementations are future (not authorized by this version).

### 2.4 TransformRegistry — Discovery and Catalog

`TransformRegistry` is the catalog/discovery primitive. It owns:

- **Discovery**: lookup by `transformType` + `transformVersion`.
- **Version compatibility**: compatibility rules between transform versions.
- **Certification metadata**: certification status, certifier identity.
- **Revocation metadata**: revocation status, revocation reason, revokedAt.
- **Tenant isolation**: registry lookups are tenant-scoped.

`TransformRegistry` is NOT:
- an execution engine (that is `TransformRuntime`);
- a marketplace (discovery/publishing/licensing is future);
- a kernel primitive (it is service-layer);
- a vertical-specific catalog.

Classification: **FROZEN-CONTRACT** — the registry contract is frozen;
production implementation is future (requires a separate Work Item after
WORK-009 is VERIFIED).

### 2.5 TransformRuntime — Execution Engine

`TransformRuntime` is the execution engine. It owns:

- **Execute**: invoke a Transform's `execute()` on a payload.
- **Reverse**: invoke a Transform's `reverse()` (if reversible).
- **Cost estimation**: invoke a Transform's `estimateCost()`.
- **Verify**: invoke a Transform's `verify()`.
- **Provenance emission**: after execution, emit an immutable `TransformRecord`
  capturing the full provenance (inputHash, outputHash, transformType,
  transformVersion, parameters, nodeId, resultStatus).
- **Idempotency**: deterministic idempotency keys for replay convergence.
- **Failure semantics**: explicit failure states (not silent exceptions).

`TransformRuntime` is NOT:
- a registry (it resolves transforms via `TransformRegistry`, not vice versa);
- a durable record (it emits `TransformRecord`, but does not own durable storage);
- a kernel primitive (it is service-layer);
- coupled to EconomicPipeline, Route, TransportExecution, or RuntimeRegistry.

Classification: **FROZEN-CONTRACT** — the runtime contract is frozen;
production implementation is future (requires a separate Work Item after
WORK-009 is VERIFIED).

### 2.6 TransformRecord — Immutable Provenance (IMPLEMENTED, unchanged)

`TransformRecord` remains the immutable durable provenance fact implemented in
Phase 14F (`src/lib/services/transform-record.service.ts`). Its contract is
unchanged from V1/V2:

- 7-element provenance: `inputHash`, `outputHash`, `transformType`,
  `transformVersion`, `parametersJson`, `nodeIdentity`, `resultStatus`.
- Immutable: no status field that transitions; never updated.
- Service-layer: NOT a kernel primitive.
- Deterministic fingerprint: `SHA-256({bundleId, payloadHash, nodeIdentity,
  transformType, transformVersion, inputHash, outputHash, canonicalize(parameters),
  resultStatus, idempotencyKey})`.

`TransformRecord` does NOT:
- become an execution primitive (it is a fact, not an executor);
- become a registry entry (it records what happened, not what is available);
- own transform storage (it references transforms by type+version, not by registry ID).

Classification: **IMPLEMENTED** (Phase 14F) — unchanged from V1/V2.

### 2.7 Dependency Direction (frozen)

```text
Transform (abstract contract)
    ↓ (TransformRegistry describes Transforms)
TransformRegistry (catalog/discovery)
    ↓ (TransformRuntime resolves Transforms via TransformRegistry)
TransformRuntime (execution engine)
    ↓ (TransformRuntime emits TransformRecord after execution)
TransformRecord (immutable provenance fact)
```

### 2.8 Anti-Dependency Prohibitions (frozen)

The Transform Stack MUST NOT depend on:

- **Vertical services**: VPP, Compute, Storage, Wireless, Manufacturing.
- **Economic Pipeline**: `economic-pipeline.ts`, contribution/reward/ledger/settlement.
- **Route/Transport**: `routing.service`, `transport.service`,
  `delivery-confirmation.service` (Transform is independent of routing/transport;
  it operates on payloads, not on delivery paths).
- **RuntimeRegistry**: `RuntimeRegistry`, `InfrastructureRuntime`,
  `ProtocolRuntime`, `HybridRuntime` (Transform is service-layer, not runtime-kernel).
- **Kernel**: `src/lib/kernel/` (Transform is NOT a kernel primitive).

The Transform Stack MUST NOT be imported by:

- **Kernel** (`src/lib/kernel/`).
- **Economic Pipeline** (the pipeline does not import transforms).
- **Data-plane routing/transport** (routing/transport do not import transforms).

Exception: `TransformRecord` may be imported by future consumers that need to
read provenance facts (e.g., audit, economic attribution — via future contracts).

### 2.9 Boundary Rules

1. `TransformRegistry` does NOT execute transforms.
2. `TransformRuntime` does NOT own catalog/discovery (it resolves via Registry).
3. `TransformRecord` does NOT become an executor or registry entry.
4. `Transform` abstract contract does NOT own storage.
5. The Transform Stack is tenant-scoped.
6. PostgreSQL is the durable source of registry metadata/provenance where
   persistence is required.
7. Deterministic version identity: `(transformType, transformVersion)` is the
   stable identity tuple.
8. Idempotency: transform execution uses deterministic idempotency keys.
9. Failure semantics: explicit failure states, not silent exceptions.
10. No premature technology decisions: sandbox, marketplace, SDK,
    cryptographic-signature, and plugin-packaging formats remain OPEN / RESEARCH.

## 3. Inherited Architecture

All V2 rules remain unchanged:

- `VerifiedEvidenceContext` boundary (ACR-001 / WORK-003) — IMPLEMENTED.
- All V1 rules: identity/resource boundaries, runtime isolation, control-plane
  pipeline, economic pipeline vertical-leakage prohibition, data-plane
  independence, PostgreSQL mandate, Phase 14A–14F primitives, reconciliation
  anti-conflation, kernel boundary restraint.
- All anti-drift rules (constitution §16).
- DOM-P02 (TransformRegistry) and DOM-P03 (TransformRuntime) are now
  SUPERSEDED by this V3 freeze (promoted from FUTURE to FROZEN-CONTRACT).
  See `spec/domain-requirements-v3.md` for DOM-015 and DOM-016.
- DOM-P04..P08 remain FUTURE/OPEN/RESEARCH (not promoted by this version).

## 4. Technology Decisions Deferred (OPEN / RESEARCH)

The following remain explicitly undecided and are NOT frozen by V3:

- Extension sandbox technology (WASM / container / native).
- Marketplace model (discovery/publishing/licensing/commercial).
- SDK API.
- Cryptographic signature system for transform certification.
- Plugin packaging format.
- Pricing/settlement for transforms.
- Economic attribution of transform execution.

## 5. Verification Requirements

The implementation of TransformRegistry/TransformRuntime (future Work Items)
MUST prove:

1. Transform/Registry/Runtime responsibilities are non-overlapping.
2. TransformRecord remains immutable provenance, service-layer only.
3. All anti-dependency prohibitions are mechanically enforced.
4. Tenant isolation is preserved.
5. Deterministic version identity and compatibility rules.
6. Idempotency and failure semantics are explicit.
7. No kernel ownership, no vertical imports, no EconomicPipeline coupling.
8. No Route/Transport/RuntimeRegistry coupling.
9. Provenance emission into TransformRecord is correct.
10. PostgreSQL remains the durable source of truth for registry metadata.
