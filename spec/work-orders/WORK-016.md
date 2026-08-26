# WORK ORDER — WORK-016 ExtensionRegistry Implementation

## Status
`RELEASED`

## Implementer
Z.ai

## Architect / Reviewer
Chief Architect

## Governing Architecture
`IAAS-GOV-ARCH-1` + `IAAS-DOM-ARCH-4` (FROZEN)

## Dependency
`WORK-015` VERIFIED

## Objective
Implement the service-layer `ExtensionRegistry` contract defined by frozen DOM-019.

## Required Work
1. Implement tenant-scoped extension catalog and lookup by `(extensionType, extensionVersion)`.
2. Implement version compatibility rules.
3. Implement certification metadata and revocation metadata.
4. Implement authoritative lifecycle state transitions: `registered → installed → activated ⇌ deactivated → revoked`.
5. Implement deterministic idempotent registration/concurrency convergence.
6. Preserve PostgreSQL as the durable source of registry metadata.
7. Add tenant-isolation and lifecycle/revocation regression coverage.
8. Add static anti-dependency coverage proving Registry never executes and remains independent of vertical, EconomicPipeline, Route/Transport, RuntimeRegistry, and kernel code.
9. Produce objective evidence mapped to DOM-019 / WORK-016 acceptance criteria.

## Mandatory Prohibitions
Do NOT:
- implement `ExtensionRuntime`;
- implement `ExtensionProvenance` storage/service;
- implement concrete extensions;
- select or implement sandbox technology;
- implement Marketplace, SDK, licensing, or economic attribution;
- modify frozen V4 architecture;
- add new Prisma models unrelated to the frozen Registry contract;
- introduce vertical/economic/data-plane/runtime-kernel coupling;
- start WORK-017.

## Required Verification
- unit tests for registration, lookup, compatibility, certification/revocation, lifecycle transitions;
- PostgreSQL integration tests for tenant isolation and concurrent/idempotent registration;
- static anti-dependency tests;
- explicit test that Registry does not execute extensions;
- specification validator;
- Typecheck;
- Architecture Contract Tests;
- PostgreSQL suite;
- Lint;
- exact diff/scope inspection;
- independent Architect Review.

## STOP CONDITIONS
Stop and report to the Architect if implementation requires any V4 architecture change, Runtime execution ownership, provenance persistence, sandbox technology commitment, new kernel primitive, schema redesign beyond the frozen contract, or cross-layer dependency prohibited by V4.

## Definition of Done
DOM-019 is implemented without architecture drift; objective evidence is recorded; one active PR exists; verification passes; Architect Review approves; PR merges; WORK-016 becomes VERIFIED. Do not start WORK-017.
