# IAAS Domain Requirements — IAAS-DOM-ARCH-6

- Domain Architecture: `IAAS-DOM-ARCH-6` (CANDIDATE / UNDER REVIEW)
- Governing Architecture: `IAAS-GOV-ARCH-1` (FROZEN)
- Change Request: `ACR-005` (UNDER_REVIEW)
- Supersedes for future planning: V5 requirements only after V6 freeze; V1-V5 remain immutable historical records

> These requirements are acceptance-bearing only after ACR-005 approval and V6 freeze. Until then they are the proposed completion baseline and must not authorize production implementation.

## ARCH-001 — V6 Candidate Governance Gate

The V6 candidate MUST remain explicitly non-frozen until ACR-005 is approved and a dedicated V6 freeze/release Work Item is VERIFIED.

Dependencies: GOV-001..GOV-008.
Acceptance Criteria:
- `ARCH-001-AC01` V5 remains immutable.
- `ARCH-001-AC02` candidate documents state `CANDIDATE / UNDER REVIEW`.
- `ARCH-001-AC03` no V6 production Work Item is READY before freeze.
- `ARCH-001-AC04` V6 freeze requires independent Architect Review.
Verification: specification validator + immutable-history regression tests.

## NET-001 — Network Instance Identity

The platform MUST distinguish declarative network intent from a deployed network instance. A `NetworkInstance` identifies one realized deployment of one immutable `NetworkVersion`.

Dependencies: NetworkDefinition, NetworkVersion.
Acceptance Criteria:
- `NET-001-AC01` one NetworkInstance references exactly one tenant and NetworkVersion.
- `NET-001-AC02` instance identity is immutable.
- `NET-001-AC03` multiple instances may be created from the same NetworkVersion without altering the version.
- `NET-001-AC04` instance lifecycle state does not mutate NetworkDefinition or NetworkVersion.
Verification: PostgreSQL lifecycle tests + immutability checks.

## NET-002 — Network Lifecycle Authority

Network lifecycle MUST be owned by one Network Lifecycle subsystem and MUST be distinct from request/execution and resource lifecycles.

Lifecycle:
`PLANNED → PROVISIONING → VALIDATING → ACTIVE ⇌ PAUSED → DRAINING → TERMINATED → ARCHIVED` with failure/rollback transitions defined by the lifecycle contract.

Dependencies: NET-001.
Acceptance Criteria:
- `NET-002-AC01` every transition has one authoritative owner.
- `NET-002-AC02` invalid transitions are rejected deterministically.
- `NET-002-AC03` rollback never edits a published NetworkVersion.
- `NET-002-AC04` instance termination does not imply deletion of historical evidence.
Verification: state-machine tests + PostgreSQL transition tests.

## NET-003 — Network-as-Code Declarative Compilation

A canonical NetworkDefinition MUST be expressible as declarative configuration and validated into an immutable NetworkVersion without kernel modification.

Dependencies: NET-001, NET-002, existing NetworkDefinition/NetworkVersion.
Acceptance Criteria:
- `NET-003-AC01` definition validation rejects unresolved references and invalid capability/policy declarations.
- `NET-003-AC02` version compilation is deterministic for equivalent inputs.
- `NET-003-AC03` published versions are immutable.
- `NET-003-AC04` the compiler does not import vertical services or concrete runtimes.
Verification: deterministic compiler tests + static dependency checks.

## NET-004 — Network Launch Lifecycle

Launch MUST implement the canonical lifecycle: Definition → Validation → Dependency Resolution → Capability Resolution → Resource Discovery → Allocation → Reservation → Commitment → Provisioning → Runtime Activation → Verification → DEPLOYED.

Dependencies: NET-003, allocation, runtime, verification contracts.
Acceptance Criteria:
- `NET-004-AC01` every stage has explicit input/output contracts.
- `NET-004-AC02` later stages cannot bypass earlier required gates.
- `NET-004-AC03` failed launch is recoverable through defined rollback/cleanup semantics.
- `NET-004-AC04` launch does not require generic-kernel modification.
Verification: end-to-end launch fixture + negative ordering tests.

## COMP-001 — Network Composition

The platform MUST support explicit composition of networks through stable contracts rather than implementation-state sharing.

