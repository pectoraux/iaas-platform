# WORK ORDER — WORK-013 Transform Stack End-to-End Conformance and Integration Hardening

Implement exactly `spec/work-items.md` section `WORK-013` against frozen `IAAS-DOM-ARCH-3`.

## Implementer
Z.ai

## Architect / Reviewer
Chief Architect

## Objective
Prove the implemented Transform Stack behaves correctly as one coherent subsystem across TransformRegistry, TransformRuntime, and TransformRecord without introducing new architecture or concrete vertical transforms.

## Read First
- `spec/domain-architecture-v3.md`
- `spec/domain-requirements-v3.md`
- `spec/domain-dependency-graph-v3.md`
- `spec/work-items.md` (`WORK-013`)
- `spec/work-orders/WORK-010.md`
- `spec/work-orders/WORK-011.md`
- existing TransformRegistry, TransformRuntime, and TransformRecord services/tests

## Required Implementation
1. Add a bounded end-to-end conformance test path for registry registration → runtime resolution → execution → immutable TransformRecord provenance.
2. Prove tenant isolation across registry lookup, runtime resolution, execution, and provenance.
3. Prove deterministic idempotency/replay convergence for repeated identical execution attempts.
4. Prove failure semantics produce explicit failed provenance and do not create contradictory durable state.
5. Prove TransformRegistry remains catalog/discovery authority and never executes transforms.
6. Prove TransformRuntime remains the sole executor and resolves through TransformRegistry.
7. Prove TransformRecord remains immutable provenance and is never mutated after creation.
8. Mechanically re-check the V3 anti-dependency prohibitions.
9. Prove PostgreSQL is the durable source of registry/provenance state and the integration suite is deterministic from a clean database.
10. Produce objective evidence mapped to every W013 acceptance criterion.

## Mandatory Prohibitions
Do NOT:
- create a new architecture version or Architecture Change Request;
- implement concrete compression, encryption, VPP, Compute, or other vertical transforms;
- redesign TransformRegistry or TransformRuntime contracts;
- modify TransformRecord semantics;
- redesign Prisma schema;
- integrate EconomicPipeline, Route, Transport, RuntimeRegistry, or kernel services;
- introduce marketplace, SDK, sandbox, licensing, or cryptographic certification architecture;
- promote DOM-P04..P08;
- start WORK-014 or any later Work Item.

## Required Verification
- PostgreSQL end-to-end registry → runtime → provenance integration tests
- tenant-isolation tests
- idempotency/replay convergence tests
- failure/provenance consistency tests
- TransformRegistry authority regression tests
- TransformRecord immutability tests
- static anti-dependency architecture tests
- specification validator
- Typecheck
- Architecture Contract Tests
- PostgreSQL suite
- Lint
- exact diff/scope inspection

## STOP CONDITIONS
Stop and report to the Architect if:
- an acceptance criterion cannot be satisfied without changing IAAS-DOM-ARCH-3;
- a schema change appears necessary;
- a concrete Transform implementation is required to make the end-to-end proof meaningful;
- Registry and Runtime ownership boundaries need to change;
- a vertical, economic, routing, transport, runtime-kernel, or marketplace dependency becomes necessary;
- failure semantics conflict with existing frozen contracts.

## Definition of Done
Implementation complete, objective evidence recorded against W013-AC01–W013-AC11, all required CI gates green, one active PR, no architecture drift, and PR submitted for independent Architect Review.
