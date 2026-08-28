# WORK-026 — Network-as-Code Validation and Launch Compiler

Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependency: WORK-025
Implementer: Z.ai

Objective: compile declarative NetworkDefinition into a deterministic launch plan and NetworkVersion without kernel modification.

Scope: manifest/definition validation, dependency/capability/resource resolution contracts, launch stage orchestration, tests.

Acceptance: NET-003-AC01..04; NET-004-AC01..04.

Constraints: NetworkManifest is only a representation; NetworkDefinition remains source of intent; no concrete vendor/runtime imports; no vertical-specific compiler branches.

Verification: deterministic fixtures, invalid-reference negatives, stage-order tests, static import graph, PostgreSQL integration.

Stop: any requirement for a universal vertical adapter or kernel code change.
