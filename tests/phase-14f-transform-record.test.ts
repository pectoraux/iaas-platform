/**
 * Phase 14F: Transform Record Foundation — Integration Tests
 *
 * Proves the frozen TransformRecord contract
 * (docs/architecture/PHASE-14F-TRANSFORM-RECORD-CONTRACT.md):
 *   - TransformRecord is an immutable provenance record (not a registry/runtime).
 *   - Tenant isolation, Node authorization, Bundle reference.
 *   - Idempotent creation, concurrent convergence, conflict detection.
 *   - Does NOT modify Bundle/Route/Node/TransportExecution/TransportAttempt/DeliveryConfirmation.
 *
 * Tests:
 *   T1 — TransformRecord creation (persisted correctly).
 *   T2 — Tenant isolation.
 *   T3 — Bundle immutability (record references Bundle, cannot mutate).
 *   T4 — Node validation (inactive/nonexistent/cross-tenant rejected).
 *   T5 — Idempotent replay (same key + same fingerprint returns existing).
 *   T6 — Idempotency conflict (same key + different fingerprint → ConflictError).
 *   T7 — Metadata is non-identity-bearing (different resultMetadata replays).
 *   T8 — Concurrent convergence (3 concurrent calls → 1 record).
 *
 * Run: DATABASE_URL=postgresql://... bun test tests/phase-14f-transform-record.test.ts --timeout 300000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { registerNode, activateNode, suspendNode } from '../src/lib/services/node.service'
import { createBundle, getBundle } from '../src/lib/services/data-plane.service'
import {
  createTransformRecord,
  getTransformRecord,
  listTransformRecords,
} from '../src/lib/services/transform-record.service'
import { initializeBootstrap } from '../src/lib/bootstrap'
import { NotFoundError, ValidationError, ConflictError } from '../src/lib/domain/errors'
import { sha256 } from '../src/lib/domain/crypto'

const databaseUrl = process.env.DATABASE_URL || ''
const isPostgres =
  databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')
const describeOrSkip = isPostgres ? describe : describe.skip

beforeAll(() => {
  if (!isPostgres) return
  initializeBootstrap()
})

// ---------------------------------------------------------------------------
// Fixture: isolated tenant + 2 Nodes + Bundle
// ---------------------------------------------------------------------------

interface TransformFixture {
  tenantId: string
  sourceNodeId: string
  destinationNodeId: string
  participantId: string
  bundleId: string
}

const FUTURE_EXPIRY = () => new Date(Date.now() + 60 * 60 * 1000) // +1h

async function createTransformFixture(label: string): Promise<TransformFixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const labelLc = label.toLowerCase()

  const tenant = await createTenant({
    name: `Phase 14F Transform — ${label}`,
    slug: `p14f-${labelLc}-${stamp}`,
    plan: 'growth',
  })

  const participant = await db.participantIdentity.create({ data: {} })

  const mkNode = async (suffix: string, display: string) => {
    const n = await registerNode(tenant.id, {
      participantId: participant.id,
      nodeKind: 'protocol_endpoint',
      displayName: display,
      idempotencyKey: `${suffix}-${labelLc}-${stamp}`,
    })
    await activateNode(tenant.id, n.id)
    return n
  }

  const sourceNode = await mkNode('src', `Source ${label}`)
  const destNode = await mkNode('dst', `Dest ${label}`)

  const bundle = await createBundle(tenant.id, {
    sourceNodeId: sourceNode.id,
    destinationNodeId: destNode.id,
    nodeKind: 'generic_payload',
    payloadType: 'application/json',
    payload: '{"transform":"test"}',
    idempotencyKey: `bundle-${labelLc}-${stamp}`,
    expiryTime: FUTURE_EXPIRY(),
  })

  return {
    tenantId: tenant.id,
    sourceNodeId: sourceNode.id,
    destinationNodeId: destNode.id,
    participantId: participant.id,
    bundleId: bundle.id,
  }
}

async function createSecondTenant(label: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return createTenant({
    name: `Phase 14F Other — ${label}`,
    slug: `p14f-other-${label.toLowerCase()}-${stamp}`,
    plan: 'growth',
  })
}

// ===========================================================================
// T1 — TransformRecord creation
// ===========================================================================

describeOrSkip('Phase 14F: T1 — TransformRecord creation', () => {
  it('record is persisted correctly with all provenance fields', async () => {
    const f = await createTransformFixture('T1')

    const record = await createTransformRecord(f.tenantId, {
      bundleId: f.bundleId,
      nodeId: f.sourceNodeId,
      transformType: 'compression',
      transformVersion: '1.0.0',
      inputHash: sha256('input-data'),
      outputHash: sha256('output-data'),
      parameters: { algorithm: 'gzip', level: 6 },
      resultStatus: 'success',
      resultMetadata: { ratio: 0.45 },
      idempotencyKey: 't1-key',
    })

    expect(record.id).toBeDefined()
    expect(record.tenantId).toBe(f.tenantId)
    expect(record.bundleId).toBe(f.bundleId)
    expect(record.nodeId).toBe(f.sourceNodeId)
    expect(record.transformType).toBe('compression')
    expect(record.transformVersion).toBe('1.0.0')
    expect(record.inputHash).toBe(sha256('input-data'))
    expect(record.outputHash).toBe(sha256('output-data'))
    expect(record.resultStatus).toBe('success')

    // Re-read to confirm persistence.
    const refetched = await getTransformRecord(f.tenantId, record.id)
    expect(refetched.id).toBe(record.id)
    expect(refetched.transformType).toBe('compression')
  })
})

// ===========================================================================
// T2 — Tenant isolation
// ===========================================================================

describeOrSkip('Phase 14F: T2 — Tenant isolation', () => {
  it('Tenant A cannot access Tenant B transform records', async () => {
    const f = await createTransformFixture('T2')
    const tenantB = await createSecondTenant('T2')

    const record = await createTransformRecord(f.tenantId, {
      bundleId: f.bundleId,
      nodeId: f.sourceNodeId,
      transformType: 'compression',
      transformVersion: '1.0.0',
      inputHash: sha256('input'),
      outputHash: sha256('output'),
      idempotencyKey: 't2-key',
    })

    // Tenant A can read it.
    const fetched = await getTransformRecord(f.tenantId, record.id)
    expect(fetched.id).toBe(record.id)

    // Tenant B cannot read it.
    await expect(getTransformRecord(tenantB.id, record.id)).rejects.toBeInstanceOf(NotFoundError)

    // Tenant B cannot list it.
    const tenantBRecords = await listTransformRecords(tenantB.id)
    expect(tenantBRecords.find((r) => r.id === record.id)).toBeUndefined()
  })
})

// ===========================================================================
// T3 — Bundle immutability
// ===========================================================================

describeOrSkip('Phase 14F: T3 — Bundle immutability', () => {
  it('TransformRecord references Bundle but cannot mutate its identity', async () => {
    const f = await createTransformFixture('T3')

    const bundleBefore = await getBundle(f.tenantId, f.bundleId)
    const beforeId = bundleBefore.id
    const beforePayload = bundleBefore.payloadBytesJson
    const beforeHash = bundleBefore.payloadHash
    const beforeDest = bundleBefore.destinationNodeId

    await createTransformRecord(f.tenantId, {
      bundleId: f.bundleId,
      nodeId: f.sourceNodeId,
      transformType: 'compression',
      transformVersion: '1.0.0',
      inputHash: sha256('input'),
      outputHash: sha256('output'),
      idempotencyKey: 't3-key',
    })

    // Bundle is UNCHANGED.
    const bundleAfter = await getBundle(f.tenantId, f.bundleId)
    expect(bundleAfter.id).toBe(beforeId)
    expect(bundleAfter.payloadBytesJson).toBe(beforePayload)
    expect(bundleAfter.payloadHash).toBe(beforeHash)
    expect(bundleAfter.destinationNodeId).toBe(beforeDest)
  })
})

// ===========================================================================
// T4 — Node validation
// ===========================================================================

describeOrSkip('Phase 14F: T4 — Node validation', () => {
  it('inactive/nonexistent/cross-tenant Node is rejected', async () => {
    const f = await createTransformFixture('T4')

    // Nonexistent Node.
    await expect(
      createTransformRecord(f.tenantId, {
        bundleId: f.bundleId,
        nodeId: 'nonexistent-node-id',
        transformType: 'compression',
        transformVersion: '1.0.0',
        inputHash: sha256('input'),
        outputHash: sha256('output'),
        idempotencyKey: 't4a-key',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)

    // Suspended Node.
    const suspendedNode = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'Suspended transform node',
      idempotencyKey: 't4-suspended',
    })
    await suspendNode(f.tenantId, suspendedNode.id)
    await expect(
      createTransformRecord(f.tenantId, {
        bundleId: f.bundleId,
        nodeId: suspendedNode.id,
        transformType: 'compression',
        transformVersion: '1.0.0',
        inputHash: sha256('input'),
        outputHash: sha256('output'),
        idempotencyKey: 't4b-key',
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    // Cross-tenant Node.
    const tenantB = await createSecondTenant('T4')
    const participantB = await db.participantIdentity.create({ data: {} })
    const nodeB = await registerNode(tenantB.id, {
      participantId: participantB.id,
      nodeKind: 'protocol_endpoint',
      displayName: 'Tenant B node',
      idempotencyKey: 't4-nodeB',
    })
    await activateNode(tenantB.id, nodeB.id)
    await expect(
      createTransformRecord(f.tenantId, {
        bundleId: f.bundleId,
        nodeId: nodeB.id,
        transformType: 'compression',
        transformVersion: '1.0.0',
        inputHash: sha256('input'),
        outputHash: sha256('output'),
        idempotencyKey: 't4c-key',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)

    // Active Node succeeds; null nodeId (system-applied) also succeeds.
    const r1 = await createTransformRecord(f.tenantId, {
      bundleId: f.bundleId,
      nodeId: f.sourceNodeId,
      transformType: 'compression',
      transformVersion: '1.0.0',
      inputHash: sha256('input'),
      outputHash: sha256('output'),
      idempotencyKey: 't4d-key',
    })
    expect(r1.nodeId).toBe(f.sourceNodeId)

    const r2 = await createTransformRecord(f.tenantId, {
      bundleId: f.bundleId,
      transformType: 'system_transform',
      transformVersion: '1.0.0',
      inputHash: sha256('input'),
      outputHash: sha256('output'),
      idempotencyKey: 't4e-key',
    })
    expect(r2.nodeId).toBeNull()
  })
})

// ===========================================================================
// T5 — Idempotent replay
// ===========================================================================

describeOrSkip('Phase 14F: T5 — Idempotent replay', () => {
  it('same key + same fingerprint returns the existing record', async () => {
    const f = await createTransformFixture('T5')

    const input = {
      bundleId: f.bundleId,
      nodeId: f.sourceNodeId,
      transformType: 'compression',
      transformVersion: '1.0.0',
      inputHash: sha256('input'),
      outputHash: sha256('output'),
      parameters: { algorithm: 'gzip' },
      idempotencyKey: 't5-key',
    }

    const r1 = await createTransformRecord(f.tenantId, input)
    const r2 = await createTransformRecord(f.tenantId, input)

    // Both return the SAME record.
    expect(r2.id).toBe(r1.id)

    // Exactly one record row.
    const count = await db.transformRecord.count({
      where: { tenantId: f.tenantId, idempotencyKey: 't5-key' },
    })
    expect(count).toBe(1)
  })
})

// ===========================================================================
// T6 — Idempotency conflict
// ===========================================================================

describeOrSkip('Phase 14F: T6 — Idempotency conflict', () => {
  it('same key + different outputHash raises ConflictError', async () => {
    const f = await createTransformFixture('T6')

    await createTransformRecord(f.tenantId, {
      bundleId: f.bundleId,
      nodeId: f.sourceNodeId,
      transformType: 'compression',
      transformVersion: '1.0.0',
      inputHash: sha256('input'),
      outputHash: sha256('output-A'),
      idempotencyKey: 't6-key',
    })

    // Same key, different outputHash → ConflictError.
    await expect(
      createTransformRecord(f.tenantId, {
        bundleId: f.bundleId,
        nodeId: f.sourceNodeId,
        transformType: 'compression',
        transformVersion: '1.0.0',
        inputHash: sha256('input'),
        outputHash: sha256('output-B'), // different
        idempotencyKey: 't6-key',
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('same key + different transformVersion raises ConflictError', async () => {
    const f = await createTransformFixture('T6b')

    await createTransformRecord(f.tenantId, {
      bundleId: f.bundleId,
      nodeId: f.sourceNodeId,
      transformType: 'compression',
      transformVersion: '1.0.0',
      inputHash: sha256('input'),
      outputHash: sha256('output'),
      idempotencyKey: 't6b-key',
    })

    // Same identity key (tenantId, bundleId, nodeId, transformType, idempotencyKey)
    // but different transformVersion (part of fingerprint, NOT part of identity key)
    // → ConflictError.
    await expect(
      createTransformRecord(f.tenantId, {
        bundleId: f.bundleId,
        nodeId: f.sourceNodeId,
        transformType: 'compression', // SAME type (identity key matches)
        transformVersion: '2.0.0', // DIFFERENT version (fingerprint differs)
        inputHash: sha256('input'),
        outputHash: sha256('output'),
        idempotencyKey: 't6b-key',
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })
})

// ===========================================================================
// T7 — Metadata is non-identity-bearing
// ===========================================================================

describeOrSkip('Phase 14F: T7 — Metadata non-identity-bearing', () => {
  it('same key + same fingerprint + different resultMetadata replays', async () => {
    const f = await createTransformFixture('T7')

    const r1 = await createTransformRecord(f.tenantId, {
      bundleId: f.bundleId,
      nodeId: f.sourceNodeId,
      transformType: 'compression',
      transformVersion: '1.0.0',
      inputHash: sha256('input'),
      outputHash: sha256('output'),
      parameters: { algorithm: 'gzip' },
      resultMetadata: { ratio: 0.45, timestamp: '2026-01-01' },
      idempotencyKey: 't7-key',
    })

    // Same key + same fingerprint + DIFFERENT resultMetadata → idempotent replay.
    const r2 = await createTransformRecord(f.tenantId, {
      bundleId: f.bundleId,
      nodeId: f.sourceNodeId,
      transformType: 'compression',
      transformVersion: '1.0.0',
      inputHash: sha256('input'),
      outputHash: sha256('output'),
      parameters: { algorithm: 'gzip' },
      resultMetadata: { ratio: 0.50, timestamp: '2026-02-02' }, // different metadata
      idempotencyKey: 't7-key',
    })

    // Same record returned (resultMetadata is non-identity-bearing).
    expect(r2.id).toBe(r1.id)
  })
})

// ===========================================================================
// T8 — Concurrent convergence
// ===========================================================================

describeOrSkip('Phase 14F: T8 — Concurrent convergence', () => {
  it('3 concurrent identical requests converge to one record', async () => {
    const f = await createTransformFixture('T8')

    const input = {
      bundleId: f.bundleId,
      nodeId: f.sourceNodeId,
      transformType: 'compression',
      transformVersion: '1.0.0',
      inputHash: sha256('input'),
      outputHash: sha256('output'),
      idempotencyKey: 't8-concurrent',
    }

    const results = await Promise.allSettled([
      createTransformRecord(f.tenantId, input),
      createTransformRecord(f.tenantId, input),
      createTransformRecord(f.tenantId, input),
    ])

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createTransformRecord>>> =>
        r.status === 'fulfilled',
    )
    expect(fulfilled.length).toBe(3)

    // All resolved IDs are identical.
    const ids = new Set(fulfilled.map((r) => r.value.id))
    expect(ids.size).toBe(1)

    // Exactly one record row.
    const count = await db.transformRecord.count({
      where: { tenantId: f.tenantId, idempotencyKey: 't8-concurrent' },
    })
    expect(count).toBe(1)
  })
})
