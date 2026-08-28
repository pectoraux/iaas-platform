# WORK-024R — IAAS-DOM-ARCH-6 Governance Lock Repair

Status: `READY`
Architecture Version: `IAAS-GOV-ARCH-1`
Target Domain Architecture: `IAAS-DOM-ARCH-6` (CANDIDATE)
Dependency: WORK-023 — architecture-completion PR #35 merged and Architect-reviewed
Implementer: Z.ai
Architect / Reviewer: Chief Architect / Architecture Custodian

## Objective
Repair the post-merge governance-lock regression that makes `main` specification CI red, without changing V6 semantics or implementing production features.

## Required implementation

Z.ai MUST submit a PR that changes only the governance/specification surface necessary to restore the canonical legacy validator contract in `spec/architecture-lock.md`.

The PR MUST:

- restore the exact `Domain Architecture Version: ` marker required by the existing specification validator, with V5 as the current version while V6 remains candidate until the freeze gate;
- preserve the historical frozen-rule wording required by the legacy validator;
- place any V6 completion wording in additive governance text rather than silently rewriting historical rule semantics;
- leave all V1-V5 historical architecture artifacts byte-for-byte unchanged;
- make no production-code, schema, migration, dependency, or runtime changes;
- make no new architectural decision or alter ACR-005 semantics.

## Acceptance Criteria

- `W024R-AC01` `bun run spec:validate` passes on the corrected state.
- `W024R-AC02` `bun run v6:validate` passes.
- `W024R-AC03` V1-V5 historical architecture files remain byte-for-byte identical.
- `W024R-AC04` The PR diff is limited to the governance/specification correction required for the failing validator.
- `W024R-AC05` V5 remains CURRENT CANONICAL / FROZEN and V6 remains CANDIDATE / UNDER REVIEW until the separate freeze decision.
- `W024R-AC06` Full CI is green on the PR head.
- `W024R-AC07` No implementation Work Item is started by this correction.

## Verification evidence

Z.ai must provide in the PR:

1. exact diff scope;
2. mapping of W024R-AC01..AC07 to objective evidence;
3. local reproduction of the formerly failing validator;
4. green GitHub Actions results for the corrected PR;
5. confirmation that no production files, schema, migrations, or dependencies changed.

## Out of Scope

Production implementation; V6 freeze; NetworkInstance; Network-as-Code; composition; allocation; fragmentation; trust; packaging; economics; operations; observability; SDK; federation; reference networks; dependency upgrades; historical architecture rewrites.

## Governance constraints

- `IAAS-DOM-ARCH-6` remains CANDIDATE until the independent Architect review and explicit WORK-024 freeze gate are satisfied.
- This Work Order is a correction to governance/validation compatibility, not a new architecture version.
- If the correction reveals an actual architectural contradiction, Z.ai MUST stop and report it for Architect review rather than changing V6 silently.
- WORK-025 and later remain blocked until V6 is explicitly frozen and the release gate is satisfied.

## Definition of Done

Z.ai opens a bounded PR implementing only this correction, all acceptance criteria pass, and the Architect approves the PR. V6 freeze remains a separate subsequent governance decision.