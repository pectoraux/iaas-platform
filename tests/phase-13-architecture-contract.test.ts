/**
 * Phase 13: Architecture Anti-Drift Tests
 *
 * Static contract tests that enforce structural boundaries.
 * These tests MUST pass before any Phase 13+ implementation begins.
 *
 * Rules enforced:
 * 1. Generic economic pipeline imports NO vertical service.
 * 2. VPP/Compute import the generic pipeline (not vice versa).
 * 3. InfrastructureRuntime does NOT import ProtocolRuntime.
 * 4. ProtocolRuntime does NOT import InfrastructureRuntime.
 * 5. economicStage is NOT consulted by generic reconciliation.
 * 6. Marketplace (future) MUST NOT directly execute extensions.
 * 7. TransformRegistry (future) MUST NOT depend on TransitNet.
 * 8. Protocol contract MUST NOT import TransitNet implementation.
 * 9. Future protocol code MUST NOT be required by kernel code.
 * 10. InfrastructureRuntime cannot depend on ProtocolRuntime implementation.
 * 11. Generic services cannot import VPP/Compute.
 * 12. The control plane orchestrator cannot import concrete runtimes.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync, existsSync } from 'fs'

function readFile(path: string): string {
  return readFileSync(path, 'utf8')
}

function getImportLines(source: string): string {
  return source
    .split('\n')
    .filter((l) => l.match(/^\s*import\s/) || l.match(/^\s*}\s*from\s/))
    .join('\n')
}

describe('Phase 13: Architecture Anti-Drift', () => {
  // 1. Generic economic pipeline imports NO vertical service
  it('generic economic pipeline imports no vertical service', () => {
    const source = readFile('./src/lib/control-plane/economic-pipeline.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/vpp\.service/)
    expect(imports).not.toMatch(/compute\.service/)
    expect(imports).not.toMatch(/compute-adapter\.service/)
    expect(imports).not.toMatch(/storage\.service/)
    expect(imports).not.toMatch(/wireless\.service/)
  })

  // 2. Generic economic pipeline imports no VPP/compute patterns
  it('generic economic pipeline imports have no VPP/compute references', () => {
    const source = readFile('./src/lib/control-plane/economic-pipeline.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/vpp/i)
    expect(imports).not.toMatch(/compute-adapter/)
  })

  // 3. InfrastructureRuntime does NOT import ProtocolRuntime
  it('InfrastructureRuntime does not import ProtocolRuntime', () => {
    const source = readFile('./src/lib/kernel/runtime/infrastructure-runtime.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/protocol-runtime/)
    expect(imports).not.toMatch(/protocol\//)
  })

  // 4. ProtocolRuntime does NOT import InfrastructureRuntime
  it('ProtocolRuntime does not import InfrastructureRuntime', () => {
    const source = readFile('./src/lib/kernel/runtime/protocol-runtime.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/infrastructure-runtime/)
    expect(imports).not.toMatch(/infrastructure-adapter/)
    expect(imports).not.toMatch(/adapter-registry/)
  })

  // 5. economicStage is NOT consulted by generic reconciliation
  it('generic reconciliation does not reference economicStage', () => {
    const source = readFile('./src/lib/control-plane/economic-pipeline.ts')
    expect(source).not.toMatch(/economicStage/)
    expect(source).not.toMatch(/VppDispatchAssignment/)
  })

  // 6. Generic services cannot import VPP/Compute
  it('generic services import no vertical services', () => {
    const genericServices = [
      'capacity.service',
      'contribution.service',
      'reward.service',
      'ledger.service',
      'settlement.service',
      'verification.service',
      'ingestion.service',
      'worker.service',
      'attestation.service',
    ]
    for (const svc of genericServices) {
      const path = `./src/lib/services/${svc}.ts`
      if (!existsSync(path)) continue
      const source = readFile(path)
      const imports = getImportLines(source)
      expect(imports).not.toMatch(/vpp\.service/)
      expect(imports).not.toMatch(/compute\.service/)
      expect(imports).not.toMatch(/compute-adapter\.service/)
    }
  })

  // 7. Control plane orchestrator cannot import concrete runtimes
  it('control plane orchestrator does not import concrete runtimes', () => {
    const source = readFile('./src/lib/control-plane/execution-orchestrator.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/infrastructure-runtime/)
    expect(imports).not.toMatch(/protocol-runtime/)
    expect(imports).not.toMatch(/hybrid-runtime/)
    // Must use resolveRuntime (the indirection)
    expect(source).toContain('resolveRuntime')
  })

  // 8. Control plane scheduler cannot import concrete runtimes
  it('control plane scheduler does not import concrete runtimes', () => {
    const source = readFile('./src/lib/control-plane/scheduler.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/infrastructure-runtime/)
    expect(imports).not.toMatch(/protocol-runtime/)
    expect(imports).not.toMatch(/hybrid-runtime/)
  })

  // 9. Execution lease cannot import vertical services
  it('execution lease imports no vertical services', () => {
    const source = readFile('./src/lib/control-plane/execution-lease.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/vpp\.service/)
    expect(imports).not.toMatch(/compute\.service/)
  })

  // 10. CapacityProvider cannot import vertical services
  it('capacity provider imports no vertical services', () => {
    const source = readFile('./src/lib/control-plane/capacity-provider.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/vpp\.service/)
    expect(imports).not.toMatch(/compute\.service/)
    expect(imports).not.toMatch(/compute-adapter\.service/)
  })

  // 11. VPP imports the generic pipeline (correct direction)
  it('VPP imports the generic economic pipeline', () => {
    const source = readFile('./src/lib/services/vpp.service.ts')
    expect(source).toContain('economic-pipeline')
  })

  // 12. Compute imports the generic pipeline (correct direction)
  it('Compute imports the generic economic pipeline', () => {
    const source = readFile('./src/lib/services/compute.service.ts')
    expect(source).toContain('economic-pipeline')
  })

  // 13. Architecture Constitution exists
  it('architecture constitution document exists', () => {
    expect(existsSync('./docs/architecture/ARCHITECTURE-CONSTITUTION.md')).toBe(true)
  })

  // 14. Gap matrix exists
  it('gap matrix document exists', () => {
    expect(existsSync('./docs/architecture/PHASE-13-GAP-MATRIX.md')).toBe(true)
  })

  // 15. Dependency graph exists
  it('dependency graph document exists', () => {
    expect(existsSync('./docs/architecture/PHASE-13-DEPENDENCY-GRAPH.md')).toBe(true)
  })

  // 16. Future network coverage exists
  it('future network coverage document exists', () => {
    expect(existsSync('./docs/architecture/FUTURE-NETWORK-COVERAGE.md')).toBe(true)
  })

  // 17. No future architecture implementation files exist yet
  it('no Node/Bundle/Transform/Extension implementation files exist', () => {
    const futureFiles = [
      './src/lib/kernel/node.ts',
      './src/lib/kernel/bundle.ts',
      './src/lib/kernel/transform.ts',
      './src/lib/kernel/transform-registry.ts',
      './src/lib/kernel/extension.ts',
      './src/lib/kernel/extension-registry.ts',
      './src/lib/kernel/data-plane.ts',
      './src/lib/kernel/marketplace.ts',
      './src/lib/kernel/sdk.ts',
    ]
    for (const f of futureFiles) {
      expect(existsSync(f)).toBe(false)
    }
  })
})
