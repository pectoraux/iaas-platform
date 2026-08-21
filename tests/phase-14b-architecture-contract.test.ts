/**
 * Phase 14B: Data Plane / Bundle Architecture Anti-Drift Tests
 *
 * Static contract tests enforcing the DataPlane/Bundle boundary (Phase 14B
 * Step 18 — 14 rules). These complement the Phase 13/14A architecture tests
 * and are STATIC — they read source files and assert structural boundaries.
 * They do NOT require a database connection.
 *
 * Rules enforced:
 *   1. DataPlane does not import VPP.
 *   2. DataPlane does not import Compute.
 *   3. DataPlane does not import TransitNet.
 *   4. DataPlane does not import Cloudlet.
 *   5. Bundle does not contain vertical-specific fields.
 *   6. Bundle does not own Asset/Device/ResourceIdentity.
 *   7. Bundle references Node identity for protocol endpoints.
 *   8. Generic economic pipeline does not import Bundle/DataPlane.
 *   9. Marketplace does not exist in this milestone.
 *  10. Transform does not exist in this milestone.
 *  11. Routing implementation does not exist in this milestone.
 *  12. ProtocolRuntime depends on a generic DataPlane boundary, not a vertical implementation.
 *  13. Node remains the protocol endpoint identity boundary.
 *  14. Control Plane does not become a packet-processing engine.
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

describe('Phase 14B: Data Plane / Bundle Architecture Anti-Drift', () => {
  // 1. DataPlane does not import VPP
  it('data-plane service does not import VPP', () => {
    const source = readFile('./src/lib/services/data-plane.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/vpp\.service/)
    expect(imports).not.toMatch(/portfolio-/)
    expect(imports).not.toMatch(/vpp-baseline/)
  })

  // 2. DataPlane does not import Compute
  it('data-plane service does not import Compute', () => {
    const source = readFile('./src/lib/services/data-plane.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/compute\.service/)
    expect(imports).not.toMatch(/compute-adapter/)
  })

  // 3. DataPlane does not import TransitNet
  it('data-plane service does not import TransitNet', () => {
    const source = readFile('./src/lib/services/data-plane.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/transit/)
    expect(imports).not.toMatch(/transitnet/)
  })

  // 4. DataPlane does not import Cloudlet
  it('data-plane service does not import Cloudlet', () => {
    const source = readFile('./src/lib/services/data-plane.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/cloudlet/)
  })

  // 5. Bundle does not contain vertical-specific fields
  it('Bundle model has no vertical-specific fields (no vpp/compute/transit/cloudlet)', () => {
    const schema = readFile('./prisma/schema.prisma')
    const bundleStart = schema.indexOf('model Bundle {')
    const bundleEnd = schema.indexOf('\n}', bundleStart)
    const bundleSection = schema.slice(bundleStart, bundleEnd)
    expect(bundleSection).not.toMatch(/kwh|gpuHours|bandwidth|transitRoute|cloudletCache/i)
    expect(bundleSection).not.toMatch(/vppSpecific|computeSpecific|transitSpecific/i)
  })

  // 6. Bundle does not own Asset/Device/ResourceIdentity
  it('Bundle does not own Asset/Device/ResourceIdentity (no direct FKs to them)', () => {
    const schema = readFile('./prisma/schema.prisma')
    const bundleStart = schema.indexOf('model Bundle {')
    const bundleEnd = schema.indexOf('\n}', bundleStart)
    const bundleSection = schema.slice(bundleStart, bundleEnd)
    // Bundle references Node, NOT Asset/Device/ResourceIdentity directly.
    expect(bundleSection).not.toMatch(/assetId\s+String/)
    expect(bundleSection).not.toMatch(/deviceId\s+String/)
    expect(bundleSection).not.toMatch(/resourceId\s+String/)
  })

  // 7. Bundle references Node identity for protocol endpoints
  it('Bundle references Node identity for source/destination', () => {
    const schema = readFile('./prisma/schema.prisma')
    const bundleStart = schema.indexOf('model Bundle {')
    const bundleEnd = schema.indexOf('\n}', bundleStart)
    const bundleSection = schema.slice(bundleStart, bundleEnd)
    expect(bundleSection).toMatch(/sourceNodeId\s+String\s*\/\/ FK to Node/)
    expect(bundleSection).toMatch(/destinationNodeId\s+String\s*\/\/ FK to Node/)
  })

  // 8. Generic economic pipeline does not import Bundle/DataPlane
  it('generic economic pipeline does not import data-plane/bundle service', () => {
    const source = readFile('./src/lib/control-plane/economic-pipeline.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/data-plane\.service/)
    expect(imports).not.toMatch(/bundle\.service/)
    expect(imports).not.toMatch(/data-plane/)
    expect(imports).not.toMatch(/bundle/)
  })

  // 9. Marketplace does not exist in this milestone
  it('no Marketplace implementation file exists', () => {
    expect(existsSync('./src/lib/kernel/marketplace.ts')).toBe(false)
    expect(existsSync('./src/lib/services/marketplace.service.ts')).toBe(false)
    const source = readFile('./src/lib/services/data-plane.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/marketplace/)
  })

  // 10. Transform does not exist in this milestone
  it('no Transform/TransformRegistry implementation file exists', () => {
    expect(existsSync('./src/lib/kernel/transform.ts')).toBe(false)
    expect(existsSync('./src/lib/kernel/transform-registry.ts')).toBe(false)
    expect(existsSync('./src/lib/services/transform.service.ts')).toBe(false)
    const source = readFile('./src/lib/services/data-plane.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/transform/)
  })

  // 11. No KERNEL-level routing/transport implementation exists.
  //    Phase 14C implements routing as a SERVICE-LAYER primitive
  //    (src/lib/services/routing.service.ts), NOT a kernel contract.
  //    The kernel-level routing.ts/dtn.ts must NOT exist.
  //    data-plane.service.ts (Phase 14B) must not import routing (independent).
  it('no kernel-level routing/dtn files exist; data-plane.service does not import routing', () => {
    expect(existsSync('./src/lib/kernel/routing.ts')).toBe(false)
    expect(existsSync('./src/lib/kernel/router.ts')).toBe(false)
    expect(existsSync('./src/lib/kernel/dtn.ts')).toBe(false)
    // data-plane.service.ts must remain independent of routing.
    const source = readFile('./src/lib/services/data-plane.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/routing\.service/)
    expect(imports).not.toMatch(/dtn/)
    expect(imports).not.toMatch(/forwarding/)
  })

  // 12. ProtocolRuntime depends on a generic DataPlane boundary, not a vertical implementation
  it('ProtocolRuntime does not import data-plane service or vertical services', () => {
    const source = readFile('./src/lib/kernel/runtime/protocol-runtime.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/data-plane\.service/)
    expect(imports).not.toMatch(/vpp\.service/)
    expect(imports).not.toMatch(/compute\.service/)
    expect(imports).not.toMatch(/node\.service/)
  })

  // 13. Node remains the protocol endpoint identity boundary
  it('Node service exists and remains the protocol endpoint identity (Bundle uses Node, not vice versa)', () => {
    expect(existsSync('./src/lib/services/node.service.ts')).toBe(true)
    // Node service does not import data-plane (no reverse dependency).
    const nodeSource = readFile('./src/lib/services/node.service.ts')
    const nodeImports = getImportLines(nodeSource)
    expect(nodeImports).not.toMatch(/data-plane/)
    expect(nodeImports).not.toMatch(/bundle/)
  })

  // 14. Control Plane does not become a packet-processing engine
  it('control plane orchestrator/scheduler do not import data-plane service', () => {
    const orchSource = readFile('./src/lib/control-plane/execution-orchestrator.ts')
    const orchImports = getImportLines(orchSource)
    expect(orchImports).not.toMatch(/data-plane\.service/)
    expect(orchImports).not.toMatch(/bundle\.service/)

    const schedSource = readFile('./src/lib/control-plane/scheduler.ts')
    const schedImports = getImportLines(schedSource)
    expect(schedImports).not.toMatch(/data-plane\.service/)
    expect(schedImports).not.toMatch(/bundle\.service/)
  })

  // Additional: Bundle identity is deterministic (not DB row ID or timestamp)
  it('Bundle identity is deterministic (id is a hash, not @default(cuid()))', () => {
    const schema = readFile('./prisma/schema.prisma')
    const bundleStart = schema.indexOf('model Bundle {')
    const bundleEnd = schema.indexOf('\n}', bundleStart)
    const bundleSection = schema.slice(bundleStart, bundleEnd)
    // id is @id (no @default — caller supplies the deterministic hash).
    expect(bundleSection).toMatch(/id\s+String\s+@id\s*\/\/ deterministic/)
    expect(bundleSection).not.toMatch(/@default\(cuid\(\)\)/)
  })

  // Additional: Bundle has persisted expiryTime (not in-memory timer)
  it('Bundle has persisted expiryTime field', () => {
    const schema = readFile('./prisma/schema.prisma')
    const bundleStart = schema.indexOf('model Bundle {')
    const bundleEnd = schema.indexOf('\n}', bundleStart)
    const bundleSection = schema.slice(bundleStart, bundleEnd)
    expect(bundleSection).toMatch(/expiryTime\s+DateTime/)
  })

  // Additional: BundleDelivery enforces one-delivery-per-receiver
  it('BundleDelivery deduplicates by deterministic deliveryId (one per bundle+receiver)', () => {
    const schema = readFile('./prisma/schema.prisma')
    const deliveryStart = schema.indexOf('model BundleDelivery {')
    const deliveryEnd = schema.indexOf('\n}', deliveryStart)
    const deliverySection = schema.slice(deliveryStart, deliveryEnd)
    // id is @id (deterministic hash, not cuid default).
    expect(deliverySection).toMatch(/id\s+String\s+@id\s*\/\/ deterministic/)
    expect(deliverySection).not.toMatch(/@default\(cuid\(\)\)/)
    // attemptCount tracks duplicate reception.
    expect(deliverySection).toMatch(/attemptCount\s+Int/)
  })

  // Additional: Phase 14B contract document exists
  it('Phase 14B Data Plane contract document exists', () => {
    expect(existsSync('./docs/architecture/PHASE-14B-DATA-PLANE-CONTRACT.md')).toBe(true)
  })
})
