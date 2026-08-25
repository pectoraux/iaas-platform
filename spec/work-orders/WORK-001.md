# WORK ORDER — WORK-001

## Identity

- Work Item: `WORK-001`
- Title: WorkflowOS Specification and Governance Foundation
- Architecture Version: `IAAS-GOV-ARCH-1`
- Implementer: Z.ai
- Architect / Reviewer: Chief Architect

## Objective

Complete the governance foundation so that the IAAS repository can mechanically validate its persistent architecture/requirements/work-item specification layer before any domain implementation resumes.

## Requirements

- `GOV-001` through `GOV-008`
- Acceptance criteria: `W001-AC01` through `W001-AC13`

## Current Repository State

The governance specification documents already exist under `spec/` on the WORK-001 branch. They are the draft architectural/planning artifacts and are not yet VERIFIED.

Existing IAAS domain architecture documents remain authoritative repository evidence for WORK-002 reconciliation. Do not rewrite or replace them during WORK-001.

## Required Implementation

1. Add an executable specification consistency validator.
2. Validate all required `spec/` files exist.
3. Validate the frozen governance architecture version is present and consistent.
4. Validate every Work Item declares exactly one architecture version.
5. Validate required Work Item fields and the 13 WORK-001 acceptance criterion IDs.
6. Validate dependency references resolve and the initial graph has no cycle.
7. Validate WORK-002 cannot be considered eligible before WORK-001 is `VERIFIED`.
8. Validate required truth classifications exist.
9. Validate the Architecture Change Request protocol exists and is referenced.
10. Validate the verification protocol distinguishes objective evidence from agent narrative.
11. Validate that WORK-001 contains no production implementation scope.
12. Add a CI invocation for the specification validator.
13. The validator must fail non-zero on inconsistency and produce a deterministic success message on pass.

## Repository Scope

Expected areas:

- `spec/`
- `scripts/` or equivalent existing validation location
- `.github/workflows/ci.yml`
- `package.json` only if required to expose the validator command

## Out of Scope

Do not:

- change IAAS production services;
- change Prisma schema or migrations;
- modify Node/Data Plane/Routing/Transport implementations;
- modify vertical network implementations;
- create `IAAS-DOM-ARCH-1`;
- reorder or reinterpret the domain implementation roadmap;
- change the frozen governance architecture;
- merge the PR;
- mark WORK-001 `VERIFIED`.

## Required Tests

- validator passes against the repository's current specification;
- validator fails when a required spec file is missing;
- validator fails when a required Work Item dependency is unresolved;
- validator fails on a malformed/missing architecture version;
- validator fails when a required WORK-001 acceptance criterion is missing;
- validator fails if WORK-001 includes forbidden production scope.

## Required Verification Evidence

Provide:

- exact validator command;
- successful command output;
- CI job/run URL and result;
- test evidence for at least the failure cases above;
- final PR diff showing no production IAAS implementation changes.

## Stop Conditions

Stop and report to the Architect if:

- the specification contradicts the existing constitutional architecture;
- a required invariant cannot be expressed without changing frozen architecture;
- the validator requires domain-specific assumptions not yet established;
- CI cannot execute the validator without unrelated infrastructure changes;
- the Work Item appears to require scope expansion.

## Definition of Done

WORK-001 is ready for Architect Review only when:

1. all required governance specification documents are present;
2. the executable consistency validator passes;
3. negative validator tests demonstrate that key inconsistencies fail;
4. CI records a passing validation result;
5. the diff contains no production IAAS changes;
6. Z.ai has not marked the Work Item `VERIFIED`.
