# WORK-001 — Verification Evidence (Implementer-Submitted)

- Work Item: `WORK-001`
- Architecture Version: `IAAS-GOV-ARCH-1`
- Implementer: Z.ai
- Prepared: 2026-08-25 (UTC)
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

Result (local and in CI): **19 pass / 0 fail**.

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
| persistent Work Order loses its verification gate | SC-16 |
| positive case: current spec passes deterministically | — |

Each negative test copies `spec/` to a temporary directory, applies one
targeted mutation, runs the validator as a subprocess against the mutated
copy, and asserts: non-zero exit, `SPEC VALIDATION FAILED` on stderr, the
expected check ID, and the expected diagnostic fragment.

## 5. Final PR Diff Evidence (no production IAAS changes)

```text
$ git diff --stat origin/main...HEAD
 .github/workflows/ci.yml                 |  52 +++++++++++++--
 package.json                             |   2 +
 scripts/spec-validator.ts                | 708 +++++++++++++++++++++++++++++++
 spec/README.md                           |  38 ++++
 spec/architecture-change-request.md      |  29 ++++
 spec/architecture-lock.md                |  34 +++++
 spec/architecture.md                     |  12 ++
 spec/dependency-graph.md                 |  13 ++
 spec/requirements.md                     |  45 +++++++
 spec/verification.md                     |  21 ++
 spec/work-items.md                       |  70 +++++++++++
 spec/work-order-template.md              |  28 ++++
 spec/work-orders/WORK-001.md             | 103 +++++++++++++++++
 spec/evidence/WORK-001-verification-evidence.md (this file)
 tests/spec-consistency-validator.test.ts | 302 +++++++++++++++++++++++++++
```

Observations:

- No `src/`, `prisma/`, `mini-services/`, Node/Data Plane/Routing/Transport,
  or vertical network files are touched.
- `package.json` changes only add the `spec:validate` and `spec:test` script
  entries (explicitly allowed: "package.json only if required to expose the
  validator command").
- The diff-scope guard in CI mechanically enforces this allowlist on every
  future PR push for this branch.

## 6. Validator Check Map (Work Order "Required Implementation" coverage)

| Work Order requirement | Validator check(s) |
|---|---|
| 2. required spec files exist | SC-01, SC-02 |
| 3. frozen governance version present and consistent | SC-03, SC-04 |
| 4. every Work Item declares exactly one architecture version | SC-05 |
| 5. required Work Item fields + 13 WORK-001 AC IDs | SC-06, SC-07, SC-08 |
| 6. dependency references resolve; graph acyclic | SC-09, SC-10 |
| 7. WORK-002 not eligible before WORK-001 VERIFIED | SC-11 |
| 8. required truth classifications | SC-12 |
| 9. ACR protocol exists and is referenced | SC-13 |
| 10. verification protocol distinguishes evidence from narrative | SC-14 |
| 11. WORK-001 contains no production implementation scope | SC-15 (+ CI diff-scope guard) |
| 12. CI invocation | `.github/workflows/ci.yml` job `spec-validation` |
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
| W001-AC09 | PR #3 is the single active WORK-001 PR; validator check SC-16 keeps the Work Order's single-PR boundary declared |
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
