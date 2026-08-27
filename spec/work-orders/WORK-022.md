# WORK-022 — Sandbox Lifecycle Completion

Status: `READY`
Architecture Version: `IAAS-GOV-ARCH-1`
Governing Domain Architecture: `IAAS-DOM-ARCH-5` (FROZEN)
Dependency: `WORK-021` VERIFIED
Implementer: Z.ai

## Objective
Complete the frozen V5 §2.5 sandbox lifecycle semantics on the verified WORK-021 sandbox foundation: every architectural lifecycle state must hold its sandbox meaning. WORK-021 wired the terminal `revoked` state (durable revocation → authoritative termination of active executions); this slice wires the remaining transitions — `deactivated` terminates active sandbox execution contexts through the same authoritative control path, and `installed` performs module validation without execution.

## Derived Gap (why this Work Item exists)
V5 §2.5 defines the sandbox lifecycle semantics:

```text
registered → installed → activated ⇌ deactivated → revoked
installed:   module validation/compilation may occur without execution
deactivated: active execution context terminated/deactivated
revoked:     terminal state; future execution denied and active context terminated
```

Verified WORK-021 repository reality:
- `revoked` — WIRED (AR-021-17): both durable paths (`revokeExtension` and `transitionLifecycle(→ revoked)`) fire the ActiveExecutionRegistry termination hook synchronously after the durable update.
- `deactivated` — NOT WIRED: `transitionLifecycle(→ deactivated)` performs the durable update, and the Runtime lifecycle gate denies FUTURE executions, but in-flight sandbox executions are NOT terminated — they run to their own completion/timeout. This violates the §2.5 definition of the state.
- `installed` — NOT WIRED: the registered → installed transition performs no module validation; the WORK-021 SandboxImportVerifier runs only at execution time.

## Required Outcome
- `transitionLifecycle(→ deactivated)` terminates every active sandbox execution of the extension through the authoritative ActiveExecutionRegistry control path (durable update → synchronous termination hook → `SandboxExecutionHandle.revoke()` → termination), with failed provenance recording the termination.
- Deactivation is reversible: while `deactivated`, execution is denied by the existing lifecycle gate; after re-activation (`deactivated → activated`), execution is permitted again. The terminal revoked-execution ledger is used ONLY by `revoked`.
- The registered → installed transition can validate the extension's WASM binary (classification + import verification against declared capabilities) WITHOUT spawning a sandbox or executing the module; unauthorized imports deny the transition.
- `revoked` remains the only terminal lifecycle state; WORK-021 revocation semantics are unchanged.
- Lifecycle termination is tenant-scoped and extension-scoped.
- Lifecycle transitions record `activeExecutionsTerminated` audit metadata.

## Scope
- extension-registry lifecycle transitions (`installed`, `deactivated`) and audit metadata;
- active-execution registry deactivation semantics (reversible, distinct from the terminal revoked ledger);
- sandbox-host validate-only path (classification + import verification, no spawn, no execution);
- extension-runtime integration where required;
- unit, architecture, real-WASI, and PostgreSQL/end-to-end tests;
- evidence.

## Out of Scope
- changing `IAAS-DOM-ARCH-5`;
- authoritative measurement completion for `fuelUnits`/`cpuTimeNs`/`peakLinearMemoryBytes` (documented WORK-021 implementation limitation; a future bounded slice);
- changing V4/V5 provenance schema semantics beyond metadata fields the frozen contract already requires;
- ContainerSandbox or native/plugin sandbox implementation;
- concrete third-party extensions;
- Marketplace/SDK/packaging;
- economic attribution or pricing;
- vertical integration; kernel/data-plane redesign;
- WORK-023 or later Work Items.

## Architecture Constraints
- Service layer only; no kernel ownership.
- ExtensionRegistry remains the lifecycle/catalog authority; ExtensionRuntime remains the execution/isolation and capability authority.
- Capability ceiling remains `min(declared, approved)`; no ambient authority.
- Termination goes through the architectural termination abstraction (`SandboxExecutionHandle.revoke()`); no runtime-specific API becomes the platform contract.
- The termination hook fires synchronously after the durable database update (no `await` between durability and termination).
- No silent unsandboxed fallback; deny-by-default is preserved.
- V5 remains FROZEN: this slice implements the frozen §2.5 contract; it does not change it.

## Acceptance Criteria
- `W022-AC01` `transitionLifecycle(→ deactivated)` terminates every active sandbox execution of the extension through the authoritative control path (durable update → synchronous hook → `handle.revoke()` → termination); the terminated executions fail with the recorded termination cause and emit failed provenance.
- `W022-AC02` Deactivation is reversible: execution is denied while `deactivated` (existing lifecycle gate) and permitted again after re-activation; the terminal revoked-execution ledger is never used for deactivation.
- `W022-AC03` The registered → installed transition validates the extension's WASM binary (classification + import verification against declared capabilities) without spawning a sandbox or executing the module; unauthorized imports deny the transition.
- `W022-AC04` `revoked` remains the only terminal state; WORK-021 revocation semantics (ledger refusal, termination, failed provenance `denialReason='revoked'`) are unchanged.
- `W022-AC05` Lifecycle termination is tenant-scoped and extension-scoped: deactivating one tenant's extension never terminates another tenant's executions or another extension's executions.
- `W022-AC06` Lifecycle transitions record `activeExecutionsTerminated` audit metadata.
- `W022-AC07` No vertical, EconomicPipeline, Route/Transport, RuntimeRegistry, kernel, or catalog-ownership dependency is introduced; the registry does not execute extensions and the runtime does not own lifecycle.
- `W022-AC08` End-to-end proof against real PostgreSQL and a real wasmtime execution: deactivation terminates an active infinite-loop execution; re-activation permits a new execution; install-time validation denies an unauthorized real Component Model binary without spawning.
- `W022-AC09` Required Typecheck, lint, architecture tests, specification validator, and PostgreSQL/integration gates pass; implementation remains within Work Order scope.
- `W022-AC10` V5 remains FROZEN and unmodified; no provenance schema semantics change; no new architecture version is introduced.

## Required Verification
- static architecture/anti-dependency and wiring checks (hook synchronous after the durable deactivation update);
- unit tests for lifecycle, reversibility, race, and scoping semantics;
- real WASI integration tests using actual component fixtures (deactivation termination; install-time validation denial without spawn);
- PostgreSQL/end-to-end provenance verification (golden deactivation chain and re-activation chain);
- tenant isolation verification;
- Typecheck; lint; architecture contract tests; spec validator; CI; scope inspection;
- independent Architect Review.

## Stop Conditions
Stop and request architecture review if implementation requires changing V5 §2.5 semantics, adding a cross-layer primitive, introducing ambient authority, or making deactivation terminal.

Do not implement measurement completion, containers, native/plugin sandboxes, Marketplace, SDK, or concrete extension packages in WORK-022.
