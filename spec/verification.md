# IAAS Verification Protocol

Verification is an evidence-evaluation step, not an agent declaration.

## Criterion Record

Every evaluated acceptance criterion should be recorded as:

```text
criterion_id
result: PASS | FAIL | BLOCKED
verification_method
command_or_artifact
observed_result
verified_at
verifier
```

## Evidence Classes

Preferred evidence, from strongest to weaker where applicable:

1. deterministic integration/end-to-end test
2. database/concurrency test
3. static architecture test
4. CI result
5. targeted unit test
6. runtime/log evidence
7. source inspection

Agent narrative is contextual information only and cannot itself establish `PASS`.

## Review Separation

```text
VERIFICATION
Does the implementation satisfy the acceptance criteria?

ARCHITECT REVIEW
Is the implementation architecturally compliant and within Work Item scope?
```

A failed verification returns the Work Item to `IMPLEMENTING`. An architectural deficiency in an otherwise passing implementation returns it to `IMPLEMENTING` via `REQUEST_CHANGES`. A deficiency in the frozen design itself requires an Architecture Change Request.
