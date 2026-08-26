# IAAS Domain Architecture — IAAS-DOM-ARCH-4 (Candidate)

- Domain Architecture Version: `IAAS-DOM-ARCH-4`
- Status: **CANDIDATE** (pending Architect approval of ACR-003)
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Supersedes: `IAAS-DOM-ARCH-3` (FROZEN — will become immutable historical record upon V4 freeze)
- Architecture Change Request: `ACR-003` (UNDER_REVIEW)
- Produced by: `WORK-014` (Extension Stack Architecture)

> This document is a **candidate** domain architecture. It is NOT frozen until
> the Architect explicitly approves ACR-003. V3 remains the current canonical
> domain architecture until that approval. This candidate preserves V3 except
> for the explicit Extension Stack boundary addition defined below.

## 1. Version Relationship

`IAAS-DOM-ARCH-4` preserves every rule and primitive of `IAAS-DOM-ARCH-3`
except the Extension Stack boundary. V3 remains immutable; this candidate is
a new version that will supersede V3 upon Architect approval.

V3 inherited from V2: `VerifiedEvidenceContext` (ACR-001) + Transform Stack
(ACR-002). V4 inherits from V3: all of the above + Extension Stack (ACR-003
candidate).

## 2. Extension Stack Boundary

### 2.1 Purpose

The Extension Stack is the generic, vertical-neutral contract for pluggable
operations that can modify or enhance platform behavior — routing strategies,
scheduling algorithms, mobility prediction, cache strategies, deduplication,
protocol algorithms, security behaviors, and transform invocation (per
constitution §10). It does NOT replace the Transform Stack; Extensions and
Transforms are distinct subsystems with a one-way relationship.

### 2.2 Extension Stack Pipeline

```text
Extension (abstract pluggable operation contract)
    ↓
ExtensionRegistry (discovery, version compatibility, certification/revocation, lifecycle)
    ↓
ExtensionRuntime (execution, isolation, capability enforcement, provenance)
    ↓
ExtensionProvenance (immutable record of extension execution — future durable model)
```

### 2.3 Extension — Abstract Pluggable Operation Contract

`Extension` is the abstract contract for a pluggable operation. It declares
capabilities, resource requirements, and lifecycle hooks without owning
storage or becoming a concrete service.

Contract:

```text
Extension
  ├─ identity: extensionType (generic string) + extensionVersion (semver)
  ├─ capabilities: declared capability set (e.g. routing_strategy, scheduling, cache)
  ├─ dependencies: declared dependencies on other Extensions or Transforms
  ├─ resourceLimits: cpu, memory, time limits declared by the extension
  ├─ lifecycle hooks: onInstall, onActivate, onDeactivate, onUninstall
  ├─ execute(context, input): output
  ├─ reverse?(output): input (if reversible)
  ├─ verify(input, output): boolean
  ├─ securityProperties: declared (publisher identity, signature status)
  └─ compatibilityRules: version compatibility constraints
```

Classification: **FROZEN-CONTRACT** — the abstract contract is frozen; concrete
Extension implementations remain future (not authorized by this version).

### 2.4 ExtensionRegistry — Discovery and Catalog

`ExtensionRegistry` owns:

- **Discovery**: lookup by `(extensionType, extensionVersion)`.
- **Version compatibility**: compatibility rules between extension versions.
- **Certification metadata**: certifier identity, certification status.
- **Revocation metadata**: revocation status, reason, revokedAt.
- **Lifecycle metadata**: install/activate/deactivate/uninstall status.
- **Tenant isolation**: registry lookups are tenant-scoped.

`ExtensionRegistry` is NOT:
- an execution engine (that is `ExtensionRuntime`);
- a marketplace (discovery/publishing/licensing is future — `DOM-P05`);
- a kernel primitive (it is service-layer);
- a vertical-specific catalog;
- a TransformRegistry replacement.

Classification: **FROZEN-CONTRACT** — the registry contract is frozen;
production implementation is future.

### 2.5 ExtensionRuntime — Execution and Isolation Engine

`ExtensionRuntime` owns:

- **Execute**: invoke an Extension's `execute()` within an isolation boundary.
- **Reverse**: invoke an Extension's `reverse()` (if reversible).
- **Verify**: invoke an Extension's `verify()`.
- **Capability enforcement**: enforce declared capabilities and resource limits.
- **Isolation**: enforce isolation boundaries (resource limits, capability
  scoping) — the concrete sandbox technology (WASM/container/native) remains
  OPEN/RESEARCH.
- **Provenance emission**: after execution, emit an immutable provenance record.
- **Idempotency**: deterministic idempotency keys for replay convergence.
- **Failure semantics**: explicit failure states (not silent exceptions).

`ExtensionRuntime` is NOT:
- a registry (it resolves extensions via `ExtensionRegistry`, not vice versa);
- a durable record owner (it emits provenance, does not own storage);
- a kernel primitive (it is service-layer);
- a TransformRuntime replacement;
- coupled to EconomicPipeline, Route, Transport, RuntimeRegistry, or kernel.

Classification: **FROZEN-CONTRACT** — the runtime contract is frozen;
production implementation is future.

### 2.6 Extension↔Transform Relationship

Extensions MAY invoke Transforms via `TransformRuntime` (resolve + execute).
The relationship is one-way:

```text
Extension → TransformRuntime.executeTransform()
```

