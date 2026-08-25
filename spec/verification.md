# IAAS Verification Protocol

Verification is evidence evaluation, not an agent declaration.

For each acceptance criterion record:

```text
criterion_id
result: PASS | FAIL | BLOCKED
verification_method
command_or_artifact
observed_result
verified_at
verifier
```

Preferred evidence: deterministic integration/end-to-end tests, database/concurrency tests, static architecture tests, CI results, targeted unit tests, runtime evidence, then source inspection.

Agent narrative is contextual only and cannot establish PASS.

Verification asks whether the implementation satisfies acceptance criteria. Architect Review separately asks whether it is architecturally compliant and within scope.
