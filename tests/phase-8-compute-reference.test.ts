/**
 * Phase 8: Compute Reference Network — Behavioral Tests
 *
 * These tests prove the architecture is a Network Operating System, not a
 * well-factored VPP application. The SAME InfrastructureRuntime, AdapterRegistry,
 * Execution, and economic pipeline that serves energy-vpp serves compute —
 * with zero kernel modifications.
 *
 * The proof:
 *   Compute Network
 *        ↓
 *   NetworkVersion(runtimeKind=infrastructure)
 *        ↓
 *   InfrastructureRuntime (unchanged from Phase 7)
 *        ↓
 *   AdapterRegistry (unchanged from Phase 7)
 *        ↓
 *   ComputeAdapter (new, but uses the SAME interface as DERAdapter)
 *        ↓
 *   Execution → Contribution → Reward → Settlement (unchanged generic pipeline)
 *
 * Critically:
 *   - No VPP-specific kernel changes
 *   - No compute-specific economic primitives
 *   - No modifications to InfrastructureRuntime for compute
 *
 * Run: bun test tests/phase-8-compute-reference.test.ts --timeout 30000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { initializeBootstrap } from '../src/lib/bootstrap'
import { adapterRegistry, resolveAdapter } from '../src/lib/kernel/runtime'
import { InfrastructureRuntime } from '../src/lib/kernel/runtime/infrastructure-runtime'
import { AdapterRegistry } from '../src/lib/kernel/runtime/adapter-registry'
import { SimulatedComputeAdapter } from '../src/lib/services/compute-adapter.service'
import { getTemplate } from '../src/lib/domain/templates'

// Initialize the bootstrap before tests — this registers both the DER adapter
// and the compute adapter in the global AdapterRegistry.
beforeAll(() => {
  initializeBootstrap()
})

// ---------------------------------------------------------------------------
// Test 1: The compute-gpu-network template exists and is correctly configured
// ---------------------------------------------------------------------------

describe('Phase 8: compute-gpu-network template', () => {
  it('the compute-gpu-network template exists', () => {
    const template = getTemplate('compute-gpu-network')
    expect(template).toBeDefined()
    expect(template!.vertical).toBe('compute')
    expect(template!.runtimeKind ?? 'infrastructure').toBe('infrastructure')
  })

  it('compute-gpu-network has compute asset types and gpu_compute capability', () => {
    const template = getTemplate('compute-gpu-network')!
    expect(template.asset_types).toContain('compute_node')
    expect(template.asset_types).toContain('gpu_cluster')
    expect(template.capabilities.map(c => c.type)).toContain('gpu_compute')
  })

  it('compute-gpu-network uses the generic verification + reward pipeline', () => {
    const template = getTemplate('compute-gpu-network')!
    // Same verification checks as energy-vpp (generic pipeline).
    expect(template.verification.checks).toContain('device_signature')
    expect(template.verification.checks).toContain('schema_validation')
    // Fixed-rate reward (same economic primitive as energy-vpp).
    expect(template.reward.type).toBe('fixed_rate')
    expect(template.reward.unit).toBe('GPU-hours')
  })

  it('Phase 8B: reward unit matches capability unit (no mismatch)', () => {
    const gpuTemplate = getTemplate('compute-gpu-network')!
    const cpuTemplate = getTemplate('compute-cpu-network')!

    // GPU: capability unit = GPU-hours, reward unit = GPU-hours ✅
    expect(gpuTemplate.capabilities[0].unit).toBe(gpuTemplate.reward.unit)

    // CPU: capability unit = CPU-hours, reward unit = CPU-hours ✅
    expect(cpuTemplate.capabilities[0].unit).toBe(cpuTemplate.reward.unit)
  })
})

// ---------------------------------------------------------------------------
// Test 2: The compute adapter is registered and resolvable
// ---------------------------------------------------------------------------

describe('Phase 8: compute adapter registration', () => {
  it('the compute adapter is registered for compute asset types', () => {
    expect(adapterRegistry.has('compute_node')).toBe(true)
    expect(adapterRegistry.has('gpu_cluster')).toBe(true)
  })

  it('resolveAdapter returns the compute adapter for compute_node', () => {
    const adapter = resolveAdapter('compute_node')
    expect(adapter.adapterType).toBe('simulated_compute')
  })

  it('resolveAdapter returns the compute adapter for gpu_cluster', () => {
    const adapter = resolveAdapter('gpu_cluster')
    expect(adapter.adapterType).toBe('simulated_compute')
  })

  it('the compute adapter advertises compute capabilities', () => {
    const adapters = adapterRegistry.listAdapters()
    const compute = adapters.find(a => a.adapterType === 'simulated_compute')
    expect(compute).toBeDefined()
    expect(compute!.supportedCapabilities).toContain('gpu_compute')
    expect(compute!.supportedCapabilities).toContain('cpu_compute')
  })
})

// ---------------------------------------------------------------------------
// Test 3: Compute execution via the REAL InfrastructureRuntime
// ---------------------------------------------------------------------------

describe('Phase 8: compute execution via InfrastructureRuntime', () => {
  it('InfrastructureRuntime executes a GPU compute job and returns telemetry', async () => {
    // Use the REAL InfrastructureRuntime with the global registry (which has
    // the compute adapter registered via bootstrap).
    const runtime = new InfrastructureRuntime(adapterRegistry)

    const result = await runtime.executeAssignment({
      assetId: 'compute-node-1',
      assetType: 'compute_node',
      capabilityType: 'gpu_compute',
      assignedQuantity: '10', // 10 GPU-hours
      assignedUnit: 'GPU-hours',
      durationSeconds: 3600,
      parameters: { gpuCount: 4 },
    })

    expect(result.success).toBe(true)
    // 95% efficiency → 9.5 GPU-hours
    expect(parseFloat(result.actualQuantity)).toBeCloseTo(9.5, 1)
    expect(result.actualUnit).toBe('GPU-hours')
    // Telemetry has compute-specific fields.
    expect(result.telemetryPayload.gpu_count).toBe(4)
    expect(result.telemetryPayload.gpu_utilization_pct).toBe(95)
    expect(result.telemetryPayload.memory_gb).toBe(64) // 4 GPUs × 16 GB
  })

  it('InfrastructureRuntime executes a CPU compute job and returns telemetry', async () => {
    const runtime = new InfrastructureRuntime(adapterRegistry)

    const result = await runtime.executeAssignment({
      assetId: 'compute-node-2',
      assetType: 'compute_node',
      capabilityType: 'cpu_compute',
      assignedQuantity: '20', // 20 CPU-hours
      assignedUnit: 'CPU-hours',
      durationSeconds: 3600,
      parameters: { cpuCores: 8 },
    })

    expect(result.success).toBe(true)
    expect(parseFloat(result.actualQuantity)).toBeCloseTo(19, 0) // 95% of 20
    expect(result.telemetryPayload.cpu_cores).toBe(8)
    expect(result.telemetryPayload.cpu_utilization_pct).toBe(95)
    expect(result.telemetryPayload.memory_gb).toBe(32) // 8 cores × 4 GB
  })

  it('compute adapter resolves by explicit adapterType', async () => {
    const runtime = new InfrastructureRuntime(adapterRegistry)

    const result = await runtime.executeAssignment({
      assetId: 'gpu-cluster-1',
      assetType: 'gpu_cluster',
      adapterType: 'simulated_compute', // explicit selection
      capabilityType: 'gpu_compute',
      assignedQuantity: '100',
      assignedUnit: 'GPU-hours',
      durationSeconds: 3600,
      parameters: { gpuCount: 8 },
    })

    expect(result.success).toBe(true)
    expect(result.telemetryPayload.gpu_count).toBe(8)
  })

  it('capability mismatch throws (gpu_compute not supported by DER adapter)', async () => {
    // battery → simulated_der (supports energy_discharge, NOT gpu_compute)
    const runtime = new InfrastructureRuntime(adapterRegistry)

    await expect(
      runtime.executeAssignment({
        assetId: 'battery-1',
        assetType: 'battery',
        capabilityType: 'gpu_compute', // NOT supported by DER adapter
        assignedQuantity: '10',
        assignedUnit: 'GPU-hours',
        durationSeconds: 3600,
      }),
    ).rejects.toThrow(/does not support capability/)
  })
})

// ---------------------------------------------------------------------------
// Test 4: Isolated compute execution (fresh registry, no global state)
// ---------------------------------------------------------------------------

describe('Phase 8: isolated compute execution', () => {
  it('a fresh registry + compute adapter + InfrastructureRuntime works end-to-end', async () => {
    // Create a completely isolated registry + runtime — no global state.
    const reg = new AdapterRegistry()
    reg.register({
      adapter: new SimulatedComputeAdapter(),
      supportedAssetTypes: ['compute_node', 'gpu_cluster'],
      supportedCapabilities: ['gpu_compute', 'cpu_compute'],
    })
    const runtime = new InfrastructureRuntime(reg)

    // Execute a GPU job.
    const result = await runtime.executeAssignment({
      assetId: 'isolated-gpu-1',
      assetType: 'gpu_cluster',
      capabilityType: 'gpu_compute',
      assignedQuantity: '50',
      assignedUnit: 'GPU-hours',
      durationSeconds: 1800,
      parameters: { gpuCount: 2 },
    })

    expect(result.success).toBe(true)
    expect(parseFloat(result.actualQuantity)).toBeCloseTo(47.5, 1) // 95% of 50
    expect(result.telemetryPayload.gpu_count).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Test 5: The kernel was NOT modified for compute
// ---------------------------------------------------------------------------

describe('Phase 8: kernel unchanged for compute', () => {
  it('InfrastructureRuntime source does NOT mention compute, gpu, or cpu', () => {
    // This is a structural proof: the InfrastructureRuntime source file must
    // NOT contain compute-specific terms. The runtime is generic — it resolves
    // adapters by asset type without knowing what compute, gpu, or cpu means.
    const runtimePath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'infrastructure-runtime.ts')
    const content = readFileSync(runtimePath, 'utf-8')

    // The runtime must NOT mention compute-specific terms.
    expect(content).not.toMatch(/compute_node/)
    expect(content).not.toMatch(/gpu_cluster/)
    expect(content).not.toMatch(/gpu_compute/)
    expect(content).not.toMatch(/cpu_compute/)
    expect(content).not.toMatch(/GPU-hours/)
  })

  it('AdapterRegistry source does NOT mention compute, gpu, or cpu', () => {
    const registryPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'adapter-registry.ts')
    const content = readFileSync(registryPath, 'utf-8')

    expect(content).not.toMatch(/compute_node/)
    expect(content).not.toMatch(/gpu_cluster/)
    expect(content).not.toMatch(/gpu_compute/)
    expect(content).not.toMatch(/cpu_compute/)
  })

  it('the compute adapter uses the SAME InfrastructureAdapter interface as DER', () => {
    // Both SimulatedDERAdapter and SimulatedComputeAdapter implement the
    // same generic InfrastructureAdapter interface. The compute adapter
    // does NOT define a new interface or extend the kernel contract.
    const computeAdapterPath = join(process.cwd(), 'src', 'lib', 'services', 'compute-adapter.service.ts')
    const content = readFileSync(computeAdapterPath, 'utf-8')

    expect(content).toMatch(/class SimulatedComputeAdapter implements InfrastructureAdapter/)
    expect(content).toMatch(/from .@\/lib\/kernel\/adapters\/infrastructure-adapter./)
  })
})
