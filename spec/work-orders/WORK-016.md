# WORK ORDER — WORK-016 ExtensionRegistry Implementation

## Status
Not released. This Work Order becomes eligible only after WORK-015 is VERIFIED and merged.

## Implementer
Z.ai

## Architect / Reviewer
Chief Architect

## Governing Architecture
`IAAS-GOV-ARCH-1` + `IAAS-DOM-ARCH-4` (FROZEN)

## Objective
Implement the service-layer ExtensionRegistry contract defined by frozen DOM-019 without implementing ExtensionRuntime, concrete extensions, sandbox technology, marketplace, SDK, or ExtensionProvenance storage.

## Mandatory Scope
- tenant-scoped extension catalog
- identity/version lookup
- compatibility rules
- certification/revocation metadata
- authoritative lifecycle state transitions
- deterministic idempotent registration
- PostgreSQL durable source
- static anti-dependency tests

## Mandatory Prohibitions
Do NOT implement ExtensionRuntime, ExtensionProvenance Prisma/service storage, concrete extensions, sandbox technology, Marketplace, SDK, licensing, economic attribution, or modify frozen V4.

## Required Verification
Unit tests, PostgreSQL integration tests, tenant isolation, lifecycle/revocation tests, idempotency/concurrency tests, anti-dependency architecture tests, validator, Typecheck, Architecture Contract Tests, PostgreSQL suite, lint, exact scope inspection, independent Architect Review.

## STOP CONDITIONS
Stop and report if the Registry contract requires any V4 change, runtime execution, provenance persistence, sandbox technology commitment, new kernel primitive, or vertical/economic/data-plane coupling.

## Definition of Done
Implementation satisfies DOM-019, preserves all frozen V4 boundaries, produces objective evidence, opens one PR, and waits for independent Architect Review. Do not start WORK-017.
