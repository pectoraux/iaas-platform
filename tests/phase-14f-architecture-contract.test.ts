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

  // 14. Idempotency semantics: @@unique + fingerprint
  it('TransformRecord has @@unique([tenantId, bundleId, nodeId, transformType, idempotencyKey])', () => {
    const schema = readFile('./prisma/schema.prisma')
    const recordStart = schema.indexOf('model TransformRecord {')
    const recordEnd = schema.indexOf('\n}', recordStart)
    const recordSection = schema.slice(recordStart, recordEnd)
    expect(recordSection).toMatch(/@@unique\(\[tenantId,\s*bundleId,\s*nodeId,\s*transformType,\s*idempotencyKey\]\)/)
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
  it('transform-record service has computeTransformFingerprint for idempotency conflict detection', () => {
    const source = readFile('./src/lib/services/transform-record.service.ts')
    expect(source).toMatch(/computeTransformFingerprint/)
    // The fingerprint must include material fields, NOT resultMetadata.
    const fnStart = source.indexOf('function computeTransformFingerprint')
    const fnEnd = source.indexOf('\n}', fnStart)
    const fn = source.slice(fnStart, fnEnd)
    expect(fn).toMatch(/transformType/)
    expect(fn).toMatch(/transformVersion/)
    expect(fn).toMatch(/inputHash/)
    expect(fn).toMatch(/outputHash/)
    expect(fn).toMatch(/parameters/)
    // resultMetadata must NOT be in the fingerprint (non-identity-bearing).
    expect(fn).not.toMatch(/resultMetadata/)
  })

  // Additional: Phase 14F contract document exists
  it('Phase 14F Transform Record contract document exists', () => {
    expect(existsSync('./docs/architecture/PHASE-14F-TRANSFORM-RECORD-CONTRACT.md')).toBe(true)
  })
})
