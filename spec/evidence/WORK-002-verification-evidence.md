# WORK-002 — Verification Evidence (Implementer-Submitted)

- Work Item: `WORK-002`
- Architecture Version: `IAAS-GOV-ARCH-1` (governance, FROZEN); `IAAS-DOM-ARCH-1` (domain, FROZEN — published by this Work Item)
- Implementer: Z.ai
- Prepared: 2026-08-25 (UTC)
- Status: **submitted for independent verification and Architect Review**

> Per `spec/verification.md`, this document records objective evidence
> (commands, outputs, test results, diffs). It is implementer-collected evidence.
> It does not establish `VERIFIED` — that decision belongs to verification and
> Architect Review (GOV-003/GOV-004).

## 1. Deliverables (Work Order "Required Deliverables")

| # | Deliverable | Path | Status |
|---|---|---|---|
| 1 | Repository baseline (truth-classified) | `docs/architecture/REPOSITORY-BASELINE.md` | committed |
| 2 | Canonical Domain Architecture `IAAS-DOM-ARCH-1` | `spec/domain-architecture.md` | committed; registered in `spec/architecture.md` + `spec/architecture-lock.md` |
| 3 | Domain requirements (stable IDs) | `spec/domain-requirements.md` (DOM-001…DOM-012 + DOM-P01…P08 PROPOSED) | committed |
| 4 | Domain dependency graph (acyclic) | `spec/domain-dependency-graph.md` | committed |
| 5 | Truth-classified reconciliation matrix | `docs/architecture/RECONCILIATION-MATRIX.md` (R-01…R-13) | committed |

## 2. Validator Command and Output

```text
$ bun run spec:validate
SPEC VALIDATION PASSED
architecture=IAAS-GOV-ARCH-1 domain-architecture=IAAS-DOM-ARCH-1 required-files=13 work-items=2 work-item-schema-fields=11 work001-acceptance-criteria=13 dependency-edges=1 checks=19
exit=0
```

The validator was evolved for WORK-002:
- **SC-04 evolved**: the WORK-001 "PENDING WORK-002" placeholder is fulfilled — `IAAS-DOM-ARCH-1` is now registered as FROZEN in `spec/architecture.md` and `spec/architecture-lock.md`, with cross-document consistency enforced. (The frozen governance rules 1–13 are untouched.)
- **SC-11 evolved**: the eligibility text check now verifies the graph states "WORK-001 is VERIFIED" (the release condition), replacing the stale "WORK-002 is blocked until WORK-001 is VERIFIED" text that became false when WORK-001 was marked VERIFIED. (This also fixes a pre-existing negative-test staleness on main — see §6.)
- **SC-17 added**: `spec/domain-architecture.md` declares `IAAS-DOM-ARCH-1`, marks it FROZEN, references `IAAS-GOV-ARCH-1`, and distinguishes IMPLEMENTED / FUTURE / OPEN-RESEARCH / FROZEN-CONTRACT statuses.
- **SC-18 added**: `spec/domain-requirements.md` references `IAAS-DOM-ARCH-1`, uses stable `DOM-xxx` IDs, and distinguishes PROPOSED from implemented.
- **SC-19 added**: `spec/domain-dependency-graph.md` references `IAAS-DOM-ARCH-1`, declares frozen anti-drift prohibitions, records the `Node -> Bundle` data-plane direction, and states the graph is acyclic.

Success line counters updated: `required-files=13` (was 10), `checks=19` (was 16), plus new `domain-architecture=IAAS-DOM-ARCH-1`.

## 3. Test Evidence

```text
$ bun test tests/spec-consistency-validator.test.ts tests/pr-invariant-check.test.ts tests/work-002-baseline.test.ts --timeout 120000
 72 pass
 0 fail
 287 expect() calls
Ran 72 tests across 3 files. [~1.65s]
```

Breakdown:
- `tests/spec-consistency-validator.test.ts`: 36 tests (25 WORK-001 + 11 WORK-002 domain cases). The WORK-001 SC-11 negative test was updated to reflect WORK-001's VERIFIED state (see §6).
- `tests/pr-invariant-check.test.ts`: 18 tests (unchanged, WORK-001).
- `tests/work-002-baseline.test.ts`: 18 new tests verifying the docs/ deliverables (REPOSITORY-BASELINE.md + RECONCILIATION-MATRIX.md existence, truth classifications, audit-area coverage, model-count reconciliation, contradiction recording, no-stop-condition, no INFERRED/PROPOSED promoted to fact).

