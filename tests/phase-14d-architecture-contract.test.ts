/**
 * Phase 14D: Transport Execution Architecture Anti-Drift Tests
 *
 * Static contract tests enforcing the Transport boundary (Phase 14D Step 9 — 12 rules).
 * These complement the Phase 13/14A/14B/14C architecture tests and are STATIC —
 * they read source files and assert structural boundaries. No DB connection.
 *
 * Rules enforced:
 *   1. Transport exists.
 *   2. Transport is service-layer.
 *   3. No kernel transport primitive exists (beyond the TransportAdapter interface).
 *   4. Transport does not import routing internals.
 *   5. Transport does not implement network protocols.
 *   6. Transport does not modify Bundle.
 *   7. Transport does not modify Route.
 *   8. Transport does not create Nodes.
 *   9. Transport capability remains generic.
 *  10. No DTN implementation exists.
 *  11. No adapter marketplace exists.
 *  12. No SDK exposure exists.
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

describe('Phase 14D: Transport Execution Architecture Anti-Drift', () => {
  // 1. Transport exists
  it('Transport service and adapter interface exist', () => {
    expect(existsSync('./src/lib/services/transport.service.ts')).toBe(true)
    expect(existsSync('./src/lib/kernel/adapters/transport-adapter.ts')).toBe(true)
  })

  // 2. Transport is service-layer
  it('TransportExecution is a service-layer primitive, not a kernel contract', () => {
    expect(existsSync('./src/lib/services/transport.service.ts')).toBe(true)
    // No kernel transport execution service (the kernel only owns the adapter INTERFACE).
    expect(existsSync('./src/lib/kernel/transport-execution.ts')).toBe(false)
    expect(existsSync('./src/lib/kernel/transport-service.ts')).toBe(false)
  })

  // 3. No kernel transport primitive exists (beyond the TransportAdapter interface)
  it('no kernel transport execution/network primitive files exist', () => {
    const kernelFiles = [
      './src/lib/kernel/transport.ts',
      './src/lib/kernel/network.ts',
      './src/lib/kernel/connection.ts',
      './src/lib/kernel/socket.ts',
      './src/lib/kernel/channel.ts',
      './src/lib/kernel/forwarding.ts',
    ]
    for (const f of kernelFiles) {
      expect(existsSync(f)).toBe(false)
    }
  })

  // 4. Transport does not import routing internals
  it('transport service does not import routing service internals', () => {
    const source = readFile('./src/lib/services/transport.service.ts')
    const imports = getImportLines(source)
    // Transport may import getRoute for FK validation, but NOT routing decision functions.
    // (getRoute is a read — transport executes, does not decide routes.)
    expect(imports).not.toMatch(/createRoutePlan/)
    expect(imports).not.toMatch(/addRouteHop/)
    expect(imports).not.toMatch(/activateRoute/)
    expect(imports).not.toMatch(/completeRoute/)
    expect(imports).not.toMatch(/failRoute/)
    expect(imports).not.toMatch(/expireRoute/)
    // Must NOT import routing service as a mutation dependency.
    expect(imports).not.toMatch(/from.*routing\.service.*import/)
  })

  // 5. Transport does not implement network protocols
  it('transport service and adapter do not implement network protocols (no socket/connect/fetch calls)', () => {
    const svcSource = readFile('./src/lib/services/transport.service.ts')
    const adapterSource = readFile('./src/lib/kernel/adapters/transport-adapter.ts')
    // No actual network/socket calls (implementation, not comments).
    expect(svcSource).not.toMatch(/net\.connect|net\.createConnection|socket\.connect|dgram\.createSocket|http\.request|https\.request|fetch\(/)
    expect(adapterSource).not.toMatch(/net\.connect|net\.createConnection|socket\.connect|dgram\.createSocket|http\.request|https\.request|fetch\(/)
    // No protocol-specific module imports.
    const svcImports = getImportLines(svcSource)
    const adapterImports = getImportLines(adapterSource)
    expect(svcImports).not.toMatch(/from ['"]net['"]|from ['"]http['"]|from ['"]https['"]|from ['"]dgram['"]|from ['"]ws['"]/)
    expect(adapterImports).not.toMatch(/from ['"]net['"]|from ['"]http['"]|from ['"]https['"]|from ['"]dgram['"]|from ['"]ws['"]/)
  })

  // 6. Transport does not modify Bundle
  it('transport service does not modify Bundle identity/payload/destination', () => {
    const source = readFile('./src/lib/services/transport.service.ts')
    // Must NOT call db.bundle.update/create/delete (transport references, does not mutate).
    expect(source).not.toMatch(/db\.bundle\.update/)
    expect(source).not.toMatch(/db\.bundle\.create/)
    expect(source).not.toMatch(/db\.bundle\.delete/)
    // Must NOT mutate Bundle fields.
    expect(source).not.toMatch(/bundle\.destinationNodeId\s*=/)
    expect(source).not.toMatch(/bundle\.payloadBytesJson\s*=/)
    expect(source).not.toMatch(/bundle\.payloadHash\s*=/)
    expect(source).not.toMatch(/bundle\.id\s*=/)
  })

  // 7. Transport does not modify Route
  it('transport service does not modify Route', () => {
    const source = readFile('./src/lib/services/transport.service.ts')
    // Must NOT call db.route.update/create/delete (transport references, does not mutate).
    expect(source).not.toMatch(/db\.route\.update/)
    expect(source).not.toMatch(/db\.route\.create/)
    expect(source).not.toMatch(/db\.route\.delete/)
    // Must NOT mutate Route fields.
    expect(source).not.toMatch(/route\.sourceNodeId\s*=/)
    expect(source).not.toMatch(/route\.destinationNodeId\s*=/)
    expect(source).not.toMatch(/route\.status\s*=/)
  })

  // 8. Transport does not create Nodes
  it('transport service does not create Nodes (only references them for validation)', () => {
    const source = readFile('./src/lib/services/transport.service.ts')
    // Must NOT call db.node.create (transport references Nodes, does not create them).
    expect(source).not.toMatch(/db\.node\.create/)
    // Must NOT import registerNode (the Node creation function).
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/registerNode/)
    expect(imports).not.toMatch(/activateNode/)
    expect(imports).not.toMatch(/suspendNode/)
    expect(imports).not.toMatch(/revokeNode/)
  })

  // 9. Transport capability remains generic
  it('TransportCapability model has no protocol-specific or marketplace fields', () => {
    const schema = readFile('./prisma/schema.prisma')
    const capStart = schema.indexOf('model TransportCapability {')
    const capEnd = schema.indexOf('\n}', capStart)
    const capSection = schema.slice(capStart, capEnd)
    // No protocol-specific fields.
    expect(capSection).not.toMatch(/wifi|bluetooth|lte|satellite|tcp|udp|quic/i)
    // No marketplace/pricing fields.
    expect(capSection).not.toMatch(/price|license|marketplace|bandwidth|throughput/i)
  })

  // 10. No DTN implementation exists
  it('no DTN forwarding implementation file exists', () => {
    expect(existsSync('./src/lib/kernel/dtn.ts')).toBe(false)
    expect(existsSync('./src/lib/services/dtn.service.ts')).toBe(false)
    expect(existsSync('./src/lib/kernel/dtn-forwarding.ts')).toBe(false)
    // transport.service.ts must not import DTN.
    const source = readFile('./src/lib/services/transport.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/dtn/i)
  })

  // 11. No adapter marketplace exists
  it('no adapter marketplace implementation file exists', () => {
    expect(existsSync('./src/lib/kernel/marketplace.ts')).toBe(false)
    expect(existsSync('./src/lib/services/marketplace.service.ts')).toBe(false)
    expect(existsSync('./src/lib/services/adapter-marketplace.service.ts')).toBe(false)
    // transport.service.ts must not import marketplace.
    const source = readFile('./src/lib/services/transport.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/marketplace/)
  })

  // 12. No SDK exposure exists
  it('no SDK implementation file exists', () => {
    expect(existsSync('./src/lib/kernel/sdk.ts')).toBe(false)
    expect(existsSync('./src/lib/services/sdk.service.ts')).toBe(false)
    // transport.service.ts must not import SDK.
    const source = readFile('./src/lib/services/transport.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/\bsdk\b/)
  })

  // Additional: TransportExecution references Bundle + Route (does not redefine)
  it('TransportExecution model references Bundle and Route via FK (does not redefine identity)', () => {
    const schema = readFile('./prisma/schema.prisma')
    const execStart = schema.indexOf('model TransportExecution {')
    const execEnd = schema.indexOf('\n}', execStart)
    const execSection = schema.slice(execStart, execEnd)
    expect(execSection).toMatch(/bundleId\s+String\s*\/\/ FK to Bundle/)
    expect(execSection).toMatch(/routeId\s+String\s*\/\/ FK to Route/)
    // Does NOT contain Bundle payload/identity fields (redefinition forbidden).
    expect(execSection).not.toMatch(/payloadHash|payloadBytesJson|payloadType/)
    expect(execSection).not.toMatch(/sourceNodeId|destinationNodeId/) // Route owns these
  })

  // Additional: TransportAttempt references Node identity (from/to)
  it('TransportAttempt model references Node identity for hop endpoints', () => {
    const schema = readFile('./prisma/schema.prisma')
    const attemptStart = schema.indexOf('model TransportAttempt {')
    const attemptEnd = schema.indexOf('\n}', attemptStart)
    const attemptSection = schema.slice(attemptStart, attemptEnd)
    expect(attemptSection).toMatch(/fromNodeId\s+String\s*\/\/ FK to Node/)
    expect(attemptSection).toMatch(/toNodeId\s+String\s*\/\/ FK to Node/)
  })

  // Additional: TransportAdapter interface has the 3 required methods
  it('TransportAdapter interface defines executeTransportAttempt, getCapabilities, validate', () => {
    const source = readFile('./src/lib/kernel/adapters/transport-adapter.ts')
    expect(source).toMatch(/executeTransportAttempt\s*\(/)
    expect(source).toMatch(/getCapabilities\s*\(/)
    expect(source).toMatch(/validate\s*\(/)
    // MockTransportAdapter exists.
    expect(source).toMatch(/class MockTransportAdapter/)
  })

  // Additional: TransportAdapter does NOT import network modules
  it('transport-adapter.ts does not import network/socket/http modules', () => {
    const source = readFile('./src/lib/kernel/adapters/transport-adapter.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/from ['"]net['"]|from ['"]http['"]|from ['"]https['"]|from ['"]dgram['"]|from ['"]ws['"]/)
    expect(imports).not.toMatch(/from ['"]socket\.io/)
  })

  // Additional: Phase 14D contract document exists
  it('Phase 14D Transport contract document exists', () => {
    expect(existsSync('./docs/architecture/PHASE-14D-TRANSPORT-CONTRACT.md')).toBe(true)
  })
})
