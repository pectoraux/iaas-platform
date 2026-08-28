# IAAS V6 Implementation Dependency Graph

- Target architecture: `IAAS-DOM-ARCH-6` (FROZEN)
- The architecture gate is complete: items become implementation-eligible strictly per the Eligibility Rule below.
- WORK-025 is the sole released (`READY`) item; every other item remains `DRAFT` until its dependencies are `VERIFIED`.

## Governance / Architecture Gate

```text
WORK-023 (V6 architecture completion candidate)
          ↓
WORK-024 (V6 freeze and governance release)
```

`WORK-022` is a V5 production item and is intentionally held by `spec/work-state/V6-ARCHITECTURE-HOLD.md`. It is not a prerequisite for completing V6 architecture because architecture completion must precede further production implementation.

## Post-Freeze Implementation DAG

```text
WORK-024
   ├──────────────→ WORK-025 NetworkInstance + lifecycle
   │                    ↓
   │                WORK-026 Network-as-Code + launch
   │                    ↓
   │             ┌──────┴────────┐
   │             ↓               ↓
   │         WORK-027        WORK-028
   │      Composition      Allocation/Time
   │             ↓               ↓
   │         WORK-029           │
   │      Fragmentation          │
   │             └───────┬───────┘
   │                     ↓
   ├──────────────────→ WORK-030 Trust
   │                     ↓
   │                  WORK-031 Package
   │                     ↓
   │                  WORK-032 Package Admission
   │                     ↓
   │                  WORK-033 Distribution / Marketplace boundary
   │
   ├──────────────────→ WORK-034 Economic Metering/Attribution
   │                     ↓
   │                  WORK-035 Operations
   │                     ↓
   │                  WORK-036 Observability/Evidence
   │                     ↓
   │                  WORK-037 SDK
   │
   └──────────────────→ WORK-038 Federation research gate

WORK-026 + WORK-027 + WORK-028 + WORK-029 + WORK-034 + WORK-035 + WORK-036
                                  ↓
                              WORK-039
                       Reference conformance
                                  ↓
                     WORK-040 Universal launch proof
                                  ↓
                     WORK-041 Final conformance gate
```

## Exact Dependency Edges

```text
WORK-023 → WORK-024
WORK-024 → WORK-025
WORK-025 → WORK-026
WORK-026 → WORK-027
WORK-026 → WORK-028
WORK-027 → WORK-029
WORK-027 → WORK-030
WORK-030 → WORK-031
WORK-031 → WORK-032
WORK-032 → WORK-033
WORK-028 → WORK-034
WORK-030 → WORK-034
WORK-025 → WORK-035
WORK-030 → WORK-035
WORK-034 → WORK-036
WORK-035 → WORK-036
WORK-026 → WORK-037
WORK-027 → WORK-037
WORK-030 → WORK-037
WORK-035 → WORK-037
WORK-030 → WORK-038
WORK-034 → WORK-038
WORK-026 → WORK-039
WORK-027 → WORK-039
WORK-028 → WORK-039
WORK-029 → WORK-039
WORK-034 → WORK-039
WORK-035 → WORK-039
WORK-036 → WORK-039
WORK-029 → WORK-040
WORK-032 → WORK-040
WORK-034 → WORK-040
WORK-035 → WORK-040
WORK-036 → WORK-040
WORK-039 → WORK-040
WORK-040 → WORK-041
WORK-038 → WORK-041
```

## Edge Classes

### Implemented / prerequisite edges

All edges through WORK-022 are historical/current implementation-state evidence in the main graph. They are not rewritten by the V6 architecture package.

### Planned edges

All V6 edges above became implementation dependencies when WORK-024 froze V6. Items are released (`READY`) only per the Eligibility Rule below, one dependency-eligible item at a time.

### Optional edges

```text
WORK-038 (federation research) is not a prerequisite for local IAAS operation.
Marketplace/SDK consumers are optional product surfaces for deployments that do not need them.
Concrete Transform/Extension implementations are optional workload artifacts.
```

### Forbidden dependency classes

No Work Item may make any of these edges necessary:

```text
vertical → generic kernel
EconomicPipeline ↔ DataPlane
Marketplace → ExtensionRuntime execution
SDK → private implementation semantics
NetworkDefinition → concrete vendor
NetworkComposition → private runtime state
Forecast → Commitment without AllocationDecision
Telemetry → Attestation without Verification
```

## Eligibility Rule

A candidate Work Item is `READY` only after:

1. its governing architecture is FROZEN;
2. all dependency Work Items are `VERIFIED`;
3. its Work Order is complete;
4. no open ACR blocks its scope;
5. objective verification requirements are defined.

V6 is FROZEN. WORK-025 is the sole `READY` item (released by WORK-024); WORK-026 through WORK-041 remain `DRAFT` until their dependencies are `VERIFIED`. No production implementation Work Item may be assigned or opened except a released (`READY`) item.
