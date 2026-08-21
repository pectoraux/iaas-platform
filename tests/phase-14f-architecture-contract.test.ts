/**
 * Phase 14F: Transform Record Architecture Anti-Drift Tests
 *
 * Static contract tests enforcing the TransformRecord boundary.
 * These are STATIC — they read source files and assert structural boundaries.
 * No DB connection.
 *
 * Rules enforced:
 *   1. TransformRecord exists as a service-layer primitive.
 *   2. No kernel transform primitive exists (no TransformRegistry/TransformRuntime).
 *   3. TransformRecord does not import routing/transport internals.
 *   4. TransformRecord does not implement execute/reverse/estimateCost/verify.
 *   5. TransformRecord does not modify Bundle.
 *   6. TransformRecord does not modify Route.
 *   7. TransformRecord does not modify Node.
 *   8. TransformRecord does not modify TransportExecution/TransportAttempt/DeliveryConfirmation.
 *   9. No TransformRegistry implementation exists.
 *  10. No TransformRuntime implementation exists.
 *  11. No marketplace/pricing/settlement exists.
 *  12. No SDK exists.
 *  13. TransformRecord is immutable (no status field, no lifecycle).
 *  14. Idempotency semantics represented by @@unique + fingerprint.
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

describe('Phase 14F: Transform Record Architecture Anti-Drift', () => {
  // 1. TransformRecord exists as a service-layer primitive
  it('TransformRecord service exists at the service layer', () => {
    expect(existsSync('./src/lib/services/transform-record.service.ts')).toBe(true)
  })

  // 2. No kernel transform primitive exists (no TransformRegistry/TransformRuntime)
  it('no kernel transform/registry/runtime primitive files exist', () => {
    const kernelFiles = [
      './src/lib/kernel/transform.ts',
      './src/lib/kernel/transform-registry.ts',
      './src/lib/kernel/transform-runtime.ts',
    ]
    for (const f of kernelFiles) {
      expect(existsSync(f)).toBe(false)
    }
  })

  // 3. TransformRecord does not import routing/transport internals
  it('transform-record service does not import routing/transport mutation functions', () => {
    const source = readFile('./src/lib/services/transform-record.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/createRoutePlan|addRouteHop|activateRoute|completeRoute/)
    expect(imports).not.toMatch(/createTransportExecution|startTransportExecution|completeTransportExecution/)
    expect(imports).not.toMatch(/createTransportAttempt|markAttemptSent|acknowledgeAttempt|failAttempt/)
    expect(imports).not.toMatch(/createDeliveryConfirmation|verifyDeliveryConfirmation/)
  })

  // 4. TransformRecord does not implement execute/reverse/estimateCost/verify
  it('transform-record service does not implement execute/reverse/estimateCost/verify (TransformRuntime is future)', () => {
    const source = readFile('./src/lib/services/transform-record.service.ts')
    // No TransformRuntime methods exported.
    expect(source).not.toMatch(/export\s+async\s+function\s+executeTransform/)
    expect(source).not.toMatch(/export\s+async\s+function\s+reverseTransform/)
    expect(source).not.toMatch(/export\s+async\s+function\s+estimateTransformCost/)
    expect(source).not.toMatch(/export\s+async\s+function\s+verifyTransform/)
  })

  // 5. TransformRecord does not modify Bundle
  it('transform-record service does not call db.bundle.update/create/delete', () => {
    const source = readFile('./src/lib/services/transform-record.service.ts')
    expect(source).not.toMatch(/db\.bundle\.(update|create|delete|upsert)/)
  })

  // 6. TransformRecord does not modify Route
  it('transform-record service does not call db.route.update/create/delete', () => {
    const source = readFile('./src/lib/services/transform-record.service.ts')
    expect(source).not.toMatch(/db\.route\.(update|create|delete|upsert)/)
  })

  // 7. TransformRecord does not modify Node
  it('transform-record service does not call db.node.update/create/delete', () => {
    const source = readFile('./src/lib/services/transform-record.service.ts')
    expect(source).not.toMatch(/db\.node\.(update|create|delete|upsert)/)
  })

  // 8. TransformRecord does not modify TransportExecution/TransportAttempt/DeliveryConfirmation
  it('transform-record service does not call db.transportExecution/transportAttempt/deliveryConfirmation.update/create/delete', () => {
    const source = readFile('./src/lib/services/transform-record.service.ts')
    expect(source).not.toMatch(/db\.transportExecution\.(update|create|delete|upsert)/)
    expect(source).not.toMatch(/db\.transportAttempt\.(update|create|delete|upsert)/)
    expect(source).not.toMatch(/db\.deliveryConfirmation\.(update|create|delete|upsert)/)
  })

  // 9. No TransformRegistry implementation exists
  it('no TransformRegistry implementation file exists', () => {
    expect(existsSync('./src/lib/kernel/transform-registry.ts')).toBe(false)
    expect(existsSync('./src/lib/services/transform-registry.service.ts')).toBe(false)
    const source = readFile('./src/lib/services/transform-record.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/transform-registry/)
  })

  // 10. No TransformRuntime implementation exists
  it('no TransformRuntime implementation file exists', () => {
    expect(existsSync('./src/lib/kernel/transform-runtime.ts')).toBe(false)
    expect(existsSync('./src/lib/services/transform-runtime.service.ts')).toBe(false)
    const source = readFile('./src/lib/services/transform-record.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/transform-runtime/)
  })

  // 11. No marketplace/pricing/settlement exists
  it('no marketplace/pricing/settlement implementation files exist; service has no marketplace code', () => {
    expect(existsSync('./src/lib/kernel/marketplace.ts')).toBe(false)
    expect(existsSync('./src/lib/services/marketplace.service.ts')).toBe(false)
    expect(existsSync('./src/lib/services/pricing.service.ts')).toBe(false)
    const source = readFile('./src/lib/services/transform-record.service.ts')
    expect(source).not.toMatch(/db\.marketplace\.|db\.pricing\.|db\.settlement\./)
    expect(source).not.toMatch(/createMarketplace|createPricing|createSettlement/)
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/marketplace\.service|pricing\.service|settlement\.service/)
  })

  // 12. No SDK exists
  it('no SDK implementation file exists', () => {
    expect(existsSync('./src/lib/kernel/sdk.ts')).toBe(false)
    expect(existsSync('./src/lib/services/sdk.service.ts')).toBe(false)
    const source = readFile('./src/lib/services/transform-record.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/\bsdk\b/)
  })

  // 13. TransformRecord is immutable (no status field, no lifecycle)
  it('TransformRecord model has no status/lifecycle field (immutable receipt)', () => {
    const schema = readFile('./prisma/schema.prisma')
    const recordStart = schema.indexOf('model TransformRecord {')
    const recordEnd = schema.indexOf('\n}', recordStart)
    const recordSection = schema.slice(recordStart, recordEnd)
    // resultStatus is the transform result, not a lifecycle status — it's set
    // at creation and never updated. The model has no 'status' field that
    // transitions (unlike TransportExecution which has created|started|completed).
    expect(recordSection).not.toMatch(/^\s*status\s+String\s+@default/m)
    expect(recordSection).toMatch(/resultStatus\s+String\s+@default\("success"\)/)
  })

  // 14. Idempotency semantics: @@unique uses nodeIdentity (non-null), NOT nodeId (nullable)
  it('TransformRecord @@unique uses nodeIdentity (non-null), NOT nodeId (nullable) — fixes NULL-unique defect', () => {
    const schema = readFile('./prisma/schema.prisma')
    const recordStart = schema.indexOf('model TransformRecord {')
    const recordEnd = schema.indexOf('\n}', recordStart)
    const recordSection = schema.slice(recordStart, recordEnd)
    // nodeIdentity must be non-null String (not String?).
    expect(recordSection).toMatch(/nodeIdentity\s+String\s/)
    // @@unique must use nodeIdentity, NOT nodeId.
    expect(recordSection).toMatch(/@@unique\(\[tenantId,\s*bundleId,\s*nodeIdentity,\s*transformType,\s*idempotencyKey\]\)/)
    // nodeId remains nullable (optional FK).
    expect(recordSection).toMatch(/nodeId\s+String\?/)
    // The old @@unique with nodeId must NOT exist.
    expect(recordSection).not.toMatch(/@@unique\(\[tenantId,\s*bundleId,\s*nodeId,\s*transformType/)
  })

  // Additional: TransformRecord has provenance fields (constitution §9)
  it('TransformRecord model has inputHash + outputHash + transformType + transformVersion + parametersJson (provenance)', () => {
    const schema = readFile('./prisma/schema.prisma')
    const recordStart = schema.indexOf('model TransformRecord {')
    const recordEnd = schema.indexOf('\n}', recordStart)
    const recordSection = schema.slice(recordStart, recordEnd)
    expect(recordSection).toMatch(/inputHash\s+String/)
    expect(recordSection).toMatch(/outputHash\s+String/)
    expect(recordSection).toMatch(/transformType\s+String/)
    expect(recordSection).toMatch(/transformVersion\s+String/)
    expect(recordSection).toMatch(/parametersJson\s+String/)
  })

  // Additional: TransformRecord references Bundle + Node (not Route/TransportExecution)
  it('TransformRecord references Bundle + optional Node (not Route/TransportExecution)', () => {
    const schema = readFile('./prisma/schema.prisma')
    const recordStart = schema.indexOf('model TransformRecord {')
    const recordEnd = schema.indexOf('\n}', recordStart)
    const recordSection = schema.slice(recordStart, recordEnd)
    expect(recordSection).toMatch(/bundleId\s+String\s*\/\/ FK to Bundle/)
    expect(recordSection).toMatch(/nodeId\s+String\?\s*\/\/ FK to Node/)
    // Does NOT reference Route or TransportExecution.
    expect(recordSection).not.toMatch(/routeId\s+String/)
    expect(recordSection).not.toMatch(/executionId\s+String/)
    expect(recordSection).not.toMatch(/attemptId\s+String/)
  })

  // Additional: fingerprint computation exists (idempotency conflict detection)
  it('transform-record service has computeTransformFingerprint with resultStatus + nodeIdentity + canonicalize', () => {
    const source = readFile('./src/lib/services/transform-record.service.ts')
    expect(source).toMatch(/computeTransformFingerprint/)
    // Check the full source for the fingerprint's material fields (not just the
    // function slice, because the type annotation closing brace confuses slicing).
    expect(source).toMatch(/nodeIdentity: input\.nodeIdentity/)
    expect(source).toMatch(/resultStatus: input\.resultStatus/)
    expect(source).toMatch(/parameters: canonicalize\(input\.parameters\)/)
    // resultMetadata must NOT be in the fingerprint.
    // Check the function region (between computeTransformFingerprint and the next function).
    const fnStart = source.indexOf('function computeTransformFingerprint')
    const canonStart = source.indexOf('function canonicalize')
    const fnRegion = source.slice(fnStart, canonStart > fnStart ? canonStart : source.length)
    expect(fnRegion).not.toMatch(/resultMetadata/)
  })

  // Additional: canonical serialization helper exists (Defect C fix)
  it('transform-record service has canonicalize() for deterministic parameter serialization', () => {
    const source = readFile('./src/lib/services/transform-record.service.ts')
    expect(source).toMatch(/function canonicalize\(/)
    // Must recursively sort keys.
    const canonStart = source.indexOf('function canonicalize(')
    const canonEnd = source.indexOf('\n}', canonStart)
    const canonFn = source.slice(canonStart, canonEnd)
    expect(canonFn).toMatch(/\.sort\(\)/)
    expect(canonFn).toMatch(/Array\.isArray/)
  })

  // Additional: service computes nodeIdentity (non-null identity representation)
  it('transform-record service computes nodeIdentity from nodeId (namespaced: node:<id> or system:__unattributed__)', () => {
    const source = readFile('./src/lib/services/transform-record.service.ts')
    // Must use namespaced encoding — not bare nodeId or bare sentinel.
    expect(source).toMatch(/`node:\$\{input\.nodeId\}`/)
    expect(source).toMatch(/'system:__unattributed__'/)
    // The create data must include nodeIdentity.
    expect(source).toMatch(/nodeIdentity,/)
  })

  // Additional: Phase 14F contract document exists
  it('Phase 14F Transform Record contract document exists', () => {
    expect(existsSync('./docs/architecture/PHASE-14F-TRANSFORM-RECORD-CONTRACT.md')).toBe(true)
  })
})
