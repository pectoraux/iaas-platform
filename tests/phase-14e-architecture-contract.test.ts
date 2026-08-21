/**
 * Phase 14E: Delivery Confirmation Architecture Anti-Drift Tests
 *
 * Static contract tests enforcing the DeliveryConfirmation boundary (Phase 14E
 * Step 7 — 12 rules). These complement the Phase 13/14A/14B/14C/14D
 * architecture tests and are STATIC — they read source files and assert
 * structural boundaries. No DB connection.
 *
 * Rules enforced:
 *   1. DeliveryConfirmation exists as a service-layer primitive.
 *   2. No kernel delivery primitive exists.
 *   3. DeliveryConfirmation does not import routing/transport internals.
 *   4. DeliveryConfirmation does not implement network protocols.
 *   5. DeliveryConfirmation does not modify Bundle.
 *   6. DeliveryConfirmation does not modify Route.
 *   7. DeliveryConfirmation does not modify Node.
 *   8. DeliveryConfirmation does not modify TransportExecution/TransportAttempt.
 *   9. No retransmission/timer/sliding-window implementation exists.
 *  10. No DTN/custody-transfer implementation exists.
 *  11. No marketplace/pricing/settlement exists.
 *  12. No SDK exists.
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

describe('Phase 14E: Delivery Confirmation Architecture Anti-Drift', () => {
  // 1. DeliveryConfirmation exists as a service-layer primitive
  it('DeliveryConfirmation service exists at the service layer', () => {
    expect(existsSync('./src/lib/services/delivery-confirmation.service.ts')).toBe(true)
  })

  // 2. No kernel delivery primitive exists
  it('no kernel delivery/confirmation primitive files exist', () => {
    const kernelFiles = [
      './src/lib/kernel/delivery.ts',
      './src/lib/kernel/confirmation.ts',
      './src/lib/kernel/receipt.ts',
      './src/lib/kernel/acknowledgment.ts',
    ]
    for (const f of kernelFiles) {
      expect(existsSync(f)).toBe(false)
    }
  })

  // 3. DeliveryConfirmation does not import routing/transport internals
  it('delivery-confirmation service does not import routing/transport mutation functions', () => {
    const source = readFile('./src/lib/services/delivery-confirmation.service.ts')
    const imports = getImportLines(source)
    // May import getBundle/getNode/getRoute for read validation, but NOT mutation functions.
    expect(imports).not.toMatch(/createRoutePlan|addRouteHop|activateRoute|completeRoute/)
    expect(imports).not.toMatch(/createTransportExecution|startTransportExecution|completeTransportExecution/)
    expect(imports).not.toMatch(/createTransportAttempt|markAttemptSent|acknowledgeAttempt|failAttempt/)
  })

  // 4. DeliveryConfirmation does not implement network protocols
  it('delivery-confirmation service does not implement network protocols (no socket/connect/fetch)', () => {
    const source = readFile('./src/lib/services/delivery-confirmation.service.ts')
    expect(source).not.toMatch(/net\.connect|net\.createConnection|socket\.connect|dgram\.createSocket|http\.request|https\.request|fetch\(/)
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/from ['"]net['"]|from ['"]http['"]|from ['"]https['"]|from ['"]dgram['"]|from ['"]ws['"]/)
  })

  // 5. DeliveryConfirmation does not modify Bundle
  it('delivery-confirmation service does not call db.bundle.update/create/delete', () => {
    const source = readFile('./src/lib/services/delivery-confirmation.service.ts')
    expect(source).not.toMatch(/db\.bundle\.(update|create|delete|upsert)/)
  })

  // 6. DeliveryConfirmation does not modify Route
  it('delivery-confirmation service does not call db.route.update/create/delete', () => {
    const source = readFile('./src/lib/services/delivery-confirmation.service.ts')
    expect(source).not.toMatch(/db\.route\.(update|create|delete|upsert)/)
  })

  // 7. DeliveryConfirmation does not modify Node
  it('delivery-confirmation service does not call db.node.update/create/delete', () => {
    const source = readFile('./src/lib/services/delivery-confirmation.service.ts')
    expect(source).not.toMatch(/db\.node\.(update|create|delete|upsert)/)
  })

  // 8. DeliveryConfirmation does not modify TransportExecution/TransportAttempt
  it('delivery-confirmation service does not call db.transportExecution/transportAttempt.update/create/delete', () => {
    const source = readFile('./src/lib/services/delivery-confirmation.service.ts')
    expect(source).not.toMatch(/db\.transportExecution\.(update|create|delete|upsert)/)
    expect(source).not.toMatch(/db\.transportAttempt\.(update|create|delete|upsert)/)
  })

  // 9. No retransmission/timer/sliding-window implementation exists
  it('no retransmission/timer/sliding-window implementation files exist', () => {
    expect(existsSync('./src/lib/services/retransmission.service.ts')).toBe(false)
    expect(existsSync('./src/lib/services/sliding-window.service.ts')).toBe(false)
    expect(existsSync('./src/lib/kernel/timer.ts')).toBe(false)
    expect(existsSync('./src/lib/kernel/retransmission.ts')).toBe(false)
    const source = readFile('./src/lib/services/delivery-confirmation.service.ts')
    expect(source).not.toMatch(/setTimeout|setInterval|retransmit|slidingWindow|windowSize/i)
  })

  // 10. No DTN/custody-transfer implementation exists
  it('no DTN/custody-transfer implementation files exist', () => {
    expect(existsSync('./src/lib/kernel/dtn.ts')).toBe(false)
    expect(existsSync('./src/lib/services/dtn.service.ts')).toBe(false)
    expect(existsSync('./src/lib/kernel/custody-transfer.ts')).toBe(false)
    const source = readFile('./src/lib/services/delivery-confirmation.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/dtn|custody/i)
  })

  // 11. No marketplace/pricing/settlement exists
  it('no marketplace/pricing/settlement implementation files exist; service has no marketplace code', () => {
    expect(existsSync('./src/lib/kernel/marketplace.ts')).toBe(false)
    expect(existsSync('./src/lib/services/marketplace.service.ts')).toBe(false)
    expect(existsSync('./src/lib/services/pricing.service.ts')).toBe(false)
    // Check for actual marketplace/pricing CODE (function calls, not comment mentions).
    const source = readFile('./src/lib/services/delivery-confirmation.service.ts')
    expect(source).not.toMatch(/db\.marketplace\.|db\.pricing\.|db\.settlement\./)
    expect(source).not.toMatch(/createMarketplace|createPricing|createSettlement/)
    // No marketplace/pricing imports.
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/marketplace\.service|pricing\.service|settlement\.service/)
  })

  // 12. No SDK exists
  it('no SDK implementation file exists', () => {
    expect(existsSync('./src/lib/kernel/sdk.ts')).toBe(false)
    expect(existsSync('./src/lib/services/sdk.service.ts')).toBe(false)
    const source = readFile('./src/lib/services/delivery-confirmation.service.ts')
    const imports = getImportLines(source)
    expect(imports).not.toMatch(/\bsdk\b/)
  })

  // Additional: DeliveryConfirmation model has immutable receipt fields
  it('DeliveryConfirmation model has confirmationHash + confirmedAt + receiverNodeId (receipt fields)', () => {
    const schema = readFile('./prisma/schema.prisma')
    const confirmStart = schema.indexOf('model DeliveryConfirmation {')
    const confirmEnd = schema.indexOf('\n}', confirmStart)
    const confirmSection = schema.slice(confirmStart, confirmEnd)
    expect(confirmSection).toMatch(/confirmationHash\s+String/)
    expect(confirmSection).toMatch(/confirmedAt\s+DateTime/)
    expect(confirmSection).toMatch(/receiverNodeId\s+String/)
    // No status field — it's immutable (no lifecycle).
    expect(confirmSection).not.toMatch(/status\s+String\s+@default/)
  })

  // Additional: DeliveryConfirmation has idempotency via @@unique
  it('DeliveryConfirmation has @@unique([tenantId, bundleId, receiverNodeId, idempotencyKey])', () => {
    const schema = readFile('./prisma/schema.prisma')
    const confirmStart = schema.indexOf('model DeliveryConfirmation {')
    const confirmEnd = schema.indexOf('\n}', confirmStart)
    const confirmSection = schema.slice(confirmStart, confirmEnd)
    expect(confirmSection).toMatch(/@@unique\(\[tenantId,\s*bundleId,\s*receiverNodeId,\s*idempotencyKey\]\)/)
  })

  // Additional: Phase 14E contract document exists
  it('Phase 14E Delivery Confirmation contract document exists', () => {
    expect(existsSync('./docs/architecture/PHASE-14E-DELIVERY-CONFIRMATION-CONTRACT.md')).toBe(true)
  })

  // ADVERSARIAL: confirmationHash MUST include transportAttemptId in the fingerprint
  it('confirmationHash derivation includes transportAttemptId (fingerprint is material)', () => {
    const source = readFile('./src/lib/services/delivery-confirmation.service.ts')
    // The computeConfirmationHash function must include transportAttemptId.
    const hashFnStart = source.indexOf('function computeConfirmationHash')
    const hashFnEnd = source.indexOf('\n}', hashFnStart)
    const hashFn = source.slice(hashFnStart, hashFnEnd)
    expect(hashFn).toMatch(/transportAttemptId/)
  })

  // ADVERSARIAL: P2002 handler MUST distinguish transportAttemptId @unique from idempotency key
  it('P2002 handler distinguishes transportAttemptId @unique from idempotency key (via meta.target)', () => {
    const source = readFile('./src/lib/services/delivery-confirmation.service.ts')
    // The handler must inspect meta.target, not just check code === 'P2002'.
    expect(source).toMatch(/getP2002Target/)
    expect(source).toMatch(/meta\?.target/)
    // Must check for 'transportAttemptId' in the target.
    expect(source).toMatch(/target\.includes\(['"]transportAttemptId['"]\)/)
    // Must NOT use the old isPrismaUniqueConstraintError that blindly treats all P2002 as replay.
    expect(source).not.toMatch(/isPrismaUniqueConstraintError/)
  })

  // ADVERSARIAL: verifyDeliveryConfirmation MUST use the same hash derivation as creation
  it('verifyDeliveryConfirmation uses computeConfirmationHash (single canonical derivation)', () => {
    const source = readFile('./src/lib/services/delivery-confirmation.service.ts')
    const verifyStart = source.indexOf('export async function verifyDeliveryConfirmation')
    const verifyEnd = source.indexOf('\n}', verifyStart)
    const verifyFn = source.slice(verifyStart, verifyEnd)
    // Must call computeConfirmationHash, not inline a different sha256/JSON.stringify.
    expect(verifyFn).toMatch(/computeConfirmationHash/)
    // Must NOT have a duplicated inline sha256(JSON.stringify(...)) that differs from creation.
    expect(verifyFn).not.toMatch(/sha256\(\s*JSON\.stringify/)
  })

  // ADVERSARIAL: metadata is NOT in the hash (non-identity-bearing)
  it('confirmationHash does NOT include metadata (metadata is non-identity-bearing)', () => {
    const source = readFile('./src/lib/services/delivery-confirmation.service.ts')
    const hashFnStart = source.indexOf('function computeConfirmationHash')
    const hashFnEnd = source.indexOf('\n}', hashFnStart)
    const hashFn = source.slice(hashFnStart, hashFnEnd)
    expect(hashFn).not.toMatch(/metadata/)
  })
})
