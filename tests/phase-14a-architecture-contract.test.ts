/**
 * Phase 14A: Node Architecture Anti-Drift Tests
 *
 * Static contract tests enforcing the Node boundary (Phase 14A Step 7/14).
 * These complement the Phase 13 architecture contract tests and are
 * STATIC — they read source files and assert structural boundaries.
 * They do NOT require a database connection.
 *
 * Rules enforced (Phase 14A Step 7 — 15 rules):
 *   1. Node does not replace Device.
 *   2. Node does not replace Asset.
 *   3. Node does not replace ParticipantIdentity.
 *   4. Node does not duplicate ResourceIdentity.
 *   5. NodeNetworkMembership is distinct from NetworkResourceMembership.
 *   6. Generic economic pipeline does not import Node service.
 *   7. Node service does not import VPP.
 *   8. Node service does not import Compute.
 *   9. ProtocolRuntime does not import Node-specific vertical services.
 *  10. No Data Plane implementation is introduced.
 *  11. No Bundle implementation is introduced.
 *  12. No Transform implementation is introduced.
 *  13. No Extension/Marketplace implementation is introduced.
 *  14. No protocol-specific Node type exists (no VppNode/ComputeNode/TransitNode/CloudletNode).
 *  15. Node remains a generic service-layer/domain boundary, not a kernel-specific vertical.
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

describe('Phase 14A: Node Architecture Anti-Drift', () => {
  // 1. Node does not replace Device
  it('Node does not replace Device (Device model + Node.deviceId optional FK coexist)', () => {
    const schema = readFile('./prisma/schema.prisma')
    expect(schema).toContain('model Device {')
    expect(schema).toContain('model Node {')
    // Node references Device via optional FK (not a replacement).
    expect(schema).toMatch(/deviceId\s+String\?\s*\/\/ FK to Device/)
  })

  // 2. Node does not replace Asset
  it('Node does not replace Asset (Asset model still exists; Node has no direct assetId)', () => {
    const schema = readFile('./prisma/schema.prisma')
    expect(schema).toContain('model Asset {')
    // Node reaches Asset transitively via Device.assetId, NOT directly.
    const nodeStart = schema.indexOf('model Node {')
    const nodeEnd = schema.indexOf('\n}', nodeStart)
    const nodeSection = schema.slice(nodeStart, nodeEnd)
    expect(nodeSection).not.toMatch(/assetId\s+String/)
  })

  // 3. Node does not replace ParticipantIdentity
  it('Node does not replace ParticipantIdentity (model exists, Node references it)', () => {
    const schema = readFile('./prisma/schema.prisma')
    expect(schema).toContain('model ParticipantIdentity {')
    expect(schema).toMatch(/participantId\s+String\?\s*\/\/ FK to ParticipantIdentity/)
  })

  // 4. Node does not duplicate ResourceIdentity
  it('Node does not duplicate ResourceIdentity (ResourceIdentity exists, Node references it)', () => {
    const schema = readFile('./prisma/schema.prisma')
    expect(schema).toContain('model ResourceIdentity {')
    expect(schema).toMatch(/resourceId\s+String\?\s*\/\/ FK to ResourceIdentity/)
  })

  // 5. NodeNetworkMembership is distinct from NetworkResourceMembership
  it('NodeNetworkMembership is distinct from NetworkResourceMembership', () => {
    const schema = readFile('./prisma/schema.prisma')
    expect(schema).toContain('model NetworkResourceMembership {')
    expect(schema).toContain('model NodeNetworkMembership {')

    const nrmStart = schema.indexOf('model NetworkResourceMembership {')
    const nnmStart = schema.indexOf('model NodeNetworkMembership {')
    const nrmSection = schema.slice(nrmStart, nnmStart)
    const nnmEnd = schema.indexOf('\n}', nnmStart)
    const nnmSection = schema.slice(nnmStart, nnmEnd)

    // NodeNetworkMembership references Node, not ResourceIdentity.
    expect(nnmSection).toMatch(/nodeId\s+String\s*\/\/ FK to Node/)
    expect(nnmSection).not.toMatch(/resourceId\s+String\s*\/\/ FK to ResourceIdentity/)
    // NetworkResourceMembership references ResourceIdentity, not Node.
    expect(nrmSection).toMatch(/resourceId\s+String\s*\/\/ FK to ResourceIdentity/)
    expect(nrmSection).not.toMatch(/nodeId\s+String\s*\/\/ FK to Node/)
  })

  // 6. Generic economic pipeline does not import Node service
  it('generic economic pipeline does not import node service', () => {
    const source = readFile('./src/lib/control-plane/economic-pipeline.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/node\.service/)
    expect(imports).not.toMatch(/node-service/)
  })

  // 7. Node service does not import VPP
  it('node service does not import VPP', () => {
    const source = readFile('./src/lib/services/node.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/vpp\.service/)
    expect(imports).not.toMatch(/vpp-baseline/)
    expect(imports).not.toMatch(/portfolio-/)
  })

  // 8. Node service does not import Compute
  it('node service does not import Compute', () => {
    const source = readFile('./src/lib/services/node.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/compute\.service/)
    expect(imports).not.toMatch(/compute-adapter/)
  })

  // 9. ProtocolRuntime does not import Node-specific vertical services
  it('ProtocolRuntime does not import Node service or vertical services', () => {
    const source = readFile('./src/lib/kernel/runtime/protocol-runtime.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/infrastructure-runtime/)
    expect(imports).not.toMatch(/vpp\.service/)
    expect(imports).not.toMatch(/compute\.service/)
    expect(imports).not.toMatch(/node\.service/)
  })

  // 10. No KERNEL-level Data Plane implementation is introduced.
  //    Phase 14B implements the DataPlane as a SERVICE-LAYER primitive
  //    (src/lib/services/data-plane.service.ts), NOT a kernel contract.
  //    The kernel-level data-plane.ts must NOT exist.
  //    node.service.ts (Phase 14A) must not import data-plane (no reverse dep).
  it('no kernel-level Data Plane file exists; node.service does not import data-plane', () => {
    expect(existsSync('./src/lib/kernel/data-plane.ts')).toBe(false)
    // node.service.ts must not import data-plane (Node is lower-level than Bundle).
    const source = readFile('./src/lib/services/node.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/data-plane/)
    expect(imports).not.toMatch(/bundle/)
  })

  // 11. No KERNEL-level Bundle implementation is introduced.
  //    Phase 14B implements Bundle as a Prisma model + service-layer primitive.
  //    The kernel-level bundle.ts must NOT exist.
  it('no kernel-level Bundle file exists', () => {
    expect(existsSync('./src/lib/kernel/bundle.ts')).toBe(false)
  })

  // 12. No Transform implementation is introduced
  it('no Transform/TransformRegistry implementation file exists', () => {
    expect(existsSync('./src/lib/kernel/transform.ts')).toBe(false)
    expect(existsSync('./src/lib/kernel/transform-registry.ts')).toBe(false)
    const source = readFile('./src/lib/services/node.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/transform/)
  })

  // 13. No Extension/Marketplace implementation is introduced
  it('no Extension/ExtensionRegistry/Marketplace implementation file exists', () => {
    expect(existsSync('./src/lib/kernel/extension.ts')).toBe(false)
    expect(existsSync('./src/lib/kernel/extension-registry.ts')).toBe(false)
    expect(existsSync('./src/lib/kernel/marketplace.ts')).toBe(false)
    const source = readFile('./src/lib/services/node.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/extension/)
    expect(imports).not.toMatch(/marketplace/)
  })

  // 14. No protocol-specific Node type exists (generic only)
  it('no protocol-specific Node variant files exist (VppNode/ComputeNode/TransitNode/CloudletNode)', () => {
    const variants = [
      './src/lib/services/vpp-node.service.ts',
      './src/lib/services/compute-node.service.ts',
      './src/lib/services/transit-node.service.ts',
      './src/lib/services/cloudlet-node.service.ts',
      './src/lib/kernel/vpp-node.ts',
      './src/lib/kernel/compute-node.ts',
      './src/lib/kernel/transit-node.ts',
      './src/lib/kernel/cloudlet-node.ts',
    ]
    for (const f of variants) {
      expect(existsSync(f)).toBe(false)
    }
  })

  // 15. Node remains a generic service-layer/domain boundary, not a kernel-specific vertical
  it('Node is a service-layer primitive (no kernel-level node.ts)', () => {
    expect(existsSync('./src/lib/services/node.service.ts')).toBe(true)
    expect(existsSync('./src/lib/kernel/node.ts')).toBe(false)
  })

  // Additional: Node identity is immutable (cuid, not IP/MAC-derived)
  it('Node identity is a cuid (immutable, not derived from device/IP/MAC)', () => {
    const schema = readFile('./prisma/schema.prisma')
    const nodeStart = schema.indexOf('model Node {')
    const nodeEnd = schema.indexOf('\n}', nodeStart)
    const nodeSection = schema.slice(nodeStart, nodeEnd)
    expect(nodeSection).toMatch(/id\s+String\s+@id\s+@default\(cuid\(\)\)/)
    // No IP/MAC/hostname fields on the Node.
    expect(nodeSection).not.toMatch(/ipAddress|macAddress|hostname/)
  })

  // Additional: NodeNetworkMembership enforces one-membership-per-network
  it('NodeNetworkMembership has unique constraint on (nodeId, networkId)', () => {
    const schema = readFile('./prisma/schema.prisma')
    const nnmStart = schema.indexOf('model NodeNetworkMembership {')
    const nnmEnd = schema.indexOf('\n}', nnmStart)
    const nnmSection = schema.slice(nnmStart, nnmEnd)
    expect(nnmSection).toMatch(/@@unique\(\[nodeId,\s*networkId\]\)/)
  })

  // Additional: Node contract document exists
  it('Phase 14A Node contract document exists', () => {
    expect(existsSync('./docs/architecture/PHASE-14A-NODE-CONTRACT.md')).toBe(true)
  })
})
