# IAAS Domain Requirements — IAAS-DOM-ARCH-6

- Architecture Version: `IAAS-DOM-ARCH-6` (FROZEN)
- Domain Architecture: `IAAS-DOM-ARCH-6` (FROZEN)
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Change Request: `ACR-005` (APPROVED)
- Supersedes for future planning: V5 requirements (V6 frozen via WORK-024); V1-V5 remain immutable historical records

> These requirements became acceptance-bearing with ACR-005 approval and the V6 freeze (WORK-024). Implementation Work Items are released strictly according to `spec/dependency-graph-v6.md`.

## ARCH-001 — V6 Candidate Governance Gate
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `ACR-005`
Description: The V6 candidate MUST remain explicitly non-frozen until ACR-005 is approved and the dedicated V6 freeze/release gate is verified.
Acceptance Criteria: V6 status remains CANDIDATE / UNDER REVIEW; no V6 implementation Work Item becomes READY before freeze; V1-V5 remain immutable.
Verification: V6 validator; historical immutability checks; independent Architect Review.

## NET-001 — Network Instance Identity and Ownership
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `ARCH-001`
Description: A declarative NetworkDefinition/version MAY produce a distinct NetworkInstance with stable identity, ownership, lifecycle state, and tenant scope without redefining the network definition.
Acceptance Criteria: NetworkInstance identity is distinct from NetworkDefinition identity; lifecycle state is authoritative in the network lifecycle subsystem; tenant scope is explicit.
Verification: domain contract tests; persistence and tenant-isolation tests; authority/ownership static checks.

## NET-002 — Declarative Network-as-Code
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `NET-001`
Description: Network-as-Code MUST represent networks declaratively through a versioned definition that can be validated and resolved deterministically without kernel modification.
Acceptance Criteria: definition, validation, dependency resolution, capability/resource resolution, allocation, provisioning, activation, verification, and deployment are represented as one lifecycle; simple and complex networks use the same model.
Verification: manifest compilation tests; deterministic-resolution tests; reference-network conformance.

## NET-003 — Network Lifecycle Authority
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `NET-001`, `NET-002`
Description: Network instance lifecycle transitions MUST have one authoritative owner and MUST be distinct from generic workflow state.
Acceptance Criteria: provision/validate/activate/pause/resume/scale/drain/upgrade/rollback/terminate/archive semantics are explicit; invalid transitions are rejected; workflow lifecycle is not reused as infrastructure lifecycle authority.
Verification: lifecycle state-machine tests; authority matrix checks; invalid-transition tests.

## NET-004 — Deterministic Network Launch
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `NET-002`, `NET-003`
Description: A valid NetworkDefinition MUST be launchable into a NetworkInstance using the canonical resolution and allocation contracts without modifying kernel semantics.
Acceptance Criteria: launch consumes resolved dependencies, capabilities, resources, and policies; activation occurs only after provisioning and verification; launch failures cannot create an active instance.
Verification: launch integration tests; failure-atomicity tests; universal-launch proof.

## COMP-001 — Network Composition
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `NET-001`, `NET-002`
Description: Multiple independently defined networks MUST be composable through explicit composition contracts rather than private internal state exposure.
Acceptance Criteria: composition has stable identity; component networks remain independently authoritative; composition is deterministic and auditable.
Verification: composition contract tests; authority/encapsulation checks.

## COMP-002 — Composition Bindings
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `COMP-001`
Description: ResourceBinding, CapabilityBinding, PolicyBinding, NetworkDependency, NetworkExport, and NetworkImport semantics MUST be explicit where cross-network interaction is required.
Acceptance Criteria: bindings reference public contracts only; binding failure is explicit; internal runtime state is never used as a composition contract.
Verification: binding schema tests; negative private-state access tests; dependency graph validation.

## COMP-003 — Composition Isolation and Failure Semantics
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `COMP-001`, `COMP-002`
Description: A composed network MUST preserve tenant, resource, capability, policy, and lifecycle isolation between component networks.
Acceptance Criteria: failure of one component cannot silently mutate another component's authoritative state; teardown follows explicit dependency semantics.
Verification: failure-isolation tests; tenant-scope tests; lifecycle cascade tests.

## ALLOC-001 — Stable Allocation Contract
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `NET-002`, `COMP-001`
Description: Allocation MUST be expressed through a stable strategy interface independent of any one optimization or market algorithm.
Acceptance Criteria: allocation strategies are pluggable policy/configuration; allocation decisions remain separate from reservations, commitments, and execution.
Verification: strategy contract tests; anti-coupling checks; pipeline separation tests.

