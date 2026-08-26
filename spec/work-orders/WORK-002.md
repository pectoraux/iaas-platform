# WORK ORDER — WORK-002

## Identity

- Work Item: `WORK-002`
- Title: Repository Baseline and Domain Architecture V1
- Architecture Version: `IAAS-GOV-ARCH-1`
- Implementer: Z.ai
- Architect / Reviewer: Chief Architect

## Objective

Establish the first canonical IAAS Domain Architecture Version by auditing the existing repository against repository evidence, classifying architectural knowledge as `OBSERVED`, `INFERRED`, `CONFIRMED`, or `PROPOSED`, and reconciling the existing architecture corpus with actual code, schema, tests, CI, and history.

This Work Item is an architecture-reconstruction and truth-establishment task. It does not authorize broad refactoring or feature implementation.

## Preconditions

- `WORK-001` is `VERIFIED`.
- `IAAS-GOV-ARCH-1` remains FROZEN.
- Existing `docs/architecture/` documents remain evidence until explicitly reconciled.

## Requirements

- `W002-AC01` through `W002-AC04`
- `GOV-001` through `GOV-008` continue to govern execution.

## Required Deliverables

1. `docs/architecture/REPOSITORY-BASELINE.md`
2. Canonical Domain Architecture `IAAS-DOM-ARCH-1`
3. Domain requirements derived from the verified baseline
4. Domain dependency graph derived from the canonical architecture
5. Truth-classified reconciliation matrix mapping existing architecture statements to repository evidence

## Repository Audit Coverage

Inspect, at minimum:

- `docs/architecture/`
- `src/`
- `prisma/`
- `tests/`
- `.github/workflows/`
- package/build/runtime configuration
- relevant examples and scripts
- recent architectural commits and reconciliation history

The audit must explicitly account for the existing Phase 13R reconciliation and Phase 14A–14F implementation corpus rather than silently replacing it.

## Truth Classification

Every material architectural statement discovered during the audit must be classified as one of:

- `OBSERVED` — directly evidenced by code, schema, tests, CI, or repository history.
- `INFERRED` — derived interpretation not directly established by an explicit architectural decision.
- `CONFIRMED` — explicitly supported by authoritative architecture decisions plus repository evidence.
- `PROPOSED` — future design or unresolved recommendation.

Do not promote `INFERRED` or `PROPOSED` statements into historical fact.

## Domain Architecture V1 Rules

`IAAS-DOM-ARCH-1` must:

- preserve the frozen governance architecture boundary;
- reconcile, not overwrite, the current constitutional architecture;
- explicitly distinguish implemented, frozen-contract, future, and open/research concepts;
- identify contradictions between architecture documents and implementation;
- identify incomplete implementations and missing verification;
- define generic kernel boundaries and vertical-leakage constraints;
- define the canonical dependency direction for the major domain primitives;
- avoid introducing new production abstractions unless required to reconcile an observed architectural contradiction.

## Acceptance Criteria

### W002-AC01

`REPOSITORY-BASELINE.md` exists and every major architecture area has truth-classified findings with repository evidence references.

### W002-AC02

Canonical `IAAS-DOM-ARCH-1` is published, internally consistent, registered by the specification layer, and explicitly states what is implemented, frozen contract, future, and open/research.

### W002-AC03

Domain requirements and the domain dependency graph are derived from `IAAS-DOM-ARCH-1`, use stable IDs, contain no unresolved dependencies, and contain no circular dependencies.

### W002-AC04

The implementation contains no unrelated production refactor or feature expansion beyond the repository baseline audit and architecture synthesis.

## Required Verification

- repository baseline inspection;
- truth-classification consistency checks;
- architecture/version consistency validation;
- domain requirement and dependency-graph consistency validation;
- static architecture checks against existing constitutional anti-drift rules;
- independent Architect Review of `IAAS-DOM-ARCH-1`;
- PR diff inspection for scope containment.

## Out of Scope

Do not:

- implement new IAAS production features;
- refactor production code merely for cleanliness;
- modify Prisma schema or migrations unless an existing architectural fact cannot otherwise be accurately documented (escalate first);
- modify Node/Data Plane/Routing/Transport behavior;
- implement vertical networks;
- invent future roadmap items as confirmed architecture;
- change `IAAS-GOV-ARCH-1`;
- silently resolve architecture contradictions by changing production code.

## Stop Conditions

Stop and report to the Architect if:

- existing architecture sources materially contradict each other and cannot be reconciled by evidence classification;
- the repository evidence demonstrates that `IAAS-DOM-ARCH-1` needs a new frozen architectural primitive or boundary;
- resolving a contradiction would require production implementation changes;
- a supposedly implemented feature has insufficient repository evidence to classify as `CONFIRMED`;
- a proposed future feature is being presented as existing architecture;
- a dependency direction cannot be established without an architecture decision.

## Definition of Done

1. Repository baseline is committed.
2. `IAAS-DOM-ARCH-1` is published and registered.
3. All material baseline findings have truth classifications and evidence references.
4. Domain requirements and dependency graph are committed and internally consistent.
5. No unrelated production changes are present.
6. Verification evidence is complete.
7. Z.ai submits the PR for independent Architect Review.

Z.ai MUST NOT mark `WORK-002` `VERIFIED` or begin a subsequent Work Item.
