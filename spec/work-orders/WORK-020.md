# WORK-020 — IAAS-DOM-ARCH-5 Freeze and DOM-P05 Promotion

Status: `READY`
Architecture Version: `IAAS-GOV-ARCH-1`
Governing Domain Architecture: `IAAS-DOM-ARCH-4` → successor `IAAS-DOM-ARCH-5`
Dependency: `WORK-019` VERIFIED
Implementer: Architect/governance release

## Objective
Freeze the approved ACR-004 sandbox architecture as IAAS-DOM-ARCH-5 and promote DOM-P05, while preserving V4 immutability and introducing no sandbox implementation.

## Required Outcome
- ACR-004 status = `APPROVED`.
- IAAS-DOM-ARCH-5 status = `FROZEN` and canonical.
- IAAS-DOM-ARCH-4 remains immutable historical architecture.
- DOM-P05 becomes the frozen V5 sandbox contract.
- No concrete WASI revision or runtime is frozen.
- No sandbox implementation is authorized or introduced.

## Scope
Only:
- `spec/architecture-change-requests/ACR-004.md`
- `spec/domain-architecture-v5.md`
- `spec/work-items.md`
- `spec/dependency-graph.md`
- regression/evidence artifacts necessary to prove the transition

## Out of Scope
Any WASM runtime, container runtime, native/plugin sandbox, ExtensionRuntime redesign, ExtensionProvenance schema change, concrete extension, Marketplace, SDK, economics, DOM-P06..P08 promotion.

## Acceptance Criteria
- W020-AC01 through W020-AC10 in `spec/work-items.md`.

## Verification
- inspect ACR status and decision trace;
- verify V5 is complete and marked FROZEN;
- verify V4 files are unchanged;
- verify DOM-P05 promotion and V5 inheritance;
- verify resource measurements remain distinct;
- verify termination/fallback semantics;
- run `bun run spec:validate`;
- run relevant regression tests;
- run Typecheck/lint/architecture gates where applicable;
- inspect diff scope;
- independent Architect Review.

## Stop Conditions
Do not implement or release sandbox runtime code from WORK-020. After WORK-020 is VERIFIED, create a separate bounded implementation Work Item for the selected WASI Component Model sandbox contract.