## ALLOC-002 — Temporal Reservation Semantics
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `ALLOC-001`
Description: Resource coordination MUST support explicit availability windows, reservation windows, deadlines, priorities, and preemption semantics without redefining resource truth.
Acceptance Criteria: temporal constraints are explicit inputs; reservations do not become commitments automatically; conflicting reservations resolve deterministically.
Verification: temporal allocation tests; conflict/preemption tests; persistence tests.

## ALLOC-003 — Allocation Strategy Neutrality
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `ALLOC-001`, `ALLOC-002`
Description: Exclusive, shared, pooled, fair, priority, scheduled, opportunistic, auction, and market strategies MUST remain policies/configuration over the stable allocation contract rather than kernel-specific primitives.
Acceptance Criteria: no strategy requires a kernel fork; strategy identity and parameters are auditable; operational truth remains outside economics.
Verification: strategy conformance tests; dependency-direction tests; configuration validation.

## DATA-001 — Fragmentation and Reassembly
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `NET-001`
Description: Data Plane fragmentation MUST be represented as a generic protocol-independent contract with stable fragment identity and reassembly state.
Acceptance Criteria: FragmentIdentity, index/count, integrity, expiration, and ReassemblyState semantics are explicit; fragments remain associated with their parent Bundle and tenant.
Verification: fragmentation/reassembly integration tests; expiration/integrity tests; tenant isolation tests.

## DATA-002 — Delivery Idempotency and Transform Provenance
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `DATA-001`
Description: Bundle delivery MUST preserve at-least-once semantics, idempotency, deduplication, expiration, and independent TransformRecord provenance.
Acceptance Criteria: duplicate delivery cannot create duplicate committed effects; TransformRecord remains immutable provenance rather than executor or registry.
Verification: duplicate/retry tests; transform-provenance tests; anti-dependency checks.

## TRUST-001 — Generic Trust Binding
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `ARCH-001`
Description: Participants, nodes, resources, packages, transforms, extensions, network definitions, execution evidence, and attestations MUST be bindable to verifiable identity/credential material.
Acceptance Criteria: identity, credential/key binding, signature, and verification semantics are distinct concepts; no concrete algorithm is frozen by V6.
Verification: trust contract tests; negative credential tests; architecture review.

## TRUST-002 — Signature and Integrity Semantics
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `TRUST-001`
Description: Signed artifacts and evidence MUST provide integrity, signer identity, version binding, and explicit verification outcomes.
Acceptance Criteria: invalid, missing, expired, or revoked trust material fails closed where required; verification does not mutate the signed artifact.
Verification: signature/verification tests; tamper tests; fail-closed tests.

## TRUST-003 — Attestation Boundaries
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `TRUST-001`, `DATA-002`
Description: Verification and attestation MUST consume evidence while preserving the distinction between observation, evidence, verification result, and attestation.
Acceptance Criteria: raw telemetry is not authoritative truth; attestation cannot be emitted solely from unverified observation; authority remains in Verification.
Verification: evidence-pipeline tests; anti-telemetry-to-attestation tests; authority checks.

## PKG-001 — Unified Package Model
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `TRUST-001`
Description: Installable IAAS artifacts MUST share a generic package model supporting identity, version, manifest, dependencies, capabilities, compatibility, integrity, publisher, signature, and artifacts.
Acceptance Criteria: NetworkPackage, TransformPackage, ExtensionPackage, and AdapterPackage are typed uses of one package contract rather than duplicated package architectures.
Verification: package schema/contract tests; cross-kind conformance tests.

## PKG-002 — Package Admission and Compatibility
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `PKG-001`, `TRUST-002`
Description: Package admission MUST validate integrity, signatures/trust, compatibility, dependencies, and declared capabilities before installation.
Acceptance Criteria: denied packages have no partial installation state; admission remains separate from runtime execution; implementation format remains configurable.
Verification: admission tests; dependency-resolution tests; failure-atomicity tests.

## DIST-001 — Registry and Marketplace Separation
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `PKG-001`
Description: Technical registries MUST remain catalog/lifecycle authorities while a marketplace remains a distribution/commerce surface.
Acceptance Criteria: marketplace cannot replace technical registry authority; marketplace cannot execute extensions; package technical identity remains registry-owned.
Verification: authority and anti-dependency tests; marketplace boundary checks.

## DIST-002 — Distribution Lifecycle
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `DIST-001`, `PKG-002`
Description: Publishing, certification, discovery, installation, licensing, pricing, and distribution MUST remain separate from runtime execution and operational truth.
Acceptance Criteria: publisher/certification/license metadata is explicit; commercial policy cannot silently mutate installed runtime state.
Verification: lifecycle tests; authority separation tests; security review.

