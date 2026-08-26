# IAAS Domain Architecture — IAAS-DOM-ARCH-4 (Candidate)

- Domain Architecture Version: `IAAS-DOM-ARCH-4`
- Status: **CANDIDATE** (pending Architect approval of ACR-003)
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Supersedes: `IAAS-DOM-ARCH-3` (FROZEN — will become immutable historical record upon V4 freeze)
- Architecture Change Request: `ACR-003` (UNDER_REVIEW)
- Produced by: `WORK-014` (Extension Stack Architecture)

> This document is a **candidate** domain architecture. It is NOT frozen until
> the Architect explicitly approves ACR-003. V3 remains the current canonical
> domain architecture until that approval. All contracts, DAGs, and
> classifications below are **proposed** — they become frozen only upon V4
> freeze. This candidate preserves V3 except for the Extension Stack boundary.

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

### 2.2 Extension Stack Pipeline (proposed)

```text
Extension (abstract pluggable operation contract)
    ↓
ExtensionRegistry (discovery, version compatibility, certification/revocation, lifecycle)
    ↓
ExtensionRuntime (execution, isolation, capability enforcement, provenance)
    ↓
ExtensionProvenance (immutable durable provenance record)
```

### 2.3 Extension — Abstract Pluggable Operation Contract

`Extension` is the abstract contract for a pluggable operation. It declares
capabilities, resource requirements, and lifecycle hooks without owning
storage or becoming a concrete service.

Contract:

```text
Extension
  ├─ identity: extensionType (generic string) + extensionVersion (semver)
  ├─ declaredCapabilities: capability set the extension requests (e.g. routing_strategy, scheduling, cache)
  ├─ declaredResourceLimits: cpu, memory, time limits the extension requests
  ├─ dependencies: declared dependencies on other Extensions or Transforms
  ├─ lifecycle hooks: onInstall, onActivate, onDeactivate, onUninstall
  ├─ execute(context, input): output
  ├─ reverse?(output): input (if reversible)
  ├─ verify(input, output): boolean
  ├─ securityProperties: declared (publisher identity, signature status)
  └─ compatibilityRules: version compatibility constraints
```

Classification: **PROPOSED CONTRACT** — the abstract contract is proposed;
it becomes FROZEN-CONTRACT only upon V4 freeze. Concrete Extension
implementations remain future (not authorized by this or any current version).

### 2.4 ExtensionRegistry — Discovery and Catalog

`ExtensionRegistry` owns:

- **Discovery**: lookup by `(extensionType, extensionVersion)`.
- **Version compatibility**: compatibility rules between extension versions.
- **Certification metadata**: certifier identity, certification status.
- **Revocation metadata**: revocation status, reason, revokedAt.
- **Lifecycle metadata authority**: the registry is the authoritative owner
  of lifecycle state transitions (see §2.10).
- **Tenant isolation**: registry lookups are tenant-scoped.

`ExtensionRegistry` is NOT:
- an execution engine (that is `ExtensionRuntime`);
- a marketplace (discovery/publishing/licensing is future — `DOM-P05`);
- a kernel primitive (it is service-layer);
- a vertical-specific catalog;
- a TransformRegistry replacement.

Classification: **PROPOSED CONTRACT** — becomes FROZEN-CONTRACT only upon
V4 freeze.

### 2.5 ExtensionRuntime — Execution and Isolation Engine

`ExtensionRuntime` owns:

- **Execute**: invoke an Extension's `execute()` within an isolation boundary.
- **Reverse**: invoke an Extension's `reverse()` (if reversible).
- **Verify**: invoke an Extension's `verify()`.
- **Capability enforcement**: enforce the runtime-enforced ceiling (the
  minimum of the extension-declared request and the tenant/operator-approved
  ceiling — see §2.9).
- **Resource-limit enforcement**: enforce the runtime-enforced resource
  ceiling (the minimum of declared and approved limits).
- **Isolation**: enforce isolation boundaries (resource limits, capability
  scoping) — the concrete sandbox technology (WASM/container/native) remains
  OPEN/RESEARCH.
- **Provenance emission**: after execution, emit an immutable
  `ExtensionProvenance` record (see §2.6).
- **Execution gating**: the runtime observes registry lifecycle state and
  refuses to execute extensions that are not `activated` (see §2.10).
