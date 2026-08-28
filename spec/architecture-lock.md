# IAAS Architecture Lock

- Governance Architecture Version: `IAAS-GOV-ARCH-1`
- Status: **FROZEN**
- Domain Architecture Version: `IAAS-DOM-ARCH-5` (FROZEN — approved through ACR-004 / WORK-020).
- Candidate Domain Architecture: `IAAS-DOM-ARCH-6` (CANDIDATE / UNDER REVIEW — ACR-005).
- Historical Domain Versions: `IAAS-DOM-ARCH-1` through `IAAS-DOM-ARCH-4` — immutable historical records.

## Frozen Rules

1. Frozen architecture versions are immutable.
2. Every Work Item MUST reference exactly one governing architecture version.
3. Domain architecture changes require an Architecture Change Request and a new version.
4. Repository state is evidence, not automatically architectural intent.
5. Truth classifications are `OBSERVED`, `INFERRED`, `CONFIRMED`, `PROPOSED`.
6. Acceptance requires objective evidence; agent claims are not evidence.
7. Verification and Architect Review are separate decisions.
8. A Work Item has at most one active implementation PR.
9. Only dependency-eligible Work Items may become `READY`.
10. Implementers may not silently redefine frozen architecture.
11. Corrections remain attached to the same Work Item unless architecture changes.
12. The implementation agent does not choose the next Work Item.
13. WORK-001 authorizes no production feature implementation.
14. Architecture-completion changes are specification/governance changes until the new architecture is frozen; they do not authorize production implementation merely by existing.

## Current Governance State

```text
IAAS-DOM-ARCH-5 = CURRENT CANONICAL / FROZEN
IAAS-DOM-ARCH-6 = CANDIDATE / UNDER REVIEW
```

While ACR-005 is under review:

- V5 remains immutable.
- V6 Work Items MUST remain `DRAFT`.
- No production Work Item may be released against V6.
- Existing V5 implementation work may be explicitly BLOCKED by the architecture-completion gate when continuing it would violate the Architect's instruction to finish architecture first.

## Workflow

```text
DRAFT -> READY -> ASSIGNED -> IMPLEMENTING -> PR_OPEN -> VERIFYING -> ARCHITECT_REVIEW
VERIFYING -> VERIFICATION_FAILED -> IMPLEMENTING
ARCHITECT_REVIEW -> REQUEST_CHANGES -> IMPLEMENTING
ARCHITECT_REVIEW -> ARCHITECTURE_CHANGE_REQUIRED -> ARCHITECTURE_CHANGE_REQUEST
ARCHITECT_REVIEW -> IMPLEMENTATION_BLOCKED -> IMPLEMENTING
ARCHITECT_REVIEW -> APPROVED -> MERGED -> VERIFIED
```

`ARCHITECTURE TRUTH`, `REPOSITORY TRUTH`, and `VERIFICATION TRUTH` are distinct authorities.

## V6 Freeze Gate

`IAAS-DOM-ARCH-6` may become FROZEN only when:

1. ACR-005 is `APPROVED`.
2. V6 architecture, requirements, domain DAG, and Work Item DAG are internally consistent.
3. V1-V5 historical architecture documents are proven unchanged.
4. Forbidden dependency and authority checks pass.
5. Reference-network universalism checks pass.
6. An independent Architect Review explicitly approves V6.
7. A dedicated V6 freeze Work Item is VERIFIED.

Until all seven conditions are met, V6 is not a governing architecture for production work.
