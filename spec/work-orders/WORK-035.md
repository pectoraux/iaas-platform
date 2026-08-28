# WORK-035 — Operations Lifecycle Controller

Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: WORK-025, WORK-030
Implementer: Z.ai

Objective: implement the generic infrastructure operations lifecycle independently of workflow/request state.

Scope: provision, validate, activate, pause, resume, scale, drain, upgrade, rollback, terminate, archive; capability declaration; audit.

Acceptance: OPS-001-AC01..04.

Constraints: operations owns operational lifecycle only; it cannot mutate published network definitions or become workflow authority.

Verification: lifecycle state-machine tests, rollback/failure tests, audit/persistence checks, architecture anti-dependency tests.

Stop: do not merge operational lifecycle with NetworkRequest or execution lease state machines.
