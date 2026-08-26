# WORK-009 — Transform Stack Architecture Freeze

Status: `READY`

Architecture Version: `IAAS-GOV-ARCH-1`

Current Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)

Target Domain Architecture: `IAAS-DOM-ARCH-3` (must be frozen by this Work Item)

Architecture Change Request: `ACR-002` (APPROVED)

Dependencies: `WORK-008`

Requirements: `BASE-016`; inherited TransformRecord/data-plane/tenant/vertical-neutrality rules from `IAAS-DOM-ARCH-2` and Phase 14F.

Objective: formally specify and freeze the generic Transform + TransformRegistry + TransformRuntime architecture without implementing the production registry or runtime.

Repository Scope: `spec/`, `docs/architecture/` only for architecture synthesis/evidence, targeted governance/specification tests, ACR documentation, and WORK-009 evidence.

Architecture Constraints:

- `IAAS-GOV-ARCH-1` remains FROZEN.
- `IAAS-DOM-ARCH-2` remains immutable historical architecture.
- `TransformRecord` remains the implemented immutable provenance fact.
- TransformRegistry and TransformRuntime remain service/data-plane layer concepts, not kernel primitives.
- Transform architecture remains vertical-neutral.
- No imports into or from RuntimeRegistry, EconomicPipeline, Route, TransportExecution, DeliveryConfirmation, or vertical services except future explicit contracts documented by the architecture.
- PostgreSQL remains canonical where registry metadata/provenance is durable.

Out of Scope:

- production TransformRegistry implementation;
- production TransformRuntime implementation;
- marketplace, SDK, extension sandbox, pricing, settlement, cryptographic-signature infrastructure;
- new Prisma models unless the architecture document explicitly requires them and an Architect-approved follow-on Work Item authorizes implementation;
- modifying `IAAS-DOM-ARCH-2` in place;
- any production code change.

Acceptance Criteria:

- `W009-AC01` approved `ACR-002` is referenced and the proposed architecture change is traceable.
- `W009-AC02` `IAAS-DOM-ARCH-3` is published as the successor architecture and explicitly preserves all V2 rules except the Transform stack promotion.
- `W009-AC03` Transform, TransformRegistry, and TransformRuntime responsibilities and boundaries are explicit.
- `W009-AC04` TransformRecord remains an immutable service-layer provenance fact and is not converted into a registry/runtime primitive.
- `W009-AC05` dependency directions and anti-dependencies are explicit: no kernel ownership; no vertical coupling; no EconomicPipeline/Data Plane leakage; no Route/Transport coupling.
- `W009-AC06` lifecycle, version compatibility, discovery/certification/revocation metadata, execution, verification, failure, and idempotency responsibilities are bounded without prescribing implementation technology prematurely.
- `W009-AC07` future TransformRegistry/Runtime implementation is blocked until `IAAS-DOM-ARCH-3` is VERIFIED, and no production implementation is introduced by WORK-009.
- `W009-AC08` architecture validator/regression tests prove version registration, historical V2 immutability, dependency boundaries, and no production-code changes.

Required Verification:

- architecture/ACR document inspection;
- specification consistency validator;
- targeted negative/positive architecture tests;
- exact diff scope inspection proving zero production files;
- CI evidence;
- independent Architect Review.

Definition of Done: ACR traceable; IAAS-DOM-ARCH-3 published and frozen; V2 preserved as historical architecture; Transform boundaries fully specified; tests and validator pass; zero production changes; PR merged; Work Item VERIFIED.
