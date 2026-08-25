# IAAS Architecture Lock

## Status

- Governance Architecture Version: `IAAS-GOV-ARCH-1`
- Status: **FROZEN**
- Purpose: govern architecture, requirements, work items, implementation, verification, and review.
- Domain Architecture Version: **not yet frozen**; established by WORK-002 after repository baseline audit.

This document freezes the **development governance contract**. It does not silently replace the existing domain architecture in `docs/architecture/`.

## Frozen Governance Rules

1. A Work Item references exactly one governing architecture version.
2. A frozen architecture version is immutable.
3. A domain architecture change requires an explicit Architecture Change Request and a new version.
4. Repository state is evidence, not automatically architectural intent.
5. Existing facts are classified as `OBSERVED`, `INFERRED`, `CONFIRMED`, or `PROPOSED`.
6. Requirements have stable IDs and objective acceptance criteria.
7. Acceptance criteria require evidence; agent assertions are not evidence.
8. Verification and Architect Review are distinct decisions.
9. A Work Item has at most one active implementation PR; historical PRs remain linked.
10. Only dependency-eligible Work Items may become `READY`.
11. Implementers may report ambiguity or request architecture change, but may not silently redefine frozen architecture.
12. Corrections remain attached to the same Work Item unless architecture changes create a new Work Item.
13. The implementation agent does not determine the next eligible Work Item.
14. No production feature implementation is authorized by WORK-001.

## Canonical Workflow

```text
DRAFT
  -> READY
  -> ASSIGNED
  -> IMPLEMENTING
  -> PR_OPEN
  -> VERIFYING
  -> ARCHITECT_REVIEW

VERIFYING -> VERIFICATION_FAILED -> IMPLEMENTING
ARCHITECT_REVIEW -> REQUEST_CHANGES -> IMPLEMENTING
ARCHITECT_REVIEW -> ARCHITECTURE_CHANGE_REQUIRED -> ARCHITECTURE_CHANGE_REQUEST
ARCHITECT_REVIEW -> IMPLEMENTATION_BLOCKED -> IMPLEMENTING
ARCHITECT_REVIEW -> APPROVED -> MERGED -> VERIFIED
```

The workflow authority, not an implementation agent, owns legal state transitions.

## Truth Model

```text
ARCHITECTURE TRUTH  = frozen specification + approved architecture changes
REPOSITORY TRUTH    = Git commits, branches, PRs, CI, repository contents
VERIFICATION TRUTH  = reproducible tests, static checks, runtime evidence, CI
```

No narrative from an LLM can override these authorities.