- **Idempotency**: deterministic idempotency keys for replay convergence.
- **Failure semantics**: explicit failure states (not silent exceptions).

`ExtensionRuntime` is NOT:
- a registry (it resolves extensions via `ExtensionRegistry`, not vice versa);
- the authority for lifecycle transitions (it observes and enforces, but the
  registry owns the state — see §2.10);
- a kernel primitive (it is service-layer);
- a TransformRuntime replacement;
- coupled to EconomicPipeline, Route, Transport, RuntimeRegistry, or kernel.

Classification: **PROPOSED CONTRACT** — becomes FROZEN-CONTRACT only upon
V4 freeze.

### 2.6 ExtensionProvenance — Durable Provenance Record (proposed)

`ExtensionProvenance` is the immutable durable record of an Extension
execution. The architecture defines its contract now — implementation
(including the Prisma model) is future, but the contract boundary is
proposed here so implementation cannot invent it.

**Ownership**: `ExtensionProvenance` is a service-layer durable record,
persisted in PostgreSQL. It is owned by the provenance boundary (analogous
to `TransformRecord`), NOT by `ExtensionRuntime` directly. The runtime
emits the provenance payload; a provenance service (future implementation)
owns the durable storage. The runtime does NOT directly write to the
database.

**Minimum identity/fingerprint**:

```text
ExtensionProvenance
  ├─ tenantId
  ├─ extensionType
  ├─ extensionVersion
  ├─ executionIdempotencyKey (deterministic, for replay convergence)
  ├─ inputHash (SHA-256 of the execution input)
  ├─ outputHash (SHA-256 of the execution output)
  ├─ resultStatus (success | failed)
  ├─ resourceUsage (actual CPU/memory/time consumed)
  ├─ capabilitiesExercised (the capabilities actually used during execution)
  ├─ tenantApprovedCeiling (the capability/resource ceiling approved by the tenant)
  └─ createdAt
```

**Deterministic fingerprint**: `SHA-256({tenantId, extensionType,
extensionVersion, executionIdempotencyKey, inputHash, outputHash,
resultStatus})`.

**Idempotency**: the `executionIdempotencyKey` is deterministic. Repeated
identical execution attempts converge to the same `ExtensionProvenance`
record (1:1 with the idempotency key, per tenant).

**Failure ordering**: provenance is emitted AFTER execution completes
(success or failure). If the extension execution throws, a provenance
record with `resultStatus='failed'` is still emitted (durable record of
the failure), and the error is re-thrown to the caller. The caller never
gets a silent success.

**Tenant binding**: every `ExtensionProvenance` record is tenant-scoped.
Cross-tenant provenance queries are prohibited.

Classification: **PROPOSED CONTRACT** — becomes FROZEN-CONTRACT only upon
V4 freeze. The Prisma model and service implementation are future Work Items.

### 2.7 Extension↔Transform Relationship

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

### 2.8 Dependency Direction (proposed)

```text
Extension (abstract contract)
    ↓ (ExtensionRegistry describes Extensions)
ExtensionRegistry (catalog/discovery/lifecycle authority)
    ↓ (ExtensionRuntime resolves Extensions via ExtensionRegistry)
ExtensionRuntime (execution/isolation engine)
    ↓ (ExtensionRuntime emits provenance payload)
ExtensionProvenance (immutable durable record — owned by provenance boundary)
```

### 2.9 Capability Authority and Resource-Limit Policy

The architecture defines a four-layer precedence chain for capabilities
and resource limits:

```text
1. Extension-declared request
   The Extension declares the capabilities it wants to exercise and the
   resource limits it wants (cpu, memory, time).

2. Tenant/operator authorization
   The tenant (or operator acting on behalf of the tenant) approves a
   capability ceiling and resource ceiling for the Extension. This is the
   authorized maximum — it MAY be lower than the extension's request but
   MUST NOT be higher.

3. Runtime-enforced ceiling
   The ExtensionRuntime enforces the minimum of (declared, approved):
   - effectiveCapabilities = extension.declaredCapabilities ∩ tenant.approvedCapabilities
   - effectiveResourceLimits = min(extension.declaredLimits, tenant.approvedLimits)
   The runtime enforces these as hard ceilings. If the extension attempts
   to exceed them, the execution is terminated and a failure provenance
   record is emitted.

4. Execution allowed / denied
   If the effective capability set does not include a capability the
   extension attempts to use, or the resource limit is exceeded, execution
   is DENIED. A denied execution emits an ExtensionProvenance with
   resultStatus='failed' and a denial reason.
```

