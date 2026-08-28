# WORK-025 — NetworkInstance and Network Lifecycle

Status: `READY`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependency: WORK-024
Implementer: Z.ai

Objective: implement the durable identity and lifecycle authority for a deployed NetworkInstance.

Required architecture: NetworkInstance references one immutable NetworkVersion; lifecycle is distinct from NetworkDefinition, request, execution, and resource lifecycles.

Scope: schema/model, network-lifecycle service, transitions, authorization, audit, PostgreSQL tests, architecture tests.

Acceptance: NET-001-AC01..04; NET-002-AC01..04.

Constraints: no mutation of published NetworkVersion; no vertical-specific lifecycle owner; no composition or federation semantics in this item.

Verification: real PostgreSQL state-machine tests, tenant isolation, invalid-transition negatives, historical evidence preservation, static dependency checks.

Stop: any need for kernel ownership, NetworkVersion mutation, or new cross-layer authority.
