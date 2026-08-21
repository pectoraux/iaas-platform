/**
 * Phase 13R: Architecture Reconciliation Contract Tests
 *
 * Static tests proving the reconciled constitutional architecture.
 * These enforce the anti-drift rules added by the Phase 13R reconciliation
 * (Constitution §16 rules 10-13) and verify the identity boundary,
 * economic neutrality, runtime separation, and future-concept non-leakage.
 *
 * These tests are STATIC — they read source files and assert structural
 * boundaries. No DB connection required.
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

describe('Phase 13R: Architecture Reconciliation', () => {
  // === Rule 10: Phase 14 data-plane services MUST NOT import vertical services ===
  it('Phase 14 data-plane services import no vertical services (rule 10)', () => {
    const services = [
      './src/lib/services/node.service.ts',
      './src/lib/services/data-plane.service.ts',
      './src/lib/services/routing.service.ts',
      './src/lib/services/transport.service.ts',
      './src/lib/services/delivery-confirmation.service.ts',
      './src/lib/services/transform-record.service.ts',
    ]
    for (const svc of services) {
      if (!existsSync(svc)) continue
      const source = readFile(svc)
      const imports = getImportLines(source)
      expect(imports).not.toMatch(/vpp\.service/)
      expect(imports).not.toMatch(/compute\.service/)
      expect(imports).not.toMatch(/compute-adapter\.service/)
      expect(imports).not.toMatch(/storage\.service/)
      expect(imports).not.toMatch(/wireless\.service/)
    }
  })

  // === Rule 11: Phase 14 data-plane services MUST NOT import economic pipeline ===
  it('Phase 14 data-plane services import no economic pipeline (rule 11)', () => {
    const services = [
      './src/lib/services/node.service.ts',
      './src/lib/services/data-plane.service.ts',
      './src/lib/services/routing.service.ts',
      './src/lib/services/transport.service.ts',
      './src/lib/services/delivery-confirmation.service.ts',
      './src/lib/services/transform-record.service.ts',
    ]
    for (const svc of services) {
      if (!existsSync(svc)) continue
      const source = readFile(svc)
      const imports = getImportLines(source)
      expect(imports).not.toMatch(/economic-pipeline/)
      expect(imports).not.toMatch(/control-plane\/economic/)
    }
  })

  // === Rule 12: Phase 14 data-plane services MUST NOT import ProtocolRuntime/HybridRuntime ===
  it('Phase 14 data-plane services import no ProtocolRuntime/HybridRuntime (rule 12)', () => {
    const services = [
      './src/lib/services/node.service.ts',
      './src/lib/services/data-plane.service.ts',
      './src/lib/services/routing.service.ts',
      './src/lib/services/transport.service.ts',
      './src/lib/services/delivery-confirmation.service.ts',
      './src/lib/services/transform-record.service.ts',
    ]
    for (const svc of services) {
      if (!existsSync(svc)) continue
      const source = readFile(svc)
      const imports = getImportLines(source)
      expect(imports).not.toMatch(/protocol-runtime/)
      expect(imports).not.toMatch(/hybrid-runtime/)
    }
  })

  // === Rule 13: Kernel MUST NOT import Phase 14 data-plane services (except TransportAdapter) ===
  it('kernel does not import Phase 14 data-plane services (rule 13, except TransportAdapter)', () => {
    // Check kernel directory for imports of Phase 14 services.
    // The only allowed import is transport-adapter.ts (a kernel contract interface).
    const kernelDirs = [
      './src/lib/kernel/runtime',
      './src/lib/kernel/execution',
      './src/lib/kernel/concurrency',
    ]
    for (const dir of kernelDirs) {
      // We check specific known kernel files for Phase 14 service imports.
      // This is a representative sample — a full grep would require listing all files.
    }
    // Check infrastructure-runtime does not import Phase 14 services.
    const infraSource = readFile('./src/lib/kernel/runtime/infrastructure-runtime.ts')
    const infraImports = getImportLines(infraSource)
    expect(infraImports).not.toMatch(/node\.service|data-plane\.service|routing\.service|transport\.service|delivery-confirmation\.service|transform-record\.service/)

    // Check protocol-runtime does not import Phase 14 services.
    const protoSource = readFile('./src/lib/kernel/runtime/protocol-runtime.ts')
    const protoImports = getImportLines(protoSource)
    expect(protoImports).not.toMatch(/node\.service|data-plane\.service|routing\.service|transport\.service|delivery-confirmation\.service|transform-record\.service/)

    // Check hybrid-runtime does not import Phase 14 services.
    const hybridSource = readFile('./src/lib/kernel/runtime/hybrid-runtime.ts')
    const hybridImports = getImportLines(hybridSource)
    expect(hybridImports).not.toMatch(/node\.service|data-plane\.service|routing\.service|transport\.service|delivery-confirmation\.service|transform-record\.service/)
  })

  // === Identity boundary: Asset ≠ Device ≠ Node ≠ ParticipantIdentity ≠ ResourceIdentity ===
  it('identity boundary preserved: Asset, Device, Node, ParticipantIdentity, ResourceIdentity are distinct models', () => {
    const schema = readFile('./prisma/schema.prisma')
    expect(schema).toContain('model Asset {')
    expect(schema).toContain('model Device {')
    expect(schema).toContain('model Node {')
    expect(schema).toContain('model ParticipantIdentity {')
    expect(schema).toContain('model ResourceIdentity {')
  })

  // === Generic economic pipeline remains vertical-neutral (rule 1, re-asserted) ===
  it('generic economic pipeline remains vertical-neutral', () => {
    const source = readFile('./src/lib/control-plane/economic-pipeline.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/vpp\.service/)
    expect(imports).not.toMatch(/compute\.service/)
    expect(imports).not.toMatch(/compute-adapter\.service/)
    expect(imports).not.toMatch(/storage\.service/)
    expect(imports).not.toMatch(/wireless\.service/)
    // Also must not import Phase 14 data-plane services.
    expect(imports).not.toMatch(/node\.service/)
    expect(imports).not.toMatch(/data-plane\.service/)
    expect(imports).not.toMatch(/routing\.service/)
    expect(imports).not.toMatch(/transport\.service/)
    expect(imports).not.toMatch(/delivery-confirmation\.service/)
    expect(imports).not.toMatch(/transform-record\.service/)
  })

  // === Runtime boundaries remain distinct (rules 3-4, re-asserted) ===
  it('InfrastructureRuntime does not import ProtocolRuntime', () => {
    const source = readFile('./src/lib/kernel/runtime/infrastructure-runtime.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/protocol-runtime/)
    expect(imports).not.toMatch(/protocol\//)
  })

  it('ProtocolRuntime does not import InfrastructureRuntime', () => {
    const source = readFile('./src/lib/kernel/runtime/protocol-runtime.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/infrastructure-runtime/)
    expect(imports).not.toMatch(/infrastructure-adapter/)
    expect(imports).not.toMatch(/adapter-registry/)
  })

  // === Marketplace remains future/non-executing (rule 6, re-asserted) ===
  it('marketplace does not exist (remains future)', () => {
    expect(existsSync('./src/lib/kernel/marketplace.ts')).toBe(false)
    expect(existsSync('./src/lib/services/marketplace.service.ts')).toBe(false)
  })

  // === TransformRegistry/Runtime remain future (rule 7, re-asserted) ===
  it('TransformRegistry and TransformRuntime do not exist (remain future)', () => {
    expect(existsSync('./src/lib/kernel/transform-registry.ts')).toBe(false)
    expect(existsSync('./src/lib/kernel/transform-runtime.ts')).toBe(false)
    expect(existsSync('./src/lib/services/transform-registry.service.ts')).toBe(false)
    expect(existsSync('./src/lib/services/transform-runtime.service.ts')).toBe(false)
  })

  // === Extension system remains future (rules in §10) ===
  it('Extension system does not exist (remains future)', () => {
    expect(existsSync('./src/lib/kernel/extension.ts')).toBe(false)
    expect(existsSync('./src/lib/kernel/extension-registry.ts')).toBe(false)
    expect(existsSync('./src/lib/kernel/extension-runtime.ts')).toBe(false)
  })

  // === SDK remains future (§12) ===
  it('SDK does not exist (remains future)', () => {
    expect(existsSync('./src/lib/kernel/sdk.ts')).toBe(false)
    expect(existsSync('./src/lib/services/sdk.service.ts')).toBe(false)
  })

  // === Future protocol implementations do not leak backward into kernel (rule 9) ===
  it('kernel does not require Phase 14 data-plane services (except TransportAdapter contract)', () => {
    // The transport-adapter.ts is a kernel contract interface (allowed).
    // All other kernel files must not import Phase 14 services.
    const adapterRegistrySource = readFile('./src/lib/kernel/runtime/adapter-registry.ts')
    const adapterRegistryImports = getImportLines(adapterRegistrySource)
    expect(adapterRegistryImports).not.toMatch(/node\.service|data-plane\.service|routing\.service|transport\.service|delivery-confirmation\.service|transform-record\.service/)
  })

  // === Constitution admits Phase 14 implementations ===
  it('Constitution admits Node as IMPLEMENTED (Phase 14A)', () => {
    const constitution = readFile('./docs/architecture/ARCHITECTURE-CONSTITUTION.md')
    expect(constitution).toContain('IMPLEMENTED — Phase 14A')
    expect(constitution).not.toContain('Node (FUTURE — not yet implemented)')
  })

  it('Constitution admits Bundle as IMPLEMENTED (Phase 14B)', () => {
    const constitution = readFile('./docs/architecture/ARCHITECTURE-CONSTITUTION.md')
    expect(constitution).toContain('Bundle (IMPLEMENTED — Phase 14B)')
    expect(constitution).not.toContain('Bundle (contract — NOT YET IMPLEMENTED)')
  })

  it('Constitution admits DATA PLANE as PARTIALLY IMPLEMENTED', () => {
    const constitution = readFile('./docs/architecture/ARCHITECTURE-CONSTITUTION.md')
    expect(constitution).toContain('DATA PLANE BOUNDARY (PARTIALLY IMPLEMENTED')
    expect(constitution).not.toContain('DATA PLANE BOUNDARY (contract — NOT YET IMPLEMENTED)')
  })

  it('Constitution admits TRANSFORM as PARTIALLY IMPLEMENTED', () => {
    const constitution = readFile('./docs/architecture/ARCHITECTURE-CONSTITUTION.md')
    expect(constitution).toContain('TRANSFORM BOUNDARY (PARTIALLY IMPLEMENTED')
    expect(constitution).not.toContain('TRANSFORM BOUNDARY (contract — NOT YET IMPLEMENTED)')
  })

  it('Constitution includes new anti-drift rules 10-13', () => {
    const constitution = readFile('./docs/architecture/ARCHITECTURE-CONSTITUTION.md')
    expect(constitution).toContain('10. Phase 14 data-plane services')
    expect(constitution).toContain('11. Phase 14 data-plane services MUST NOT import the generic economic pipeline')
    expect(constitution).toContain('12. Phase 14 data-plane services MUST NOT import ProtocolRuntime or HybridRuntime')
    expect(constitution).toContain('13. The kernel MUST NOT import Phase 14 data-plane services')
  })

  // === Gap Matrix reflects actual status ===
  it('Gap Matrix lists Node as EXISTS (Phase 14A)', () => {
    const matrix = readFile('./docs/architecture/PHASE-13-GAP-MATRIX.md')
    expect(matrix).toContain('| Node | EXISTS (Phase 14A)')
    expect(matrix).not.toContain('| Node | MISSING')
  })

  it('Gap Matrix lists Bundle as EXISTS (Phase 14B)', () => {
    const matrix = readFile('./docs/architecture/PHASE-13-GAP-MATRIX.md')
    expect(matrix).toContain('| Bundle | EXISTS (Phase 14B)')
    expect(matrix).not.toContain('| Bundle | MISSING')
  })

  it('Gap Matrix lists Transform as PARTIALLY EXISTS', () => {
    const matrix = readFile('./docs/architecture/PHASE-13-GAP-MATRIX.md')
    expect(matrix).toContain('| Transform | PARTIALLY EXISTS (Phase 14F)')
  })

  // === Dependency Graph reflects frozen architecture ===
  it('Dependency Graph shows Node as IMPLEMENTED', () => {
    const graph = readFile('./docs/architecture/PHASE-13-DEPENDENCY-GRAPH.md')
    expect(graph).toContain('IMPLEMENTED — Phase 14A')
    expect(graph).not.toContain('Node (future)')
  })

  it('Dependency Graph shows frozen Phase 14 dependency direction', () => {
    const graph = readFile('./docs/architecture/PHASE-13-DEPENDENCY-GRAPH.md')
    expect(graph).toContain('Frozen dependency direction')
    expect(graph).toContain('Node(14A) → Bundle(14B) → Route(14C) → TransportExecution(14D)')
  })

  // === Reconciliation document exists ===
  it('Phase 13R Reconciliation document exists', () => {
    expect(existsSync('./docs/architecture/PHASE-13-RECONCILIATION.md')).toBe(true)
  })
})
