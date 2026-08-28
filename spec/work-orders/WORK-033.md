# WORK-033 — Extension Distribution Boundary

Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependency: WORK-032
Implementer: Z.ai

Objective: implement technical publication/listing contracts while preserving Registry, Runtime, and Package authority.

Scope: publication/listing records, discovery APIs, licensing/commercial metadata boundary, lifecycle separation tests.

Acceptance: DIST-001-AC01..03; DIST-002-AC01..03.

Constraints: marketplace never executes extensions, never becomes technical registry, and never changes operational truth; commercial model remains configurable.

Verification: static non-execution checks, authority tests, API contract tests.

Stop: no marketplace-to-runtime shortcut or second technical registry.
