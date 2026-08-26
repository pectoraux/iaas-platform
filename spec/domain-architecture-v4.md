# IAAS Domain Architecture — IAAS-DOM-ARCH-4

- Domain Architecture Version: `IAAS-DOM-ARCH-4`
- Status: **FROZEN**
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Supersedes: `IAAS-DOM-ARCH-3` (FROZEN historical record)
- Architecture Change Request: `ACR-003` (APPROVED)
- Produced by: `WORK-014`; frozen by `WORK-015`

> V4 is the current canonical domain architecture. V3 remains an immutable historical record. The Extension Stack contract below is FROZEN-CONTRACT; concrete Extension implementations remain future and require separate Work Items.

## 1. Version Relationship

V4 inherits all V3 rules and primitives and adds the approved Extension Stack boundary. V3 is not modified in place.

## 2. Extension Stack

### 2.1 Extension

A generic, vertical-neutral pluggable operation contract.

```text
Extension
  identity: extensionType + extensionVersion
  declaredCapabilities
  declaredResourceLimits
  dependencies
  lifecycle hooks
  execute(context, input) -> output
  reverse?(output) -> input
  verify(input, output) -> boolean
  securityProperties
  compatibilityRules
```

FROZEN-CONTRACT. Concrete extensions are future.

### 2.2 ExtensionRegistry

Service-layer catalog and lifecycle authority. Owns discovery, version compatibility, certification metadata, revocation metadata, authoritative lifecycle state, and tenant isolation. It never executes extensions, is not a marketplace, is not a kernel primitive, is not vertical-specific, and does not replace TransformRegistry.

FROZEN-CONTRACT. Production implementation is future.

### 2.3 ExtensionRuntime

Service-layer execution and isolation authority. Resolves through ExtensionRegistry; executes, reverses, verifies, enforces capabilities/resource limits, gates lifecycle state, provides deterministic idempotency, emits provenance payloads, and defines explicit failure semantics. It does not own catalog/lifecycle state or durable provenance storage.

FROZEN-CONTRACT. Production implementation is future.

### 2.4 ExtensionProvenance

Immutable durable service-layer provenance record persisted in PostgreSQL. A provenance boundary owns durable storage; ExtensionRuntime emits the payload and never writes directly to the database.

Minimum identity:

```text
tenantId, extensionType, extensionVersion,
executionIdempotencyKey, inputHash, outputHash,
resultStatus, resourceUsage, capabilitiesExercised,
tenantApprovedCeiling, createdAt
```

Fingerprint:

```text
SHA-256({tenantId, extensionType, extensionVersion,
executionIdempotencyKey, inputHash, outputHash, resultStatus})
```

Repeated identical attempts converge 1:1 per tenant/idempotency key. Provenance is emitted after both success and failure; failed execution records `resultStatus='failed'` and re-throws. Cross-tenant provenance queries are prohibited.

FROZEN-CONTRACT. Prisma/service implementation is future.

### 2.5 Extension ↔ Transform

One-way only:

```text
Extension → TransformRuntime.executeTransform()
```

Extensions do not own/mutate TransformRegistry or TransformRecord. Transform Stack components do not depend on Extension Stack.

### 2.6 Capability and Resource Authority

Precedence is:

```text
Extension-declared request
        ↓
Tenant/operator authorization
        ↓
Runtime-enforced ceiling = min(declared, approved)
        ↓
Execution allowed / denied
```

Tenant/operator authorization is authoritative. The extension cannot self-authorize. Requests outside the effective ceiling are denied and produce failed provenance.

### 2.7 Lifecycle Authority

```text
registered → installed → activated ⇌ deactivated → revoked (terminal)
                              ↓
                          executing (transient)
```

ExtensionRegistry owns lifecycle transitions. ExtensionRuntime observes/enforces them; only `activated` extensions may execute. Revoked is terminal. An in-flight execution may finish within enforced limits or be terminated with failed provenance. `installed` is a lifecycle state; `uninstall` is an administrative action. Provenance remains durable.

### 2.8 Security and Isolation

The contract requires capability scoping, resource-limit enforcement, tenant isolation, publisher identity metadata, immutable provenance, and failure containment. Sandbox technology (WASM/container/native) remains OPEN/RESEARCH and is not frozen by V4.

### 2.9 Anti-Dependencies

The Extension Stack MUST NOT depend on vertical services, EconomicPipeline, Route/Transport, RuntimeRegistry, or `src/lib/kernel/`. Those layers MUST NOT import ExtensionRegistry/ExtensionRuntime except through a future explicitly approved architecture contract. Extension Stack may call TransformRuntime and perform read-only TransformRegistry lookup.

## 3. Inherited Architecture

All V3 identity, runtime, control-plane, economic, data-plane, PostgreSQL, reconciliation, kernel, and anti-drift rules remain in force.

`DOM-P04` is **SUPERSEDED** by `DOM-018..DOM-022` under approved ACR-003. `DOM-P05..DOM-P08` remain FUTURE/OPEN/RESEARCH.

## 4. Deferred Technology / Product Areas

Sandbox technology, Marketplace (`DOM-P05`), SDK (`DOM-P06`), cryptographic mechanism, packaging, pricing/settlement, economic attribution, and Fragmentation/Reassembly (`DOM-P07`/`DOM-P08`) remain future/open as documented.

## 5. Future Implementation Verification

Future ExtensionRegistry/ExtensionRuntime Work Items MUST prove responsibility separation, capability/resource precedence, tenant isolation, anti-dependencies, Extension→Transform direction, idempotency/failure semantics, provenance fingerprint/tenant binding/order, PostgreSQL durability, and lifecycle enforcement.