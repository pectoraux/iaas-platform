# WORK-021 — WASI Sandbox Host Foundation

Status: `READY`
Architecture Version: `IAAS-GOV-ARCH-1`
Governing Domain Architecture: `IAAS-DOM-ARCH-5` (FROZEN)
Dependency: `WORK-020` VERIFIED
Implementer: Z.ai

## Objective
Implement the first production sandbox slice required by frozen V5: a service-layer WASI Component Model sandbox host that creates an isolated execution context for untrusted extensions and enforces the frozen capability, resource, termination, provenance, and deny-by-default contracts.

## Required Outcome
- A concrete WASI-compatible runtime is selected as an implementation detail and documented with compatibility/security rationale.
- Untrusted extension execution occurs only inside the sandbox boundary.
- ExtensionRuntime remains the execution/isolation authority and grants the effective `min(declared, approved)` capability/resource ceiling.
- No ambient filesystem, network, environment, device, or cross-tenant authority.
- Sandbox-unavailable always denies execution with `sandbox_unavailable`.
- Sandbox termination is host-observable and results in failed provenance plus the required terminal outcome.
- Resource quantities remain distinct: executionBudget/fuelUnits, cpuTimeNs, wallTimeMs, peakLinearMemoryBytes, hostcallBytes.

## Scope
- sandbox host abstraction and service-layer implementation;
- concrete WASI runtime adapter;
- component/module validation and instantiation;
- capability import/grant enforcement;
- memory/resource limits and execution-budget enforcement;
- termination/interruption contract;
- deny-by-default availability policy;
- integration with existing ExtensionRuntime through the approved abstraction;
- unit, architecture, and PostgreSQL/end-to-end tests where needed;
- evidence and implementation-level runtime compatibility documentation.

## Out of Scope
- changing IAAS-DOM-ARCH-5;
- changing V4/V5 provenance schema semantics outside what the frozen contract already requires;
- ContainerSandbox implementation;
- native/plugin-process sandbox implementation;
- Marketplace/SDK/packaging;
- concrete third-party extensions;
- economic attribution or pricing;
- vertical integration;
- kernel/data-plane redesign;
- WORK-022 or later Work Items.

## Architecture Constraints
- Service layer only; no kernel ownership.
- Runtime must not acquire catalog ownership; Registry remains lifecycle/catalog authority.
- Sandbox host must not bypass ExtensionRuntime's `min(declared, approved)` authority.
- No ambient capability grants.
- No silent unsandboxed fallback.
- Concrete runtime/version is implementation policy, not a new architecture version.
- Preserve V5's architectural termination abstraction; do not expose runtime-specific lifecycle APIs as the platform contract.
- Preserve immutable, tenant-scoped provenance through the existing provenance boundary.

## Acceptance Criteria
- `W021-AC01` Concrete WASI runtime selection is documented as an implementation detail and is compatible with the frozen V5 sandbox contract.
- `W021-AC02` A sandbox execution context can validate and instantiate a component without exposing host ambient authority.
- `W021-AC03` Only capabilities within `min(declared, approved)` are granted; unauthorized imports/operations are denied.
- `W021-AC04` Each execution is isolated from other tenants and host process state except explicitly granted capability handles.
- `W021-AC05` Execution budget/fuel, memory, and wall-clock limits are independently enforced; fuel is never treated as CPU milliseconds.
- `W021-AC06` Host/runtime CPU measurement is recorded separately when available and is never inferred from fuel.
- `W021-AC07` Revocation, timeout, and resource exhaustion terminate the sandbox context through the architectural termination contract and cannot leave a live execution context.
- `W021-AC08` Sandbox unavailability is deny-by-default with `denialReason='sandbox_unavailable'`; no unsandboxed fallback occurs.
- `W021-AC09` Failed sandbox executions emit failed provenance through the existing provenance boundary and preserve Runtime rethrow/terminal semantics.
- `W021-AC10` No vertical, EconomicPipeline, Route/Transport, RuntimeRegistry, kernel, or catalog-ownership dependency is introduced.
- `W021-AC11` End-to-end execution against a real WASI module proves successful execution, capability denial, resource-limit failure, revocation/termination, tenant isolation, and sandbox-unavailable behavior.
- `W021-AC12` Required Typecheck, lint, architecture tests, specification validator, and PostgreSQL/integration gates pass; implementation remains within Work Order scope.

## Required Verification
- static architecture/anti-dependency tests;
- unit tests for capability, resource, lifecycle, termination, and fallback semantics;
- real WASI integration tests using an actual component/module fixture;
- PostgreSQL/end-to-end provenance verification;
- tenant isolation verification;
- Typecheck; lint; architecture contract tests; spec validator; CI; scope inspection;
- independent Architect Review.

## Stop Conditions
Stop and request architecture review if implementation requires changing V5 semantics, adding a cross-layer primitive, introducing ambient authority, or making the concrete runtime choice a frozen architecture rule.

Do not implement containers, native/plugin sandboxes, Marketplace, SDK, or concrete extension packages in WORK-021.
