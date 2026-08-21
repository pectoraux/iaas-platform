# Phase 13 — Repository-Grounded Gap Matrix

> Classifies every architectural concept as EXISTS, PARTIALLY EXISTS, WRONG ABSTRACTION, or MISSING.
> Based on direct repository inspection at commit `dcc76df`.

---

## IDENTITY

| Concept | Status | Location | Notes |
|---------|--------|----------|-------|
| Tenant | EXISTS | `prisma/schema.prisma:51` | Top-level isolation. Fully implemented. |
| ParticipantIdentity | EXISTS | `prisma/schema.prisma:1752` | Global identity, no networkId. |
| ParticipantMembership | EXISTS | `prisma/schema.prisma:1766` | Network-scoped membership. |
| ParticipantRole | EXISTS | `prisma/schema.prisma:1786` | Roles: provider/consumer/verifier/validator/orchestrator/observer. |
| Organization | EXISTS | `prisma/schema.prisma:97` | Optional grouping. |

## RESOURCES

| Concept | Status | Location | Notes |
|---------|--------|----------|-------|
| Asset | EXISTS | `prisma/schema.prisma:204` | Physical/logical thing providing capability. |
| Device | EXISTS | `prisma/schema.prisma:272` | Technical interface to an asset. |
| DeviceCredential | EXISTS | `prisma/schema.prisma:294` | HMAC-SHA256 signing (provisioning secret model). |
| Operator | EXISTS | `prisma/schema.prisma:173` | Person/org contributing infrastructure. |
| Capability | EXISTS | `prisma/schema.prisma:322` | Network-version-scoped capability definition. |
| ResourceIdentity | EXISTS | `prisma/schema.prisma:1804` | Universal resource abstraction. |
| NetworkResourceMembership | EXISTS | `prisma/schema.prisma:1833` | Resource's membership in a network. |
| CapacityResource | EXISTS | `prisma/schema.prisma:493` | Platform-level capacity record. |
| AssetNetworkAssignment | EXISTS | `prisma/schema.prisma:240` | Asset-to-network assignment with verified capacity. |

## NETWORKS

| Concept | Status | Location | Notes |
|---------|--------|----------|-------|
| NetworkDefinition | EXISTS | `prisma/schema.prisma:114` | Tenant-scoped network. |
| NetworkVersion | EXISTS | `prisma/schema.prisma:136` | Immutable after publication. runtimeKind immutable. |
| NetworkTemplate | EXISTS | `src/lib/domain/templates.ts` | Reusable blueprint. 6 templates defined. |
| RuntimeRegistry | EXISTS | `src/lib/kernel/runtime/registry.ts` | Resolves runtimeKind → NetworkRuntime. |

## EXECUTION

| Concept | Status | Location | Notes |
|---------|--------|----------|-------|
| NetworkRequest | EXISTS | `prisma/schema.prisma:1864` | Deterministic ID from idempotency key. |
| AllocationDecision | EXISTS | `prisma/schema.prisma:1899` | Pure scheduler output. |
| AllocationReservation | EXISTS | `prisma/schema.prisma:1931` | Decision → capacity reservation binding. |
| CapacityReservation | EXISTS | `prisma/schema.prisma:524` | Platform capacity reservation. |
| CapacityCommitment | EXISTS | `prisma/schema.prisma:557` | Commitment from reservation. |
| CapacityUsage | EXISTS | `prisma/schema.prisma:610` | Actual usage record. |
| Execution | EXISTS | `prisma/schema.prisma:1392` | Generic execution record. |
| ExecutionAssignment | EXISTS | `prisma/schema.prisma:1425` | Per-asset assignment. |
| ExecutionLease | EXISTS | `prisma/schema.prisma:1488` | Ownership/fencing with FENCING lifecycle. |
| EconomicPipelineState | EXISTS | `prisma/schema.prisma:1539` | Economic checkpoint. |
| InfrastructureRuntime | EXISTS | `src/lib/kernel/runtime/infrastructure-runtime.ts` | Physical adapter dispatch. |
| ProtocolRuntime | EXISTS | `src/lib/kernel/runtime/protocol-runtime.ts` | Deterministic state transitions. |
| HybridRuntime | EXISTS | `src/lib/kernel/runtime/hybrid-runtime.ts` | Bridges infra + protocol. |
| InfrastructureAdapter | EXISTS | `src/lib/kernel/adapters/infrastructure-adapter.ts` | Adapter contract. |
| AdapterRegistry | EXISTS | `src/lib/kernel/runtime/adapter-registry.ts` | Asset-type → adapter resolution. |
| CapacityProvider | EXISTS | `src/lib/control-plane/capacity-provider.ts` | Resource → kernel translation boundary. |

## ECONOMICS

| Concept | Status | Location | Notes |
|---------|--------|----------|-------|
| Event | EXISTS | `prisma/schema.prisma:346` | Device-signed telemetry. |
| VerificationResult | EXISTS | `prisma/schema.prisma:387` | Policy-driven verification. |
| Attestation | EXISTS | `prisma/schema.prisma:409` | Verified claim. |
| Contribution | EXISTS | `prisma/schema.prisma:433` | Verified economic activity. |
| RewardRule | EXISTS | `prisma/schema.prisma:641` | Versioned reward policy. |
| Reward | EXISTS | `prisma/schema.prisma:663` | Economic entitlement. |
| LedgerAccount | EXISTS | `prisma/schema.prisma:713` | Double-entry account. |
| LedgerPosting | EXISTS | `prisma/schema.prisma:730` | Balanced posting. |
| LedgerEntry | EXISTS | `prisma/schema.prisma:747` | Individual debit/credit. |
| Settlement | EXISTS | `prisma/schema.prisma:776` | Payment instruction. |

