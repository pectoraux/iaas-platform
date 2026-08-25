# WORK-001 — Verification Evidence (Implementer-Submitted)

- Work Item: `WORK-001`
- Architecture Version: `IAAS-GOV-ARCH-1`
- Implementer: Z.ai
- Prepared: 2026-08-25 (UTC)
- Updated: 2026-08-25 (UTC) — second submission round: Architect Review corrections AR-001, AR-002, AR-003
- Status: **submitted for independent verification and Architect Review**

> Per `spec/verification.md`, this document records objective evidence
> (commands, outputs, CI runs, diffs). It is implementer-collected evidence.
> It does not establish `VERIFIED` — that decision belongs to verification and
> Architect Review, which remain separate from this submission (GOV-003/GOV-004).

## 1. Exact Validator Command

```text
bun run spec:validate
```

(equivalently: `bun scripts/spec-validator.ts`; the validator is
dependency-free and accepts `--spec-dir <path>` for negative-test isolation.)

## 2. Successful Command Output (local, commit d3eb4d70)

```text
$ bun run spec:validate
$ bun scripts/spec-validator.ts
SPEC VALIDATION PASSED
architecture=IAAS-GOV-ARCH-1 required-files=10 work-items=2 work001-acceptance-criteria=13 dependency-edges=1 checks=16
```

Exit code: `0`. Output is deterministic (byte-identical across repeated runs;
asserted by the positive test).

## 3. CI Job/Run URL and Result

- Workflow run (implementation commit `d3eb4d70`):
  https://github.com/pectoraux/iaas-platform/actions/runs/32837200309
- Job: **Specification Consistency Validator (WORK-001)** — `success`
  - Job URL: https://github.com/pectoraux/iaas-platform/actions/runs/32837200309/job/97768602064
  - Steps: validator `success`; negative tests `success` (19 pass / 0 fail);
    diff-scope enforcement `success`.
- CI validator output (from the job log):

  ```text
  SPEC VALIDATION PASSED
  architecture=IAAS-GOV-ARCH-1 required-files=10 work-items=2 work001-acceptance-criteria=13 dependency-edges=1 checks=16
  ```

- CI diff-scope guard output (from the job log):

  ```text
  WORK-001 diff scope check passed: only governance/specification artifacts changed.
  Changed files:
  .github/workflows/ci.yml
  package.json
  scripts/spec-validator.ts
  spec/README.md
  spec/architecture-change-request.md
  spec/architecture-lock.md
  spec/architecture.md
  spec/dependency-graph.md
  spec/requirements.md
  spec/verification.md
  spec/work-items.md
  spec/work-order-template.md
  spec/work-orders/WORK-001.md
  tests/spec-consistency-validator.test.ts
  ```

### Pre-existing CI baseline failures (OBSERVED, not caused by WORK-001)

The `Typecheck`, `Architecture Contract Tests`, and `PostgreSQL Integration
Tests` jobs fail on this run. These failures are pre-existing on `main`
(run https://github.com/pectoraux/iaas-platform/actions/runs/32511416648,
commit `db61a940`, same three jobs failing) and are unrelated to WORK-001:
the WORK-001 diff touches no production code (mechanically enforced by the
diff-scope guard above). The pre-existing failures are repository baseline
material for WORK-002's truth-classified audit and are explicitly out of
WORK-001 scope ("Do not change IAAS production services"). Fixing them here
would violate the Work Order's scope containment.

## 4. Negative Test Evidence

Command:

```text
bun test tests/spec-consistency-validator.test.ts
```

Result (local and in CI): **25 pass / 0 fail** (19 in the first submission round; +6 for the AR-001 complete-schema enforcement).

Required failure cases from the Work Order ("Required Tests"):

| # | Required negative case | Test name | Validator check |
|---|---|---|---|
| 1 | required spec file missing | `fails when a required spec file is missing` | SC-01 |
| 2 | Work Item dependency unresolved | `fails when a Work Item dependency is unresolved` | SC-09 |
| 3 | malformed/missing architecture version | `fails when a Work Item does not declare an architecture version`; `fails when the frozen governance architecture version is inconsistent between documents`; `fails when the governance architecture version is malformed` | SC-05 / SC-03 |
| 4 | required WORK-001 AC missing | `fails when a required WORK-001 acceptance criterion is missing` | SC-07 |
| 5 | WORK-001 forbidden production scope | `fails when WORK-001 declares forbidden production scope`; `fails when the WORK-001 production freeze is removed from requirements` | SC-15 |

Additional negative cases (beyond the required minimum):