**Precedence**: tenant/operator authorization is authoritative. The runtime
enforces the approved ceiling, which is always ≤ the extension's declared
request. The extension cannot self-authorize capabilities or resources
beyond what the tenant approved.

### 2.10 Lifecycle Authority and Transition Semantics

Extension lifecycle:

```text
registered → installed → activated ⇌ deactivated → revoked (terminal)
                              ↓
                          executing (transient)
```

**Registry-owned transitions** (metadata authority — the registry is the
sole owner of lifecycle state):

| Transition | Owner | Semantics |
|---|---|---|
| → registered | ExtensionRegistry | Extension is cataloged (metadata only, not installed) |
| registered → installed | ExtensionRegistry | Extension's installation hooks are acknowledged; lifecycle metadata updated |
| installed → activated | ExtensionRegistry | Extension is available for execution |
| activated → deactivated | ExtensionRegistry | Extension is paused (not available for new executions) |
| deactivated → activated | ExtensionRegistry | Extension is resumed |
| * → revoked | ExtensionRegistry | Extension is permanently disabled (terminal — cannot transition back) |

**Runtime-observed/enforced** (the runtime does NOT own these transitions;
it observes registry state and enforces):

| Enforcement | Owner | Semantics |
|---|---|---|
| Execution gate | ExtensionRuntime | The runtime checks the registry's lifecycle state before executing. Only `activated` extensions may execute. |
| In-flight on revocation | ExtensionRuntime | If an extension is revoked while an execution is in-flight, the runtime completes the current execution (if it finishes within the resource/time limit) and then refuses all future executions. The in-flight execution's provenance is emitted normally. If the in-flight execution exceeds its time limit after revocation, it is terminated and a failure provenance is emitted. |

**Revocation is terminal**: once `revoked`, an extension cannot transition
to any other state. The registry entry remains for audit. The runtime
refuses all executions.

**Installation/uninstallation**: `installed` means the extension's
installation hooks have been acknowledged by the registry. `uninstall` is
NOT a lifecycle state — it is a registry administrative action that removes
the extension from the catalog. An uninstalled extension's provenance
records remain durable (audit integrity).

### 2.11 Anti-Dependency Prohibitions (proposed)

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

### 2.12 Security and Isolation (contract-level, not technology)

The contract defines isolation *obligations*:

1. **Capability scoping**: an Extension can only exercise capabilities within
   the runtime-enforced ceiling (§2.9).
2. **Resource limits**: CPU, memory, and time limits are enforced per the
   runtime-enforced ceiling (§2.9).
3. **Tenant isolation**: Extensions are tenant-scoped; cross-tenant execution
   is prohibited.
4. **Publisher identity**: declared as metadata; cryptographic verification is
   future (not frozen by this contract).
5. **Provenance**: every Extension execution emits an immutable
   `ExtensionProvenance` record (§2.6).
6. **Failure containment**: an Extension failure does not crash the platform;
   failures are caught and recorded.

The concrete sandbox technology (WASM/container/native) remains OPEN/RESEARCH.
Implementation selects technology in a future Work Item.

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
  this V4 candidate (promoted from FUTURE to PROPOSED CONTRACT) — pending
  ACR-003 approval. See `spec/domain-requirements-v4.md` for DOM-018..DOM-022.
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
2. Capability scoping and resource limits are enforced per the §2.9 precedence.
3. Tenant isolation is preserved.
4. All anti-dependency prohibitions are mechanically enforced.
5. Extension→Transform relationship is one-way (Extension may call
   TransformRuntime; Transform does NOT import Extension).
6. Idempotency and failure semantics are explicit.
7. No kernel ownership, no vertical imports, no EconomicPipeline coupling.
8. No Route/Transport/RuntimeRegistry coupling.
9. ExtensionProvenance is emitted with the correct fingerprint, tenant binding,
   and failure-ordering semantics (§2.6).
10. PostgreSQL remains the durable source of truth for registry metadata and
    provenance.
11. Lifecycle transitions are correctly enforced: registry owns state, runtime
    observes and enforces, revocation is terminal, in-flight executions on
    revocation complete or are terminated (§2.10).
