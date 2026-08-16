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
import { describe, it, expect } from 'bun:test'
import {
  resolveRuntime,
  runtimeRegistry,
  RUNTIME_KINDS,
  validateRuntimeKind,
  isRuntimeKind,
} from '../src/lib/kernel/runtime'
import { InfrastructureRuntime } from '../src/lib/kernel/runtime/infrastructure-runtime'
import { ProtocolRuntime } from '../src/lib/kernel/runtime/protocol-runtime'
import { HybridRuntime } from '../src/lib/kernel/runtime/hybrid-runtime'

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
    const runtime = new InfrastructureRuntime()
    expect(typeof runtime.createExecution).toBe('function')
    expect(typeof runtime.linkExecutionSource).toBe('function')
    expect(typeof runtime.createExecutionAssignment).toBe('function')
    expect(typeof runtime.beginAssignmentExecution).toBe('function')
    expect(typeof runtime.recordAssignmentResults).toBe('function')
    expect(typeof runtime.completeAssignment).toBe('function')
    expect(typeof runtime.failAssignment).toBe('function')
    expect(typeof runtime.finalizeIfTerminal).toBe('function')
  })
})
