# IAAS Domain Architecture — IAAS-DOM-ARCH-5

- Domain Architecture Version: `IAAS-DOM-ARCH-5`
- Status: **FROZEN**
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Supersedes: `IAAS-DOM-ARCH-4` (FROZEN historical record)
- Architecture Change Request: `ACR-004` (APPROVED)
- Produced by: `WORK-019`; frozen by `WORK-020`

> V5 is the current canonical domain architecture. V4 remains an immutable historical record. This version freezes the sandbox architecture contract; concrete sandbox implementation remains future and requires separate bounded Work Items.

## 1. Inherited Architecture

All V4 identity, resource, network, allocation, execution, runtime, node, data-plane, verification, economics, workflow, policy, adapter, and Extension Stack rules remain in force unless explicitly amended below.

V4 is not modified in place.

## 2. Sandbox Architecture

### 2.1 Preferred Sandbox Contract

IAAS adopts the **WASI Component Model / capability-sandbox contract** as the preferred sandbox architecture for untrusted extensions.

The architecture intentionally does not freeze a particular WASI revision or concrete runtime. Runtime/version selection remains an implementation and compatibility-policy concern.

Minimum contract:

- no ambient authority;
- external access requires explicitly granted host capability handles;
- filesystem/network access is capability-scoped;
- execution is structurally isolated from the host and other tenants;
- resource limits are independently enforceable;
- termination is host-observable and produces failed provenance when execution is interrupted;
- unavailable sandbox means deny-by-default, never silent unsandboxed execution.

### 2.2 Trust Boundary

The sandbox trust boundary is the **WASM component/instance boundary**.

The ExtensionRuntime host is trusted. Extension code is untrusted. The host grants only the effective capabilities authorized by the V4 `min(declared, approved)` rule.

### 2.3 Resource Authority and Measurement

Resource quantities remain distinct:

- `executionBudget` / `fuelUnits`: deterministic guest execution budget, not CPU time;
- `cpuTimeNs`: host/runtime CPU measurement when available;
- `wallTimeMs`: host-monotonic elapsed time;
- `peakLinearMemoryBytes`: observed linear-memory peak;
- `hostcallBytes`: host/guest transfer accounting.

Fuel is never represented as CPU milliseconds without an explicit measurement-source contract.

### 2.4 Capability Enforcement

ExtensionRuntime computes the effective capability/resource ceiling according to V4 §2.6. The sandbox enforces the resulting ceiling at the actual operation boundary.

The extension cannot self-authorize.

### 2.5 Lifecycle and Termination

Architectural lifecycle:

```text
registered → installed → activated ⇌ deactivated → revoked
```

Sandbox lifecycle semantics:

- installed: module validation/compilation may occur without execution;
- activated: sandbox execution context instantiated with effective capabilities;
- deactivated: active execution context terminated/deactivated;
- revoked: terminal state; future execution denied and active context terminated.

Termination is an architectural abstraction. Runtime-specific APIs are not frozen.

Revocation/resource exhaustion/timeout follows:

```text
terminate sandbox execution context
        ↓
failed provenance
        ↓
terminal outcome / re-throw
```

### 2.6 Tenant Isolation and Compromise Containment

Each extension execution receives an isolated sandbox context with no shared host address space, filesystem, network, or tenant state unless explicitly granted through the approved capability boundary.

A compromised extension is confined to its granted capability surface; unsandboxed execution is prohibited.

### 2.7 Fallback

If the preferred sandbox is unavailable, extension execution is denied with `denialReason: 'sandbox_unavailable'`.

No silent native/container fallback is implied by this architecture. Any alternative sandbox implementation requires a separately approved architecture change and bounded Work Items.

## 3. ExtensionProvenance Evolution

V5 introduces authoritative measurement semantics for resource usage and exercised capabilities while preserving V4 records as historical data.

Existing V4 provenance records remain valid. New V5 provenance records identify their measurement semantics explicitly.

This is a successor-version contract change; V4 is immutable.

## 4. Deferred Areas

Marketplace, SDK, cryptographic mechanism, packaging, pricing/settlement, economic attribution, ContainerSandbox implementation, concrete extension implementations, and other deferred product areas remain future unless separately promoted by architecture change.

## 5. Architectural Rule

The sandbox boundary is infrastructure architecture, not a vertical-specific feature. Vertical services, EconomicPipeline, Route/Transport, RuntimeRegistry, and kernel layers MUST NOT acquire direct ownership of sandbox semantics.
