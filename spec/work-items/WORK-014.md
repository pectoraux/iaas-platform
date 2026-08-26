# WORK-014 — Extension Stack Architecture and ACR-003

Status: `READY`

Architecture Version: `IAAS-GOV-ARCH-1`

Domain Architecture: `IAAS-DOM-ARCH-3` (FROZEN)

Architecture Change Request: `ACR-003` (DRAFT)

Dependencies: `WORK-013`

Requirements: `ACR-003`; `GOV-001`, `GOV-003`, `GOV-005`, `GOV-006`, `GOV-008`; historical `DOM-P04`.

Objective: produce a complete, reviewable Extension Stack architecture proposal for `Extension`, `ExtensionRegistry`, and `ExtensionRuntime`, resolve the architectural questions in ACR-003, and prepare a candidate `IAAS-DOM-ARCH-4` without implementing extensions or silently promoting DOM-P04.

Repository Scope: `spec/` architecture and requirements documents, ACR-003, architecture regression tests, dependency graph, Work Item/Work Order records, and CI/specification validation needed to prove the proposal.

Architecture Constraints: `IAAS-GOV-ARCH-1` and `IAAS-DOM-ARCH-3` remain FROZEN until an explicit ACR approval and new domain architecture freeze; DOM-P04 remains FUTURE/OPEN/RESEARCH until then; no production implementation; no Prisma changes; no sandbox technology selection; no marketplace/SDK implementation; no concrete extensions; no Transform Stack boundary changes.

Out of Scope: ExtensionRegistry/ExtensionRuntime production code, concrete extensions, sandbox implementation, marketplace, SDK, licensing, economic attribution, cryptographic certification mechanism, Prisma schema redesign, new Data Plane primitives, DOM-P05..P08 promotion.

Acceptance Criteria:

- `W014-AC01` ACR-003 contains an explicit problem statement, scope, non-goals, architectural questions, promotion rule, and approval gate.
- `W014-AC02` Extension contract responsibilities, identity/versioning, capability declaration, compatibility, lifecycle, revocation, and failure semantics are explicit and non-overlapping.
- `W014-AC03` ExtensionRegistry responsibilities are limited to discovery/catalog/version/lifecycle metadata and do not include execution.
- `W014-AC04` ExtensionRuntime responsibilities are limited to execution/isolation and do not own catalog/discovery state.
- `W014-AC05` tenant isolation, capability/dependency boundaries, resource limits, and security/isolation obligations are explicit without selecting a sandbox technology prematurely.
- `W014-AC06` anti-dependencies from the Extension Stack to vertical services, EconomicPipeline, Route/Transport, RuntimeRegistry, and kernel implementation are explicit and regression-tested.
- `W014-AC07` the relationship between Extension Stack and Transform Stack is explicit; neither subsystem becomes the other.
- `W014-AC08` DOM-P04 remains FUTURE/OPEN/RESEARCH until the Architect explicitly approves ACR-003 and freezes a new domain architecture version.
- `W014-AC09` no production files, Prisma schema, or frozen V3 architecture are modified by the architecture proposal.
- `W014-AC10` the specification validator, architecture regression tests, Typecheck, lint, and exact scope checks pass.
- `W014-AC11` the Architect independently reviews and either approves the proposed V4 architecture or returns ACR-003 for correction; no implementation Work Item is released automatically.

Required Verification:

- ACR-003 completeness and traceability;
- candidate IAAS-DOM-ARCH-4 consistency inspection;
- Extension/Registry/Runtime responsibility separation tests;
- anti-dependency regression tests;
- explicit DOM-P04 remains-future test until approval;
- historical V1/V2/V3 immutability checks;
- specification validator;
- Typecheck; Architecture Contract Tests; lint;
- exact diff/scope inspection;
- independent Architect Review.

Definition of Done: ACR-003 and candidate V4 architecture are complete and internally consistent; no production implementation is introduced; all governance gates pass; Architect either approves the architecture change and freezes V4 or records required corrections; no subsequent implementation Work Item begins without explicit Architect release.
