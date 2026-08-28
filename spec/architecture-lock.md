# IAAS Architecture Lock

- Governance Architecture Version: `IAAS-GOV-ARCH-1`
- Status: **FROZEN**
- Domain Architecture Version: `IAAS-DOM-ARCH-6` (FROZEN — approved through ACR-005 / WORK-024).
- Historical Domain Versions: `IAAS-DOM-ARCH-1` through `IAAS-DOM-ARCH-5` — immutable historical records. `IAAS-DOM-ARCH-5` was approved through ACR-004 / WORK-020 and is superseded by `IAAS-DOM-ARCH-6`.

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
IAAS-DOM-ARCH-6 = CURRENT CANONICAL / FROZEN
IAAS-DOM-ARCH-5 = SUPERSEDED / IMMUTABLE
```

V6 was frozen by WORK-024 (the dedicated V6 freeze gate) after ACR-005 was APPROVED and the independent architecture review completed:

- V1-V5 historical architecture documents remain immutable.
- V6 production Work Items are released strictly according to `spec/dependency-graph-v6.md`.
- WORK-025 (NetworkInstance and Network Lifecycle) is the sole dependency-eligible released V6 Work Item; all later items remain `DRAFT` until their dependencies are `VERIFIED`.

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

EXECUTED: all seven conditions were satisfied and the gate was executed by WORK-024 (GitHub Issue #40; freeze PR reviewed and approved by the Chief Architect / Architecture Custodian). The gate conditions above remain the durable authorization record for the V6 freeze; `bun run v6:validate` durably re-verifies the frozen state.
