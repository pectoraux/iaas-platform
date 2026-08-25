# IAAS Architecture Change Request

## Purpose

A frozen architecture cannot be modified through an implementation PR. Any implementation discovery that requires changing a frozen architectural rule must be recorded as an Architecture Change Request (ACR).

## Required Fields

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
ALTERNATIVES CONSIDERED
COMPATIBILITY / MIGRATION IMPACT
VERIFICATION IMPACT
DECISION
DECIDED BY
DECISION DATE
NEW ARCHITECTURE VERSION (if approved)
```

## Decision States

```text
DRAFT
UNDER_REVIEW
APPROVED
REJECTED
SUPERSEDED
```

## Rule

An implementation agent MUST stop and escalate when the requested correction changes a frozen architectural boundary, primitive, dependency direction, ownership rule, or requirement that cannot be satisfied under the current architecture.

A code change may continue under the existing Work Item when the issue is only an implementation defect and does not alter architecture.
