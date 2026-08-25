# IAAS Architecture Change Request

A frozen architecture cannot be modified through an implementation PR.

Required fields:

```text
ACR-ID
TITLE
REQUESTED BY
DATE
AFFECTED ARCHITECTURE VERSION
AFFECTED REQUIREMENTS
AFFECTED WORK ITEMS
CURRENT RULE
PROBLEM / EVIDENCE
PROPOSED CHANGE
ALTERNATIVES
COMPATIBILITY / MIGRATION IMPACT
VERIFICATION IMPACT
DECISION
DECIDED BY
DECISION DATE
NEW ARCHITECTURE VERSION
```

States: `DRAFT`, `UNDER_REVIEW`, `APPROVED`, `REJECTED`, `SUPERSEDED`.

The implementation agent MUST stop and escalate if a correction would change a frozen boundary, primitive, dependency direction, ownership rule, or unsatisfiable requirement.
