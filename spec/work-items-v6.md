# IAAS V6 Work Items — Implementation Program

- Target Architecture: `IAAS-DOM-ARCH-6` (FROZEN)
- Governing Governance Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Change Request: `ACR-005` (APPROVED; V6 frozen via WORK-024)
- Status rule: the architecture gate is complete. Items follow the standard lifecycle — `DRAFT` → `READY` (only when dependency-eligible per `spec/dependency-graph-v6.md`) → implementation → `VERIFIED`. WORK-025 is the sole `READY` item; every other item remains `DRAFT` until its dependencies are `VERIFIED`.

## Program Rule

A Work Item exists only where an architectural obligation must become implemented, verified, or governed. Work Items do not add unapproved product ideas. Every implementation item must cite exactly one frozen architecture version before it may become READY.

## WORK-023 — IAAS-DOM-ARCH-6 Architecture Completion Candidate
Status: `VERIFIED`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: none
Requirements: `ACR-005`, `ARCH-001`
Objective: complete the V6 architecture package and inventory without changing production behavior.
Repository Scope: `spec/` architecture, requirements, domain DAG, candidate Work Item DAG, governance indexes, regression specifications.
Out of Scope: production implementation.
Architecture Constraints: V5 immutable; ACR-005 remains under review; no V6 item becomes READY.
Acceptance Criteria: ACR-005 complete; universal-primitive test complete; authority matrix complete; dependency directions explicit; open/rejected decisions explicit; V1-V5 files untouched.
Required Verification: spec validator, cross-document consistency, historical-file immutability check, independent architecture review.
Definition of Done: candidate package is internally consistent and ready for independent review.
Verification record: VERIFIED — the V6 candidate package was authored and merged to main by the Chief Architect / Architecture Custodian (merge `ea3268a`, PR #35 lineage), validated by the full specification gate, and completed independent architecture review through ACR-005 (APPROVED). Dependency for WORK-024 satisfied.

## WORK-024 — V6 Freeze and Governance Release
Status: `PR_OPEN`
Architecture Version: `IAAS-GOV-ARCH-1`
Dependencies: `WORK-023`
Requirements: `ARCH-001`, `CONF-001`
Objective: freeze `IAAS-DOM-ARCH-6` only after independent review and approval of ACR-005.
Repository Scope: specification/governance only.
Out of Scope: all production implementation.
Architecture Constraints: V5 remains immutable; V6 candidate may be corrected only through ACR-005 review; no silent edits after freeze.
Acceptance Criteria: ACR-005 APPROVED; V6 marked FROZEN; current canonical index/lock point to V6; V1-V5 historical files remain unchanged; post-freeze validator pins the new version.
Required Verification: independent Architect Review + validator + immutable-history regression tests.
Definition of Done: V6 FROZEN and released as the governing architecture for W025+.
Execution record: released to Z.ai by the Chief Architect via GitHub Issue #40 (Work Order — V6 Freeze Gate). This freeze PR executes the gate: ACR-005 recorded APPROVED, V6 recorded FROZEN / CURRENT CANONICAL, WORK-025 released as the sole dependency-eligible next item, V1-V5 immutability re-proven by the frozen-blob checks, and `bun run v6:validate` re-pinned to durably validate the frozen state. WORK-024's `VERIFIED` record follows the merge per repository convention.

## WORK-025 — NetworkInstance and Network Lifecycle
Status: `READY`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-024`
Requirements: `NET-001`, `NET-002`
Objective: implement durable NetworkInstance identity and lifecycle authority.
Repository Scope: network lifecycle service, schema/migration, tests.
Out of Scope: composition, marketplace, federation.
Architecture Constraints: NetworkDefinition/NetworkVersion remain authoritative for intent; instance lifecycle cannot mutate published versions.
Acceptance Criteria: NET-001-AC01..04 and NET-002-AC01..04.
Required Verification: PostgreSQL lifecycle tests, tenant isolation, immutability, audit.
Definition of Done: lifecycle behavior verified and merged.
Release record: released by WORK-024 (the V6 freeze gate) as the sole dependency-eligible next Work Item — `WORK-024 → WORK-025` is the only dependency edge from WORK-024 and WORK-024 is WORK-025's only dependency; every other V6 item depends on at least one non-`VERIFIED` item. Release takes effect with the merge of the WORK-024 freeze PR (which completes WORK-024 through Architect approval).

## WORK-026 — Network-as-Code Validation and Launch Compiler
Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-025`
Requirements: `NET-003`, `NET-004`
Objective: provide deterministic validation/resolution/launch planning from declarative NetworkDefinition.
Repository Scope: network compiler/validator, launch planning, tests.
Out of Scope: vertical-specific launch implementations.
Architecture Constraints: no kernel modification; no direct concrete-runtime imports; existing NetworkVersion publication semantics preserved.
Acceptance Criteria: NET-003-AC01..04, NET-004-AC01..04.
Required Verification: deterministic fixtures, negative ordering tests, static dependency tests.
Definition of Done: launch planning verified against reference definitions.

## WORK-027 — Network Composition and Export/Import Bindings
Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-026`
Requirements: `COMP-001`, `COMP-002`, `COMP-003`
Objective: implement explicit network composition and stable export/import bindings.
Repository Scope: composition service/schema/contracts/tests.
Out of Scope: federation.
Architecture Constraints: no access to private runtime state; version/tenant authorization mandatory.
Acceptance Criteria: all COMP requirements.
Required Verification: composition integration, lifecycle revocation, tenant isolation, anti-bypass tests.
Definition of Done: composed networks resolve only through exported contracts.

## WORK-028 — Allocation Strategy and Temporal Reservation
Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-026`
Requirements: `ALLOC-001`, `ALLOC-002`, `ALLOC-003`
Objective: generalize allocation strategies and explicit reservation/availability windows.
Repository Scope: scheduler/allocation policy contracts, capacity reservation extensions, tests.
Out of Scope: market implementation as a mandatory feature.
Architecture Constraints: strategy is policy/configuration; reservation and commitment authorities remain unchanged.
Acceptance Criteria: all ALLOC requirements.
Required Verification: concurrency/overlap PostgreSQL tests, deterministic strategy tests, forecast negative tests.
Definition of Done: multiple allocation strategies conform to one contract without kernel changes.

## WORK-029 — Data Plane Fragmentation and Reassembly
Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-027`
Requirements: `DATA-001`, `DATA-002`
Objective: add generic Fragment and ReassemblyState semantics.
Repository Scope: data-plane services/schema/tests.
Out of Scope: new vertical transport protocols.
Architecture Constraints: preserve Bundle/Route/Transport boundaries and at-least-once/idempotent delivery.
Acceptance Criteria: all DATA requirements.
Required Verification: out-of-order/duplicate/expiry adversarial tests, PostgreSQL concurrency, tenant isolation.
Definition of Done: reassembly is deterministic and race-safe.

## WORK-030 — Generic Trust and Signature Semantics
Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-027`
Requirements: `TRUST-001`, `TRUST-002`, `TRUST-003`
Objective: implement generic credential/key binding, signature envelope, and trust policy boundaries.
Repository Scope: trust contracts/services/tests.
Out of Scope: federation trust anchors and vendor-specific PKI.
Architecture Constraints: algorithms remain implementation/configuration choices; fail closed.
Acceptance Criteria: all TRUST requirements.
Required Verification: tamper/canonicalization/revocation tests and secret-handling inspection.
Definition of Done: artifacts and identities can be verified without coupling verification to execution.

## WORK-031 — Generic Package Model and Serialization
Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-030`
Requirements: `PKG-001`
Objective: implement one package model supporting Network/Transform/Extension/Adapter kinds.
Repository Scope: package model/schema/serialization/tests.
Out of Scope: Marketplace commerce and vendor archive formats.
Architecture Constraints: one generic package architecture; typed kinds only.
Acceptance Criteria: PKG-001-AC01..03.
Required Verification: deterministic serialization, integrity, dependency tests.
Definition of Done: package kinds share one canonical manifest model.

## WORK-032 — Package Admission and Registry Integration
Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-031`, `WORK-030`
Requirements: `PKG-002`, `DIST-001`
Objective: verify, admit, and install packages without executing payloads.
Repository Scope: package admission service and integration with existing registries.
Out of Scope: Marketplace pricing/licensing.
Architecture Constraints: registry remains technical lifecycle authority; install never equals execute.
Acceptance Criteria: PKG-002 and DIST-001.
Required Verification: no-execution install tests, dependency-cycle tests, trust revocation tests.
Definition of Done: package admission path is authoritative, deterministic, and non-executing.

## WORK-033 — Extension Distribution Boundary
Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-032`
Requirements: `DIST-001`, `DIST-002`
Objective: implement technical publication/listing boundary while preserving Registry and Runtime authority.
Repository Scope: distribution/marketplace-facing contracts, publication records, boundary tests.
Out of Scope: a mandatory commercial business model.
Architecture Constraints: marketplace cannot execute or activate extensions and cannot replace technical registry state.
Acceptance Criteria: all DIST requirements.
Required Verification: API/static non-execution checks, lifecycle authority tests.
Definition of Done: distribution contracts are independently consumable by product layers.

## WORK-034 — Generic Economic Metering and Attribution
Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-028`, `WORK-030`
Requirements: `ECON-001`, `ECON-002`, `ECON-003`
Objective: add verified usage measurement, economic attribution, and deterministic pricing policy without contaminating operational truth.
Repository Scope: economics services/schema/policies/tests.
Out of Scope: payment-provider integration and vertical pricing products.
Architecture Constraints: economic state consumes verified facts and cannot mutate operational source-of-truth.
Acceptance Criteria: all ECON requirements.
Required Verification: provenance tests, historical immutability, deterministic policy tests, anti-dependency checks.
Definition of Done: usage→attribution→pricing→existing contribution/reward/ledger/settlement chain is verified.

## WORK-035 — Operations Lifecycle Controller
Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-025`, `WORK-030`
Requirements: `OPS-001`
Objective: implement generic provision/validate/activate/pause/resume/scale/drain/upgrade/rollback/terminate/archive operations.
Repository Scope: operations service/contracts/tests.
Out of Scope: replacing existing control-plane workflow states.
Architecture Constraints: lifecycle authority distinct from workflow/request/execution and network definition state.
Acceptance Criteria: OPS-001-AC01..04.
Required Verification: lifecycle state-machine tests and rollback/audit tests.
Definition of Done: operational lifecycle is reusable by heterogeneous resource types.

## WORK-036 — Observability and Evidence Boundary
Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-034`, `WORK-035`
Requirements: `OBS-001`, `OBS-002`
Objective: define/implement canonical observation and evidence interfaces and their relationship to verification.
Repository Scope: observation/evidence contracts, adapters, tests.
Out of Scope: a single vendor telemetry platform.
Architecture Constraints: raw observations are never self-attesting; existing Event/VerificationResult/Attestation authority preserved.
Acceptance Criteria: all OBS requirements.
Required Verification: negative bypass tests and provenance-chain tests.
Definition of Done: observation→evidence→verification→attestation is explicit and enforceable.

## WORK-037 — Canonical SDK Surface
Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-026`, `WORK-027`, `WORK-030`, `WORK-035`
Requirements: `SDK-001`
Objective: publish and verify an SDK that consumes canonical APIs without creating alternate semantics.
Repository Scope: SDK contracts/generated clients/tests/documentation.
Out of Scope: hidden local daemon semantics and vertical-only helper APIs.
Architecture Constraints: SDK cannot bypass auth, lifecycle, versioning, or persistence boundaries.
Acceptance Criteria: all SDK requirements.
Required Verification: contract tests against canonical APIs.
Definition of Done: SDK operations are thin canonical consumers.

## WORK-038 — Federation Research and ACR Boundary
Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-030`, `WORK-034`
Requirements: `FED-001`
Objective: document and gate federation research without implementing cross-installation authority.
Repository Scope: research/architecture boundary documentation and conformance tests.
Out of Scope: production federation implementation.
Architecture Constraints: federation remains OPEN / RESEARCH; no SDK/marketplace backdoor.
Acceptance Criteria: FED-001-AC01..03.
Required Verification: classification tests and architecture review.
Definition of Done: federation seam is explicit and blocked from accidental promotion.

## WORK-039 — Reference Network Universal Conformance Suite
Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-026`, `WORK-027`, `WORK-028`, `WORK-029`, `WORK-034`, `WORK-035`, `WORK-036`
Requirements: `REF-001`
Objective: prove the generic architecture across materially different network classes.
Repository Scope: reference manifests/templates/fixtures/tests.
Out of Scope: full vertical production products.
Architecture Constraints: no reference network adds kernel primitives or generic vertical imports.
Acceptance Criteria: REF-001-AC01..04.
Required Verification: executable reference fixtures + static import graph checks.
Definition of Done: reference conformance suite proves universal model reuse.

## WORK-040 — Universal Network Launch Proof
Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-029`, `WORK-032`, `WORK-034`, `WORK-035`, `WORK-036`, `WORK-039`
Requirements: `NET-004`, `REF-001`, `CONF-001`
Objective: execute end-to-end Network-as-Code launch for representative simple, complex, infrastructure, protocol, hybrid, data-plane, and economic networks.
Repository Scope: integration/conformance suite.
Out of Scope: new generic primitives.
Architecture Constraints: all behavior must use previously implemented contracts; no architectural invention.
Acceptance Criteria: complete launch lifecycle, composition, allocation, execution, verification, evidence, economics, lifecycle recovery, and audit proof.
Required Verification: PostgreSQL end-to-end suites, real adapters where available, static architecture checks.
Definition of Done: launch proof succeeds for the reference matrix without kernel modification.

## WORK-041 — Final IAAS Architecture Conformance and Release Gate
Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `WORK-040`, `WORK-038`
Requirements: `CONF-001`
Objective: perform final full-program architecture conformance review and release gate.
Repository Scope: governance/specification/tests/evidence only.
Out of Scope: new features or new architectural primitives.
Architecture Constraints: any missing primitive or boundary contradiction routes to ACR-006+, never to silent V6 edits.
Acceptance Criteria: all V6 invariants pass; all reference networks remain generic; no forbidden dependency; historical architecture intact; implementation DAG complete.
Required Verification: full CI, specification validator, static import graph, PostgreSQL, lint, scope inspection, independent Architect Review.
Definition of Done: IAAS implementation program is mechanically traceable to V6 with no unresolved architecture gap.
