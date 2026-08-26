# WORK-018 Release Evidence

This governance release records the post-merge verification of WORK-017 and releases WORK-018.

- WORK-017 implementation PR: #25
- WORK-017 merge commit: `978cbbb4984a939b1a5dbdfdd00dfe0a6f94397d`
- WORK-017 status: VERIFIED
- Governing domain architecture: `IAAS-DOM-ARCH-4` (FROZEN)
- WORK-018 status: READY / RELEASED
- Dependency: `WORK-017 -> WORK-018`
- No production implementation is included in this release.

## Release Boundary

WORK-018 authorizes Z.ai to implement only the frozen `DOM-022` durable ExtensionProvenance boundary. Sandbox selection, concrete extensions, Marketplace, SDK, economics, vertical/data-plane/kernel coupling, Registry/Runtime redesign, and WORK-019 are prohibited.

## Verification Basis

WORK-017 was independently reviewed against its exact submitted head `c70a613a4e68618216e76a3370485fd6218d2d92`; CI run `33005125198` completed successfully for Specification Consistency Validator, Architecture Contract Tests, PostgreSQL Integration Tests, Typecheck, and Lint. The merge followed that verification.