## ECON-001 — Usage Measurement and Economic Attribution
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `TRUST-003`
Description: Economic attribution MUST consume verified operational facts rather than become an operational source of truth.
Acceptance Criteria: usage measurements and attribution rules are distinct; unverified facts cannot produce authoritative settlement inputs; economics cannot mutate operational truth.
Verification: evidence-to-economics integration tests; anti-dependency tests.

## ECON-002 — Pricing and Reward Policy
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `ECON-001`
Description: Pricing, contribution, and reward policies MUST be generic, configurable policy inputs over verified usage and attribution.
Acceptance Criteria: pricing strategy does not modify execution semantics; policy versions are explicit and auditable.
Verification: pricing-policy contract tests; versioning tests; operational/economic separation tests.

## ECON-003 — Ledger and Settlement Boundary
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `ECON-001`, `ECON-002`
Description: Ledger posting and settlement MUST remain downstream of verified economic attribution and MUST NOT become a second operational truth system.
Acceptance Criteria: ledger authority is unique; settlement cannot change execution or delivery truth; payment instructions remain distinct from ledger state.
Verification: ledger/settlement integration tests; duplicate-ledger detection; anti-operational-mutation tests.

## OPS-001 — Generic Infrastructure Operations Lifecycle
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `NET-003`, `NET-004`
Description: Infrastructure operations MUST expose a generic lifecycle contract covering provision, validate, activate, pause, resume, scale, drain, upgrade, rollback, terminate, and archive.
Acceptance Criteria: operational lifecycle authority is distinct from workflow lifecycle; transitions are auditable and idempotent where required.
Verification: lifecycle state-machine tests; failure/retry tests; authority checks.

## OBS-001 — Observability and Evidence Model
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `TRUST-003`, `OPS-001`
Description: Telemetry, Metric, Log, Trace, Event, and Evidence MUST remain distinct concepts with explicit conversion semantics.
Acceptance Criteria: telemetry can be observed without becoming evidence automatically; evidence is attributable and immutable where contractually required.
Verification: observability model tests; evidence-conversion tests; anti-dependency checks.

## OBS-002 — Verification and Attestation Pipeline
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `OBS-001`, `TRUST-003`
Description: Verified operational truth MUST follow observation → evidence → verification → attestation semantics.
Acceptance Criteria: raw observation cannot directly produce attestation; failed verification cannot silently produce a successful attestation.
Verification: pipeline conformance tests; negative verification tests; provenance checks.

## SDK-001 — Canonical SDK Surface
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `NET-002`, `TRUST-001`, `PKG-001`
Description: The IAAS SDK MUST consume canonical IAAS contracts and MUST NOT introduce private semantics, alternate persistence authority, or hidden state transitions.
Acceptance Criteria: SDK calls map one-to-one to canonical service contracts; unsupported operations fail explicitly; SDK remains a consumer/adapter surface.
Verification: SDK contract tests; API parity tests; private-semantics static checks.

## FED-001 — Federation Research Boundary
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `TRUST-001`, `NET-001`
Description: Federation MAY be explored as a future cross-domain capability but MUST remain OPEN / RESEARCH in V6 until identity, remote resource, cross-domain execution, trust, and settlement semantics are mature enough to freeze.
Acceptance Criteria: federation has an explicit research classification; no V6 production dependency requires federation; no concrete federation transport or cryptographic algorithm is frozen.
Verification: architecture classification tests; dependency graph checks; no-production-dependency checks.

## REF-001 — Reference Network Universalism
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `NET-002`, `COMP-001`, `ALLOC-001`, `DATA-001`
Description: Reference networks MUST be realizable as templates/instances over generic IAAS primitives without modifying generic kernel semantics.
Acceptance Criteria: compute, storage, wireless, DTN, manufacturing, construction, mobility, food, energy, blockchain, and community-finance examples remain reference networks or adapters rather than kernel primitives.
Verification: reference-network conformance matrix; kernel import/authority checks; universal-launch proof.

## CONF-001 — Full Architecture Conformance
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: `NET-004`, `COMP-003`, `ALLOC-003`, `DATA-002`, `TRUST-003`, `PKG-002`, `DIST-002`, `ECON-003`, `OPS-001`, `OBS-002`, `SDK-001`, `REF-001`
Description: The complete V6 architecture MUST be mechanically testable for authority uniqueness, acyclic dependency direction, historical immutability, universalism, trust boundaries, and implementation gating.
Acceptance Criteria: all V6 requirements have objective verification; all promoted primitives have explicit owners; all prohibited dependencies are represented; all V6 Work Items remain DRAFT until the freeze gate is satisfied; no production implementation is authorized by candidate documents alone.
Verification: V6 validator; specification consistency validator; architecture regression suite; DAG cycle detection; anti-drift checks; independent Architect Review.
