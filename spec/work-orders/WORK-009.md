# WORK-009 — Implementation Work Order

## Authority

- Work Item: `WORK-009`
- Implementer: Z.ai
- Architect / Reviewer: Chief Architect
- Governing architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Current domain architecture: `IAAS-DOM-ARCH-2` (FROZEN)
- Target architecture: `IAAS-DOM-ARCH-3`
- ACR: `ACR-002` (APPROVED)
- Dependency: `WORK-008` VERIFIED

## Objective

Produce and freeze the next domain architecture version that promotes the currently-FUTURE TransformRegistry + TransformRuntime boundary while preserving the implemented TransformRecord provenance primitive and all inherited V2 boundaries.

## Required Deliverables

1. `spec/domain-architecture-v3.md`
2. `spec/domain-requirements-v3.md`
3. `spec/domain-dependency-graph-v3.md`
4. architecture-version registration/update artifacts required by the governance layer without rewriting V2
5. WORK-009 verification evidence
6. targeted specification/architecture regression tests

## Mandatory Architecture Model

The frozen architecture must establish:

```text
Transform concept
      ↓
TransformRegistry
      ↓
TransformRuntime
      ↓
TransformRecord
```

with explicit separation:

- Transform = abstract operation contract (`execute`, `reverse`, `estimateCost`, `verify`).
- TransformRegistry = catalog/discovery/version compatibility/certification/revocation metadata.
- TransformRuntime = execution + verification engine; emits immutable TransformRecord provenance.
- TransformRecord = durable service-layer fact; never becomes an execution or registry primitive.

## Required Boundaries

- service/data-plane layer, not kernel;
- vertical-neutral;
- PostgreSQL-backed durable metadata where persistence is required;
- no import of vertical services;
- no import of EconomicPipeline;
- no dependency on Route, TransportExecution, TransportAttempt, DeliveryConfirmation;
- no dependency on RuntimeRegistry/InfrastructureRuntime/ProtocolRuntime/HybridRuntime;
- no mutation of Bundle, Node, Route, transport, or TransformRecord from the registry/runtime merely to implement catalog/execution concerns;
- tenant isolation mandatory;
- deterministic version identity and compatibility rules;
- explicit failure semantics;
- explicit idempotency semantics;
- explicit provenance emission into TransformRecord.

## Historical Architecture Rule

Do NOT edit `IAAS-DOM-ARCH-2` in place.

`IAAS-DOM-ARCH-2` remains immutable historical architecture. `IAAS-DOM-ARCH-3` is a new version.

## Technology Rule

Do not prematurely freeze a concrete sandbox technology, marketplace model, SDK API, cryptographic-signature system, or plugin packaging format. Those remain future/open unless required to define the core TransformRegistry/Runtime boundary.

## Explicit Non-Goals

- no production implementation;
- no Prisma schema change;
- no `src/` changes;
- no TransformRegistry service;
- no TransformRuntime service;
- no marketplace/extension/SDK work;
- no economic integration;
- no data-plane implementation beyond specification.

## Acceptance Criteria

- `W009-AC01` ACR-002 traceability is explicit.
- `W009-AC02` IAAS-DOM-ARCH-3 is complete, internally consistent, and registered as the proposed next frozen architecture.
- `W009-AC03` Transform/Registry/Runtime responsibilities are non-overlapping.
- `W009-AC04` TransformRecord remains immutable provenance and service-layer only.
- `W009-AC05` all dependency and anti-dependency directions are explicit.
- `W009-AC06` discovery/version/certification/revocation/execution/verification/failure/idempotency boundaries are explicit without over-specifying technology.
- `W009-AC07` production implementation remains prohibited and the next implementation Work Item is blocked until this Work Item is VERIFIED.
- `W009-AC08` regression tests prove architecture-version integrity, V2 immutability, and zero production-code scope.

## Stop Conditions

Stop and request Architect Review if:

- the existing Phase 14F contract cannot be reconciled without changing a frozen rule;
- registry/runtime ownership would require kernel changes;
- a Transform dependency on EconomicPipeline or transport is discovered as necessary rather than optional;
- durable schema changes are required to define the architecture;
- a new architecture primitive outside the Transform stack becomes necessary;
- the proposed architecture requires an unresolved security or sandbox decision.

## Evidence Required

- validator output;
- regression test output;
- exact diff scope;
- architecture-version registration evidence;
- CI run and job evidence;
- Architect Review readiness statement.