Dependencies: NET-003.
Acceptance Criteria:
- `COMP-001-AC01` composition identifies participating NetworkInstances or immutable versions explicitly.
- `COMP-001-AC02` dependencies are tenant-authorized and version-pinned.
- `COMP-001-AC03` composition has no direct dependency on internal runtime state.
- `COMP-001-AC04` composition cannot bypass allocation, trust, or lifecycle authority.
Verification: composition integration + anti-bypass tests.

## COMP-002 — Capability / Resource / Policy Bindings

Composition MUST use explicit `CapabilityBinding`, `ResourceBinding`, and `PolicyBinding` contracts.

Dependencies: COMP-001.
Acceptance Criteria:
- `COMP-002-AC01` bindings refer to stable exported identities.
- `COMP-002-AC02` bindings are tenant-scoped and authorization-checked.
- `COMP-002-AC03` binding resolution is deterministic.
Verification: binding resolution and tenant-isolation tests.

## COMP-003 — Network Export / Import Boundary

Networks MAY export capabilities/resources/policies through explicit `NetworkExport`; consumers bind through `NetworkImport`.

Dependencies: COMP-002.
Acceptance Criteria:
- `COMP-003-AC01` imports cannot access non-exported implementation state.
- `COMP-003-AC02` exported contracts are versioned.
- `COMP-003-AC03` revoked or terminated exports fail closed.
Verification: contract and lifecycle tests.

## ALLOC-001 — Allocation Strategy Contract

Allocation MUST expose a stable service-layer strategy contract. Concrete strategies MUST NOT become kernel branches.

Dependencies: existing scheduler/allocation.
Acceptance Criteria:
- `ALLOC-001-AC01` strategy selection is policy/configuration data.
- `ALLOC-001-AC02` strategy implementations share one allocation contract.
- `ALLOC-001-AC03` strategy choice does not change reservation/commitment authority.
- `ALLOC-001-AC04` market/auction/fair/priority are optional strategies, not mandatory kernel semantics.
Verification: strategy conformance tests + static kernel-scope checks.

## ALLOC-002 — Temporal Coordination

Resource availability and reservations MUST support explicit windows and deadlines.

Dependencies: ALLOC-001, CapacityReservation.
Acceptance Criteria:
- `ALLOC-002-AC01` ReservationWindow has deterministic start/end semantics.
- `ALLOC-002-AC02` overlapping exclusive reservations are rejected or resolved by policy before commitment.
- `ALLOC-002-AC03` availability windows cannot be confused with observed usage.
- `ALLOC-002-AC04` deadline and priority are inputs to allocation policy, not ledger truth.
Verification: concurrency and overlap tests against PostgreSQL.

## ALLOC-003 — Demand / Forecast Separation

Demand is requested or inferred need; forecast is advisory and MUST NOT become authoritative capacity or allocation state without an explicit allocation decision.

Dependencies: ALLOC-001.
Acceptance Criteria:
- `ALLOC-003-AC01` forecast data cannot create commitments directly.
- `ALLOC-003-AC02` actual commitments reference durable allocation decisions.
Verification: negative integration tests.

## DATA-001 — Fragmentation

The Data Plane MUST support optional fragmentation of a Bundle for transport scenarios requiring bounded fragments.

Dependencies: existing Bundle/Route/Transport.
Acceptance Criteria:
- `DATA-001-AC01` Fragment has immutable identity and parent Bundle identity.
- `DATA-001-AC02` sequence/index and total-count semantics are explicit when total is known.
- `DATA-001-AC03` fragment integrity is independently verifiable.
- `DATA-001-AC04` expiry and tenant scope are inherited/enforced.
Verification: fragment unit/PG tests.

## DATA-002 — Idempotent Reassembly

Reassembly MUST converge under duplicate/out-of-order delivery, enforce expiration, and isolate tenants.

Dependencies: DATA-001.
Acceptance Criteria:
- `DATA-002-AC01` duplicate fragments do not create duplicate payload materialization.
- `DATA-002-AC02` out-of-order fragments are accepted within the validity window.
- `DATA-002-AC03` expired reassembly cannot complete.
- `DATA-002-AC04` completion is deterministic and auditable.
Verification: adversarial ordering + PostgreSQL concurrency tests.

## TRUST-001 — Credential / Key Binding

The platform MUST define generic credential/key-binding semantics for participants, nodes, packages, and network artifacts without freezing one cryptographic algorithm.

