# WORK ORDER — WORK-018 ExtensionProvenance Durable Persistence

## Status
`RELEASED`

## Implementer
Z.ai

## Architect / Reviewer
Chief Architect

## Governing Architecture
`IAAS-GOV-ARCH-1` + `IAAS-DOM-ARCH-4` (FROZEN)

## Dependency
`WORK-017` VERIFIED

## Objective
Implement the service-layer durable `ExtensionProvenance` boundary defined by frozen DOM-022, consuming provenance payloads emitted by `ExtensionRuntime` without taking execution ownership.

## Required Work
1. Define and implement the immutable tenant-scoped `ExtensionProvenance` durable record with the frozen 11-field contract.
2. Persist provenance only through a dedicated service-layer provenance boundary.
3. Enforce the frozen SHA-256 fingerprint over the material identity fields.
4. Enforce one durable record per tenant/idempotency key under concurrent writes.
5. Preserve success and failure provenance semantics; failed execution remains failed and is re-thrown by Runtime.
6. Make PostgreSQL the durable source of truth.
7. Prove records are immutable after creation and expose no update/delete path.
8. Preserve Runtime emits / provenance service persists separation.
9. Add tenant isolation, concurrency, fingerprint, immutability, and failure regression coverage.
10. Produce objective evidence mapped to DOM-022 / WORK-018 acceptance criteria.

## Mandatory Prohibitions
Do NOT:
- redesign `ExtensionRuntime` or `ExtensionRegistry`;
- move persistence ownership into `ExtensionRuntime`;
- select or implement sandbox technology;
- implement concrete extensions;
- implement Marketplace, SDK, licensing, or economic attribution;
- alter frozen V4 architecture;
- introduce vertical/EconomicPipeline/Route/Transport/RuntimeRegistry/kernel coupling;
- change Transform Stack ownership or dependencies;
- start WORK-019.

## Required Verification
- unit tests for record construction, fingerprint determinism, immutability, and failure semantics;
- PostgreSQL tests for persistence, tenant isolation, concurrent idempotency convergence, and durable reload;
- static proof the provenance service owns persistence and Runtime does not;
- static proof no update/delete path exists;
- static anti-dependency tests;
- specification validator;
- Typecheck;
- Architecture Contract Tests;
- PostgreSQL suite;
- Lint;
- exact diff/scope inspection;
- independent Architect Review.

## STOP CONDITIONS
Stop and report to the Architect if implementation requires any V4 architecture change, Runtime persistence ownership, sandbox technology commitment, Registry redesign, new kernel primitive, or prohibited cross-layer dependency.

## Definition of Done
DOM-022 is implemented without architecture drift; objective evidence is recorded; one active PR exists; verification passes; Architect Review approves; PR merges; WORK-018 becomes VERIFIED. Do not start WORK-019.
