# WORK-027 — Network Composition and Export/Import Bindings

Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependency: WORK-026
Implementer: Z.ai

Objective: implement explicit NetworkComposition, NetworkDependency, CapabilityBinding, ResourceBinding, PolicyBinding, NetworkExport, and NetworkImport contracts.

Scope: composition model/service, stable exported identities, resolution and authorization, PostgreSQL persistence where required, tests.

Acceptance: COMP-001-AC01..04; COMP-002-AC01..03; COMP-003-AC01..03.

Constraints: version-pinned, tenant-authorized, no private runtime-state sharing, no lifecycle/allocation/trust bypass, no federation.

Verification: composed-network integration tests, export revocation/termination tests, tenant-isolation tests, static anti-bypass checks.

Stop: any need to expose internal runtime state or let composition mutate network definitions.