## PROTOCOL

| Concept | Status | Location | Notes |
|---------|--------|----------|-------|
| ProtocolStateStore | EXISTS | `src/lib/kernel/runtime/protocol/state-store.ts` | In-memory + PostgreSQL implementations. |
| ProtocolTransactionExecutor | EXISTS | `src/lib/kernel/runtime/protocol/executor.ts` | Deterministic execution. |
| ValidatorRegistry | EXISTS | `src/lib/kernel/runtime/protocol/validator-consensus.ts` | Stub — Phase 9C. |
| ConsensusEngine | EXISTS | `src/lib/kernel/runtime/protocol/validator-consensus.ts` | SimpleConsensusEngine. |
| PhysicalExecutionEvidence | EXISTS | `prisma/schema.prisma:1584+` | Content-addressed evidence. |
| ReconciliationAttempt | EXISTS | `prisma/schema.prisma:1619+` | Attempt-based lifecycle. |
| ProtocolOutcome | EXISTS | `prisma/schema.prisma:1640+` | Append-only outcome. |
| ReconciliationStore | EXISTS | `src/lib/kernel/runtime/protocol/` | In-memory + PostgreSQL. |

## FUTURE CONCEPTS

> Updated by Phase 13R Reconciliation. See docs/architecture/PHASE-13-RECONCILIATION.md.

| Concept | Status | Notes |
|---------|--------|-------|
| Node | EXISTS (Phase 14A) | Protocol participant. Distinct from Asset/Device. Service-layer primitive. |
| NodeAgent | FUTURE | Software executing protocol participation. Not yet needed (YAGNI). |
| DataPlane | EXISTS (Phase 14B) | Service-layer contract for receive/store/deliver/expire/deduplicate. |
| Bundle | EXISTS (Phase 14B) | Generic data-plane primitive. Immutable identity, source/destination, expiry, priority, payload. |
| BundleDelivery | EXISTS (Phase 14B) | Append-only delivery records. At-least-once + idempotent. |
| Route | EXISTS (Phase 14C) | Planned path from source Node to destination Node. Attaches to Bundle. |
| RouteHop | EXISTS (Phase 14C) | Ordered hops within a Route. @@unique([routeId, sequence]). |
| NodeCapability | EXISTS (Phase 14C) | Generic data-plane capability declaration. Not a marketplace. |
| NodeReachability | EXISTS (Phase 14C) | Reachability knowledge (reachable, lastSeen, expiresAt). Not physical proof. |
| TransportExecution | EXISTS (Phase 14D) | Forward lifecycle (created → started → completed/failed/cancelled). |
| TransportAttempt | EXISTS (Phase 14D) | Per-hop attempts with deterministic attemptNumber. |
| TransportCapability | EXISTS (Phase 14D) | Transport capability declaration (STORE_AND_FORWARD, BUNDLE_TRANSFER, etc.). |
| TransportAdapter | EXISTS (Phase 14D) | Kernel contract interface. MockTransportAdapter has no network calls. |
| DeliveryConfirmation | EXISTS (Phase 14E) | Immutable receipt for "acknowledge" data-plane operation. |
| Transform | PARTIALLY EXISTS (Phase 14F) | TransformRecord provenance only. Execute/reverse/verify NOT implemented. |
| TransformRegistry | FUTURE | Technical catalog + versioning + compatibility. Not yet needed. |
| TransformRuntime | FUTURE | Execution of resolved transforms. Not yet needed. |
| Extension | FUTURE | Pluggable behavior (routing, scheduling, etc.). Not yet needed. |
| ExtensionRegistry | FUTURE | Publisher identity, signature, permissions. Not yet needed. |
| ExtensionRuntime | FUTURE | Sandboxed execution (WASM/container/native — OPEN). Not yet needed. |
| Marketplace | FUTURE | Discovery/publishing/licensing. MUST NOT execute. Not yet needed. |
| SDK | FUTURE | Generic API domains. Not yet needed. |
| RemoteAPI | FUTURE | Fleet management API. Not yet needed. |
| Sandbox | FUTURE | Resource-limited extension execution. Not yet needed. |

## VPP-SPECIFIC (LEGACY)

| Concept | Status | Location | Notes |
|---------|--------|----------|-------|
| VppBuyerProgram | EXISTS | `prisma/schema.prisma:971` | VPP-specific program. |
| VppCapacityReservation | EXISTS | `prisma/schema.prisma:1007` | VPP-specific reservation. |
| VppDispatch | EXISTS | `prisma/schema.prisma:1038` | VPP dispatch. |
| VppDispatchAssignment | EXISTS | `prisma/schema.prisma:1096` | VPP assignment. economicStage is LEGACY. |
| VppBaseline | EXISTS | `prisma/schema.prisma:1141` | VPP baseline calculation. |
| VppPortfolioCommitment | EXISTS | `prisma/schema.prisma:1220` | VPP portfolio. |
| VppBuyerSettlement | EXISTS | `prisma/schema.prisma:1323` | VPP buyer settlement. |

## SUMMARY

- **54 Prisma models exist** (identity, resources, networks, execution, economics, protocol, VPP-specific).
- **3 runtime implementations exist** (Infrastructure, Protocol, Hybrid).
- **15 future concepts are MISSING** (Node, DataPlane, Bundle, Transform, Extension, Marketplace, SDK, etc.).
- **0 concepts have WRONG ABSTRACTION** — the existing architecture is sound.
- **0 concepts require PARTIAL replacement** — all existing abstractions extend cleanly.