Extensions do NOT:
- own or mutate `TransformRegistry`;
- own or mutate `TransformRecord`;
- become TransformRegistry or TransformRuntime;
- bypass the Transform Stack's anti-dependency rules.

Transforms do NOT:
- import or depend on ExtensionRegistry or ExtensionRuntime;
- become Extensions.

### 2.7 Dependency Direction (frozen)

```text
Extension (abstract contract)
    ↓ (ExtensionRegistry describes Extensions)
ExtensionRegistry (catalog/discovery/lifecycle)
    ↓ (ExtensionRuntime resolves Extensions via ExtensionRegistry)
ExtensionRuntime (execution/isolation engine)
    ↓ (ExtensionRuntime emits provenance)
ExtensionProvenance (immutable record — future durable model)
```

### 2.8 Anti-Dependency Prohibitions (frozen)

The Extension Stack MUST NOT depend on:

- **Vertical services**: VPP, Compute, Storage, Wireless, Manufacturing.
- **Economic Pipeline**: `economic-pipeline.ts`, contribution/reward/ledger/settlement.
- **Route/Transport**: `routing.service`, `transport.service`,
  `delivery-confirmation.service`.
- **RuntimeRegistry**: `RuntimeRegistry`, `InfrastructureRuntime`,
  `ProtocolRuntime`, `HybridRuntime`.
- **Kernel**: `src/lib/kernel/`.

The Extension Stack MUST NOT be imported by:

- **Kernel** (`src/lib/kernel/`).
- **Economic Pipeline**.
- **Data-plane routing/transport** (unless through explicit future contracts).

The Extension Stack MAY import:
- `TransformRuntime` (one-way: Extension → TransformRuntime, not vice versa).
- `TransformRegistry` (read-only lookup, does not mutate).

### 2.9 Security and Isolation (contract-level, not technology)

The contract defines isolation *obligations*:

1. **Capability scoping**: an Extension can only exercise its declared capabilities.
2. **Resource limits**: CPU, memory, and time limits are declared and enforced.
3. **Tenant isolation**: Extensions are tenant-scoped; cross-tenant execution
   is prohibited.
4. **Publisher identity**: declared as metadata; cryptographic verification is
   future (not frozen by this contract).
5. **Provenance**: every Extension execution emits an immutable provenance record.
6. **Failure containment**: an Extension failure does not crash the platform;
   failures are caught and recorded.

The concrete sandbox technology (WASM/container/native) remains OPEN/RESEARCH.
Implementation selects technology in a future Work Item.

### 2.10 Lifecycle

Extension lifecycle:

```text
registered → activated → executing → deactivated → revoked
```

- `registered`: Extension is cataloged in ExtensionRegistry.
- `activated`: Extension is available for execution.
- `executing`: ExtensionRuntime is currently executing the Extension.
- `deactivated`: Extension is paused (not available for execution, but
  cataloged).
- `revoked`: Extension is permanently disabled (remains in catalog for audit).

Lifecycle transitions are managed by ExtensionRegistry (metadata) and
enforced by ExtensionRuntime (execution gate).

## 3. Inherited Architecture

All V3 rules remain unchanged:

- `VerifiedEvidenceContext` boundary (ACR-001 / WORK-003) — IMPLEMENTED.
- Transform Stack (ACR-002 / WORK-009): Transform, TransformRegistry,
  TransformRuntime, TransformRecord — all IMPLEMENTED (WORK-010/011 VERIFIED).
- All V1/V2 rules: identity/resource boundaries, runtime isolation, control-plane
  pipeline, economic pipeline vertical-leakage prohibition, data-plane
  independence, PostgreSQL mandate, Phase 14A–14F primitives, reconciliation
  anti-conflation, kernel boundary restraint.
- All anti-drift rules (constitution §16).
- `DOM-P04` (Extension + ExtensionRegistry + ExtensionRuntime): SUPERSEDED by
  this V4 candidate (promoted from FUTURE to FROZEN-CONTRACT) — pending ACR-003
  approval. See `spec/domain-requirements-v4.md` for DOM-018..DOM-021.
- `DOM-P05..P08` remain FUTURE/OPEN/RESEARCH (not promoted by this version).

## 4. Technology Decisions Deferred (OPEN / RESEARCH)

The following remain explicitly undecided and are NOT frozen by V4:

- Extension sandbox technology (WASM / container / native) — implementation decision.
- Marketplace model (discovery/publishing/licensing/commercial) — `DOM-P05` FUTURE.
- SDK API — `DOM-P06` FUTURE.
- Cryptographic signature system for extension certification — future.
- Plugin packaging format — future.
- Pricing/settlement for extensions — future.
- Economic attribution of extension execution — future.
- Fragmentation/Reassembly — `DOM-P07` FUTURE.

## 5. Verification Requirements

The implementation of ExtensionRegistry/ExtensionRuntime (future Work Items)
MUST prove:

1. Extension/Registry/Runtime responsibilities are non-overlapping.
2. Capability scoping and resource limits are enforced.
3. Tenant isolation is preserved.
4. All anti-dependency prohibitions are mechanically enforced.
5. Extension→Transform relationship is one-way (Extension may call
   TransformRuntime; Transform does NOT import Extension).
6. Idempotency and failure semantics are explicit.
7. No kernel ownership, no vertical imports, no EconomicPipeline coupling.
8. No Route/Transport/RuntimeRegistry coupling.
9. Provenance emission is correct.
10. PostgreSQL remains the durable source of truth for registry metadata.
11. Lifecycle transitions are correctly enforced.
