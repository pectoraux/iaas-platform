# WORK-029 — Data Plane Fragmentation and Reassembly

Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependency: WORK-027
Implementer: Z.ai

Objective: add generic Fragment and ReassemblyState without altering Bundle/Route/Transport authority.

Scope: fragment identity/index/count/integrity/expiry, idempotent reassembly, persistence, tests.

Acceptance: DATA-001-AC01..04; DATA-002-AC01..04.

Constraints: at-least-once semantics; duplicates converge; out-of-order delivery is supported; expired state cannot complete; tenant isolation is mandatory; no economic/runtime coupling.

Verification: adversarial ordering/duplicate/expiry tests, PostgreSQL concurrency, tenant isolation, architecture anti-dependency tests.

Stop: any request to add vertical-specific fragment semantics to generic Bundle/Transport.
