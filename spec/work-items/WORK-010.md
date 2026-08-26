# WORK-010 — TransformRegistry Implementation

Status: `VERIFIED`

Architecture Version: `IAAS-GOV-ARCH-1`

Domain Architecture: `IAAS-DOM-ARCH-3` (FROZEN)

Dependencies: `WORK-009`

Requirements: `BASE-017`, `DOM-015`; inherited V1/V2/V3 boundaries.

Objective: implement the frozen `TransformRegistry` contract as the first Transform Stack implementation slice.

Repository Scope: service-layer TransformRegistry implementation, registry persistence required by the frozen contract, targeted domain/unit/PostgreSQL tests, static anti-dependency tests, CI/specification updates required by the implementation, and evidence.

Architecture Constraints: `IAAS-DOM-ARCH-3` is FROZEN; TransformRegistry is service-layer only; tenant-scoped; discovery/catalog and version compatibility only; no execution; no marketplace; no kernel ownership; no RuntimeRegistry; no vertical/EconomicPipeline/Route/Transport imports; PostgreSQL is durable source of truth; TransformRuntime remains unimplemented and must not be introduced as part of WORK-010.

Out of Scope: TransformRuntime implementation; concrete Transform implementations; marketplace/licensing; sandbox technology; SDK; signatures/certification cryptography beyond metadata required by the frozen registry contract; changes to TransformRecord semantics; Data Plane routing/transport changes; EconomicPipeline; RuntimeRegistry; kernel changes; new architecture version.

Acceptance Criteria:

- `W010-AC01` a service-layer `TransformRegistry` contract/implementation exists with tenant-scoped lookup by `(transformType, transformVersion)`.
- `W010-AC02` registry metadata supports version compatibility rules without executing transforms.
- `W010-AC03` certification metadata is represented with certifier identity/status and revocation metadata with status/reason/revokedAt, without prematurely freezing cryptographic implementation.
- `W010-AC04` PostgreSQL is the durable source of registry state; concurrent/idempotent registration behavior is deterministic.
- `W010-AC05` tenant isolation is mechanically proven; cross-tenant lookup/registration cannot leak records.
- `W010-AC06` static architecture checks prove the registry imports no vertical services, EconomicPipeline, Route/Transport, RuntimeRegistry, or kernel code.
- `W010-AC07` TransformRuntime remains absent/unimplemented; registry does not execute transforms and does not mutate TransformRecord.
- `W010-AC08` all targeted tests, specification validation, typecheck, lint, PostgreSQL integration tests, and exact diff/scope checks pass with objective evidence.

Required Verification:

- unit tests for registration, lookup, compatibility, certification/revocation metadata, idempotency;
- PostgreSQL integration tests for tenant isolation and concurrent registration;
- static import/anti-dependency tests;
- explicit test that registry does not execute transforms;
- explicit test that TransformRuntime remains absent from production code;
- full CI evidence and exact PR diff inspection;
- independent Architect Review.

Definition of Done: registry implementation satisfies DOM-015 without architecture drift; TransformRuntime remains unimplemented; PostgreSQL evidence is green; CI gates pass; PR merged; Work Item VERIFIED by the Architect.
