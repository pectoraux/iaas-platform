# IAAS Architecture Specification

## Versions

| Artifact | Version | Status |
|---|---|---|
| Governance Architecture | `IAAS-GOV-ARCH-1` | FROZEN |
| Domain Architecture | `IAAS-DOM-ARCH-3` | FROZEN |
| Domain Architecture | `IAAS-DOM-ARCH-4` | CANDIDATE |
| Domain Architecture | `IAAS-DOM-ARCH-2` | SUPERSEDED |
| Domain Architecture | `IAAS-DOM-ARCH-1` | SUPERSEDED |

`IAAS-DOM-ARCH-1`, `IAAS-DOM-ARCH-2`, and `IAAS-DOM-ARCH-3` remain immutable
historical records.

The current canonical Domain Architecture is `IAAS-DOM-ARCH-3`, published in
`spec/domain-architecture-v3.md` and frozen through `ACR-002` (Transform Stack
Architecture Freeze). V3 preserves V2 except for the explicit Transform Stack
boundary.

A candidate `IAAS-DOM-ARCH-4` is proposed in `spec/domain-architecture-v4.md`
through `ACR-003` (Extension Stack Architecture). V4 is NOT frozen until the
Architect explicitly approves ACR-003. V4 preserves V3 except for the Extension
Stack boundary (Extension → ExtensionRegistry → ExtensionRuntime).

V2 preserved V1 except for the `VerifiedEvidenceContext` boundary (ACR-001).
V1 was produced by WORK-002 (Repository Baseline and Domain Architecture V1).

The existing `docs/architecture/` corpus remains repository evidence; no version
silently replaces the constitution. Domain architecture changes beyond the
approved version require a new Architecture Change Request.
