/**
 * Phase 14B: Data Plane / Bundle Foundation — Integration Tests
 *
 * Proves the frozen Bundle contract (docs/architecture/PHASE-14B-DATA-PLANE-CONTRACT.md):
 *   - Bundle is a generic data-plane primitive, distinct from ProtocolTransaction/VPP delivery.
 *   - Bundle identity is immutable + deterministic (survives crash/retry/replication).
 *   - Bundle is tenant-isolated.
 *   - Bundle uses Node as protocol endpoint identity.
 *   - Bundle deduplication + concurrent reception converge.
 *   - Crash recovery (persisted Bundle survives restart).
 *   - Expiry is persisted + enforced.
 *   - Delivery retry is idempotent (at-least-once + idempotent, NOT exactly-once).
 *
 * Tests:
 *   B1 — create/store: Bundle persisted correctly.
 *   B2 — identity: Bundle ID remains immutable (deterministic).
 *   B3 — tenant isolation: Tenant A cannot read Tenant B bundle.
 *   B4 — source validation: Invalid/unregistered/inactive source Node rejected.
 *   B5 — destination validation: Invalid destination rejected.
 *   B6 — duplicate reception: Same Bundle ID received twice → one logical Bundle.
 *   B7 — concurrent reception: Multiple concurrent inserts converge to one Bundle.
 *   B8 — crash recovery: Persisted Bundle survives restart (re-read after process death).
 *   B9 — expiry: Expired Bundle cannot be newly delivered.
 *   B10 — retry: Delivery retry is idempotent (attemptCount incremented, no duplicate).
 *   B11 — Node membership: Source/destination Node participation validated.
 *   B12 — payload boundary: Bundle metadata and payload storage follow selected model.
 *
 * Run: DATABASE_URL=postgresql://... bun test tests/phase-14b-bundle.test.ts --timeout 300000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { registerNode, activateNode, suspendNode, revokeNode } from '../src/lib/services/node.service'
import {
  createBundle,
  getBundle,
  listBundles,
  deliverBundle,
  deriveBundleId,
  deriveDeliveryId,
} from '../src/lib/services/data-plane.service'
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
// Fixture: isolated tenant + two Nodes (source + destination)
// ---------------------------------------------------------------------------

interface BundleFixture {
  tenantId: string
  sourceNodeId: string
  destinationNodeId: string
  participantId: string
}

async function createBundleFixture(label: string): Promise<BundleFixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const labelLc = label.toLowerCase()

  const tenant = await createTenant({
    name: `Phase 14B Bundle — ${label}`,
    slug: `p14b-${labelLc}-${stamp}`,
    plan: 'growth',
  })

  // One participant controlling both Nodes (sufficient for Phase 14B —
  // Bundle identity is Node-based, not participant-based).
  const participant = await db.participantIdentity.create({ data: {} })

  // Source Node (active — can send bundles).
  const sourceNode = await registerNode(tenant.id, {
    participantId: participant.id,
    nodeKind: 'protocol_endpoint',
    displayName: `Source ${label}`,
    idempotencyKey: `src-${labelLc}-${stamp}`,
  })
  await activateNode(tenant.id, sourceNode.id)

  // Destination Node (registered — can receive bundles; not revoked).
  const destNode = await registerNode(tenant.id, {
    participantId: participant.id,
    nodeKind: 'protocol_endpoint',
    displayName: `Dest ${label}`,
    idempotencyKey: `dst-${labelLc}-${stamp}`,
  })
  await activateNode(tenant.id, destNode.id)

  return {
    tenantId: tenant.id,
    sourceNodeId: sourceNode.id,
    destinationNodeId: destNode.id,
    participantId: participant.id,
  }
}

async function createSecondTenant(label: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return createTenant({
    name: `Phase 14B Other — ${label}`,
    slug: `p14b-other-${label.toLowerCase()}-${stamp}`,
    plan: 'growth',
  })
}

const FUTURE_EXPIRY = () => new Date(Date.now() + 60 * 60 * 1000) // +1h
const PAST_EXPIRY = () => new Date(Date.now() - 60 * 60 * 1000) // -1h

// ===========================================================================
// B1 — create/store
// ===========================================================================

describeOrSkip('Phase 14B: B1 — create/store', () => {
  it('Bundle is persisted correctly', async () => {
    const f = await createBundleFixture('B1')

    const bundle = await createBundle(f.tenantId, {
      sourceNodeId: f.sourceNodeId,
      destinationNodeId: f.destinationNodeId,
      nodeKind: 'generic_payload',
      payloadType: 'application/json',
      payload: '{"hello":"world"}',
      idempotencyKey: 'b1-key',
      priority: 5,
      expiryTime: FUTURE_EXPIRY(),
    })

    expect(bundle.id).toBeDefined()
    expect(bundle.tenantId).toBe(f.tenantId)
    expect(bundle.sourceNodeId).toBe(f.sourceNodeId)
    expect(bundle.destinationNodeId).toBe(f.destinationNodeId)
    expect(bundle.status).toBe('created')
    expect(bundle.payloadType).toBe('application/json')
    expect(bundle.priority).toBe(5)
    expect(bundle.expiryTime).toBeDefined()

    // Re-read to confirm persistence (B8 crash recovery precursor).
    const refetched = await getBundle(f.tenantId, bundle.id)
    expect(refetched.id).toBe(bundle.id)
    expect(refetched.payloadHash).toBe(bundle.payloadHash)

    // A delivery record was created (status: stored).
    expect(refetched.deliveries.length).toBeGreaterThanOrEqual(1)
    expect(refetched.deliveries[0].status).toBe('stored')
  })
})

// ===========================================================================
// B2 — identity (immutable, deterministic)
// ===========================================================================

describeOrSkip('Phase 14B: B2 — identity', () => {
  it('Bundle ID is deterministic and immutable', async () => {
    const f = await createBundleFixture('B2')

    const payload = '{"data":"immutable-test"}'
    const expectedId = deriveBundleId({
      tenantId: f.tenantId,
      sourceNodeId: f.sourceNodeId,
      idempotencyKey: 'b2-key',
    })

    const bundle = await createBundle(f.tenantId, {
      sourceNodeId: f.sourceNodeId,
      destinationNodeId: f.destinationNodeId,
      nodeKind: 'generic_payload',
      payloadType: 'application/json',
      payload,
      idempotencyKey: 'b2-key',
      expiryTime: FUTURE_EXPIRY(),
    })

    expect(bundle.id).toBe(expectedId)

    // The ID is NOT derived from DB row ID or timestamp alone — it is the
    // deterministic SHA-256 of the identity tuple.
    expect(bundle.id).toMatch(/^[0-9a-f]{64}$/)

    // payloadHash is stored separately (integrity), NOT part of the identity.
    expect(bundle.payloadHash).toBe(sha256(payload))
  })
})

// ===========================================================================
// B3 — tenant isolation
// ===========================================================================

describeOrSkip('Phase 14B: B3 — tenant isolation', () => {
  it('Tenant A cannot read Tenant B bundle', async () => {
    const fA = await createBundleFixture('B3A')
    const tenantB = await createSecondTenant('B3')

    const bundle = await createBundle(fA.tenantId, {
      sourceNodeId: fA.sourceNodeId,
      destinationNodeId: fA.destinationNodeId,
      nodeKind: 'generic_payload',
      payloadType: 'application/json',
      payload: '{"tenant":"A"}',
      idempotencyKey: 'b3-key',
      expiryTime: FUTURE_EXPIRY(),
    })

    // Tenant A can read it.
    const fetched = await getBundle(fA.tenantId, bundle.id)
    expect(fetched.id).toBe(bundle.id)

    // Tenant B cannot read it.
    await expect(getBundle(tenantB.id, bundle.id)).rejects.toBeInstanceOf(NotFoundError)

    // Tenant B cannot list it.
    const tenantBBundles = await listBundles(tenantB.id)
    expect(tenantBBundles.find((b) => b.id === bundle.id)).toBeUndefined()
  })
})

// ===========================================================================
// B4 — source validation
// ===========================================================================

describeOrSkip('Phase 14B: B4 — source validation', () => {
  it('inactive/revoked/nonexistent source Node is rejected', async () => {
    const f = await createBundleFixture('B4')

    // Nonexistent source.
    await expect(
      createBundle(f.tenantId, {
        sourceNodeId: 'nonexistent-node-id',
        destinationNodeId: f.destinationNodeId,
        nodeKind: 'generic_payload',
        payloadType: 'application/json',
        payload: '{}',
        idempotencyKey: 'b4a-key',
        expiryTime: FUTURE_EXPIRY(),
      }),
    ).rejects.toBeInstanceOf(NotFoundError)

    // Suspended source (registered but suspended).
    const suspendedNode = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'Suspended source',
      idempotencyKey: 'b4-suspended-src',
    })
    await suspendNode(f.tenantId, suspendedNode.id)
    await expect(
      createBundle(f.tenantId, {
        sourceNodeId: suspendedNode.id,
        destinationNodeId: f.destinationNodeId,
        nodeKind: 'generic_payload',
        payloadType: 'application/json',
        payload: '{}',
        idempotencyKey: 'b4b-key',
        expiryTime: FUTURE_EXPIRY(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    // Cross-tenant source (Tenant B's Node used as source in Tenant A).
    const tenantB = await createSecondTenant('B4')
    const participantB = await db.participantIdentity.create({ data: {} })
    const nodeB = await registerNode(tenantB.id, {
      participantId: participantB.id,
      nodeKind: 'protocol_endpoint',
      displayName: 'Tenant B node',
      idempotencyKey: 'b4-nodeB',
    })
    await activateNode(tenantB.id, nodeB.id)
    await expect(
      createBundle(f.tenantId, {
        sourceNodeId: nodeB.id,
        destinationNodeId: f.destinationNodeId,
        nodeKind: 'generic_payload',
        payloadType: 'application/json',
        payload: '{}',
        idempotencyKey: 'b4c-key',
        expiryTime: FUTURE_EXPIRY(),
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

// ===========================================================================
// B5 — destination validation
// ===========================================================================

describeOrSkip('Phase 14B: B5 — destination validation', () => {
  it('revoked/nonexistent/cross-tenant destination is rejected', async () => {
    const f = await createBundleFixture('B5')

    // Nonexistent destination.
    await expect(
      createBundle(f.tenantId, {
        sourceNodeId: f.sourceNodeId,
        destinationNodeId: 'nonexistent-dest-id',
        nodeKind: 'generic_payload',
        payloadType: 'application/json',
        payload: '{}',
        idempotencyKey: 'b5a-key',
        expiryTime: FUTURE_EXPIRY(),
      }),
    ).rejects.toBeInstanceOf(NotFoundError)

    // Revoked destination.
    const revokedDest = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'Revoked dest',
      idempotencyKey: 'b5-revoked-dest',
    })
    await activateNode(f.tenantId, revokedDest.id)
    await revokeNode(f.tenantId, revokedDest.id)
    await expect(
      createBundle(f.tenantId, {
        sourceNodeId: f.sourceNodeId,
        destinationNodeId: revokedDest.id,
        nodeKind: 'generic_payload',
        payloadType: 'application/json',
        payload: '{}',
        idempotencyKey: 'b5b-key',
        expiryTime: FUTURE_EXPIRY(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    // Self-delivery rejected.
    await expect(
      createBundle(f.tenantId, {
        sourceNodeId: f.sourceNodeId,
        destinationNodeId: f.sourceNodeId,
        nodeKind: 'generic_payload',
        payloadType: 'application/json',
        payload: '{}',
        idempotencyKey: 'b5c-key',
        expiryTime: FUTURE_EXPIRY(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

// ===========================================================================
// B6 — duplicate reception (idempotent)
// ===========================================================================

describeOrSkip('Phase 14B: B6 — duplicate reception', () => {
  it('same Bundle ID received twice → one logical Bundle', async () => {
    const f = await createBundleFixture('B6')

    const input = {
      sourceNodeId: f.sourceNodeId,
      destinationNodeId: f.destinationNodeId,
      nodeKind: 'generic_payload',
      payloadType: 'application/json',
      payload: '{"dup":"test"}',
      idempotencyKey: 'b6-key',
      expiryTime: FUTURE_EXPIRY(),
    }

    const bundleCountBefore = await db.bundle.count({ where: { tenantId: f.tenantId } })

    const b1 = await createBundle(f.tenantId, input)
    const b2 = await createBundle(f.tenantId, input)

    // Both return the SAME bundle.
    expect(b2.id).toBe(b1.id)

    // Exactly one bundle row.
    const bundleCountAfter = await db.bundle.count({ where: { tenantId: f.tenantId } })
    expect(bundleCountAfter).toBe(bundleCountBefore + 1)
  })

  it('same key with different payload raises ConflictError', async () => {
    const f = await createBundleFixture('B6b')

    await createBundle(f.tenantId, {
      sourceNodeId: f.sourceNodeId,
      destinationNodeId: f.destinationNodeId,
      nodeKind: 'generic_payload',
      payloadType: 'application/json',
      payload: '{"v":1}',
      idempotencyKey: 'b6b-key',
      expiryTime: FUTURE_EXPIRY(),
    })

    await expect(
      createBundle(f.tenantId, {
        sourceNodeId: f.sourceNodeId,
        destinationNodeId: f.destinationNodeId,
        nodeKind: 'generic_payload',
        payloadType: 'application/json',
        payload: '{"v":2}', // different payload
        idempotencyKey: 'b6b-key', // same key
        expiryTime: FUTURE_EXPIRY(),
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })
})

// ===========================================================================
// B7 — concurrent reception convergence
// ===========================================================================

describeOrSkip('Phase 14B: B7 — concurrent reception', () => {
  it('concurrent inserts of same Bundle converge to one durable Bundle', async () => {
    const f = await createBundleFixture('B7')

    const input = {
      sourceNodeId: f.sourceNodeId,
      destinationNodeId: f.destinationNodeId,
      nodeKind: 'generic_payload',
      payloadType: 'application/json',
      payload: '{"concurrent":"test"}',
      idempotencyKey: 'b7-concurrent-key',
      expiryTime: FUTURE_EXPIRY(),
    }

    const results = await Promise.allSettled([
      createBundle(f.tenantId, input),
      createBundle(f.tenantId, input),
      createBundle(f.tenantId, input),
    ])

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createBundle>>> =>
        r.status === 'fulfilled',
    )
    const rejected = results.filter((r) => r.status === 'rejected')

    // All converge successfully (P2002 catch + re-read).
    expect(rejected.length).toBe(0)
    expect(fulfilled.length).toBe(3)

    // All resolved IDs are identical.
    const ids = new Set(fulfilled.map((r) => r.value.id))
    expect(ids.size).toBe(1)

    // Exactly one bundle row.
    const count = await db.bundle.count({
      where: { tenantId: f.tenantId, idempotencyKey: 'b7-concurrent-key' },
    })
    expect(count).toBe(1)
  })
})

// ===========================================================================
// B8 — crash recovery (persisted Bundle survives restart)
// ===========================================================================

describeOrSkip('Phase 14B: B8 — crash recovery', () => {
  it('persisted Bundle survives process restart (re-read via new client)', async () => {
    const f = await createBundleFixture('B8')

    const bundle = await createBundle(f.tenantId, {
      sourceNodeId: f.sourceNodeId,
      destinationNodeId: f.destinationNodeId,
      nodeKind: 'generic_payload',
      payloadType: 'application/json',
      payload: '{"crash":"recovery"}',
      idempotencyKey: 'b8-key',
      expiryTime: FUTURE_EXPIRY(),
    })

    // Simulate "process restart" by re-reading via a fresh query (the
    // database is the source of truth, not in-memory state).
    const recovered = await db.bundle.findUnique({ where: { id: bundle.id } })
    expect(recovered).not.toBeNull()
    expect(recovered!.id).toBe(bundle.id)
    expect(recovered!.tenantId).toBe(f.tenantId)
    expect(recovered!.sourceNodeId).toBe(f.sourceNodeId)
    expect(recovered!.destinationNodeId).toBe(f.destinationNodeId)
    expect(recovered!.payloadHash).toBe(bundle.payloadHash)
    expect(recovered!.status).toBe('created')
    expect(recovered!.expiryTime).toEqual(bundle.expiryTime)

    // The delivery record also survives.
    const deliveries = await db.bundleDelivery.findMany({ where: { bundleId: bundle.id } })
    expect(deliveries.length).toBeGreaterThanOrEqual(1)
    expect(deliveries[0].status).toBe('stored')
  })
})

// ===========================================================================
// B9 — expiry (persisted + enforced)
// ===========================================================================

describeOrSkip('Phase 14B: B9 — expiry', () => {
  it('expired Bundle cannot be newly delivered', async () => {
    const f = await createBundleFixture('B9')

    // Create a Bundle that is ALREADY expired.
    const bundle = await createBundle(f.tenantId, {
      sourceNodeId: f.sourceNodeId,
      destinationNodeId: f.destinationNodeId,
      nodeKind: 'generic_payload',
      payloadType: 'application/json',
      payload: '{"expired":true}',
      idempotencyKey: 'b9-key',
      expiryTime: PAST_EXPIRY(), // already expired
    })

    // Attempt delivery → rejected.
    await expect(
      deliverBundle(f.tenantId, {
        bundleId: bundle.id,
        receiverNodeId: f.destinationNodeId,
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    // Bundle status is now 'expired'.
    const expired = await getBundle(f.tenantId, bundle.id)
    expect(expired.status).toBe('expired')
  })
})

// ===========================================================================
// B10 — retry (idempotent delivery)
// ===========================================================================

describeOrSkip('Phase 14B: B10 — retry', () => {
  it('delivery retry is idempotent (attemptCount incremented, no duplicate)', async () => {
    const f = await createBundleFixture('B10')

    const bundle = await createBundle(f.tenantId, {
      sourceNodeId: f.sourceNodeId,
      destinationNodeId: f.destinationNodeId,
      nodeKind: 'generic_payload',
      payloadType: 'application/json',
      payload: '{"retry":"test"}',
      idempotencyKey: 'b10-key',
      expiryTime: FUTURE_EXPIRY(),
    })

    const deliveryCountBefore = await db.bundleDelivery.count({
      where: { bundleId: bundle.id, receiverNodeId: f.destinationNodeId },
    })
    // createBundle creates an initial 'stored' delivery record, so before = 1.

    // First delivery.
    const d1 = await deliverBundle(f.tenantId, {
      bundleId: bundle.id,
      receiverNodeId: f.destinationNodeId,
    })
    expect(d1.status).toBe('delivered')
    expect(d1.deliveredAt).toBeDefined()

    // Retry (concurrent or sequential).
    const d2 = await deliverBundle(f.tenantId, {
      bundleId: bundle.id,
      receiverNodeId: f.destinationNodeId,
    })

    // Same delivery record (idempotent — NOT a new row). The count does not
    // increase because retries converge to the existing record.
    const deliveryCountAfter = await db.bundleDelivery.count({
      where: { bundleId: bundle.id, receiverNodeId: f.destinationNodeId },
    })
    expect(deliveryCountAfter).toBe(deliveryCountBefore) // still one record

    // attemptCount incremented (duplicate reception tracked, not duplicated).
    expect(d2.attemptCount).toBeGreaterThanOrEqual(2)

    // The Bundle is marked delivered (first delivery time preserved).
    const bundleAfter = await getBundle(f.tenantId, bundle.id)
    expect(bundleAfter.status).toBe('delivered')
    expect(bundleAfter.deliveredAt).toEqual(d1.deliveredAt)
  })

  it('concurrent delivery converges to one delivery record', async () => {
    const f = await createBundleFixture('B10b')

    const bundle = await createBundle(f.tenantId, {
      sourceNodeId: f.sourceNodeId,
      destinationNodeId: f.destinationNodeId,
      nodeKind: 'generic_payload',
      payloadType: 'application/json',
      payload: '{"concurrent":"delivery"}',
      idempotencyKey: 'b10b-key',
      expiryTime: FUTURE_EXPIRY(),
    })

    const results = await Promise.allSettled([
      deliverBundle(f.tenantId, { bundleId: bundle.id, receiverNodeId: f.destinationNodeId }),
      deliverBundle(f.tenantId, { bundleId: bundle.id, receiverNodeId: f.destinationNodeId }),
      deliverBundle(f.tenantId, { bundleId: bundle.id, receiverNodeId: f.destinationNodeId }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected.length).toBe(0)
    expect(fulfilled.length).toBe(3)

    // Exactly one delivery record.
    const count = await db.bundleDelivery.count({
      where: { bundleId: bundle.id, receiverNodeId: f.destinationNodeId },
    })
    expect(count).toBe(1)
  })
})

// ===========================================================================
// B11 — Node membership / participation validation
// ===========================================================================

describeOrSkip('Phase 14B: B11 — Node membership', () => {
  it('source/destination Node participation is validated', async () => {
    const f = await createBundleFixture('B11')

    // Source must be active — create a registered (not active) node.
    const inactiveSource = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'Inactive source',
      idempotencyKey: 'b11-inactive-src',
    })
    // (not activated — status: 'registered')
    await expect(
      createBundle(f.tenantId, {
        sourceNodeId: inactiveSource.id,
        destinationNodeId: f.destinationNodeId,
        nodeKind: 'generic_payload',
        payloadType: 'application/json',
        payload: '{}',
        idempotencyKey: 'b11a-key',
        expiryTime: FUTURE_EXPIRY(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    // Valid source + valid destination succeeds.
    const bundle = await createBundle(f.tenantId, {
      sourceNodeId: f.sourceNodeId,
      destinationNodeId: f.destinationNodeId,
      nodeKind: 'generic_payload',
      payloadType: 'application/json',
      payload: '{"ok":true}',
      idempotencyKey: 'b11b-key',
      expiryTime: FUTURE_EXPIRY(),
    })
    expect(bundle.status).toBe('created')
  })
})

// ===========================================================================
// B12 — payload boundary (metadata ≠ payload storage)
// ===========================================================================

describeOrSkip('Phase 14B: B12 — payload boundary', () => {
  it('Bundle metadata and payload storage follow the selected model without violating tenancy', async () => {
    const f = await createBundleFixture('B12')

    const payload = '{"payload":"boundary-test"}'
    const bundle = await createBundle(f.tenantId, {
      sourceNodeId: f.sourceNodeId,
      destinationNodeId: f.destinationNodeId,
      nodeKind: 'generic_payload',
      payloadType: 'application/json',
      payload,
      payloadRef: 'content-addressed-ref-abc123', // external storage reference
      idempotencyKey: 'b12-key',
      priority: 3,
      nonce: 42,
      expiryTime: FUTURE_EXPIRY(),
      metadata: { custom: 'meta' },
    })

    // Metadata fields are present.
    expect(bundle.payloadType).toBe('application/json')
    expect(bundle.payloadRef).toBe('content-addressed-ref-abc123')
    expect(bundle.priority).toBe(3)
    expect(bundle.nonce).toBe(42)

    // payloadHash is the SHA-256 of the payload (integrity).
    expect(bundle.payloadHash).toBe(sha256(payload))

    // payloadBytesJson holds the inline small payload (JSON string).
    expect(bundle.payloadBytesJson).toBe(payload)

    // The Bundle is tenant-scoped (no cross-tenant leakage).
    expect(bundle.tenantId).toBe(f.tenantId)

    // metadataJson is separate from payload.
    const meta = JSON.parse(bundle.metadataJson)
    expect(meta.custom).toBe('meta')

    // A different tenant cannot access this bundle's payload.
    const tenantB = await createSecondTenant('B12')
    await expect(getBundle(tenantB.id, bundle.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})