### WORK-002 negative-test coverage (SC-04 / SC-17 / SC-18 / SC-19)

| Check | Negative case | Test |
|---|---|---|
| SC-04 | domain architecture reverted to PENDING | `fails when the domain architecture is reverted to PENDING` |
| SC-04 | malformed domain version | `fails when the domain architecture version is malformed` |
| SC-04 | domain versions disagree between docs | `fails when domain architecture versions disagree between docs` |
| SC-17 | domain-architecture.md not FROZEN | `fails when domain-architecture.md is not FROZEN` |
| SC-17 | missing status distinction | `fails when domain-architecture.md loses a required status distinction` |
| SC-17 | missing governing-architecture reference | `fails when domain-architecture.md does not reference the governing architecture` |
| SC-18 | no stable DOM-xxx IDs | `fails when domain-requirements.md has no stable DOM-xxx IDs` |
| SC-18 | loses PROPOSED distinction | `fails when domain-requirements.md loses the PROPOSED distinction` |
| SC-19 | loses acyclic statement | `fails when domain-dependency-graph.md loses the acyclic statement` |
| SC-19 | loses frozen data-plane direction | `fails when domain-dependency-graph.md loses the frozen data-plane direction` |
| SC-19 | loses anti-drift prohibitions | `fails when domain-dependency-graph.md loses the anti-drift prohibitions` |

## 4. Diff Scope Evidence (no production IAAS changes)

```text
$ { git diff --name-only origin/main...HEAD; git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u
.github/workflows/ci.yml
docs/architecture/RECONCILIATION-MATRIX.md
docs/architecture/REPOSITORY-BASELINE.md
scripts/spec-validator.ts
spec/README.md
spec/architecture-lock.md
spec/architecture.md
spec/dependency-graph.md
spec/domain-architecture.md
spec/domain-dependency-graph.md
spec/domain-requirements.md
tests/spec-consistency-validator.test.ts
tests/work-002-baseline.test.ts
```

- No `src/`, `prisma/`, `mini-services/`, Node/Data Plane/Routing/Transport, or vertical network files are touched.
- `package.json` is NOT modified (the existing `spec:validate` / `spec:test` scripts already expose the validator; no new script needed).
- The CI diff-scope guard allowlist was extended to permit `docs/architecture/` and `tests/work-002-baseline.test.ts` (WORK-002 Repository Scope), and continues to FAIL CLOSED (AR-003).

## 5. Lint Evidence

```text
$ bunx eslint scripts/spec-validator.ts tests/spec-consistency-validator.test.ts tests/work-002-baseline.test.ts
(exit 0, no errors)
```

## 6. Pre-existing Test Staleness Fixed (SC-11)

The WORK-001 negative test `fails when WORK-002 is marked eligible before WORK-001 is VERIFIED (SC-11)` was **already failing on clean main** (confirmed: `git checkout main && bun test ... -t "WORK-002 is marked eligible"` → 1 fail). Cause: the architect's `mark WORK-001 VERIFIED` commit made WORK-002's READY status eligible, so the mutation (WORK-002 BLOCKED→READY) was no longer a violation. This is pre-existing staleness from the WORK-001→VERIFIED transition, not caused by WORK-002 domain changes.

Fix (spec-layer, in WORK-002 scope):
- `spec/dependency-graph.md` updated to state "WORK-001 is VERIFIED" (current truth), replacing the now-false "WORK-002 is blocked until WORK-001 is VERIFIED."
- SC-11 text check evolved to verify the graph documents "WORK-001 is VERIFIED."
- The negative test replaced with two tests that are real violations under the current state: (a) revert WORK-001 to a non-VERIFIED status while WORK-002 stays READY (eligibility loop), (b) remove the "WORK-001 is VERIFIED" statement from the graph (text check).

## 7. Truth Classification Summary (Reconciliation Matrix)

