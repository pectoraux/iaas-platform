# IAAS Work Order Template

Every implementation prompt MUST be generated from a persistent Work Item and include:

```text
WORK-ID
TITLE
ARCHITECTURE VERSION
OBJECTIVE
REQUIREMENTS
ACCEPTANCE CRITERIA
DEPENDENCIES
REPOSITORY SCOPE
EXPECTED FILES / MODULES
ARCHITECTURE CONSTRAINTS
OUT OF SCOPE
EXISTING REPOSITORY EVIDENCE
IMPLEMENTATION GUIDANCE
REQUIRED TESTS
REQUIRED VERIFICATION
REQUIRED EVIDENCE
DEFINITION OF DONE
STOP CONDITIONS
```

Stop conditions include architecture ambiguity, missing prerequisites, contradictory requirements, need for a new cross-layer abstraction, or architecture change required.

The implementation agent may not redefine frozen architecture, expand scope, mark VERIFIED, bypass verification, or silently change workflow state.