| Negative case | Validator check |
|---|---|
| duplicate WORK-001 AC IDs | SC-07 |
| dependency graph contains a cycle | SC-10 |
| duplicate dependency edge in dependency-graph.md | SC-10 |
| graph edge not declared in work-items.md | SC-10 |
| WORK-002 marked eligible before WORK-001 is VERIFIED | SC-11 |
| truth classification removed | SC-12 |
| ACR protocol corrupted | SC-13 |
| verification protocol loses evidence/narrative distinction | SC-14 |
| required Work Item field missing | SC-06 |
| schema field required for every Work Item missing (AR-001) | SC-06 |
| empty schema field value (AR-001) | SC-06 |
| required schema section missing (AR-001) | SC-06 |
| Work Item declares no acceptance criterion IDs (AR-001) | SC-06 |
| WORK-001 Required Verification loses a required activity (AR-001) | SC-08 |
| WORK-001 Definition of Done loses a required element (AR-001) | SC-08 |
| persistent Work Order loses its verification gate | SC-16 |
| positive case: current spec passes deterministically | — |

### 4a. One-Active-PR Invariant Check Tests (AR-002)

Command:

```text
bun test tests/pr-invariant-check.test.ts
```

Result (local and in CI): **18 pass / 0 fail**.

| Case class | Test name |
|---|---|
| violation (exit 1) | two open PRs reference the same Work Item |
| violation (exit 1) | branch-only references, titles carry no Work Item ID |
| violation (exit 1) | one PR attributed via title, another via branch |
| non-attribution | wording like “network-12” is not misattributed |
| pass (exit 0) | single PR references one Work Item |
| pass (exit 0) | different Work Items each have exactly one PR |
| pass (exit 0) | zero open PRs |
| pass (exit 0) | unattributed open PRs reported without failing |
| pass (exit 0) | GitHub API-shaped fixtures (`head` as `{ref: ...}`) |
| pass (exit 0) | `{"pulls": [...]}` object fixtures |
| fail-closed (exit 2) | fixture file missing |
| fail-closed (exit 2) | fixture not valid JSON |
| fail-closed (exit 2) | fixture invalid shape |
| fail-closed (exit 2) | fixture entry malformed |
| fail-closed (exit 2) | `--repo` omitted for live verification |
| fail-closed (exit 2) | `--repo` not `<owner>/<name>` |
| fail-closed (exit 2) | GitHub API unreachable |
| fail-closed (exit 2) | no GitHub token available |

Technique: the spec-consistency tests each copy `spec/` to a temporary
directory, apply one targeted mutation, and run the validator as a
subprocess against the mutated copy, asserting non-zero exit,
`SPEC VALIDATION FAILED` on stderr, the expected check ID, and the expected
diagnostic fragment. The PR-invariant tests drive the check as a subprocess
with JSON fixtures (violation cases) and closed local ports / missing
credentials (fail-closed cases); the suite is deterministic and offline.

## 5. Final PR Diff Evidence (no production IAAS changes)

```text
$ git diff --stat origin/main...HEAD
  .github/workflows/ci.yml                        |  65 +-
  package.json                                    |   5 +-
  scripts/pr-invariant-check.ts                   | 299 +++++++++
  scripts/spec-validator.ts                       | 774 ++++++++++++++++++++++++
  spec/README.md                                  |  38 ++
  spec/architecture-change-request.md             |  29 +
  spec/architecture-lock.md                       |  34 ++
  spec/architecture.md                            |  12 +
  spec/dependency-graph.md                        |  13 +
 spec/evidence/WORK-001-verification-evidence.md (this file)
  spec/requirements.md                            |  45 ++
  spec/verification.md                            |  21 +
  spec/work-items.md                              |  89 +++
  spec/work-order-template.md                     |  28 +
  spec/work-orders/WORK-001.md                    | 103 ++++
  tests/pr-invariant-check.test.ts                | 273 +++++++++
  tests/spec-consistency-validator.test.ts        | 365 +++++++++++
```

Observations:

- No `src/`, `prisma/`, `mini-services/`, Node/Data Plane/Routing/Transport,
  or vertical network files are touched.