Dependencies: identity primitives.
Acceptance Criteria:
- `TRUST-001-AC01` a credential is bound to an identity/artifact subject.
- `TRUST-001-AC02` validity/revocation status is explicit.
- `TRUST-001-AC03` secret/private material is never persisted as plaintext.
- `TRUST-001-AC04` algorithm selection remains implementation/configuration policy.
Verification: trust model unit tests + secret-handling checks.

## TRUST-002 — Signature Envelope

A `SignatureEnvelope` MUST bind signed content identity, signer/key identity, algorithm metadata, and signature bytes.

Dependencies: TRUST-001.
Acceptance Criteria:
- `TRUST-002-AC01` signatures are verified over canonical content.
- `TRUST-002-AC02` verification failure is fail-closed.
- `TRUST-002-AC03` an unsigned/unverified package cannot pass package trust admission.
Verification: canonicalization and tamper tests.

## TRUST-003 — Trust Policy / Decision

Trust policy MUST be separate from signature mechanics and execution.

Dependencies: TRUST-002.
Acceptance Criteria:
- `TRUST-003-AC01` trust evaluation is policy-driven.
- `TRUST-003-AC02` a positive trust decision does not execute the subject.
- `TRUST-003-AC03` revocation invalidates future trust decisions according to policy.
Verification: policy matrix + revocation tests.

## PKG-001 — Generic Package Model

All installable IAAS artifacts MUST use one generic package contract with typed package kinds.

Dependencies: TRUST-001.
Acceptance Criteria:
- `PKG-001-AC01` Package has identity, version, manifest, dependencies, capabilities, compatibility, publisher, integrity, and artifacts.
- `PKG-001-AC02` package kinds include Network, Transform, Extension, and Adapter without separate packaging architectures.
- `PKG-001-AC03` package metadata is content-addressable or otherwise integrity-bound.
Verification: package schema/serialization tests.

## PKG-002 — Package Admission

Package installation/admission MUST validate integrity, compatibility, dependencies, publisher/trust, and declared capabilities before runtime activation.

Dependencies: PKG-001, TRUST-003.
Acceptance Criteria:
- `PKG-002-AC01` admission is deterministic.
- `PKG-002-AC02` dependency cycles are rejected.
- `PKG-002-AC03` admission does not execute package payloads.
- `PKG-002-AC04` sandbox lifecycle remains authoritative for extension execution.
Verification: negative package tests + no-execution installation tests.

## DIST-001 — Registry / Distribution Separation

Technical registries remain catalog/lifecycle authorities. Distribution and marketplaces are consumers/producers of package metadata, not replacements for registries.

Dependencies: PKG-002, existing TransformRegistry, ExtensionRegistry.
Acceptance Criteria:
- `DIST-001-AC01` Marketplace cannot change technical runtime lifecycle directly.
- `DIST-001-AC02` publication does not equal installation or activation.
- `DIST-001-AC03` registries remain authoritative technical catalogs.
Verification: static boundary tests.

## DIST-002 — Marketplace Boundary

The Marketplace MAY own listing, discovery, commercial terms, and licensing; it MUST NOT execute extensions or mutate operational truth.

Dependencies: DIST-001.
Acceptance Criteria:
- `DIST-002-AC01` marketplace APIs do not invoke extension execution.
- `DIST-002-AC02` marketplace state is not authoritative for runtime activation.
- `DIST-002-AC03` pricing model remains configurable/product-specific.
Verification: interface/anti-dependency tests.

## ECON-001 — Usage Measurement

Verified operational outcomes MAY be converted into immutable `UsageMeasurement` facts before economic attribution.

Dependencies: Verification/Attestation, existing execution/data-plane facts.
Acceptance Criteria:
- `ECON-001-AC01` measurement source and units are explicit.
- `ECON-001-AC02` measurements cannot overwrite operational facts.
- `ECON-001-AC03` unmeasured quantities are not fabricated from limits/ceilings.
Verification: measurement provenance tests.

## ECON-002 — Economic Attribution

A generic `EconomicAttribution` contract MUST map verified usage/activity to the economic beneficiary/provider without requiring vertical-specific services.

Dependencies: ECON-001.
Acceptance Criteria:
- `ECON-002-AC01` attribution references verified source identities.
- `ECON-002-AC02` attribution rules are policy-driven.
- `ECON-002-AC03` attribution cannot mutate Event, VerificationResult, Attestation, Execution, Route, Transport, or resource truth.
Verification: anti-dependency + reconciliation tests.

## ECON-003 — Pricing Policy

Pricing MUST remain a policy boundary consumed after verified usage/attribution; a pricing result cannot become operational truth.

