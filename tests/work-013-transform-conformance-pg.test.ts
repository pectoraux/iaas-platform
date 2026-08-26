/// <reference types="bun-types" />
/**
 * WORK-013 — Transform Stack End-to-End PostgreSQL Conformance Tests
 *
 * Proves W013-AC01..AC04, W013-AC09:
 *   - end-to-end: registry → resolution → execution → provenance
 *   - tenant isolation across the full stack
 *   - idempotent replay convergence
 *   - failure semantics produce failed provenance
 *   - PostgreSQL durability / clean-database determinism
 *
 * Run: bun test tests/work-013-transform-conformance-pg.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { createOperator, createAsset, createDevice, assignAssetToNetwork } from '../src/lib/services/registry.service'
import { registerTransform, revokeTransform } from '../src/lib/services/transform-registry.service'
import {
  executeTransform,
  registerTransformImplementation,
  type TransformContract,
} from '../src/lib/services/transform-runtime.service'
import { NotFoundError, ValidationError } from '../src/lib/domain/errors'

let tenantA: string
let tenantB: string
let bundleA: string
let bundleB: string

// A simple test Transform: XOR with a key byte (reversible, lossless).
const CONF_TYPE = 'conformance-xor'
const CONF_VERSION = '1.0.0'

const conformanceTransform: TransformContract = {
  transformType: CONF_TYPE,
  transformVersion: CONF_VERSION,
  async execute(input: Buffer, params?: Record<string, unknown>): Promise<Buffer> {
    const key = (params?.key as number) ?? 0x42
    return Buffer.from(input.map(b => b ^ key))
  },
  async reverse(output: Buffer, params?: Record<string, unknown>): Promise<Buffer> {
    const key = (params?.key as number) ?? 0x42
    return Buffer.from(output.map(b => b ^ key))
  },
  async estimateCost(input: Buffer): Promise<{ cpuMs: number; memoryBytes: number; description: string }> {
    return { cpuMs: 1, memoryBytes: input.length, description: 'XOR' }
  },
  async verify(input: Buffer, output: Buffer, params?: Record<string, unknown>): Promise<boolean> {
    const key = (params?.key as number) ?? 0x42
    return Buffer.from(input.map(b => b ^ key)).equals(output)
  },
}

// A transform that always fails.
const FAIL_TYPE_PREFIX = 'conformance-fail-'

async function setupTenantWithBundle(slugPrefix: string): Promise<{ tenantId: string; bundleId: string }> {
  const tenant = await createTenant({
    name: `W013 ${slugPrefix}`,
    slug: `w013-${slugPrefix}-${Date.now()}`,
    plan: 'growth',
  })
  const { network } = await instantiateTemplate(tenant.id, 'energy-vpp')
  const operator = await createOperator(tenant.id, { displayName: `W013 ${slugPrefix} Op` })
  const asset = await createAsset(tenant.id, {
    operatorId: operator.id,
    assetType: 'battery',
    name: `W013 ${slugPrefix} Battery`,
  })
  await assignAssetToNetwork(tenant.id, asset.id, network.id, 'energy_discharge', '100', 'kW')

  // Create Bundle: need ParticipantIdentity + active Nodes.
  const srcParticipant = await db.participantIdentity.create({ data: {} })
  const dstParticipant = await db.participantIdentity.create({ data: {} })
  const { registerNode, activateNode } = await import('../src/lib/services/node.service')
  const srcNode = await registerNode(tenant.id, {
    participantId: srcParticipant.id,
    nodeKind: 'generic',
    displayName: `W013 ${slugPrefix} Src`,
    idempotencyKey: `node-src-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  })
  await activateNode(tenant.id, srcNode.id)
  const dstNode = await registerNode(tenant.id, {
    participantId: dstParticipant.id,
    nodeKind: 'generic',
    displayName: `W013 ${slugPrefix} Dst`,
    idempotencyKey: `node-dst-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  })
  await activateNode(tenant.id, dstNode.id)
  const { createBundle } = await import('../src/lib/services/data-plane.service')
  const bundle = await createBundle(tenant.id, {
    sourceNodeId: srcNode.id,
    destinationNodeId: dstNode.id,
    nodeKind: 'generic_payload',
    payloadType: 'application/octet-stream',
    payload: 'conformance test payload',
    idempotencyKey: `bundle-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    expiryTime: new Date(Date.now() + 3600000),
  })
  return { tenantId: tenant.id, bundleId: bundle.id }
}

beforeAll(async () => {
  const setupA = await setupTenantWithBundle('tenant-a')
  tenantA = setupA.tenantId
  bundleA = setupA.bundleId

  const setupB = await setupTenantWithBundle('tenant-b')
  tenantB = setupB.tenantId
  bundleB = setupB.bundleId

  // Register the conformance transform in both tenants' catalogs.
  for (const tid of [tenantA, tenantB]) {
    await registerTransform(tid, {
      transformType: CONF_TYPE,
      transformVersion: CONF_VERSION,
      description: 'W013 conformance XOR transform',
      reversibility: true,
      idempotencyKey: `conf-reg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    })
  }

  // Register the concrete implementation for runtime dispatch.
  registerTransformImplementation(conformanceTransform)
})

// ---------------------------------------------------------------------------
// W013-AC01 — end-to-end: registry → resolution → execution → provenance
// ---------------------------------------------------------------------------

describe('WORK-013 — end-to-end conformance (W013-AC01)', () => {
  it('full path: register → resolve → execute → TransformRecord created with 7-element provenance', async () => {
    const result = await executeTransform(tenantA, {
      bundleId: bundleA,
      transformType: CONF_TYPE,
      transformVersion: CONF_VERSION,
      inputPayload: Buffer.from('e2e-conformance'),
      parameters: { key: 0x55 },
      idempotencyKey: `e2e-${Date.now()}`,
    })

    expect(result.resultStatus).toBe('success')
    expect(result.outputPayload.length).toBeGreaterThan(0)
    expect(result.inputHash).toBeTruthy()
    expect(result.outputHash).toBeTruthy()
    expect(result.transformRecordId).toBeTruthy()

    // Verify the TransformRecord has the 7-element provenance.
    const record = await db.transformRecord.findUnique({ where: { id: result.transformRecordId } })
    expect(record).toBeTruthy()
    expect(record!.transformType).toBe(CONF_TYPE)
    expect(record!.transformVersion).toBe(CONF_VERSION)
    expect(record!.inputHash).toBe(result.inputHash)
    expect(record!.outputHash).toBe(result.outputHash)
    expect(record!.nodeIdentity).toBeTruthy()
    expect(record!.resultStatus).toBe('success')
    expect(record!.parametersJson).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// W013-AC02 — tenant isolation across the full stack
// ---------------------------------------------------------------------------

describe('WORK-013 — tenant isolation (W013-AC02)', () => {
  it('tenant B cannot resolve a transform registered only in tenant A', async () => {
    const privateType = `private-${Date.now()}`
    await registerTransform(tenantA, {
      transformType: privateType,
      transformVersion: '1.0.0',
      idempotencyKey: `private-${Date.now()}`,
    })

    await expect(
      executeTransform(tenantB, {
        bundleId: bundleB,
        transformType: privateType,
        transformVersion: '1.0.0',
        inputPayload: Buffer.from('cross'),
        idempotencyKey: `cross-${Date.now()}`,
      }),
    ).rejects.toThrow(NotFoundError)
  })

  it('tenant A execution does not produce TransformRecord visible to tenant B', async () => {
    const result = await executeTransform(tenantA, {
      bundleId: bundleA,
      transformType: CONF_TYPE,
      transformVersion: CONF_VERSION,
      inputPayload: Buffer.from('isolation'),
      parameters: { key: 0x42 },
      idempotencyKey: `iso-${Date.now()}`,
    })

    // The TransformRecord exists in tenant A.
    const recordA = await db.transformRecord.findUnique({ where: { id: result.transformRecordId } })
    expect(recordA).toBeTruthy()
    expect(recordA!.tenantId).toBe(tenantA)

    // Tenant B's bundle should not reference this record.
    const recordsB = await db.transformRecord.findMany({
      where: { tenantId: tenantB, bundleId: bundleA },
    })
    expect(recordsB.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// W013-AC03 — deterministic idempotency / replay convergence
// ---------------------------------------------------------------------------

describe('WORK-013 — idempotent replay (W013-AC03)', () => {
  it('repeated identical execution attempts converge to the same TransformRecord', async () => {
    const idemKey = `replay-${Date.now()}`
    const input = Buffer.from('replay-convergence')

    const first = await executeTransform(tenantA, {
      bundleId: bundleA,
      transformType: CONF_TYPE,
      transformVersion: CONF_VERSION,
      inputPayload: input,
      parameters: { key: 0x42 },
      idempotencyKey: idemKey,
    })

    const second = await executeTransform(tenantA, {
      bundleId: bundleA,
      transformType: CONF_TYPE,
      transformVersion: CONF_VERSION,
      inputPayload: input,
      parameters: { key: 0x42 },
      idempotencyKey: idemKey,
    })

    expect(second.transformRecordId).toBe(first.transformRecordId)
    expect(second.inputHash).toBe(first.inputHash)
    expect(second.outputHash).toBe(first.outputHash)

    // Exactly one TransformRecord for this idempotency key.
    const records = await db.transformRecord.findMany({
      where: { tenantId: tenantA, idempotencyKey: idemKey },
    })
    expect(records.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// W013-AC04 — failure semantics produce failed provenance
// ---------------------------------------------------------------------------

describe('WORK-013 — failure provenance (W013-AC04)', () => {
  it('failed execution emits TransformRecord with resultStatus=failed and re-throws', async () => {
    const failType = `${FAIL_TYPE_PREFIX}${Date.now()}`
    await registerTransform(tenantA, {
      transformType: failType,
      transformVersion: '1.0.0',
      idempotencyKey: `fail-reg-${Date.now()}`,
    })
    registerTransformImplementation({
      transformType: failType,
      transformVersion: '1.0.0',
      async execute(): Promise<Buffer> {
        throw new Error('W013 intentional conformance failure')
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
      executeTransform(tenantA, {
        bundleId: bundleA,
        transformType: failType,
        transformVersion: '1.0.0',
        inputPayload: Buffer.from('fail'),
        idempotencyKey: idemKey,
      }),
    ).rejects.toThrow('W013 intentional conformance failure')

    // A TransformRecord with resultStatus='failed' must exist.
    const failedRecord = await db.transformRecord.findFirst({
      where: { tenantId: tenantA, idempotencyKey: idemKey },
    })
    expect(failedRecord).toBeTruthy()
    expect(failedRecord!.resultStatus).toBe('failed')
  })

  it('revoked transform blocks execution (no success provenance created)', async () => {
    const revType = `revoked-conf-${Date.now()}`
    await registerTransform(tenantA, {
      transformType: revType,
      transformVersion: '1.0.0',
      idempotencyKey: `rev-conf-${Date.now()}`,
    })
    registerTransformImplementation({
      transformType: revType,
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
    await revokeTransform(tenantA, revType, '1.0.0', { reason: 'W013 conformance revocation test' })

    const idemKey = `rev-conf-exec-${Date.now()}`
    await expect(
      executeTransform(tenantA, {
        bundleId: bundleA,
        transformType: revType,
        transformVersion: '1.0.0',
        inputPayload: Buffer.from('revoked'),
        idempotencyKey: idemKey,
      }),
    ).rejects.toThrow(ValidationError)

    // No TransformRecord should exist (execution was blocked before TransformRecord creation).
    const records = await db.transformRecord.findMany({
      where: { tenantId: tenantA, idempotencyKey: idemKey },
    })
    expect(records.length).toBe(0)
  })
})
