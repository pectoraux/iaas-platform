# IAAS Work Items

## Schema

Every Work Item MUST define: Work ID, Objective, Governing Architecture Version, Requirements, Acceptance Criteria, Dependencies, Architecture Constraints, Repository Scope, Out of Scope, Required Verification, Definition of Done.

## Lifecycle

```text
DRAFT -> READY -> ASSIGNED -> IMPLEMENTING -> PR_OPEN -> VERIFYING -> ARCHITECT_REVIEW -> MERGED -> VERIFIED
VERIFYING -> VERIFICATION_FAILED -> IMPLEMENTING
ARCHITECT_REVIEW -> REQUEST_CHANGES -> IMPLEMENTING
ARCHITECT_REVIEW -> ARCHITECTURE_CHANGE_REQUIRED -> ARCHITECTURE_CHANGE_REQUEST
ARCHITECT_REVIEW -> IMPLEMENTATION_BLOCKED -> IMPLEMENTING
```

## VERIFIED historical Work Items

WORK-001 through WORK-014 are `VERIFIED` in dependency order. `IAAS-DOM-ARCH-4` is the current frozen domain architecture after approved ACR-003.

## WORK-015 — IAAS-DOM-ARCH-4 Freeze and DOM-P04 Truth Promotion

Status: `READY`

Architecture Version: `IAAS-GOV-ARCH-1`

Domain Architecture: `IAAS-DOM-ARCH-4` (FROZEN)

Architecture Change Request: `ACR-003` (APPROVED)

Dependencies: `WORK-014`

Requirements: `ACR-003`; `GOV-001`, `GOV-003`, `GOV-006`, `GOV-008`; V4 DOM-018..DOM-022.

Objective: persist the approved ACR-003 decision, freeze IAAS-DOM-ARCH-4 as the current canonical domain architecture, promote DOM-P04 into DOM-018..DOM-022, preserve V3 as immutable historical architecture, and release the first Extension implementation Work Items only after this governance transition is verified.

Repository Scope: `spec/` architecture/change-control documents, Work Item/dependency records, regression tests, CI configuration, and verification evidence only.

Architecture Constraints: `IAAS-GOV-ARCH-1` and `IAAS-DOM-ARCH-4` are FROZEN; V3 remains immutable historical architecture; no production implementation; no Prisma changes; no ExtensionRegistry/Runtime implementation; no sandbox selection; DOM-P05..P08 remain future/open/research.

Out of Scope: Extension production code, ExtensionRegistry/ExtensionRuntime implementation, Prisma/schema changes, sandbox technology implementation/selection, Marketplace, SDK, licensing, economic attribution, concrete extensions, DOM-P05..P08 promotion, or any architecture change beyond approved ACR-003.

Acceptance Criteria:
- `W015-AC01` ACR-003 is recorded as `APPROVED` with Architect decision metadata.
- `W015-AC02` IAAS-DOM-ARCH-4 is marked `FROZEN` and is the current canonical domain architecture.
- `W015-AC03` IAAS-DOM-ARCH-3 remains immutable historical architecture and is not rewritten.
- `W015-AC04` DOM-018..DOM-022 are frozen acceptance-bearing requirements under approved ACR-003.
- `W015-AC05` DOM-P04 is explicitly `SUPERSEDED` by DOM-018..DOM-022 in the current V4 requirement set; V1 historical requirements remain untouched.
- `W015-AC06` V4 dependency graph is frozen/canonical and remains acyclic with explicit Extension→Transform direction and anti-dependencies.
- `W015-AC07` persistent Work Item state records WORK-014 as `VERIFIED` and WORK-015 as `READY`, with `WORK-014 -> WORK-015` dependency.
- `W015-AC08` regression tests prevent reversion to candidate/future state and verify V3 immutability.
- `W015-AC09` no `src/` or Prisma changes and no production Extension implementation is introduced.
- `W015-AC10` specification validator, regression tests, Typecheck, Architecture Contract Tests, lint, CI, and exact scope inspection pass.
- `W015-AC11` no later implementation Work Item is released until WORK-015 is independently verified and merged.

Required Verification: ACR/V4 state inspection; V3 immutability regression; V4 freeze/promotion tests; specification validator; Typecheck; Architecture Contract Tests; lint; CI; exact scope/diff inspection; independent Architect Review.

Definition of Done: ACR-003 approval and V4 freeze are persistently recorded; DOM-P04 truth is promoted; WORK-014 is VERIFIED; WORK-015 is merged and VERIFIED by independent Architect Review; no production implementation has started.