| Classification | Count | Meaning |
|---|---|---|
| CONFIRMED | 9 | Architecture statement + repository evidence agree |
| OBSERVED (defect) | 3 | Documentation defect in existing corpus; code consistent; flagged for Architect |
| OBSERVED (known issue) | 1 | Pre-existing production issue (baselineEngine); out of WORK-002 scope |
| INFERRED | 0 | No derived interpretation promoted to fact |
| PROPOSED | 0 | No future design presented as existing architecture |

## 8. Documentation Defects Flagged for Architect Adjudication

These are recorded in `docs/architecture/REPOSITORY-BASELINE.md` (§9) and `docs/architecture/RECONCILIATION-MATRIX.md` (R-04, R-05, R-08). They are NOT silently resolved (the FROZEN contracts are not modified by the implementer):

- **B-01 / R-04**: `PHASE-13-GAP-MATRIX.md` summary states "54 Prisma models / 15 future concepts MISSING" — stale (67 models exist; Node/Bundle/etc. are implemented per Phase 13R). The summary contradicts the body table.
- **B-02 / R-05**: `FUTURE-NETWORK-COVERAGE.md` treats Node/Bundle/Transform as future contracts, contradicting the Phase 13R reconciliation.
- **B-03 / R-08**: `PHASE-14F-TRANSFORM-RECORD-CONTRACT.md` §14 describes `nodeIdentity` encoding two inconsistent ways. The implementation (`transform-record.service.ts:131` = `system:__unattributed__`) and tests (assert NOT `__system__`) are consistent with the namespaced encoding. Documentation defect in a FROZEN contract.

None of these required a production change or triggered a stop-condition: the implementation is consistent, and the contradictions are reconcilable by evidence classification (OBSERVED code supersedes stale documentation). They are escalated for the Architect to decide whether to amend the FROZEN documents via ACR or doc correction.

## 9. Stop-Condition Assessment

No stop-condition was triggered:

- existing architecture sources do not materially contradict each other in a way that cannot be reconciled by evidence classification (the three documentation defects are reconciled as OBSERVED code vs stale text);
- the repository evidence did not demonstrate that `IAAS-DOM-ARCH-1` needs a new frozen architectural primitive or boundary (it synthesizes existing primitives);
- no contradiction required production implementation changes;
- every supposedly-implemented feature had sufficient repository evidence to classify as CONFIRMED;
- no proposed future feature was presented as existing architecture;
- dependency directions were established from the existing frozen constitution + Phase 13R reconciliation.

## 10. Acceptance Criterion Evidence Index

| Criterion | Evidence |
|---|---|
| W002-AC01 | `docs/architecture/REPOSITORY-BASELINE.md` — every major architecture area has truth-classified findings with repository evidence references (§1–§9). Verified by `tests/work-002-baseline.test.ts`. |
| W002-AC02 | `spec/domain-architecture.md` (IAAS-DOM-ARCH-1, FROZEN, IMPLEMENTED/FUTURE/OPEN-RESEARCH/FROZEN-CONTRACT distinctions); registered in `spec/architecture.md` + `spec/architecture-lock.md`; enforced by SC-04 + SC-17. |
| W002-AC03 | `spec/domain-requirements.md` (DOM-001…012 stable IDs, no unresolved deps) + `spec/domain-dependency-graph.md` (acyclic, frozen direction); enforced by SC-18 + SC-19. |
| W002-AC04 | Diff scope (§4): no production IAAS changes; mechanically enforced by the CI diff-scope guard. |

## 11. Implementer Boundary Statement

- WORK-002 is **not** marked `VERIFIED` by the implementer.
- The PR is **not** merged by the implementer.
- No production IAAS implementation, schema, migration, Node/Data Plane/Routing/Transport, or vertical network code was modified (mechanically enforced by the CI diff-scope guard).
- `IAAS-GOV-ARCH-1` frozen rules 1–13 are untouched; only the "Domain Architecture Version" status line transitioned from the WORK-001 placeholder ("pending WORK-002") to the fulfilled `IAAS-DOM-ARCH-1` (FROZEN).
- The three documentation defects (B-01/B-02/B-03) are flagged for the Architect; the FROZEN contracts were NOT modified by the implementer.
- No subsequent Work Item was started.

Ready for independent verification and Architect Review.
