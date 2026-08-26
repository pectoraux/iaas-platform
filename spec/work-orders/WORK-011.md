# WORK ORDER — WORK-011 TransformRuntime Implementation

## Implementer
Z.ai

## Architect / Reviewer
Chief Architect

## Objective
Implement exactly the frozen `DOM-016` TransformRuntime contract under `IAAS-DOM-ARCH-3` as the second Transform Stack implementation slice. TransformRegistry (`WORK-010`) is VERIFIED and is the only registry authority. TransformRecord remains the immutable durable provenance fact.

## Read First
- `spec/domain-architecture-v3.md`
- `spec/domain-requirements-v3.md`
- `spec/domain-dependency-graph-v3.md`
- `spec/work-items.md`
- `spec/work-orders/WORK-010.md`
- `spec/architecture-lock.md`
- Phase 14F TransformRecord contract and implementation
- `src/lib/services/transform-registry.service.ts`
- `src/lib/services/transform-record.service.ts`

## Required Implementation
1. Define a service-layer `TransformRuntime` boundary.
2. Resolve transforms exclusively through the verified `TransformRegistry`.
3. Implement execution against an abstract Transform contract without hard-coding a vertical or concrete transform implementation into the runtime.
4. Support `execute`, `reverse` when reversible, `estimateCost`, and `verify` dispatch through the Transform contract.
5. Emit an immutable `TransformRecord` after execution with the required provenance.
6. Provide deterministic idempotency/replay convergence for the same execution request.
7. Define explicit failure semantics; failures must not silently produce successful provenance.
8. Preserve tenant isolation and PostgreSQL as durable source of truth.
9. Add regression tests for TransformRegistry → TransformRuntime resolution and all V3 anti-dependencies.
10. Demonstrate that the runtime does not become a registry, marketplace, kernel primitive, economic component, or transport/routing component.

## Mandatory Prohibitions
Do NOT:
- modify `IAAS-DOM-ARCH-3`;
- redesign `TransformRegistry`;
- modify TransformRecord semantics except to call its existing creation boundary with the frozen provenance contract;
- create a kernel transform primitive;
- import RuntimeRegistry;
- import EconomicPipeline;
- import Route/Transport;
- import vertical services;
- introduce Marketplace, SDK, sandbox, licensing, or cryptographic certification architecture;
- add concrete VPP/Compute/Storage/Wireless/Manufacturing transforms as part of WORK-011;
- make TransformRuntime the source of truth for transform metadata.

## Architecture Constraints
- `IAAS-GOV-ARCH-1` FROZEN.
- `IAAS-DOM-ARCH-3` FROZEN.
- `TransformRegistry` is the sole catalog/discovery authority.
- `TransformRuntime` executes; it does not discover, certify, revoke, or own registry metadata.
- `TransformRecord` is the durable provenance authority; the runtime emits it but does not mutate prior records.
- Runtime remains service-layer and tenant-scoped.
- Data Plane routing/transport and Economic Pipeline remain independent of the TransformRuntime.
- PostgreSQL remains canonical; no SQLite or in-memory replacement.

## Required Verification
- unit tests for runtime dispatch and failure semantics;
- PostgreSQL integration tests for registry resolution, execution, idempotency, provenance emission, tenant isolation, and failure behavior;
- regression tests proving TransformRegistry remains the catalog authority;
- regression tests proving TransformRecord is created once and not mutated by runtime replay;
- static anti-dependency architecture tests;
- proof no concrete transform implementation is embedded in the runtime;
- specification validator;
- typecheck;
- Architecture Contract Tests;
- PostgreSQL Integration Tests;
- lint;
- exact diff/scope inspection;
- independent Architect Review.

## STOP CONDITIONS
Stop and report to the Architect if:
- the frozen TransformRuntime contract cannot be implemented without changing `IAAS-DOM-ARCH-3`;
- a schema decision changes ownership/boundaries defined by DOM-016;
- Registry behavior must be modified to satisfy runtime requirements beyond its verified contract;
- a concrete transform implementation is required to prove the generic runtime contract;
- TransformRecord semantics or fingerprint/idempotency rules must change;
- any vertical/economic/data-plane/kernel dependency appears necessary;
- a cryptographic/security architecture decision is required.

## Definition of Done
Implementation complete; objective evidence recorded; all required CI gates green; one active PR; no architecture drift; TransformRegistry and TransformRecord boundaries preserved; PR submitted for independent Architect Review; WORK-011 not marked VERIFIED by the implementer.
