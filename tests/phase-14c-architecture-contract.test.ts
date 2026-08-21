/**
 * Phase 14C: Data Plane Routing Architecture Anti-Drift Tests
 *
 * Static contract tests enforcing the Routing boundary (Phase 14C Step 11 — 7 rules).
 * These complement the Phase 13/14A/14B architecture tests and are STATIC —
 * they read source files and assert structural boundaries. No DB connection.
 *
 * Rules enforced:
 *   1. Route exists only in service/data layer.
 *   2. No kernel routing implementation exists.
 *   3. No transport implementation exists.
 *   4. Bundle remains immutable (Route does not modify Bundle fields).
 *   5. Routing does not import: protocol runtime, economic pipeline, marketplace, transforms.
 *   6. Node remains lower-level than routing (node.service does not import routing.service).
 *   7. DataPlane remains independent (data-plane.service does not import routing.service).
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

describe('Phase 14C: Data Plane Routing Architecture Anti-Drift', () => {
  // 1. Route exists only in service/data layer
  it('Route is implemented as a service-layer primitive, not a kernel contract', () => {
    expect(existsSync('./src/lib/services/routing.service.ts')).toBe(true)
    expect(existsSync('./src/lib/kernel/routing.ts')).toBe(false)
    expect(existsSync('./src/lib/kernel/route.ts')).toBe(false)
    expect(existsSync('./src/lib/kernel/router.ts')).toBe(false)
  })

  // 2. No kernel routing implementation exists
  it('no kernel routing/transport implementation files exist', () => {
    const kernelFiles = [
      './src/lib/kernel/routing.ts',
      './src/lib/kernel/transport.ts',
      './src/lib/kernel/dtn.ts',
      './src/lib/kernel/relay.ts',
      './src/lib/kernel/gateway.ts',
      './src/lib/kernel/forwarding.ts',
    ]
    for (const f of kernelFiles) {
      expect(existsSync(f)).toBe(false)
    }
  })

  // 3. No transport implementation exists
  it('no transport service implementation exists (TCP/UDP/Bluetooth/WiFi/satellite)', () => {
    expect(existsSync('./src/lib/services/transport.service.ts')).toBe(false)
    expect(existsSync('./src/lib/services/tcp.service.ts')).toBe(false)
    expect(existsSync('./src/lib/services/udp.service.ts')).toBe(false)
    expect(existsSync('./src/lib/services/bluetooth.service.ts')).toBe(false)
    expect(existsSync('./src/lib/services/wifi-mesh.service.ts')).toBe(false)
    // routing.service.ts must not import transport abstractions.
    const source = readFile('./src/lib/services/routing.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/transport/)
    expect(imports).not.toMatch(/tcp/)
    expect(imports).not.toMatch(/udp/)
    expect(imports).not.toMatch(/bluetooth/i)
    expect(imports).not.toMatch(/wifi/i)
  })

  // 4. Bundle remains immutable (Route does not modify Bundle fields)
  it('routing service does not modify Bundle identity/payload/destination', () => {
    const source = readFile('./src/lib/services/routing.service.ts')
    // Must NOT call db.bundle.update (Route attaches, does not mutate Bundle).
    expect(source).not.toMatch(/db\.bundle\.update/)
    // Must NOT mutate Bundle.destinationNodeId / payloadBytesJson / payloadHash.
    expect(source).not.toMatch(/bundle\.destinationNodeId\s*=/)
    expect(source).not.toMatch(/bundle\.payloadBytesJson\s*=/)
    expect(source).not.toMatch(/bundle\.payloadHash\s*=/)
    expect(source).not.toMatch(/bundle\.id\s*=/)
  })

  // 5. Routing does not import protocol runtime / economic pipeline / marketplace / transforms
  it('routing service does not import protocol runtime, economic pipeline, marketplace, or transforms', () => {
    const source = readFile('./src/lib/services/routing.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/protocol-runtime/)
    expect(imports).not.toMatch(/hybrid-runtime/)
    expect(imports).not.toMatch(/economic-pipeline/)
    expect(imports).not.toMatch(/control-plane/)
    expect(imports).not.toMatch(/marketplace/)
    expect(imports).not.toMatch(/transform/)
    expect(imports).not.toMatch(/extension/)
    expect(imports).not.toMatch(/vpp\.service/)
    expect(imports).not.toMatch(/compute\.service/)
  })

  // 6. Node remains lower-level than routing (no reverse dependency)
  it('node.service does not import routing.service (Node is lower-level)', () => {
    const source = readFile('./src/lib/services/node.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/routing\.service/)
    expect(imports).not.toMatch(/route\.service/)
  })

  // 7. DataPlane remains independent (data-plane.service does not import routing.service)
  it('data-plane.service does not import routing.service (DataPlane is independent)', () => {
    const source = readFile('./src/lib/services/data-plane.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/routing\.service/)
    expect(imports).not.toMatch(/route\.service/)
  })

  // Additional: Route references Node identity (not Device/Asset/Resource)
  it('Route model references Node identity for source/destination/hops', () => {
    const schema = readFile('./prisma/schema.prisma')
    const routeStart = schema.indexOf('model Route {')
    const routeEnd = schema.indexOf('\n}', routeStart)
    const routeSection = schema.slice(routeStart, routeEnd)
    expect(routeSection).toMatch(/sourceNodeId\s+String\s*\/\/ FK to Node/)
    expect(routeSection).toMatch(/destinationNodeId\s+String\s*\/\/ FK to Node/)
    // Route does NOT reference Asset/Device/ResourceIdentity.
    expect(routeSection).not.toMatch(/assetId\s+String/)
    expect(routeSection).not.toMatch(/deviceId\s+String/)
    expect(routeSection).not.toMatch(/resourceId\s+String/)
  })

  // Additional: RouteHop has deterministic ordering (sequence unique per route)
  it('RouteHop has @@unique([routeId, sequence]) for deterministic ordering', () => {
    const schema = readFile('./prisma/schema.prisma')
    const hopStart = schema.indexOf('model RouteHop {')
    const hopEnd = schema.indexOf('\n}', hopStart)
    const hopSection = schema.slice(hopStart, hopEnd)
    expect(hopSection).toMatch(/@@unique\(\[routeId,\s*sequence\]\)/)
    expect(hopSection).toMatch(/sequence\s+Int/)
  })

  // Additional: NodeCapability has no marketplace fields
  it('NodeCapability is a declaration, not a marketplace listing (no price/license fields)', () => {
    const schema = readFile('./prisma/schema.prisma')
    const capStart = schema.indexOf('model NodeCapability {')
    const capEnd = schema.indexOf('\n}', capStart)
    const capSection = schema.slice(capStart, capEnd)
    expect(capSection).not.toMatch(/price|license|marketplace/i)
  })

  // Additional: NodeReachability represents knowledge, not physical proof
  it('NodeReachability has reachable/lastSeen/latencyHint/expiresAt (knowledge fields)', () => {
    const schema = readFile('./prisma/schema.prisma')
    const reachStart = schema.indexOf('model NodeReachability {')
    const reachEnd = schema.indexOf('\n}', reachStart)
    const reachSection = schema.slice(reachStart, reachEnd)
    expect(reachSection).toMatch(/reachable\s+Boolean/)
    expect(reachSection).toMatch(/lastSeen\s+DateTime/)
    expect(reachSection).toMatch(/latencyHint\s+Int\?/)
    expect(reachSection).toMatch(/expiresAt\s+DateTime/)
  })

  // Additional: Phase 14C contract document exists
  it('Phase 14C Routing contract document exists', () => {
    expect(existsSync('./docs/architecture/PHASE-14C-ROUTING-CONTRACT.md')).toBe(true)
  })

  // Additional: routing.service does not implement forwardBundle/sendPacket/openConnection
  it('routing service does not implement forbidden execution operations', () => {
    const source = readFile('./src/lib/services/routing.service.ts')
    expect(source).not.toMatch(/export\s+async\s+function\s+forwardBundle/)
    expect(source).not.toMatch(/export\s+async\s+function\s+sendPacket/)
    expect(source).not.toMatch(/export\s+async\s+function\s+openConnection/)
    expect(source).not.toMatch(/export\s+async\s+function\s+selectRadio/)
  })
})
