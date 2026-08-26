# WORK ORDER — WORK-014 Extension Stack Architecture and ACR-003

Implement exactly `spec/work-items/WORK-014.md` under frozen `IAAS-GOV-ARCH-1` / `IAAS-DOM-ARCH-3`.

## Implementer
Z.ai

## Architect / Reviewer
Chief Architect

## Objective
Produce a complete architecture proposal for the future Extension Stack and resolve ACR-003. This is architecture/specification work only. Do not implement extensions.

## Read First
- `spec/domain-architecture-v3.md`
- `spec/domain-requirements-v3.md`
- `spec/domain-dependency-graph-v3.md`
- `spec/domain-requirements.md` (historical DOM-P04..P08)
- `spec/work-items.md`
- `spec/work-items/WORK-014.md`
- `spec/architecture-change-request/ACR-003.md`
- existing TransformRegistry/Runtime contracts and WORK-013 evidence

## Required Work
1. Complete ACR-003 with concrete, architecture-level decisions for Extension, ExtensionRegistry, and ExtensionRuntime.
2. Produce candidate `IAAS-DOM-ARCH-4` documents without mutating V3 in place.
3. Define Extension identity/versioning, capability declaration, compatibility, lifecycle, revocation, failure, tenancy, resource limits, security/isolation, provenance, and observability boundaries.
4. Define strict Registry-vs-Runtime responsibilities.
5. Define Extension↔Transform relationship without conflating the two stacks.
6. Define anti-dependencies and regression-testable invariants.
7. Explicitly keep sandbox technology OPEN/RESEARCH unless an Architect-approved decision is required by the contract.
8. Preserve DOM-P05..P08 as FUTURE/OPEN/RESEARCH.
9. Add regression tests proving V3 remains immutable and DOM-P04 is not promoted unless ACR-003 is approved and V4 is frozen.
10. Produce objective evidence mapped to W014-AC01..AC11.

## Mandatory Prohibitions
Do NOT:
- implement ExtensionRegistry or ExtensionRuntime in production;
- implement concrete extensions;
- modify `src/` or Prisma;
- modify frozen V1/V2/V3 architecture documents in place;
- promote DOM-P04 before Architect approval;
- promote DOM-P05..P08;
- choose WASM/container/native sandbox technology as an implementation commitment unless explicitly justified as a frozen architectural requirement;
- redesign the Transform Stack;
- introduce Marketplace, SDK, licensing, or economic attribution implementation.

## STOP CONDITIONS
Stop and report to the Architect if:
- the Extension contract cannot be defined without changing the frozen V3 boundaries;
- a new kernel primitive appears necessary;
- Extension and Transform ownership overlaps materially;
- a security decision requires a technology commitment not supportable at architecture level;
- production implementation appears necessary to prove the architecture;
- DOM-P05..P08 would need promotion to complete the Extension architecture.

## Required Verification
- ACR-003 completeness and architectural-question closure;
- candidate V4 internal consistency;
- Registry/Runtime responsibility separation tests;
- tenant/capability/lifecycle/security invariants;
- anti-dependency tests;
- V3 immutability regression tests;
- DOM-P04 non-promotion gate;
- specification validator;
- Typecheck; Architecture Contract Tests; lint;
- exact diff/scope verification;
- independent Architect Review.

## Definition of Done
Candidate V4 architecture and ACR-003 are complete, reviewable, and internally consistent; all required gates are green; no production implementation has been introduced; Architect makes the explicit APPROVE/REQUEST_CHANGES/ARCHITECTURE_CHANGE_REQUIRED decision. Z.ai must not start any implementation Work Item after this one.
