# WORK ORDER — WORK-003

## Identity

- Work Item: `WORK-003`
- Title: VerifiedEvidenceContext Implementation
- Governing Architecture Version: `IAAS-GOV-ARCH-1`
- Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
- Architecture Change Request: `ACR-001` (APPROVED)
- Implementer: Z.ai
- Architect / Reviewer: Chief Architect

## Objective

Implement the frozen `VerifiedEvidenceContext` contract as the explicit generic boundary for already-verified economic evidence entering the generic Economic Pipeline.

## Requirements

- `DOM-013`
- `W003-AC01` through `W003-AC09`
- ACR-001

## Existing Repository Evidence

The current architecture records a VPP-specific pre-pipeline pattern in which `eventId` and `attestationId` are pre-populated on economic-pipeline checkpoint state after vertical-specific evidence and verification. Constitution §6 explicitly identifies `VerifiedEvidenceContext` as the intended generic evolution.

Durable PostgreSQL `Event`, `VerificationResult`, and `Attestation` records remain the source of truth. Existing reconciliation validates deterministic identities and recovers stale/NULL references.

## Required Implementation

1. Introduce an immutable, vertical-neutral `VerifiedEvidenceContext` at the evidence/economic boundary.
2. Define the exact field/type contract required by `IAAS-DOM-ARCH-2` without duplicating durable evidence payloads.
3. Integrate the generic Economic Pipeline so a valid context can enter contribution/reward/ledger/settlement processing without re-running evidence/verification stages.
4. Migrate the existing VPP pre-pipeline handoff to construct the context while preserving VPP baseline calculation and dispatch semantics.
5. Validate all durable Event/Attestation references before economic processing and preserve existing stale/invalid-reference recovery behavior.
6. Add architecture tests proving the context does not depend on vertical services or kernel ownership.
7. Add PostgreSQL integration tests proving durable-reference behavior.
8. Add regression tests proving Data Plane and Economic Pipeline remain independent.

## Acceptance Criteria

### W003-AC01

`VerifiedEvidenceContext` is an immutable value object at the evidence/economic boundary.

### W003-AC02

The context references durable Event/Attestation identities and verification policy/version without duplicating durable payloads.

### W003-AC03

The generic Economic Pipeline accepts the context without importing VPP/Compute/Storage/Wireless/Manufacturing or any other vertical.

### W003-AC04

VPP constructs the context and retains its domain-specific baseline/dispatch semantics.

### W003-AC05

Context references are validated against durable PostgreSQL identities and stale/invalid references follow the existing reconciliation recovery rules.

### W003-AC06

`VerifiedEvidenceContext` is not a kernel primitive and is not a ledger/accounting primitive.

### W003-AC07

No Economic Pipeline → Data Plane dependency exists; the existing Data Plane anti-dependencies remain mechanically enforced.

### W003-AC08

PostgreSQL remains the durable source of truth; no SQLite or in-memory-only replacement is introduced.

### W003-AC09

All required tests, static checks, CI verification, and evidence are complete; no unrelated production refactor occurs.

## Repository Scope

Expected areas:

- existing generic evidence/verification services
- `src/lib/control-plane/economic-pipeline.ts`
- VPP evidence/baseline integration boundary
- targeted tests under `tests/`
- governance/architecture checks required for the new contract
- Prisma schema only if an existing persistence fact requires a narrowly-scoped representation of the context (escalate before schema change)

## Architecture Constraints

- `IAAS-GOV-ARCH-1` remains FROZEN.
- `IAAS-DOM-ARCH-2` remains FROZEN.
- ACR-001 is the complete architectural authorization; do not extend the contract.
- Do not put the context in `src/lib/kernel/`.
- Do not replace Event, VerificationResult, or Attestation.
- Do not create a new ledger/accounting primitive.
- Generic pipeline code MUST remain vertical-neutral.
- Data Plane ↔ Economic Pipeline independence MUST remain intact.
- PostgreSQL remains mandatory.

## Out of Scope

Do not:

- modify Data Plane services or transport behavior;
- implement TransformRegistry or TransformRuntime;
- implement Extensions, Marketplace, or SDK;
- redesign the economic ledger or settlement model;
- broadly refactor VPP;
- introduce architecture version 3;
- change frozen architecture documents;
- fix unrelated pre-existing TypeScript/architecture/integration failures;
- implement another Work Item.

## Required Tests

- context construction and immutability tests;
- valid durable Event/Attestation reference tests;
- stale/invalid reference rejection/recovery tests;
- VPP integration test proving context construction;
- generic pipeline consumption test proving vertical neutrality;
- static import architecture tests;
- PostgreSQL integration tests for durable-reference validation;
- Data Plane ↔ Economic Pipeline anti-dependency regression test;
- full governance spec validation.

## Required Evidence

Provide:

- exact commands and outputs;
- CI run/job evidence;
- acceptance-criterion evidence matrix W003-AC01…W003-AC09;
- static import evidence;
- PostgreSQL evidence;
- final diff showing no unrelated scope expansion;
- any blocker or architecture ambiguity explicitly documented.

## Stop Conditions

Stop and report to the Architect if:

- implementation requires a new architectural primitive not covered by ACR-001;
- the context requires kernel ownership;
- Event/VerificationResult/Attestation source-of-truth rules must change;
- existing reconciliation behavior cannot be preserved;
- VPP cannot be migrated without changing its domain-specific semantics;
- a schema change broader than the authorized context representation becomes necessary;
- any Data Plane ↔ Economic Pipeline dependency would be required;
- the implementation would require changing `IAAS-DOM-ARCH-2`.

## Definition of Done

1. `VerifiedEvidenceContext` is implemented exactly within ACR-001.
2. VPP integration uses the context without losing domain-specific behavior.
3. Generic pipeline remains vertical-neutral.
4. Durable PostgreSQL evidence remains source of truth.
5. Data Plane/Economic Pipeline independence is mechanically proven.
6. Required tests and CI pass.
7. Evidence is complete.
8. PR is submitted for independent Architect Review.
9. Z.ai does not mark `WORK-003` VERIFIED or start another Work Item.
