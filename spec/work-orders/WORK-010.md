# WORK ORDER — WORK-010 TransformRegistry Implementation

Implement exactly `spec/work-items/WORK-010.md` against frozen `IAAS-DOM-ARCH-3`.

## Implementer
Z.ai

## Architect / Reviewer
Chief Architect

## Objective
Implement the service-layer TransformRegistry contract defined by DOM-015 as the first Transform Stack implementation slice.

## Read First
- `spec/domain-architecture-v3.md`
- `spec/domain-requirements-v3.md`
- `spec/domain-dependency-graph-v3.md`
- `spec/work-items/WORK-010.md`
- `spec/requirements.md` (`BASE-017`)
- Phase 14F TransformRecord contract and existing TransformRecord service

## Required Implementation
1. Define a generic service-layer TransformRegistry boundary.
2. Support tenant-scoped registration and lookup by `(transformType, transformVersion)`.
3. Represent version compatibility rules without executing transforms.
4. Represent certification metadata and revocation metadata without prematurely freezing cryptographic mechanisms.
5. Persist registry state in PostgreSQL.
6. Provide deterministic idempotent/concurrent registration behavior.
7. Enforce tenant isolation.
8. Add regression tests proving all V3 anti-dependencies.

## Mandatory Prohibitions
Do NOT:
- implement TransformRuntime;
- add concrete Transform execution implementations;
- modify TransformRecord semantics;
- create kernel transform primitives;
- import RuntimeRegistry;
- import EconomicPipeline;
- import Route/Transport;
- import vertical services;
- introduce Marketplace, SDK, sandbox, licensing, or signature architecture;
- modify frozen `IAAS-DOM-ARCH-3`.

## Required Verification
- unit tests
- PostgreSQL integration tests
- tenant-isolation tests
- concurrent/idempotency tests
- static import/architecture checks
- explicit proof registry does not execute transforms
- explicit proof TransformRuntime remains unimplemented
- specification validator
- typecheck
- architecture contract suite
- PostgreSQL suite
- lint
- exact diff/scope inspection

## STOP CONDITIONS
Stop and report to the Architect if:
- the frozen contract cannot be implemented without changing it;
- a schema decision changes the ownership/boundary defined by DOM-015;
- execution behavior is required inside the registry;
- TransformRuntime must be introduced to satisfy a registry requirement;
- cryptographic certification/revocation details require a new architecture decision;
- any vertical/economic/data-plane/kernel dependency appears necessary.

## Definition of Done
Implementation complete, objective evidence recorded, all required CI gates green, one active PR, no architecture drift, and PR submitted for independent Architect Review.
