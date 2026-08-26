# IAAS Architecture Specification

## Versions

| Artifact | Version | Status |
|---|---|---|
| Governance Architecture | `IAAS-GOV-ARCH-1` | FROZEN |
| Domain Architecture | `IAAS-DOM-ARCH-4` | FROZEN |
| Domain Architecture | `IAAS-DOM-ARCH-3` | SUPERSEDED / IMMUTABLE |
| Domain Architecture | `IAAS-DOM-ARCH-2` | SUPERSEDED / IMMUTABLE |
| Domain Architecture | `IAAS-DOM-ARCH-1` | SUPERSEDED / IMMUTABLE |

`IAAS-DOM-ARCH-4` is now the current canonical domain architecture following approved `ACR-003`. `IAAS-DOM-ARCH-3` remains an immutable historical architecture record.

## Current Canonical Architecture

The current canonical Domain Architecture is `IAAS-DOM-ARCH-4`, published in `spec/domain-architecture-v4.md` and frozen by `ACR-003` through WORK-015.

V4 inherits all V3 rules and adds the frozen Extension Stack boundary: `Extension → ExtensionRegistry → ExtensionRuntime → ExtensionProvenance`.

`DOM-P04` is superseded by `DOM-018..DOM-022` under approved ACR-003. `DOM-P05..P08` remain FUTURE/OPEN/RESEARCH.

Historical architecture versions remain immutable and are never rewritten in place.

The existing `docs/architecture/` corpus remains repository evidence; it does not silently replace the canonical architecture. Further architectural change requires a new Architecture Change Request and architecture version.
