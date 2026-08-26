# WORK-008 — Architecture Truth Reconciliation and Verified-Evidence Promotion

## Identity

- Work Item: `WORK-008`
- Title: Architecture Truth Reconciliation and Verified-Evidence Promotion
- Governing Architecture Version: `IAAS-GOV-ARCH-1`
- Current Domain Architecture: `IAAS-DOM-ARCH-2` (FROZEN)
- Implementer: Z.ai
- Architect / Reviewer: Chief Architect
- Status: `READY`

## Objective

Synchronize the canonical planning/specification layer with verified repository reality after WORK-003 and WORK-007.

The repository currently contains an obsolete classification in the historical V1-derived domain requirements: `DOM-P01 VerifiedEvidenceContext` is still labelled `PROPOSED`, even though ACR-001 was approved, `IAAS-DOM-ARCH-2` was frozen, and WORK-003 was implemented and VERIFIED.

WORK-008 must reconcile this truth drift without modifying any frozen architecture version in place.

## Requirements

- `BASE-015` — Architecture Truth Synchronization
- `GOV-001` — frozen architecture versions are immutable
- `GOV-003` — evidence-based verification
- `GOV-006` — truth classification
- `GOV-008` — dependency-derived eligibility

## Acceptance Criteria

### W008-AC01 — Truth Drift Inventory

Every stale statement identified as contradictory to the verified `IAAS-DOM-ARCH-2` / WORK-003 state is captured with:

- source document
- current statement
- verified repository evidence
- classification
- required correction

### W008-AC02 — VerifiedEvidenceContext Promotion

`VerifiedEvidenceContext` is no longer represented as a merely proposed architecture gap in the current domain requirements/index. The current canonical specification must identify it as implemented under `IAAS-DOM-ARCH-2` and trace it to ACR-001 and WORK-003.

### W008-AC03 — Historical V1 Preservation

`IAAS-DOM-ARCH-1` remains immutable historical architecture. Its wording is not silently rewritten.

### W008-AC04 — No Unrelated Promotion

No other `DOM-Pxx` future/open/research item may be promoted merely because related code exists. Promotion requires its own verified architecture decision and Work Item evidence.

### W008-AC05 — Cross-Document Consistency

The following remain mutually consistent:

- `spec/domain-architecture.md`
- `spec/domain-architecture-v2.md`
- `spec/domain-requirements.md`
- `spec/architecture.md`
- `spec/architecture-lock.md`
- `spec/work-items.md` / the current work-state record
- `spec/dependency-graph.md`

### W008-AC06 — Regression Protection

Add or update deterministic specification tests so the validator can detect a future reversion that incorrectly labels an already-VERIFIED architecture primitive as merely proposed.

### W008-AC07 — No Production Changes

No `src/`, `prisma/`, runtime, economic, Data Plane, or vertical production implementation changes are permitted.

### W008-AC08 — Governance Gates

The specification validator, architecture-contract tests, Typecheck, PostgreSQL integration suite, lint, and exact diff-scope verification remain green.

## Scope

Allowed:

- `spec/`
- `docs/architecture/` only for reconciliation/addendum evidence, not frozen-architecture mutation
- directly related specification tests
- CI configuration only when required to execute those tests

Forbidden:

- modifying frozen architecture versions in place
- production code changes
- new domain primitives
- new ACRs unless the reconciliation discovers a genuine contradiction
- promoting TransformRegistry, TransformRuntime, Extensions, Marketplace, SDK, Fragmentation/Reassembly, or other future items

## Required Evidence

1. Truth-drift inventory.
2. Updated current-domain requirement/index state.
3. Historical V1 unchanged evidence.
4. Regression test proving the verified-evidence promotion cannot silently revert.
5. Full CI evidence.
6. Exact diff/scope evidence.

## Stop Conditions

Stop and report to the Architect if the audit reveals:

- the verified repository implementation contradicts `IAAS-DOM-ARCH-2` itself;
- promotion would require a new architectural primitive rather than truth synchronization;
- a frozen architecture document must be changed in place;
- another proposed primitive appears implemented but lacks a verified architecture decision.

## Definition of Done

- truth drift is inventoried;
- VerifiedEvidenceContext is correctly represented as implemented/current;
- historical V1 remains immutable;
- unrelated future primitives remain future/proposed;
- regression protection is added;
- all governance and engineering CI gates remain green;
- PR submitted;
- Architect Review approves;
- PR merged;
- WORK-008 becomes `VERIFIED` only after independent Architect Review.
