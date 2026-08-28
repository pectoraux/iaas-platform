# WORK-037 — Canonical SDK Surface

Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: WORK-026, WORK-027, WORK-030, WORK-035
Implementer: Z.ai

Objective: publish an SDK consuming canonical IAAS contracts with no alternate semantics.

Scope: typed API clients, canonical domain methods, local/remote contract parity, conformance tests.

Acceptance: SDK-001-AC01..03.

Constraints: SDK cannot bypass authorization, lifecycle, immutability, or persistence authority and must not expose private implementation state.

Verification: contract tests against canonical service APIs and negative bypass tests.

Stop: no hidden local-daemon semantics or vertical-only generic SDK primitives.
