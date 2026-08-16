/**
 * Phase 5: Runtime Resolution Tests
 *
 * These tests prove the runtime selection contract:
 *   - NetworkVersion(runtimeKind=infrastructure) → InfrastructureRuntime
 *   - NetworkVersion(runtimeKind=protocol) → ProtocolRuntime (stub)
 *   - NetworkVersion(runtimeKind=hybrid) → HybridRuntime (stub)
 *   - Unknown kind → throws (no silent fallback)
 *   - runtimeKind validation rejects invalid values
 *
 * These tests do NOT require a database — they test the kernel runtime
 * registry resolution, which is pure in-memory logic. The DB-backed tests
 * (in vpp-4-2-execution-invariants.test.ts) prove the InfrastructureRuntime
 * actually works against PostgreSQL.
 *
 * Run: bun test tests/runtime-resolution.test.ts --timeout 30000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
// Phase 6.3: Tests are their own composition root. They explicitly call
// initializeBootstrap() — importing the bootstrap module alone does NOT
// register adapters (no implicit side effects). This mirrors how the
// production application (instrumentation.ts) explicitly calls it.
import { initializeBootstrap } from '../src/lib/bootstrap'
import {
  resolveRuntime,
  runtimeRegistry,
  resolveAdapter,
  adapterRegistry,
  RUNTIME_KINDS,
  validateRuntimeKind,
  isRuntimeKind,
} from '../src/lib/kernel/runtime'
import { InfrastructureRuntime } from '../src/lib/kernel/runtime/infrastructure-runtime'
import { ProtocolRuntime } from '../src/lib/kernel/runtime/protocol-runtime'
import { HybridRuntime } from '../src/lib/kernel/runtime/hybrid-runtime'
import { AdapterRegistry } from '../src/lib/kernel/runtime/adapter-registry'
import type {
  InfrastructureAdapter,
  ExecuteCommand,
  ExecuteResult,
  AssetCapabilities,
  TelemetryReading,
  HealthStatus,
} from '../src/lib/kernel/adapters/infrastructure-adapter'

// Explicitly initialize the bootstrap before tests run.
// This is the test's composition root — same pattern as instrumentation.ts.
beforeAll(() => {
  initializeBootstrap()
})

// ---------------------------------------------------------------------------
// Test 1: Each runtimeKind resolves to the correct runtime implementation
// ---------------------------------------------------------------------------

describe('Phase 5: runtime resolution', () => {
  it('runtimeKind=infrastructure → InfrastructureRuntime', () => {
    const runtime = resolveRuntime('infrastructure')
    expect(runtime).toBeInstanceOf(InfrastructureRuntime)
    expect(runtime.kind).toBe('infrastructure')
  })

  it('runtimeKind=protocol → ProtocolRuntime', () => {
    const runtime = resolveRuntime('protocol')
    expect(runtime).toBeInstanceOf(ProtocolRuntime)
    expect(runtime.kind).toBe('protocol')
  })

  it('runtimeKind=hybrid → HybridRuntime', () => {
    const runtime = resolveRuntime('hybrid')
    expect(runtime).toBeInstanceOf(HybridRuntime)
    expect(runtime.kind).toBe('hybrid')
  })
})

// ---------------------------------------------------------------------------
// Test 2: Unknown/unregistered kind throws (no silent fallback)
// ---------------------------------------------------------------------------

describe('Phase 5: unknown runtimeKind is rejected', () => {
  it('resolveRuntime throws for an unregistered kind', () => {
    // 'serverless' is not a registered runtime kind.
    expect(() => resolveRuntime('serverless' as any)).toThrow(/No runtime registered/)
  })

  it('RuntimeRegistry.resolve throws for an unregistered kind', () => {
    expect(() => runtimeRegistry.resolve('edge' as any)).toThrow(/No runtime registered/)
  })
})

// ---------------------------------------------------------------------------
// Test 3: RuntimeKind validation
// ---------------------------------------------------------------------------

describe('Phase 5: runtimeKind validation', () => {
  it('RUNTIME_KINDS contains exactly infrastructure, protocol, hybrid', () => {
    expect(RUNTIME_KINDS).toEqual(['infrastructure', 'protocol', 'hybrid'])
  })

  it('isRuntimeKind returns true for valid kinds', () => {
    expect(isRuntimeKind('infrastructure')).toBe(true)
    expect(isRuntimeKind('protocol')).toBe(true)
    expect(isRuntimeKind('hybrid')).toBe(true)
  })

  it('isRuntimeKind returns false for invalid kinds', () => {
    expect(isRuntimeKind('serverless')).toBe(false)
    expect(isRuntimeKind('edge')).toBe(false)
    expect(isRuntimeKind('')).toBe(false)
    expect(isRuntimeKind('Infrastructure')).toBe(false) // case-sensitive
  })

  it('validateRuntimeKind does not throw for valid kinds', () => {
    expect(() => validateRuntimeKind('infrastructure')).not.toThrow()
    expect(() => validateRuntimeKind('protocol')).not.toThrow()
    expect(() => validateRuntimeKind('hybrid')).not.toThrow()
  })

  it('validateRuntimeKind throws for invalid kinds', () => {
    expect(() => validateRuntimeKind('serverless')).toThrow(/Invalid runtimeKind/)
    expect(() => validateRuntimeKind('')).toThrow(/Invalid runtimeKind/)
    expect(() => validateRuntimeKind('INFRASTRUCTURE')).toThrow(/Invalid runtimeKind/)
  })
})

// ---------------------------------------------------------------------------
// Test 4: Registry has exactly three runtimes registered
// ---------------------------------------------------------------------------

describe('Phase 5: registry completeness', () => {
  it('runtimeRegistry has exactly 3 registered kinds', () => {
    const kinds = runtimeRegistry.registeredKinds()
    expect(kinds.length).toBe(3)
    expect(kinds).toContain('infrastructure')
    expect(kinds).toContain('protocol')
    expect(kinds).toContain('hybrid')
  })

  it('runtimeRegistry.has returns true for registered kinds', () => {
    expect(runtimeRegistry.has('infrastructure')).toBe(true)
    expect(runtimeRegistry.has('protocol')).toBe(true)
    expect(runtimeRegistry.has('hybrid')).toBe(true)
  })

  it('runtimeRegistry.has returns false for unregistered kinds', () => {
    expect(runtimeRegistry.has('serverless' as any)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Test 5: Protocol/Hybrid runtimes throw NotImplemented for execution ops
// ---------------------------------------------------------------------------

describe('Phase 5: protocol and hybrid runtimes are stubs', () => {
  it('ProtocolRuntime.createExecution throws NotImplemented', async () => {
    const runtime = new ProtocolRuntime()
    // Pass a mock tx — the stub throws before touching it.
    const mockTx = {} as any
    await expect(
      runtime.createExecution(mockTx, {
        tenantId: 't1',
        networkId: 'n1',
        requestedQuantity: '10',
        requestedUnit: 'kWh',
        startTime: new Date(),
        endTime: new Date(),
        sourceType: 'test',
      }),
    ).rejects.toThrow(/not implemented/)
  })

  it('HybridRuntime.createExecution throws NotImplemented', async () => {
    const runtime = new HybridRuntime()
    const mockTx = {} as any
    await expect(
      runtime.createExecution(mockTx, {
        tenantId: 't1',
        networkId: 'n1',
        requestedQuantity: '10',
        requestedUnit: 'kWh',
        startTime: new Date(),
        endTime: new Date(),
        sourceType: 'test',
      }),
    ).rejects.toThrow(/not implemented/)
  })

  it('ProtocolRuntime.completeAssignment throws NotImplemented', async () => {
    const runtime = new ProtocolRuntime()
    const mockTx = {} as any
    await expect(
      runtime.completeAssignment(mockTx, 't1', 'a1', 'e1'),
    ).rejects.toThrow(/not implemented/)
  })

  it('HybridRuntime.failAssignment throws NotImplemented', async () => {
    const runtime = new HybridRuntime()
    const mockTx = {} as any
    await expect(
      runtime.failAssignment(mockTx, 't1', 'a1', 'e1'),
    ).rejects.toThrow(/not implemented/)
  })
})

// ---------------------------------------------------------------------------
// Test 6: InfrastructureRuntime implements the full NetworkRuntime contract
// ---------------------------------------------------------------------------

describe('Phase 5: InfrastructureRuntime contract completeness', () => {
  it('InfrastructureRuntime has all NetworkRuntime methods', () => {
    const runtime = new InfrastructureRuntime(adapterRegistry)
    expect(typeof runtime.createExecution).toBe('function')
    expect(typeof runtime.linkExecutionSource).toBe('function')
    expect(typeof runtime.createExecutionAssignment).toBe('function')
    expect(typeof runtime.beginAssignmentExecution).toBe('function')
    expect(typeof runtime.executeAssignment).toBe('function')
    expect(typeof runtime.recordAssignmentResults).toBe('function')
    expect(typeof runtime.linkContribution).toBe('function')
    expect(typeof runtime.completeAssignment).toBe('function')
    expect(typeof runtime.failAssignment).toBe('function')
    expect(typeof runtime.finalizeIfTerminal).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Test 7: Phase 6 — Adapter resolution
// ---------------------------------------------------------------------------

describe('Phase 6: adapter resolution', () => {
  it('resolveAdapter returns an adapter for energy asset types', () => {
    // The DER adapter is registered for battery, solar_inverter, ev_charger, smart_meter.
    for (const assetType of ['battery', 'solar_inverter', 'ev_charger', 'smart_meter']) {
      const adapter = resolveAdapter(assetType)
      expect(adapter).toBeDefined()
      expect(adapter.adapterType).toBe('simulated_der')
    }
  })

  it('resolveAdapter throws for unregistered asset types', () => {
    expect(() => resolveAdapter('compute_node')).toThrow(/No adapter registered/)
    expect(() => resolveAdapter('storage_node')).toThrow(/No adapter registered/)
    expect(() => resolveAdapter('')).toThrow(/No adapter registered/)
  })

  it('adapterRegistry has energy asset types registered', () => {
    const types = adapterRegistry.registeredAssetTypes()
    expect(types).toContain('battery')
    expect(types).toContain('solar_inverter')
    expect(types).toContain('ev_charger')
    expect(types).toContain('smart_meter')
  })

  it('InfrastructureRuntime.executeAssignment executes via the adapter', async () => {
    const runtime = new InfrastructureRuntime(adapterRegistry)
    const result = await runtime.executeAssignment({
      assetId: 'test-asset',
      assetType: 'battery',
      capabilityType: 'energy_discharge',
      assignedQuantity: '10',
      assignedUnit: 'kWh',
      durationSeconds: 3600,
      parameters: { assignedKw: '5' },
    })

    expect(result.success).toBe(true)
    expect(result.actualQuantity).toBeTruthy()
    expect(result.actualUnit).toBe('kWh')
    expect(result.telemetryPayload).toBeDefined()
    expect(result.telemetryPayload.power_kw).toBeDefined()
  })

  it('InfrastructureRuntime.executeAssignment throws for unregistered asset type', async () => {
    const runtime = new InfrastructureRuntime(adapterRegistry)
    await expect(
      runtime.executeAssignment({
        assetId: 'test-asset',
        assetType: 'compute_node',
        capabilityType: 'gpu_compute',
        assignedQuantity: '10',
        assignedUnit: 'GPU',
        durationSeconds: 3600,
      }),
    ).rejects.toThrow(/No adapter registered/)
  })
})

// ---------------------------------------------------------------------------
// Test 7b: Phase 7.2/7.3 — Runtime adapter selection (behavioral, real runtime)
// ---------------------------------------------------------------------------

// Phase 7.3: These tests use the REAL InfrastructureRuntime with an isolated
// AdapterRegistry instance — no test wrapper. This proves the actual runtime
// implementation correctly consumes the full selection contract.
//
// The InfrastructureRuntime accepts an AdapterRegistry in its constructor
// (dependency injection), so tests can create an isolated registry + runtime
// without polluting the global singleton.

// Helper: create a mock adapter with a specific adapterType.
function mockNamedAdapter(adapterType: string): InfrastructureAdapter {
  return {
    adapterType,
    async discover(): Promise<AssetCapabilities[]> { return [] },
    async getCapabilities(): Promise<AssetCapabilities> {
      return { assetId: 'x', capabilities: [], health: 'healthy' }
    },
    async readTelemetry(): Promise<TelemetryReading> {
      return { assetId: 'x', timestamp: new Date(), capabilityType: 'x', payload: {} }
    },
    async execute(cmd: ExecuteCommand): Promise<ExecuteResult> {
      return {
        assetId: cmd.assetId,
        actualQuantity: '5',
        actualUnit: 'unit',
        telemetry: { payload: { adapterType } },
        success: true,
      }
    },
    async health(): Promise<HealthStatus> {
      return { assetId: 'x', status: 'healthy' }
    },
  }
}

describe('Phase 7.3: runtime adapter selection (real InfrastructureRuntime)', () => {
  it('explicit adapterType resolves the correct adapter', async () => {
    // Create an isolated registry with two adapters for 'battery'.
    const reg = new AdapterRegistry()
    reg.register({ adapter: mockNamedAdapter('adapter_a'), supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })
    reg.register({ adapter: mockNamedAdapter('adapter_b'), supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })

    // Use the REAL InfrastructureRuntime with the isolated registry.
    const runtime = new InfrastructureRuntime(reg)

    // Explicit adapterType: adapter_a
    const resultA = await runtime.executeAssignment({
      assetId: 'asset-1',
      assetType: 'battery',
      adapterType: 'adapter_a',
      capabilityType: 'energy_discharge',
      assignedQuantity: '10',
      assignedUnit: 'kWh',
      durationSeconds: 3600,
    })
    expect(resultA.success).toBe(true)
    expect(resultA.telemetryPayload.adapterType).toBe('adapter_a')

    // Explicit adapterType: adapter_b
    const resultB = await runtime.executeAssignment({
      assetId: 'asset-1',
      assetType: 'battery',
      adapterType: 'adapter_b',
      capabilityType: 'energy_discharge',
      assignedQuantity: '10',
      assignedUnit: 'kWh',
      durationSeconds: 3600,
    })
    expect(resultB.success).toBe(true)
    expect(resultB.telemetryPayload.adapterType).toBe('adapter_b')
  })

  it('omitted adapterType resolves single adapter', async () => {
    const reg = new AdapterRegistry()
    reg.register({ adapter: mockNamedAdapter('only_adapter'), supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })

    // Real InfrastructureRuntime with isolated registry.
    const runtime = new InfrastructureRuntime(reg)

    const result = await runtime.executeAssignment({
      assetId: 'asset-1',
      assetType: 'battery',
      // adapterType omitted — single adapter, should resolve
      capabilityType: 'energy_discharge',
      assignedQuantity: '10',
      assignedUnit: 'kWh',
      durationSeconds: 3600,
    })
    expect(result.success).toBe(true)
    expect(result.telemetryPayload.adapterType).toBe('only_adapter')
  })

  it('omitted adapterType with multiple adapters throws (ambiguous)', async () => {
    const reg = new AdapterRegistry()
    reg.register({ adapter: mockNamedAdapter('adapter_a'), supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })
    reg.register({ adapter: mockNamedAdapter('adapter_b'), supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })

    // Real InfrastructureRuntime with isolated registry.
    const runtime = new InfrastructureRuntime(reg)

    await expect(
      runtime.executeAssignment({
        assetId: 'asset-1',
        assetType: 'battery',
        // adapterType omitted — multiple adapters, AMBIGUOUS
        capabilityType: 'energy_discharge',
        assignedQuantity: '10',
        assignedUnit: 'kWh',
        durationSeconds: 3600,
      }),
    ).rejects.toThrow(/Ambiguous/)
  })

  it('capability mismatch throws', async () => {
    const reg = new AdapterRegistry()
    reg.register({ adapter: mockNamedAdapter('energy_only'), supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })

    // Real InfrastructureRuntime with isolated registry.
    const runtime = new InfrastructureRuntime(reg)

    await expect(
      runtime.executeAssignment({
        assetId: 'asset-1',
        assetType: 'battery',
        capabilityType: 'frequency_response', // NOT supported by this adapter
        assignedQuantity: '10',
        assignedUnit: 'kW',
        durationSeconds: 3600,
      }),
    ).rejects.toThrow(/does not support capability/)
  })

  it('VPP-style execution (omitted adapterType, single energy adapter) works via global runtime', async () => {
    // The global adapterRegistry has 'simulated_der' registered for battery
    // (via beforeAll → initializeBootstrap). This proves VPP's current usage
    // (no adapterType) still works — the runtime resolves the single adapter.
    const runtime = new InfrastructureRuntime(adapterRegistry)
    const result = await runtime.executeAssignment({
      assetId: 'vpp-asset',
      assetType: 'battery',
      // adapterType omitted — VPP doesn't specify it
      capabilityType: 'energy_discharge',
      assignedQuantity: '10',
      assignedUnit: 'kWh',
      durationSeconds: 3600,
      parameters: { assignedKw: '5' },
    })
    expect(result.success).toBe(true)
    expect(result.actualQuantity).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Test 8: Phase 7 — AdapterRegistry hardening (behavioral)
// ---------------------------------------------------------------------------

// Helper: create a minimal mock adapter for testing.
function mockAdapter(adapterType: string, assetTypes: string[], capabilities: string[]): InfrastructureAdapter {
  return {
    adapterType,
    async discover() { return [] },
    async getCapabilities() { return { assetId: 'x', capabilities: [], health: 'healthy' } },
    async readTelemetry() { return { assetId: 'x', timestamp: new Date(), capabilityType: 'x', payload: {} } },
    async execute(cmd: ExecuteCommand): Promise<ExecuteResult> {
      return { assetId: cmd.assetId, actualQuantity: '1', actualUnit: 'unit', telemetry: { payload: {} }, success: true }
    },
    async health() { return { assetId: 'x', status: 'healthy' } },
  }
}

describe('Phase 7.1: atomic registration', () => {
  it('registerBatch is all-or-nothing — conflict leaves registry unchanged', () => {
    const reg = new AdapterRegistry()
    const adapterA = mockAdapter('adapter_a', ['battery', 'solar_inverter'], ['energy_discharge'])
    const adapterB = mockAdapter('adapter_b', ['battery'], ['energy_discharge']) // conflicts on 'battery'

    // Register A successfully.
    reg.register({ adapter: adapterA, supportedAssetTypes: ['battery', 'solar_inverter'], supportedCapabilities: ['energy_discharge'] })

    // Attempt to register B — conflicts on 'battery' (adapterType is different,
    // but we're testing batch atomicity with a duplicate adapterType).
    const adapterB2 = mockAdapter('adapter_a', ['ev_charger'], ['energy_discharge']) // same adapterType as A

    expect(() => {
      reg.registerBatch([
        { adapter: adapterB, supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] },
        { adapter: adapterB2, supportedAssetTypes: ['ev_charger'], supportedCapabilities: ['energy_discharge'] },
      ])
    }).toThrow(/already registered/)

    // Registry is unchanged — B was not committed.
    expect(reg.hasAdapter('adapter_b')).toBe(false)
    // A is still there.
    expect(reg.hasAdapter('adapter_a')).toBe(true)
    // solar_inverter still resolves to A.
    const resolved = reg.resolve({ assetType: 'solar_inverter' })
    expect(resolved.adapterType).toBe('adapter_a')
  })

  it('register with empty supportedAssetTypes throws', () => {
    const reg = new AdapterRegistry()
    const adapter = mockAdapter('test', [], [])
    expect(() => {
      reg.register({ adapter, supportedAssetTypes: [], supportedCapabilities: [] })
    }).toThrow(/supportedAssetTypes is empty/)
  })

  it('register with empty adapterType throws', () => {
    const reg = new AdapterRegistry()
    const adapter = mockAdapter('', ['battery'], ['energy_discharge'])
    expect(() => {
      reg.register({ adapter, supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })
    }).toThrow(/adapterType is empty/)
  })

  it('register with empty string in supportedAssetTypes throws', () => {
    const reg = new AdapterRegistry()
    const adapter = mockAdapter('test', ['battery', ''], ['energy_discharge'])
    expect(() => {
      reg.register({ adapter, supportedAssetTypes: ['battery', ''], supportedCapabilities: ['energy_discharge'] })
    }).toThrow(/empty string/)
  })

  // Phase 7.1 regression: the batch must validate ALL descriptors before
  // committing ANY. A later descriptor with an empty adapterType or empty
  // supportedAssetType must leave the registry completely unchanged —
  // the first (valid) descriptor must NOT be committed.
  it('registerBatch with later empty adapterType leaves registry unchanged (regression)', () => {
    const reg = new AdapterRegistry()
    const validAdapter = mockAdapter('valid_adapter', ['battery'], ['energy_discharge'])
    const badAdapter = mockAdapter('', ['solar_inverter'], ['energy_discharge']) // empty adapterType

    expect(() => {
      reg.registerBatch([
        { adapter: validAdapter, supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] },
        { adapter: badAdapter, supportedAssetTypes: ['solar_inverter'], supportedCapabilities: ['energy_discharge'] },
      ])
    }).toThrow(/adapterType is empty/)

    // CRITICAL: the valid adapter was NOT committed — the registry is unchanged.
    expect(reg.hasAdapter('valid_adapter')).toBe(false)
    expect(reg.has('battery')).toBe(false)
    expect(reg.registeredAdapterTypes().length).toBe(0)
    expect(reg.registeredAssetTypes().length).toBe(0)
  })

  it('registerBatch with later empty supportedAssetType string leaves registry unchanged (regression)', () => {
    const reg = new AdapterRegistry()
    const validAdapter = mockAdapter('valid_adapter', ['battery'], ['energy_discharge'])
    const badAdapter = mockAdapter('bad_adapter', ['solar_inverter', ''], ['energy_discharge']) // empty string in asset types

    expect(() => {
      reg.registerBatch([
        { adapter: validAdapter, supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] },
        { adapter: badAdapter, supportedAssetTypes: ['solar_inverter', ''], supportedCapabilities: ['energy_discharge'] },
      ])
    }).toThrow(/empty string/)

    // CRITICAL: the valid adapter was NOT committed — the registry is unchanged.
    expect(reg.hasAdapter('valid_adapter')).toBe(false)
    expect(reg.hasAdapter('bad_adapter')).toBe(false)
    expect(reg.has('battery')).toBe(false)
    expect(reg.registeredAdapterTypes().length).toBe(0)
  })

  it('registerBatch with later empty supportedAssetTypes array leaves registry unchanged (regression)', () => {
    const reg = new AdapterRegistry()
    const validAdapter = mockAdapter('valid_adapter', ['battery'], ['energy_discharge'])
    const badAdapter = mockAdapter('bad_adapter', [], ['energy_discharge']) // empty array

    expect(() => {
      reg.registerBatch([
        { adapter: validAdapter, supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] },
        { adapter: badAdapter, supportedAssetTypes: [], supportedCapabilities: ['energy_discharge'] },
      ])
    }).toThrow(/supportedAssetTypes is empty/)

    // CRITICAL: the valid adapter was NOT committed — the registry is unchanged.
    expect(reg.hasAdapter('valid_adapter')).toBe(false)
    expect(reg.has('battery')).toBe(false)
  })
})

describe('Phase 7.2: explicit adapter identity', () => {
  it('duplicate adapterType is rejected', () => {
    const reg = new AdapterRegistry()
    const adapter1 = mockAdapter('tesla_powerwall', ['battery'], ['energy_discharge'])
    const adapter2 = mockAdapter('tesla_powerwall', ['battery'], ['energy_discharge'])

    reg.register({ adapter: adapter1, supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })
    expect(() => {
      reg.register({ adapter: adapter2, supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })
    }).toThrow(/already registered/)
  })

  it('hasAdapter checks adapterType existence', () => {
    const reg = new AdapterRegistry()
    const adapter = mockAdapter('tesla_powerwall', ['battery'], ['energy_discharge'])
    reg.register({ adapter, supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })

    expect(reg.hasAdapter('tesla_powerwall')).toBe(true)
    expect(reg.hasAdapter('enphase_battery')).toBe(false)
  })
})

describe('Phase 7.3: deterministic selection', () => {
  it('resolve by assetType alone works when single adapter', () => {
    const reg = new AdapterRegistry()
    const adapter = mockAdapter('simulated_der', ['battery'], ['energy_discharge'])
    reg.register({ adapter, supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })

    const resolved = reg.resolve({ assetType: 'battery' })
    expect(resolved.adapterType).toBe('simulated_der')
  })

  it('resolve by assetType + adapterType is deterministic', () => {
    const reg = new AdapterRegistry()
    const adapter1 = mockAdapter('simulated_der', ['battery'], ['energy_discharge'])
    const adapter2 = mockAdapter('tesla_powerwall', ['battery'], ['energy_discharge'])
    reg.register({ adapter: adapter1, supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })
    reg.register({ adapter: adapter2, supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })

    const resolved1 = reg.resolve({ assetType: 'battery', adapterType: 'simulated_der' })
    expect(resolved1.adapterType).toBe('simulated_der')

    const resolved2 = reg.resolve({ assetType: 'battery', adapterType: 'tesla_powerwall' })
    expect(resolved2.adapterType).toBe('tesla_powerwall')
  })

  it('ambiguous resolution (multiple adapters, no adapterType) throws', () => {
    const reg = new AdapterRegistry()
    const adapter1 = mockAdapter('simulated_der', ['battery'], ['energy_discharge'])
    const adapter2 = mockAdapter('tesla_powerwall', ['battery'], ['energy_discharge'])
    reg.register({ adapter: adapter1, supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })
    reg.register({ adapter: adapter2, supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })

    expect(() => {
      reg.resolve({ assetType: 'battery' })
    }).toThrow(/Ambiguous/)
  })

  it('unknown adapterType throws', () => {
    const reg = new AdapterRegistry()
    const adapter = mockAdapter('simulated_der', ['battery'], ['energy_discharge'])
    reg.register({ adapter, supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })

    expect(() => {
      reg.resolve({ assetType: 'battery', adapterType: 'nonexistent' })
    }).toThrow(/does not support asset type/)
  })

  it('unknown assetType throws', () => {
    const reg = new AdapterRegistry()
    expect(() => {
      reg.resolve({ assetType: 'nonexistent' })
    }).toThrow(/No adapter registered/)
  })

  it('capability check — adapter must support requested capability', () => {
    const reg = new AdapterRegistry()
    const adapter = mockAdapter('simulated_der', ['battery'], ['energy_discharge'])
    reg.register({ adapter, supportedAssetTypes: ['battery'], supportedCapabilities: ['energy_discharge'] })

    // Supported capability works.
    const resolved = reg.resolve({ assetType: 'battery', capabilityType: 'energy_discharge' })
    expect(resolved.adapterType).toBe('simulated_der')

    // Unsupported capability throws.
    expect(() => {
      reg.resolve({ assetType: 'battery', capabilityType: 'frequency_response' })
    }).toThrow(/does not support capability/)
  })
})

describe('Phase 7.4: capability-aware queries', () => {
  it('findAdaptersForCapability returns matching adapterTypes', () => {
    const reg = new AdapterRegistry()
    reg.register({
      adapter: mockAdapter('simulated_der', ['battery', 'solar_inverter'], ['energy_discharge', 'frequency_response']),
      supportedAssetTypes: ['battery', 'solar_inverter'],
      supportedCapabilities: ['energy_discharge', 'frequency_response'],
    })
    reg.register({
      adapter: mockAdapter('tesla_powerwall', ['battery'], ['energy_discharge']),
      supportedAssetTypes: ['battery'],
      supportedCapabilities: ['energy_discharge'],
    })

    // Both adapters support energy_discharge on battery.
    const energyAdapters = reg.findAdaptersForCapability('battery', 'energy_discharge')
    expect(energyAdapters.sort()).toEqual(['simulated_der', 'tesla_powerwall'])

    // Only simulated_der supports frequency_response on battery.
    const freqAdapters = reg.findAdaptersForCapability('battery', 'frequency_response')
    expect(freqAdapters).toEqual(['simulated_der'])

    // No adapter supports this capability on solar_inverter.
    const none = reg.findAdaptersForCapability('solar_inverter', 'frequency_response')
    expect(none).toEqual(['simulated_der']) // simulated_der supports it on solar_inverter too
  })

  it('findAdaptersForCapability returns empty for unknown asset type', () => {
    const reg = new AdapterRegistry()
    expect(reg.findAdaptersForCapability('nonexistent', 'energy_discharge')).toEqual([])
  })
})

describe('Phase 7.5: immutable state inspection', () => {
  it('listAdapters returns metadata, not adapter instances', () => {
    const reg = new AdapterRegistry()
    reg.register({
      adapter: mockAdapter('simulated_der', ['battery'], ['energy_discharge']),
      supportedAssetTypes: ['battery'],
      supportedCapabilities: ['energy_discharge'],
    })

    const list = reg.listAdapters()
    expect(list.length).toBe(1)
    expect(list[0].adapterType).toBe('simulated_der')
    expect(list[0].supportedAssetTypes).toContain('battery')
    expect(list[0].supportedCapabilities).toContain('energy_discharge')
    // AdapterInfo does NOT have an `adapter` property.
    expect((list[0] as any).adapter).toBeUndefined()
  })

  it('registeredAdapterTypes returns all adapter types', () => {
    const reg = new AdapterRegistry()
    reg.register({
      adapter: mockAdapter('simulated_der', ['battery'], ['energy_discharge']),
      supportedAssetTypes: ['battery'],
      supportedCapabilities: ['energy_discharge'],
    })
    reg.register({
      adapter: mockAdapter('tesla_powerwall', ['battery'], ['energy_discharge']),
      supportedAssetTypes: ['battery'],
      supportedCapabilities: ['energy_discharge'],
    })

    const types = reg.registeredAdapterTypes()
    expect(types.sort()).toEqual(['simulated_der', 'tesla_powerwall'])
  })

  it('adaptersForAssetType returns adapter types for an asset type', () => {
    const reg = new AdapterRegistry()
    reg.register({
      adapter: mockAdapter('simulated_der', ['battery'], ['energy_discharge']),
      supportedAssetTypes: ['battery'],
      supportedCapabilities: ['energy_discharge'],
    })
    reg.register({
      adapter: mockAdapter('tesla_powerwall', ['battery'], ['energy_discharge']),
      supportedAssetTypes: ['battery'],
      supportedCapabilities: ['energy_discharge'],
    })

    const adapters = reg.adaptersForAssetType('battery')
    expect(adapters.sort()).toEqual(['simulated_der', 'tesla_powerwall'])
    expect(reg.adaptersForAssetType('nonexistent')).toEqual([])
  })
})
