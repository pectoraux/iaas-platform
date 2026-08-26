# WORK ORDER — WORK-017 ExtensionRuntime Implementation

## Status
`RELEASED`

## Implementer
Z.ai

## Architect / Reviewer
Chief Architect

## Governing Architecture
`IAAS-GOV-ARCH-1` + `IAAS-DOM-ARCH-4` (FROZEN)

## Dependency
`WORK-016` VERIFIED

## Objective
Implement the service-layer `ExtensionRuntime` contract defined by frozen DOM-020.

## Required Work
1. Resolve extensions only through `ExtensionRegistry`.
2. Implement execution lifecycle for activated extensions without taking catalog/lifecycle ownership.
3. Enforce the V4 capability/resource ceiling: minimum of extension-declared and tenant/operator-approved limits.
4. Invoke optional `reverse` and `verify` operations according to DOM-020.
5. Emit immutable ExtensionProvenance payloads after success or failure through the existing provenance boundary contract; do not implement durable provenance storage in this Work Item.
6. Implement deterministic idempotency/replay convergence for identical execution attempts.
7. Implement explicit failure semantics: failed execution emits failed provenance and re-throws.
8. Observe Registry lifecycle and deny execution unless the extension is `activated`.
9. Add tenant, isolation, lifecycle, capability/resource, idempotency, failure, and anti-dependency regression coverage.
10. Produce objective evidence mapped to DOM-020 / WORK-017 acceptance criteria.

## Mandatory Prohibitions
Do NOT:
- implement or change `ExtensionRegistry` semantics except defect fixes required by DOM-020 compliance;
- implement durable `ExtensionProvenance` storage/schema/service;
- select or implement sandbox technology;
- implement concrete extensions;
- implement Marketplace, SDK, licensing, or economic attribution;
- modify frozen V4 architecture;
- introduce vertical/EconomicPipeline/Route/Transport/RuntimeRegistry/kernel coupling;
- change Transform Stack ownership or dependencies;
- start WORK-018.

## Required Verification
- unit tests for registry resolution, activation gating, capability/resource ceilings, reverse/verify, failure semantics, idempotency;
- PostgreSQL integration tests for tenant isolation, lifecycle gating, durable registry resolution, and replay convergence;
- static anti-dependency tests;
- explicit proof Runtime does not own catalog/lifecycle storage;
- explicit proof no durable provenance implementation is introduced;
- specification validator;
- Typecheck;
- Architecture Contract Tests;
- PostgreSQL suite;
- Lint;
- exact diff/scope inspection;
- independent Architect Review.

## STOP CONDITIONS
Stop and report to the Architect if implementation requires any V4 architecture change, durable provenance ownership, sandbox technology commitment, new kernel primitive, catalog/lifecycle redesign, or prohibited cross-layer dependency.

## Definition of Done
DOM-020 is implemented without architecture drift; objective evidence is recorded; one active PR exists; verification passes; Architect Review approves; PR merges; WORK-017 becomes VERIFIED. Do not start WORK-018.