Dependencies: ECON-002.
Acceptance Criteria:
- `ECON-003-AC01` pricing rules are versioned.
- `ECON-003-AC02` price calculation is deterministic for fixed inputs/policy.
- `ECON-003-AC03` changing price policy does not rewrite historical operational facts.
Verification: deterministic pricing tests + historical immutability tests.

## OPS-001 — Generic Operational Lifecycle

The platform MUST define an operations lifecycle distinct from workflow/control-plane lifecycle.

Dependencies: Resource/Node/NetworkInstance contracts.
Acceptance Criteria:
- `OPS-001-AC01` lifecycle actions include provision, validate, activate, pause, resume, scale, drain, upgrade, rollback, terminate, archive.
- `OPS-001-AC02` only resource types declaring an action may perform it.
- `OPS-001-AC03` lifecycle transitions have one authoritative owner.
- `OPS-001-AC04` termination/archive preserve required audit/evidence.
Verification: operation state-machine tests.

## OBS-001 — Observation Contracts

Telemetry, Metric, Log, and Trace MUST remain distinct observation contracts with source/time/context metadata.

Dependencies: execution/runtime contracts.
Acceptance Criteria:
- `OBS-001-AC01` observations carry source identity and timestamps.
- `OBS-001-AC02` aggregation does not change the meaning of raw telemetry.
- `OBS-001-AC03` observation storage is not verification authority.
Verification: schema/type tests.

## OBS-002 — Evidence Boundary

Evidence is an intentionally submitted observation package for verification and MUST remain distinct from raw telemetry/log/trace records.

Dependencies: OBS-001, existing Event/VerificationResult/Attestation.
Acceptance Criteria:
- `OBS-002-AC01` raw observation cannot self-attest.
- `OBS-002-AC02` evidence references its source/provenance.
- `OBS-002-AC03` verification is policy-driven and independent of economic outcome.
Verification: negative verification bypass tests.

## SDK-001 — Canonical SDK Boundary

The SDK MUST be a consumer of canonical IAAS APIs and contracts and MUST NOT introduce alternate semantics.

Dependencies: canonical service contracts.
Acceptance Criteria:
- `SDK-001-AC01` SDK operations map to canonical identities/lifecycles.
- `SDK-001-AC02` SDK cannot bypass authorization/lifecycle gates.
- `SDK-001-AC03` local and remote clients use the same semantic contract family.
Verification: contract conformance tests.

## FED-001 — Federation Research Boundary

Federation MUST remain explicitly OPEN / RESEARCH. No production federation primitive is acceptance-bearing in V6.

Dependencies: trust, network, economics.
Acceptance Criteria:
- `FED-001-AC01` local IAAS authority remains authoritative for local state.
- `FED-001-AC02` cross-domain identity/resource/network settlement concepts are documented as research seams only.
- `FED-001-AC03` federation cannot be smuggled in as an SDK or marketplace feature.
Verification: architecture classification test.

## REF-001 — Reference Network Universalism

Reference networks MUST be representable using generic primitives without vertical-specific kernel modifications.

Dependencies: NET-003, COMP-001, ALLOC-001, DATA-001, TRUST-001, PKG-001, ECON-002, OPS-001.
Acceptance Criteria:
- `REF-001-AC01` compute and storage use the same generic network model.
- `REF-001-AC02` wireless/bandwidth uses the same model.
- `REF-001-AC03` DTN/transit/local-first uses Bundle/Fragment/Route/Transport without bespoke kernel state.
- `REF-001-AC04` manufacturing/mobility/energy/protocol/community-finance examples use generic policy/capability contracts.
Verification: reference fixture matrix + static import checks.

## CONF-001 — Architecture Conformance Gate

Before any V6 implementation release, the implementation MUST pass the complete architecture conformance suite covering ownership, anti-dependencies, lifecycle, tenant isolation, immutability, idempotency, trust, and universal-network coverage.

Dependencies: all acceptance-bearing V6 requirements.
Acceptance Criteria:
- `CONF-001-AC01` all required documents and stable IDs validate.
- `CONF-001-AC02` domain DAG is acyclic and all required dependencies resolve.
- `CONF-001-AC03` forbidden dependency checks pass.
- `CONF-001-AC04` V1-V5 historical files are unchanged.
- `CONF-001-AC05` no V6 Work Item becomes READY before freeze.
Verification: specification validator + architecture regression suite + CI.
