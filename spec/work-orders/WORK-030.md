# WORK-030 — Generic Trust and Signature Semantics

Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependency: WORK-027
Implementer: Z.ai

Objective: implement credential/key binding, signature envelope, and trust-policy boundaries.

Scope: subject/key binding, canonical signing, verification, revocation, policy decision, tests.

Acceptance: TRUST-001-AC01..04; TRUST-002-AC01..03; TRUST-003-AC01..03.

Constraints: cryptographic algorithms remain configurable implementation choices; private material is never plaintext; verification is fail-closed and never executes the subject.

Verification: canonicalization/tamper tests, revocation tests, secret-handling inspection, static anti-execution checks.

Stop: algorithm selection may not expand the architecture into provider-specific PKI semantics.
