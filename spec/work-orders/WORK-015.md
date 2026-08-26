# WORK ORDER — WORK-015 IAAS-DOM-ARCH-4 Freeze and DOM-P04 Truth Promotion

## Implementer
Governance / Architect release

## Architect / Reviewer
Chief Architect

## Objective
Persist the approved ACR-003 decision, freeze IAAS-DOM-ARCH-4 as the current canonical domain architecture, promote DOM-P04 into DOM-018..DOM-022, preserve V3 as immutable historical architecture, and release no production implementation.

## Required Work
1. Mark ACR-003 APPROVED with decision metadata.
2. Mark IAAS-DOM-ARCH-4 FROZEN and current canonical.
3. Preserve IAAS-DOM-ARCH-3 unchanged as historical immutable architecture.
4. Mark DOM-018..DOM-022 FROZEN-CONTRACT / acceptance-bearing.
5. Mark DOM-P04 SUPERSEDED in current V4 while preserving V1 historical wording.
6. Mark V4 dependency graph canonical/frozen.
7. Persist WORK-014 VERIFIED and WORK-015 READY with dependency WORK-014 -> WORK-015.
8. Add regression tests for candidate-to-frozen transition and V3 immutability.

## Mandatory Prohibitions
Do NOT implement ExtensionRegistry, ExtensionRuntime, ExtensionProvenance, concrete extensions, sandbox technology, Prisma/schema, Marketplace, SDK, licensing, economic attribution, or DOM-P05..P08.

## Required Verification
- ACR/V4 freeze inspection
- V3 immutability regression
- DOM-P04 promotion regression
- specification validator
- Typecheck
- Architecture Contract Tests
- lint
- CI
- exact diff/scope inspection
- Architect Review

## Stop Conditions
Stop if V3 would need modification, ACR-003 scope would need expansion, production code is required, or any later Work Item would need to start.

## Definition of Done
V4 is frozen and canonical, ACR-003 is approved, DOM-P04 truth is promoted, WORK-014 is VERIFIED, WORK-015 is READY, all governance gates pass, and no production implementation is introduced.
