# WORK-019 — Sandbox Architecture and ACR-004

Status: `READY`
Architecture Version: `IAAS-DOM-ARCH-4`
Dependencies: `WORK-018`
Requirements: frozen V4 §2.8 Security and Isolation; deferred sandbox area

## Objective
Produce an Architecture Change Request for sandbox technology and isolation semantics for the Extension Stack. Evaluate the currently open/research options and, if a decision is justified, define candidate `IAAS-DOM-ARCH-5` without implementing sandbox technology.

## Required Deliverables
- `spec/architecture-change-requests/ACR-004.md`
- candidate architecture document if ACR-004 proposes a new frozen contract
- candidate requirements and dependency graph if needed
- regression tests proving V4 remains immutable and sandbox remains unimplemented
- verification evidence

## Required Analysis
Evaluate at minimum:
- WASM/WASI
- container isolation
- native/plugin-process isolation

Evaluation dimensions MUST include:
- capability enforcement
- resource limits and metering
- tenant isolation
- filesystem/network/device access
- process escape/compromise containment
- lifecycle integration with ExtensionRegistry/Runtime
- provenance implications
- portability and deployment model
- operational complexity
- failure and termination semantics

## Architectural Questions That MUST Be Resolved
1. What is the sandbox trust boundary?
2. Which layer is authoritative for capabilities and resource ceilings?
3. How are sandbox credentials/capabilities granted and revoked?
4. What happens to an in-flight execution on revocation or sandbox termination?
5. Which resource measurements are authoritative for provenance?
6. What minimum isolation guarantee is required across tenants?
7. What is the fallback behavior when the preferred sandbox is unavailable?
8. Does the decision require a new architecture version, or can it remain an implementation/deployment constraint under V4?

## Constraints
- `IAAS-DOM-ARCH-4` remains FROZEN until an ACR is approved and a successor version is explicitly frozen.
- No changes to V3/V4 historical architecture documents in this Work Item except additive cross-reference/evidence if necessary.
- Do NOT implement WASM, containers, native plugin execution, seccomp, namespaces, microVMs, gVisor, Firecracker, or any other sandbox runtime.
- Do NOT implement concrete extensions.
- Do NOT redesign ExtensionRegistry, ExtensionRuntime, or ExtensionProvenance except to document required future contract changes in the ACR.
- Do NOT promote Marketplace, SDK, licensing, economics, or DOM-P06..P08.
- Do NOT start WORK-020.

## Acceptance Criteria
- `W019-AC01` ACR-004 explicitly identifies the problem, affected V4 contracts, alternatives, and recommendation.
- `W019-AC02` security/isolation trust boundary is explicit.
- `W019-AC03` capability/resource authority and precedence are explicit.
- `W019-AC04` lifecycle/revocation/termination semantics are explicit.
- `W019-AC05` provenance and authoritative resource-measurement semantics are explicit.
- `W019-AC06` tenant isolation and compromise containment requirements are explicit.
- `W019-AC07` portability/deployment and operational trade-offs are evaluated.
- `W019-AC08` fallback/unavailability semantics are explicit.
- `W019-AC09` decision impact on V4 and whether a new architecture version is required is explicit.
- `W019-AC10` regression tests prove V4 immutability and no sandbox implementation.
- `W019-AC11` specification validator, Typecheck, Architecture Contract Tests, lint, scope checks, and Architect Review pass.

## Required Verification
Architecture inspection; alternative-comparison evidence; security boundary tests; V4 immutability tests; no-implementation/static scope tests; specification validator; Typecheck; Architecture Contract Tests; lint; exact diff-scope review; independent Architect Review.

## Definition of Done
ACR-004 is complete, evidence is recorded, all required gates pass, the Architect decides `APPROVE`, `REQUEST_CHANGES`, or `ARCHITECTURE_CHANGE_REQUIRED`, and no sandbox implementation begins unless a separately approved architecture version authorizes it.