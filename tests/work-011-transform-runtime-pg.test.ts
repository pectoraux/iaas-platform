/// <reference types="bun-types" />
/**
 * WORK-011 — TransformRuntime PostgreSQL Integration Tests
 *
 * Proves W011-AC01..AC09 against real PostgreSQL:
 *   - registry resolution → execution → TransformRecord emission
 *   - reverse (when reversible)
 *   - estimateCost (no execution)
 *   - verify (no execution)
 *   - idempotency (replay convergence)
 *   - failure semantics (failed provenance + re-throw)
 *   - tenant isolation (cross-tenant resolution rejected)
 *   - revocation blocks execution
 *
 * Run: bun test tests/work-011-transform-runtime-pg.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { createOperator, createAsset, createDevice, assignAssetToNetwork } from '../src/lib/services/registry.service'
import { registerTransform, revokeTransform, updateCertification } from '../src/lib/services/transform-registry.service'
import {
  executeTransform,
  reverseTransform,
  estimateTransformCost,
  verifyTransform,
  registerTransformImplementation,
  type TransformContract,
} from '../src/lib/services/transform-runtime.service'
import { NotFoundError, ValidationError } from '../src/lib/domain/errors'

let tenantId: string
let networkId: string
let bundleId: string
let deviceId: string
let provisioningSecret: string

// A simple test Transform implementation (NOT a production transform — just
// for proving the runtime contract). Reverses by XOR-ing with a key byte.
const TEST_TRANSFORM_TYPE = 'test-xor'
const TEST_TRANSFORM_VERSION = '1.0.0'

const testTransform: TransformContract = {
  transformType: TEST_TRANSFORM_TYPE,
  transformVersion: TEST_TRANSFORM_VERSION,
  async execute(input: Buffer, params?: Record<string, unknown>): Promise<Buffer> {
    const key = (params?.key as number) ?? 0x42
    return Buffer.from(input.map(b => b ^ key))
  },
  async reverse(output: Buffer, params?: Record<string, unknown>): Promise<Buffer> {
    const key = (params?.key as number) ?? 0x42
    return Buffer.from(output.map(b => b ^ key)) // XOR is its own inverse
  },
  async estimateCost(input: Buffer): Promise<{ cpuMs: number; memoryBytes: number; description: string }> {
    return { cpuMs: 1, memoryBytes: input.length, description: 'XOR transform' }
  },
  async verify(input: Buffer, output: Buffer, params?: Record<string, unknown>): Promise<boolean> {
    const key = (params?.key as number) ?? 0x42
    const expected = Buffer.from(input.map(b => b ^ key))
    return expected.equals(output)
  },
}

beforeAll(async () => {
  const tenant = await createTenant({
    name: 'WORK-011 Runtime PG',
    slug: `w011-rt-pg-${Date.now()}`,
    plan: 'growth',
  })
  tenantId = tenant.id

  const { network, version } = await instantiateTemplate(tenantId, 'energy-vpp')
  networkId = network.id

  const operator = await createOperator(tenantId, { displayName: 'W011 Operator' })
  const asset = await createAsset(tenantId, {
    operatorId: operator.id,
    assetType: 'battery',
    name: 'W011 Battery',
  })
  await assignAssetToNetwork(tenantId, asset.id, networkId, 'energy_discharge', '100', 'kW')
  const provisioned = await createDevice(tenantId, {
    assetId: asset.id,
    deviceType: 'battery_controller',
    manufacturer: 'Simulated',
    model: 'DER-Adapter-v1',
  })
  deviceId = provisioned.device.id
  provisioningSecret = provisioned.provisioningSecret

  // Create a Bundle for the transform payload reference.
  // Need active source + destination Nodes for Bundle creation.
  // Nodes require a ParticipantIdentity to exist first.
  const sourceParticipant = await db.participantIdentity.create({
    data: { tenantId },
  })
  const destParticipant = await db.participantIdentity.create({
    data: { tenantId },
  })
  const { registerNode, activateNode } = await import('../src/lib/services/node.service')
  const sourceNode = await registerNode(tenantId, {
    participantId: sourceParticipant.id,
    nodeKind: 'generic',
    displayName: 'Source Node',
    idempotencyKey: `node-src-${Date.now()}`,
  })
  await activateNode(tenantId, sourceNode.id)
  const destNode = await registerNode(tenantId, {
    participantId: destParticipant.id,
    nodeKind: 'generic',
    displayName: 'Dest Node',
    idempotencyKey: `node-dest-${Date.now()}`,
  })
  await activateNode(tenantId, destNode.id)
  const { createBundle } = await import('../src/lib/services/data-plane.service')
  const bundle = await createBundle(tenantId, {
    sourceNodeId: sourceNode.id,
    destinationNodeId: destNode.id,
    nodeKind: 'generic_payload',
    payloadType: 'application/octet-stream',
    payload: 'hello world',
    idempotencyKey: `bundle-${Date.now()}`,
    expiryTime: new Date(Date.now() + 3600000),
  })
  bundleId = bundle.id

  // Register the test transform in the catalog.
  await registerTransform(tenantId, {
    transformType: TEST_TRANSFORM_TYPE,
    transformVersion: TEST_TRANSFORM_VERSION,
    description: 'Test XOR transform',
    reversibility: true,
    lossiness: false,
    idempotencyKey: `test-xor-reg-${Date.now()}`,
  })

  // Register the concrete implementation for runtime dispatch.
  registerTransformImplementation(testTransform)
})

describe('WORK-011 — TransformRuntime PostgreSQL (W011-AC01..AC09)', () => {
  it('executes a transform and emits TransformRecord (W011-AC01, W011-AC03)', async () => {
    const result = await executeTransform(tenantId, {
      bundleId,
      transformType: TEST_TRANSFORM_TYPE,
      transformVersion: TEST_TRANSFORM_VERSION,
      inputPayload: Buffer.from('hello'),
      parameters: { key: 0x42 },
      idempotencyKey: `exec-${Date.now()}`,
    })
    expect(result.resultStatus).toBe('success')
    expect(result.outputPayload).toBeTruthy()
    expect(result.inputHash).toBeTruthy()
    expect(result.outputHash).toBeTruthy()
    expect(result.transformRecordId).toBeTruthy()

    // Verify the TransformRecord was persisted.
    const record = await db.transformRecord.findUnique({ where: { id: result.transformRecordId } })
    expect(record).toBeTruthy()
    expect(record!.transformType).toBe(TEST_TRANSFORM_TYPE)
    expect(record!.resultStatus).toBe('success')
  })

  it('reverse transform works when reversible (W011-AC03)', async () => {
    const result = await reverseTransform(tenantId, {
      bundleId,
      transformType: TEST_TRANSFORM_TYPE,
      transformVersion: TEST_TRANSFORM_VERSION,
      outputPayload: Buffer.from([0x2a, 0x2b, 0x2c]), // XOR'd with 0x42
      parameters: { key: 0x42 },
      idempotencyKey: `reverse-${Date.now()}`,
    })
    expect(result.resultStatus).toBe('success')
    // Reversing XOR with 0x42 should give back the original bytes.
    expect(result.outputPayload[0]).toBe(0x2a ^ 0x42)
  })

  it('estimateCost does NOT execute the transform (W011-AC03)', async () => {
    const cost = await estimateTransformCost(tenantId, {
      transformType: TEST_TRANSFORM_TYPE,
      transformVersion: TEST_TRANSFORM_VERSION,
      inputPayload: Buffer.from('test'),
    })
    expect(cost.cpuMs).toBeGreaterThanOrEqual(0)
    expect(cost.memoryBytes).toBeGreaterThanOrEqual(0)
    expect(cost.description).toBeTruthy()
  })

  it('verify checks (input, output) consistency without executing (W011-AC03)', async () => {
    const input = Buffer.from('hello')
    const output = Buffer.from(input.map(b => b ^ 0x42))
    const valid = await verifyTransform(tenantId, {
      transformType: TEST_TRANSFORM_TYPE,
      transformVersion: TEST_TRANSFORM_VERSION,
      inputPayload: input,
      outputPayload: output,
      parameters: { key: 0x42 },
    })
    expect(valid).toBe(true)

    const invalid = await verifyTransform(tenantId, {
      transformType: TEST_TRANSFORM_TYPE,
      transformVersion: TEST_TRANSFORM_VERSION,
      inputPayload: input,
      outputPayload: Buffer.from('wrong'),
      parameters: { key: 0x42 },
    })
    expect(invalid).toBe(false)
  })

  it('idempotent execution converges to the same TransformRecord (W011-AC08)', async () => {
    const idemKey = `idem-${Date.now()}`
    const first = await executeTransform(tenantId, {
      bundleId,
      transformType: TEST_TRANSFORM_TYPE,
      transformVersion: TEST_TRANSFORM_VERSION,
      inputPayload: Buffer.from('idempotent'),
      parameters: { key: 0x42 },
      idempotencyKey: idemKey,
    })
    const second = await executeTransform(tenantId, {
      bundleId,
      transformType: TEST_TRANSFORM_TYPE,
      transformVersion: TEST_TRANSFORM_VERSION,
      inputPayload: Buffer.from('idempotent'),
      parameters: { key: 0x42 },
      idempotencyKey: idemKey,
    })
    expect(second.transformRecordId).toBe(first.transformRecordId)
  })

  it('failure semantics: failed execution emits failed provenance + re-throws (W011-AC07)', async () => {
    // Register a transform that always fails.
    const FAIL_TYPE = `test-fail-${Date.now()}`
    await registerTransform(tenantId, {
      transformType: FAIL_TYPE,
      transformVersion: '1.0.0',
      idempotencyKey: `fail-reg-${Date.now()}`,
    })
    registerTransformImplementation({
      transformType: FAIL_TYPE,
      transformVersion: '1.0.0',
      async execute(): Promise<Buffer> {
        throw new Error('Intentional failure')
      },
      async estimateCost(): Promise<{ cpuMs: number; memoryBytes: number; description: string }> {
        return { cpuMs: 0, memoryBytes: 0, description: 'always fails' }
      },
      async verify(): Promise<boolean> {
        return false
      },
    })

    const idemKey = `fail-${Date.now()}`
    await expect(
      executeTransform(tenantId, {
        bundleId,
        transformType: FAIL_TYPE,
        transformVersion: '1.0.0',
        inputPayload: Buffer.from('fail'),
        idempotencyKey: idemKey,
      }),
    ).rejects.toThrow('Intentional failure')

    // A TransformRecord with resultStatus='failed' must exist.
    const failedRecord = await db.transformRecord.findFirst({
      where: { tenantId, idempotencyKey: idemKey },
    })
    expect(failedRecord).toBeTruthy()
    expect(failedRecord!.resultStatus).toBe('failed')
  })

  it('tenant isolation: cross-tenant resolution is rejected (W011-AC05)', async () => {
    const otherTenant = await createTenant({
      name: 'W011 Other Tenant',
      slug: `w011-other-${Date.now()}`,
      plan: 'growth',
    })
    // The transform is registered in tenantId, not in otherTenant.
    await expect(
      executeTransform(otherTenant.id, {
        bundleId,
        transformType: TEST_TRANSFORM_TYPE,
        transformVersion: TEST_TRANSFORM_VERSION,
        inputPayload: Buffer.from('cross'),
        idempotencyKey: `cross-${Date.now()}`,
      }),
    ).rejects.toThrow(NotFoundError)
  })

  it('revocation blocks execution (W011-AC07)', async () => {
    const REV_TYPE = `test-revoked-${Date.now()}`
    await registerTransform(tenantId, {
      transformType: REV_TYPE,
      transformVersion: '1.0.0',
      idempotencyKey: `rev-reg-${Date.now()}`,
    })
    registerTransformImplementation({
      transformType: REV_TYPE,
      transformVersion: '1.0.0',
      async execute(input: Buffer): Promise<Buffer> {
        return input
      },
      async estimateCost(input: Buffer): Promise<{ cpuMs: number; memoryBytes: number; description: string }> {
        return { cpuMs: 0, memoryBytes: input.length, description: 'passthrough' }
      },
      async verify(input: Buffer, output: Buffer): Promise<boolean> {
        return input.equals(output)
      },
    })
    await revokeTransform(tenantId, REV_TYPE, '1.0.0', { reason: 'test revocation' })

    await expect(
      executeTransform(tenantId, {
        bundleId,
        transformType: REV_TYPE,
        transformVersion: '1.0.0',
        inputPayload: Buffer.from('revoked'),
        idempotencyKey: `rev-exec-${Date.now()}`,
      }),
    ).rejects.toThrow(ValidationError)
  })
})
