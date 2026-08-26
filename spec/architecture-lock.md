# IAAS Architecture Lock

- Governance Architecture Version: `IAAS-GOV-ARCH-1`
- Status: **FROZEN**
- Domain Architecture Version: `IAAS-DOM-ARCH-1` (FROZEN — published by WORK-002; changes require an ACR and a new version `IAAS-DOM-ARCH-2`).

## Frozen Rules

1. Frozen architecture versions are immutable.
2. Every Work Item references exactly one governing architecture version.
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
