/**
 * Phase 14E: Delivery Confirmation Foundation — Integration Tests
 *
 * Proves the frozen DeliveryConfirmation contract
 * (docs/architecture/PHASE-14E-DELIVERY-CONFIRMATION-CONTRACT.md):
 *   - DeliveryConfirmation is an immutable receipt (not a status mutation).
 *   - Tenant isolation, receiver authorization, integrity proof.
 *   - Idempotent creation, concurrent convergence.
 *   - Does NOT modify Bundle/Route/Node/TransportExecution/TransportAttempt.
 *
 * Tests:
 *   D1 — Tenant isolation.
 *   D2 — Bundle immutability (confirmation references Bundle, cannot mutate).
 *   D3 — Immutability (confirmation is never updated; duplicate returns existing).
 *   D4 — Receiver validation (must be active Node in tenant).
 *   D5 — Destination authorization (receiver must be Bundle's destination).
 *   D6 — Concurrent confirmation convergence (two identical requests → one receipt).
 *   D7 — Integrity proof (confirmationHash links to Bundle.payloadHash).
 *   D8 — TransportAttempt link (optional 1:1 link validated).
 *
 * Run: DATABASE_URL=postgresql://... bun test tests/phase-14e-delivery-confirmation.test.ts --timeout 300000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { registerNode, activateNode, suspendNode } from '../src/lib/services/node.service'
import { createBundle, getBundle } from '../src/lib/services/data-plane.service'
import { createRoutePlan } from '../src/lib/services/routing.service'
import {
  createTransportExecution,
  startTransportExecution,
  createTransportAttempt,
} from '../src/lib/services/transport.service'
import {
  createDeliveryConfirmation,
  getDeliveryConfirmation,
  listDeliveryConfirmations,
  verifyDeliveryConfirmation,
} from '../src/lib/services/delivery-confirmation.service'
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
// Fixture: isolated tenant + 3 Nodes + Bundle + Route + TransportExecution + Attempt
// ---------------------------------------------------------------------------

interface ConfirmationFixture {
  tenantId: string
  sourceNodeId: string
  intermediateNodeId: string
  destinationNodeId: string
  participantId: string
  bundleId: string
  routeId: string
  executionId: string
  attemptId: string
}

const FUTURE_EXPIRY = () => new Date(Date.now() + 60 * 60 * 1000) // +1h

async function createConfirmationFixture(label: string): Promise<ConfirmationFixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const labelLc = label.toLowerCase()

  const tenant = await createTenant({
    name: `Phase 14E Confirm — ${label}`,
    slug: `p14e-${labelLc}-${stamp}`,
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
  const intermediateNode = await mkNode('int', `Intermediate ${label}`)
  const destNode = await mkNode('dst', `Dest ${label}`)

  const bundle = await createBundle(tenant.id, {
    sourceNodeId: sourceNode.id,
    destinationNodeId: destNode.id,
    nodeKind: 'generic_payload',
    payloadType: 'application/json',
    payload: '{"confirm":"test"}',
    idempotencyKey: `bundle-${labelLc}-${stamp}`,
    expiryTime: FUTURE_EXPIRY(),
  })

  const route = await createRoutePlan(tenant.id, {
    bundleId: bundle.id,
    expiresAt: FUTURE_EXPIRY(),
  })

  const execution = await createTransportExecution(tenant.id, {
    routeId: route.id,
    bundleId: bundle.id,
    idempotencyKey: `exec-${labelLc}-${stamp}`,
  })
  await startTransportExecution(tenant.id, execution.id)

  const attempt = await createTransportAttempt(tenant.id, {
    executionId: execution.id,
    fromNodeId: sourceNode.id,
    toNodeId: destNode.id,
  })

  return {
    tenantId: tenant.id,
    sourceNodeId: sourceNode.id,
    intermediateNodeId: intermediateNode.id,
    destinationNodeId: destNode.id,
    participantId: participant.id,
    bundleId: bundle.id,
    routeId: route.id,
    executionId: execution.id,
    attemptId: attempt.id,
  }
}

async function createSecondTenant(label: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return createTenant({
    name: `Phase 14E Other — ${label}`,
    slug: `p14e-other-${label.toLowerCase()}-${stamp}`,
    plan: 'growth',
  })
}

// ===========================================================================
// D1 — Tenant isolation
// ===========================================================================

describeOrSkip('Phase 14E: D1 — Tenant isolation', () => {
  it('Tenant A cannot access Tenant B delivery confirmations', async () => {
    const f = await createConfirmationFixture('D1')
    const tenantB = await createSecondTenant('D1')

    const confirmation = await createDeliveryConfirmation(f.tenantId, {
      bundleId: f.bundleId,
      receiverNodeId: f.destinationNodeId,
      idempotencyKey: 'd1-key',
    })

    // Tenant A can read it.
    const fetched = await getDeliveryConfirmation(f.tenantId, confirmation.id)
    expect(fetched.id).toBe(confirmation.id)

    // Tenant B cannot read it.
    await expect(getDeliveryConfirmation(tenantB.id, confirmation.id)).rejects.toBeInstanceOf(NotFoundError)

    // Tenant B cannot list it.
    const tenantBConfirms = await listDeliveryConfirmations(tenantB.id)
    expect(tenantBConfirms.find((c) => c.id === confirmation.id)).toBeUndefined()
  })
})

// ===========================================================================
// D2 — Bundle immutability
// ===========================================================================

describeOrSkip('Phase 14E: D2 — Bundle immutability', () => {
  it('DeliveryConfirmation references Bundle but cannot mutate its identity', async () => {
    const f = await createConfirmationFixture('D2')

    const bundleBefore = await getBundle(f.tenantId, f.bundleId)
    const beforeId = bundleBefore.id
    const beforePayload = bundleBefore.payloadBytesJson
    const beforeHash = bundleBefore.payloadHash
    const beforeDest = bundleBefore.destinationNodeId

    const confirmation = await createDeliveryConfirmation(f.tenantId, {
      bundleId: f.bundleId,
      receiverNodeId: f.destinationNodeId,
      idempotencyKey: 'd2-key',
    })

    // Bundle is UNCHANGED.
    const bundleAfter = await getBundle(f.tenantId, f.bundleId)
    expect(bundleAfter.id).toBe(beforeId)
    expect(bundleAfter.payloadBytesJson).toBe(beforePayload)
    expect(bundleAfter.payloadHash).toBe(beforeHash)
    expect(bundleAfter.destinationNodeId).toBe(beforeDest)

    // The confirmation references the Bundle via FK.
    expect(confirmation.bundleId).toBe(f.bundleId)
  })
})

// ===========================================================================
// D3 — Immutability + Idempotency/Conflict contract (adversarial)
// ===========================================================================

describeOrSkip('Phase 14E: D3 — Immutability + Idempotency/Conflict contract', () => {
  it('Case A — exact replay: same key + same attempt returns canonical receipt', async () => {
    const f = await createConfirmationFixture('D3a')

    const c1 = await createDeliveryConfirmation(f.tenantId, {
      bundleId: f.bundleId,
      receiverNodeId: f.destinationNodeId,
      idempotencyKey: 'd3a-key',
      transportAttemptId: f.attemptId,
    })

    const c2 = await createDeliveryConfirmation(f.tenantId, {
      bundleId: f.bundleId,
      receiverNodeId: f.destinationNodeId,
      idempotencyKey: 'd3a-key', // SAME key
      transportAttemptId: f.attemptId, // SAME attempt
    })

    // Both return the SAME confirmation (idempotent — not a new row).
    expect(c2.id).toBe(c1.id)

    // Exactly one confirmation row.
    const count = await db.deliveryConfirmation.count({
      where: { tenantId: f.tenantId, idempotencyKey: 'd3a-key' },
    })
    expect(count).toBe(1)
  })

  it('Case B — same key + DIFFERENT attempt raises ConflictError (not silent convergence)', async () => {
    const f = await createConfirmationFixture('D3b')

    // Create a second attempt on the same execution (different attemptNumber).
    const attempt2 = await createTransportAttempt(f.tenantId, {
      executionId: f.executionId,
      fromNodeId: f.sourceNodeId,
      toNodeId: f.destinationNodeId,
    })
    expect(attempt2.id).not.toBe(f.attemptId)

    // First confirmation with attempt 1.
    await createDeliveryConfirmation(f.tenantId, {
      bundleId: f.bundleId,
      receiverNodeId: f.destinationNodeId,
      idempotencyKey: 'd3b-key',
      transportAttemptId: f.attemptId,
    })

    // Second with SAME key but DIFFERENT attempt → must NOT silently converge.
    // The confirmationHash now includes transportAttemptId, so the fingerprints
    // differ → ConflictError.
    await expect(
      createDeliveryConfirmation(f.tenantId, {
        bundleId: f.bundleId,
        receiverNodeId: f.destinationNodeId,
        idempotencyKey: 'd3b-key', // SAME key
        transportAttemptId: attempt2.id, // DIFFERENT attempt
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('Case C — metadata is non-identity-bearing: same key + different metadata replays', async () => {
    const f = await createConfirmationFixture('D3c')

    const c1 = await createDeliveryConfirmation(f.tenantId, {
      bundleId: f.bundleId,
      receiverNodeId: f.destinationNodeId,
      idempotencyKey: 'd3c-key',
      transportAttemptId: f.attemptId,
      metadata: { sig: 'abc', version: 1 },
    })

    // Same key + same attempt + DIFFERENT metadata → idempotent replay.
    // Metadata is NOT part of the fingerprint — it does NOT cause a conflict.
    const c2 = await createDeliveryConfirmation(f.tenantId, {
      bundleId: f.bundleId,
      receiverNodeId: f.destinationNodeId,
      idempotencyKey: 'd3c-key',
      transportAttemptId: f.attemptId,
      metadata: { sig: 'xyz', version: 999 }, // different metadata
    })

    // Same receipt returned (metadata is non-identity-bearing).
    expect(c2.id).toBe(c1.id)
  })

  it('Case D — concurrent exact replay converges to one row', async () => {
    const f = await createConfirmationFixture('D3d')

    const input = {
      bundleId: f.bundleId,
      receiverNodeId: f.destinationNodeId,
      idempotencyKey: 'd3d-concurrent',
      transportAttemptId: f.attemptId,
    }

    const results = await Promise.allSettled([
      createDeliveryConfirmation(f.tenantId, input),
      createDeliveryConfirmation(f.tenantId, input),
      createDeliveryConfirmation(f.tenantId, input),
    ])

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createDeliveryConfirmation>>> =>
        r.status === 'fulfilled',
    )
    expect(fulfilled.length).toBe(3)

    // All resolved IDs are identical.
    const ids = new Set(fulfilled.map((r) => r.value.id))
    expect(ids.size).toBe(1)

    // Exactly one confirmation row.
    const count = await db.deliveryConfirmation.count({
      where: { tenantId: f.tenantId, idempotencyKey: 'd3d-concurrent' },
    })
    expect(count).toBe(1)
  })

  it('Case E — verifyDeliveryConfirmation uses the same fingerprint as creation', async () => {
    const f = await createConfirmationFixture('D3e')

    const confirmation = await createDeliveryConfirmation(f.tenantId, {
      bundleId: f.bundleId,
      receiverNodeId: f.destinationNodeId,
      idempotencyKey: 'd3e-key',
      transportAttemptId: f.attemptId,
    })

    // verifyDeliveryConfirmation must return true — it uses the SAME derivation.
    const verified = await verifyDeliveryConfirmation(f.tenantId, confirmation.id)
    expect(verified).toBe(true)
  })

  it('P2002 from transportAttemptId @unique is NOT treated as idempotent replay', async () => {
    const f = await createConfirmationFixture('D3f')

    // Create a second attempt on the same execution.
    const attempt2 = await createTransportAttempt(f.tenantId, {
      executionId: f.executionId,
      fromNodeId: f.sourceNodeId,
      toNodeId: f.destinationNodeId,
    })

    // First confirmation links to attempt1, with key-A.
    await createDeliveryConfirmation(f.tenantId, {
      bundleId: f.bundleId,
      receiverNodeId: f.destinationNodeId,
      idempotencyKey: 'd3f-key-a',
      transportAttemptId: f.attemptId,
    })

    // Second confirmation with DIFFERENT key (key-B) but SAME attempt (attempt1)
    // → P2002 from transportAttemptId @unique (not from idempotency key).
    // This must NOT be treated as an idempotent replay of key-A.
    await expect(
      createDeliveryConfirmation(f.tenantId, {
        bundleId: f.bundleId,
        receiverNodeId: f.destinationNodeId,
        idempotencyKey: 'd3f-key-b', // DIFFERENT key
        transportAttemptId: f.attemptId, // SAME attempt (already linked to key-A)
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })
})

// ===========================================================================
// D4 — Receiver validation
// ===========================================================================

describeOrSkip('Phase 14E: D4 — Receiver validation', () => {
  it('inactive/nonexistent/cross-tenant receiver is rejected', async () => {
    const f = await createConfirmationFixture('D4')

    // Nonexistent receiver.
    await expect(
      createDeliveryConfirmation(f.tenantId, {
        bundleId: f.bundleId,
        receiverNodeId: 'nonexistent-node-id',
        idempotencyKey: 'd4a-key',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)

    // Suspended receiver.
    const suspendedNode = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'Suspended receiver',
      idempotencyKey: 'd4-suspended',
    })
    await suspendNode(f.tenantId, suspendedNode.id)
    await expect(
      createDeliveryConfirmation(f.tenantId, {
        bundleId: f.bundleId,
        receiverNodeId: suspendedNode.id,
        idempotencyKey: 'd4b-key',
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    // Cross-tenant receiver.
    const tenantB = await createSecondTenant('D4')
    const participantB = await db.participantIdentity.create({ data: {} })
    const nodeB = await registerNode(tenantB.id, {
      participantId: participantB.id,
      nodeKind: 'protocol_endpoint',
      displayName: 'Tenant B node',
      idempotencyKey: 'd4-nodeB',
    })
    await activateNode(tenantB.id, nodeB.id)
    await expect(
      createDeliveryConfirmation(f.tenantId, {
        bundleId: f.bundleId,
        receiverNodeId: nodeB.id,
        idempotencyKey: 'd4c-key',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

// ===========================================================================
// D5 — Destination authorization
// ===========================================================================

describeOrSkip('Phase 14E: D5 — Destination authorization', () => {
  it('receiver must be the Bundle destination (source/intermediate rejected)', async () => {
    const f = await createConfirmationFixture('D5')

    // Source Node is NOT the destination → rejected.
    await expect(
      createDeliveryConfirmation(f.tenantId, {
        bundleId: f.bundleId,
        receiverNodeId: f.sourceNodeId,
        idempotencyKey: 'd5a-key',
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    // Intermediate Node is NOT the destination → rejected.
    await expect(
      createDeliveryConfirmation(f.tenantId, {
        bundleId: f.bundleId,
        receiverNodeId: f.intermediateNodeId,
        idempotencyKey: 'd5b-key',
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    // Destination Node IS the destination → succeeds.
    const confirmation = await createDeliveryConfirmation(f.tenantId, {
      bundleId: f.bundleId,
      receiverNodeId: f.destinationNodeId,
      idempotencyKey: 'd5c-key',
    })
    expect(confirmation.id).toBeDefined()
  })
})

// ===========================================================================
// D6 — Concurrent confirmation convergence
// ===========================================================================

describeOrSkip('Phase 14E: D6 — Concurrent confirmation convergence', () => {
  it('two identical confirmation requests converge to one durable receipt', async () => {
    const f = await createConfirmationFixture('D6')

    const input = {
      bundleId: f.bundleId,
      receiverNodeId: f.destinationNodeId,
      idempotencyKey: 'd6-concurrent-key',
    }

    const results = await Promise.allSettled([
      createDeliveryConfirmation(f.tenantId, input),
      createDeliveryConfirmation(f.tenantId, input),
      createDeliveryConfirmation(f.tenantId, input),
    ])

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createDeliveryConfirmation>>> =>
        r.status === 'fulfilled',
    )
    const rejected = results.filter((r) => r.status === 'rejected')

    // All converge (P2002 catch + re-read).
    expect(rejected.length).toBe(0)
    expect(fulfilled.length).toBe(3)

    // All resolved IDs are identical.
    const ids = new Set(fulfilled.map((r) => r.value.id))
    expect(ids.size).toBe(1)

    // Exactly one confirmation row.
    const count = await db.deliveryConfirmation.count({
      where: { tenantId: f.tenantId, idempotencyKey: 'd6-concurrent-key' },
    })
    expect(count).toBe(1)
  })
})

// ===========================================================================
// D7 — Integrity proof (confirmationHash)
// ===========================================================================

describeOrSkip('Phase 14E: D7 — Integrity proof', () => {
  it('confirmationHash links to Bundle.payloadHash + receiverNodeId + transportAttemptId + idempotencyKey', async () => {
    const f = await createConfirmationFixture('D7')

    const bundle = await getBundle(f.tenantId, f.bundleId)
    const expectedHash = sha256(
      JSON.stringify({
        bundleId: f.bundleId,
        payloadHash: bundle.payloadHash,
        receiverNodeId: f.destinationNodeId,
        transportAttemptId: null, // no attempt linked in this test
        idempotencyKey: 'd7-key',
      }),
    )

    const confirmation = await createDeliveryConfirmation(f.tenantId, {
      bundleId: f.bundleId,
      receiverNodeId: f.destinationNodeId,
      idempotencyKey: 'd7-key',
    })

    expect(confirmation.confirmationHash).toBe(expectedHash)

    // verifyDeliveryConfirmation recomputes and compares using the SAME derivation.
    const verified = await verifyDeliveryConfirmation(f.tenantId, confirmation.id)
    expect(verified).toBe(true)
  })
})

// ===========================================================================
// D8 — TransportAttempt link (optional 1:1)
// ===========================================================================

describeOrSkip('Phase 14E: D8 — TransportAttempt link', () => {
  it('optional transportAttemptId links the confirmation to the attempt (1:1)', async () => {
    const f = await createConfirmationFixture('D8')

    const confirmation = await createDeliveryConfirmation(f.tenantId, {
      bundleId: f.bundleId,
      receiverNodeId: f.destinationNodeId,
      idempotencyKey: 'd8-key',
      transportAttemptId: f.attemptId,
    })

    expect(confirmation.transportAttemptId).toBe(f.attemptId)

    // The link is 1:1 — a second confirmation for the same attempt (different key)
    // is rejected with ConflictError (P2002 from transportAttemptId @unique,
    // correctly distinguished from an idempotency-key replay).
    await expect(
      createDeliveryConfirmation(f.tenantId, {
        bundleId: f.bundleId,
        receiverNodeId: f.destinationNodeId,
        idempotencyKey: 'd8-key-2', // different key, but same attempt
        transportAttemptId: f.attemptId,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('attempt with mismatched toNode is rejected', async () => {
    const f = await createConfirmationFixture('D8b')

    // The attempt's toNode is f.destinationNodeId. Try confirming with
    // f.sourceNodeId (which is NOT the destination anyway, so D5 catches it).
    // Instead, create an attempt to the intermediate node and try to confirm
    // with the destination node (mismatch).
    const attempt2 = await createTransportAttempt(f.tenantId, {
      executionId: f.executionId,
      fromNodeId: f.sourceNodeId,
      toNodeId: f.intermediateNodeId,
    })

    await expect(
      createDeliveryConfirmation(f.tenantId, {
        bundleId: f.bundleId,
        receiverNodeId: f.destinationNodeId, // destination, not intermediate
        idempotencyKey: 'd8b-key',
        transportAttemptId: attempt2.id, // attempt to intermediate, not destination
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
