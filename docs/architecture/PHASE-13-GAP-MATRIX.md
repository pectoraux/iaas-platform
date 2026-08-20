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

| Concept | Status | Notes |
|---------|--------|-------|
| Node | MISSING | Protocol participant. Distinct from Asset/Device. Must be defined before ProtocolRuntime can support peer-to-peer networks. |
| NodeAgent | MISSING | Software executing protocol participation. |
| DataPlane | MISSING | Contract for receive/store/route/forward/deliver. |
| Bundle | MISSING | Generic data-plane primitive. |
| Transform | MISSING | Execute/reverse/verify with provenance. |
| TransformRegistry | MISSING | Technical catalog + versioning + compatibility. |
| TransformRuntime | MISSING | Execution of resolved transforms. |
| Extension | MISSING | Pluggable behavior (routing, scheduling, etc.). |
| ExtensionRegistry | MISSING | Publisher identity, signature, permissions. |
| ExtensionRuntime | MISSING | Sandboxed execution (WASM/container/native — OPEN). |
| Marketplace | MISSING | Discovery/publishing/licensing. MUST NOT execute. |
| SDK | MISSING | Generic API domains. |
| RemoteAPI | MISSING | Fleet management API. |
| Sandbox | MISSING | Resource-limited extension execution. |

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
