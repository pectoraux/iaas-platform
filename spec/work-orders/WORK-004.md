# WORK ORDER — WORK-004

## Identity

- Work Item: `WORK-004`
- Title: Runtime Registry Bootstrap Reliability
- Governing Architecture Version: `IAAS-GOV-ARCH-1`
- Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
- Implementer: Z.ai
- Architect / Reviewer: Chief Architect

## Objective

Restore the repository's implemented Runtime Registry contract so persisted `NetworkVersion.runtimeKind` values resolve to the correct registered runtime in real application/test bootstrap paths without changing the frozen runtime architecture.

This Work Item targets the pre-existing runtime-registration failure that currently causes failures across Phase 5.1, Phase 5.2, Phase 5.4, Phase 8B/8C, and VPP execution-invariant integration tests.

## Existing Repository Evidence

`IAAS-DOM-ARCH-2` inherits the V1 runtime boundary:

- `NetworkVersion.runtimeKind -> RuntimeRegistry.resolve() -> NetworkRuntime` is IMPLEMENTED.
- `InfrastructureRuntime`, `ProtocolRuntime`, and `HybridRuntime` are concrete runtime implementations.
- `RuntimeRegistry` / `AdapterRegistry` are singleton registries.
- Bootstrap constructs and registers concrete runtimes.
- `runtime/index.ts` does not automatically register concrete runtimes.

Current CI evidence on the WORK-003 branch shows repeated failures of:

`No runtime registered for kind 'infrastructure'. Registered kinds: .`

and corresponding `protocol` failures. These failures predate WORK-003 and prevent the repository's existing runtime-resolution contracts from being verified.

## Requirements

- `BASE-001`
- `BASE-002`
- `BASE-003`
- inherited runtime boundaries from `IAAS-DOM-ARCH-2`

## Acceptance Criteria

### W004-AC01

A published `NetworkVersion` with `runtimeKind=infrastructure` resolves to the canonical `InfrastructureRuntime` through the repository's intended bootstrap path.

### W004-AC02

A published `NetworkVersion` with `runtimeKind=protocol` resolves to the canonical `ProtocolRuntime` through the repository's intended bootstrap path.

### W004-AC03

The registry remains singleton/stable: repeated resolution of the same runtime kind returns the same registered runtime instance within the supported process lifecycle.

### W004-AC04

The correction does not change the frozen runtime architecture, runtime isolation rules, or the rule that `HybridRuntime` is the only bridge between infrastructure and protocol worlds.

### W004-AC05

The existing Phase 5.1 runtime-resolution tests pass without modifying their architectural expectations.

### W004-AC06

The correction restores the dependent Phase 5.2/5.4, Phase 8B/8C, and VPP execution-invariant integration paths sufficiently that their previous runtime-registration failures disappear.

### W004-AC07

No new vertical-specific runtime registration logic is introduced into generic kernel/runtime code.

### W004-AC08

No Prisma schema, persistence-provider, Data Plane, Economic Pipeline, or ledger redesign is introduced.

### W004-AC09

All required tests, CI evidence, and scope checks are complete and independently reproducible.

## Repository Scope

Expected areas:

- `src/lib/kernel/runtime/`
- `src/lib/bootstrap/`
- runtime initialization/registration entrypoints
- targeted runtime-resolution/integration tests
- targeted CI/test bootstrap configuration only if required for the existing architectural contract

## Architecture Constraints

- `IAAS-GOV-ARCH-1` remains FROZEN.
- `IAAS-DOM-ARCH-2` remains FROZEN.
- Preserve `NetworkRuntime` interface and the three runtime kinds.
- Preserve InfrastructureRuntime/ProtocolRuntime isolation.
- Preserve HybridRuntime as the only bridge.
- Do not make generic runtime code import VPP, Compute, Storage, Wireless, Manufacturing, or other vertical services.
- Do not solve the problem by adding hidden global side effects that violate the documented bootstrap boundary.
- Do not modify Data Plane or Economic Pipeline behavior.

## Required Tests

- Phase 5.1 runtime-resolution integration tests.
- Registry singleton/stability tests.
- Infrastructure runtime resolution test.
- Protocol runtime resolution test.
- Regression execution of the previously failing Phase 5.2 / 5.4 suites.
- Regression execution of Phase 8B / 8C suites.
- Regression execution of VPP execution-invariant tests.
- Static architecture checks proving runtime isolation remains intact.

## Required Verification

- exact local commands and outputs;
- CI run/job evidence;
- acceptance-criterion evidence matrix W004-AC01…W004-AC09;
- repository diff inspection;
- comparison against the frozen runtime architecture;
- no new architecture change request unless the frozen design is demonstrably insufficient.

## Out of Scope

Do not:

- change `IAAS-DOM-ARCH-2`;
- create `IAAS-DOM-ARCH-3`;
- redesign RuntimeRegistry semantics;
- redesign InfrastructureRuntime, ProtocolRuntime, or HybridRuntime;
- implement new network features;
- modify Data Plane services;
- modify Economic Pipeline semantics;
- fix the unrelated `baselineEngine` TypeScript issue;
- fix unrelated PostgreSQL integration failures except where they disappear naturally as runtime bootstrap is restored;
- start another Work Item.

## Stop Conditions

Stop and report to the Architect if:

- the runtime-registration failures prove to be caused by a contradiction in the frozen architecture;
- satisfying the runtime-resolution contract requires a new runtime kind or new architectural primitive;
- correct registration requires vertical-specific imports in generic runtime code;
- the documented bootstrap boundary must be fundamentally changed;
- solving the issue requires changes to the Data Plane or Economic Pipeline;
- the implementation cannot preserve the runtime isolation rules.

## Definition of Done

1. Runtime registration is restored through the intended bootstrap path.
2. W004-AC01…W004-AC09 are objectively verified.
3. The previously observed runtime-registration failures are eliminated from the targeted test suites.
4. Frozen runtime architecture remains unchanged.
5. No unrelated production refactor is present.
6. CI evidence is complete.
7. PR is submitted for independent Architect Review.
8. Z.ai does not mark WORK-004 VERIFIED or begin WORK-005.
