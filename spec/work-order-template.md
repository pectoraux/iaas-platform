# IAAS Work Order Template

Every implementation prompt delivered to an agent MUST be generated from a persistent Work Item and contain:

```text
WORK-ID:
TITLE:
ARCHITECTURE VERSION:

OBJECTIVE:

REQUIREMENTS:

ACCEPTANCE CRITERIA:

DEPENDENCIES:

REPOSITORY SCOPE:

EXPECTED FILES / MODULES:

ARCHITECTURE CONSTRAINTS:

OUT OF SCOPE:

EXISTING REPOSITORY EVIDENCE:

IMPLEMENTATION GUIDANCE:

REQUIRED TESTS:

REQUIRED VERIFICATION:

REQUIRED EVIDENCE:

DEFINITION OF DONE:

STOP CONDITIONS:
- architecture ambiguity
- missing prerequisite
- requirement contradiction
- need for a new cross-layer abstraction
- architecture change required
```

## Agent Boundary

The implementation agent may implement the Work Item, tests, and necessary implementation evidence. It may not:

- redefine a frozen architecture;
- expand the Work Item into neighboring work;
- mark the Work Item `VERIFIED`;
- bypass required verification;
- silently change workflow state;
- convert an architecture question into an implementation shortcut.