- `package.json` changes only add the `spec:validate`, `spec:test`, and
  `spec:pr-invariant` script entries (explicitly allowed: "package.json only
  if required to expose the validator command").
- The diff-scope guard in CI mechanically enforces this allowlist on every
  future PR push for this branch, and now FAILS CLOSED when the diff base
  cannot be resolved (AR-003).

## 6. Validator Check Map (Work Order "Required Implementation" coverage)

| Work Order requirement | Validator check(s) |
|---|---|
| 2. required spec files exist | SC-01, SC-02 |
| 3. frozen governance version present and consistent | SC-03, SC-04 |
| 4. every Work Item declares exactly one architecture version | SC-05 |
| 5. required Work Item fields + 13 WORK-001 AC IDs | SC-06 (complete schema, every Work Item — AR-001), SC-07, SC-08 (content pinning — AR-001) |
| 6. dependency references resolve; graph acyclic | SC-09, SC-10 |
| 7. WORK-002 not eligible before WORK-001 VERIFIED | SC-11 |
| 8. required truth classifications | SC-12 |
| 9. ACR protocol exists and is referenced | SC-13 |
| 10. verification protocol distinguishes evidence from narrative | SC-14 |
| 11. WORK-001 contains no production implementation scope | SC-15 (+ CI diff-scope guard) |
| 12. CI invocation | `.github/workflows/ci.yml` job `spec-validation` (also runs the one-active-PR invariant against live GitHub state — AR-002) |
| 13. non-zero exit on inconsistency; deterministic success message | validator exit contract + positive/negative tests |

## 7. Acceptance Criterion Evidence Index (W001-AC01 … W001-AC13)

Evidence below is implementer-collected and maps each acceptance criterion to
the mechanical artifact that satisfies it. Independent re-execution is
encouraged: all commands are deterministic and reproducible.

| Criterion | Evidence (command or artifact) |
|---|---|
| W001-AC01 | `spec/architecture-lock.md` (FROZEN `IAAS-GOV-ARCH-1`); validator checks SC-03 |
| W001-AC02 | validator check SC-05 (exactly one version per Work Item) |
| W001-AC03 | `spec/requirements.md` GOV-001..GOV-008; SC-06/SC-07/SC-08 |
| W001-AC04 | `spec/work-items.md` WORK-001 Dependencies/Out of Scope; SC-06 |
| W001-AC05 | `spec/architecture-change-request.md`; SC-13 |
| W001-AC06 | `spec/verification.md` agent-narrative rule; SC-14 |
| W001-AC07 | this document, sections 1–4 (evidence maps to ACs) |
| W001-AC08 | `spec/verification.md` + `spec/architecture-lock.md` rule 7; SC-14 |
| W001-AC09 | `scripts/pr-invariant-check.ts` verifies live GitHub state (see section 10.2); CI step "Verify one-active-PR invariant (W001-AC09, live GitHub state)"; negative-tested in `tests/pr-invariant-check.test.ts` |
| W001-AC10 | validator check SC-09/SC-10 (resolution + acyclicity; negative-tested) |
| W001-AC11 | validator check SC-12 (truth classifications; negative-tested) |
| W001-AC12 | validator check SC-11 (WORK-002 blocked until WORK-001 VERIFIED; negative-tested) |
| W001-AC13 | CI diff-scope guard (section 3) + SC-15 (negative-tested) |

## 8. Stop-Condition Assessment

No stop condition was triggered:

- the specification does not contradict the constitutional architecture;
- all invariants were expressible without changing frozen architecture;
- the validator required no domain-specific assumptions;
- CI executes the validator with no unrelated infrastructure changes
  (the spec-validation job is dependency-free);
- no scope expansion occurred (mechanically enforced, section 3).

## 9. Implementer Boundary Statement

- WORK-001 is **not** marked `VERIFIED` by the implementer.
- The PR is **not** merged by the implementer.
- No production IAAS implementation, schema, migration, Node/Data
  Plane/Routing/Transport, or vertical network code was modified.
- The next Work Item (WORK-002) was not started; it remains `BLOCKED` until
  WORK-001 is `VERIFIED` by the Architect.

## 10. Architect Review Corrections (AR-001 / AR-002 / AR-003)

The independent Architect Review of the first submission round identified
three governance defects. All three are corrected in this PR (same Work
Item, same branch, commits `3d09a92` and `c000b9f`). WORK-002 was not
started.

### 10.1 AR-001 — Work Item schema under-enforced

**Defect.** The declared schema (spec/work-items.md "Schema" / GOV-002)
requires Architecture Constraints, Repository Scope, Required Verification,
Definition of Done, etc., but the validator only enforced a subset of fields,
and only pinned the remainder for WORK-001.

**Correction.**

- `SC-06` now enforces ALL 11 declared schema fields for EVERY Work Item,
  including non-empty values and non-vacuous acceptance criteria (each Work
  Item must carry its own `W<nnn>-ACnn` criterion IDs). The success line
  reports `work-item-schema-fields=11`.
- `SC-08` was repurposed from redundant presence checks to CONTENT pinning:
  the six required WORK-001 verification activities and the four Definition
  of Done elements.
- `spec/work-items.md` was conformed to the schema it declares. WORK-002's
  new fields (Requirements, Repository Scope, Architecture Constraints,
  Acceptance Criteria `W002-AC01..04`, Required Verification, Definition of
  Done) are derived strictly from its already-declared objective and
  deliverables; its `BLOCKED` status and dependency edge are unchanged. No
  WORK-002 deliverable was produced.
- Acceptance-criterion IDs are parsed from the `Acceptance Criteria:`
  section only (range references in `Requirements:` can no longer
  masquerade as duplicate criteria).

**Negative-test proof (6 new tests, all failing as intended):** missing
schema field on any Work Item; empty schema value; missing schema section;
no acceptance criterion IDs; lost verification activity; lost DoD element.

### 10.2 AR-002 — One-active-PR invariant not actually verified

**Defect.** `W001-AC09` / GOV-005 / frozen rule 8 say a Work Item has at
most one active implementation PR, but nothing established the invariant
against GitHub state — the evidence relied on PR #3 itself.

**Correction.** New `scripts/pr-invariant-check.ts` establishes the
invariant against live GitHub state:

```text
$ bun scripts/pr-invariant-check.ts --repo pectoraux/iaas-platform
PR INVARIANT PASSED
open-prs=2 work-items-with-active-prs=1 unattributed-open-prs=1
WORK-001: active-prs=1 (pr=#3)
```

Exit code `0`. Classification: an open PR is an implementation PR for
`WORK-xxx` when its title or head branch references `WORK-xxx`. PR #1
("Phase 12B Slice 6", head `phase-12b-slice-6-reconciliation-hardening`)
references no Work Item — it predates the governance layer and is reported
as `unattributed-open-prs=1`, disclosed here as OBSERVED repository state
(adjudicating a pre-governance PR is outside WORK-001's authority).

**Fail-closed contract.** Exit 2 — not a skip — whenever the invariant
cannot be established: no token, API failure, malformed response, or more
than 1000 open PRs. Exit 1 on violation, exit 0 with a deterministic
summary otherwise.

**CI enforcement.** The `spec-validation` CI job now runs
`bun scripts/pr-invariant-check.ts --repo ${{ github.repository }}` with
`secrets.GITHUB_TOKEN` on every push and PR, so a second WORK-001 PR opened
anywhere would mechanically fail CI. 18 negative tests
(`tests/pr-invariant-check.test.ts`) prove violation detection (title,
branch, mixed references) and every fail-closed path.

**CI output (run 32841488946, job 97781766086):**

```text
PR INVARIANT PASSED
open-prs=2 work-items-with-active-prs=1 unattributed-open-prs=1
WORK-001: active-prs=1 (pr=#3)
```

### 10.3 AR-003 — Diff-scope guard did not fail closed

**Defect.** The CI guard exited 0 when `origin/${{ github.base_ref }}`
could not be resolved, so the production-scope protection could be skipped
instead of failing.

**Correction.** The guard now FAILS CLOSED (exit 1):

```text
WORK-001 SCOPE CHECK FAILED (fail-closed): cannot resolve diff base '<BASE>'.
The production-scope guard must never be skipped; failing instead of passing without a verifiable base.
```

The allowlist was extended with the two new governance artifacts
(`scripts/pr-invariant-check.ts`, `tests/pr-invariant-check.test.ts`).
CI evidence (same run): `WORK-001 diff scope check passed: only
governance/specification artifacts changed.` with the full changed-file
list limited to `spec/`, the two governance scripts, the two governance
test files, `.github/workflows/ci.yml`, and `package.json`.

### 10.4 Correction-round CI evidence

- Workflow run (correction commits `3d09a92` + `c000b9f`, head `c000b9f`):
  https://github.com/pectoraux/iaas-platform/actions/runs/32841488946
- Job: **Specification Consistency Validator (WORK-001)** — `success`
  - Job URL: https://github.com/pectoraux/iaas-platform/actions/runs/32841488946/job/97781766086
  - Steps: validator `success` (`SPEC VALIDATION PASSED`, `work-item-schema-fields=11`);
    negative tests `success` (**43 pass / 0 fail** = 25 spec-consistency + 18
    PR-invariant); one-active-PR invariant `success` (live GitHub state);
    fail-closed diff-scope enforcement `success`.
- Lint: `success`.
- Typecheck / Architecture Contract Tests / PostgreSQL Integration Tests:
  `failure` — the same pre-existing production baseline failures documented
  in section 3, unchanged by this round (the diff still touches no
  production code; mechanically enforced).
