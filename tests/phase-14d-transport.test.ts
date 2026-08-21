/**
 * Phase 14D: Transport Execution Foundation — Integration Tests
 *
 * Proves the frozen TransportExecution contract (docs/architecture/PHASE-14D-TRANSPORT-CONTRACT.md):
 *   - TransportExecution references Bundle + Route (does NOT modify them).
 *   - Lifecycle enforcement (created → started → completed/failed; terminal cannot revert).
 *   - Failure recovery (failed execution can create another attempt).
 *   - Concurrent execution creation converges.
 *   - Attempt ordering deterministic.
 *   - Capability isolation (declaration, not network ownership).
 *
 * Tests:
 *   T1 — Tenant isolation.
 *   T2 — Bundle immutability (Transport references Bundle, cannot mutate identity).
 *   T3 — Route immutability (Transport does not modify Route).
 *   T4 — Execution lifecycle (created → started → completed valid; completed → started invalid).
 *   T5 — Failure recovery (failed execution can create another attempt).
 *   T6 — Concurrent execution creation (two identical requests converge).
 *   T7 — Attempt ordering (deterministic via createdAt).
 *   T8 — Capability isolation (declaration, not network ownership).
 *
 * Run: DATABASE_URL=postgresql://... bun test tests/phase-14d-transport.test.ts --timeout 300000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { registerNode, activateNode, suspendNode } from '../src/lib/services/node.service'
import { createBundle, getBundle } from '../src/lib/services/data-plane.service'
import { createRoutePlan, addRouteHop, getRoute } from '../src/lib/services/routing.service'
import {
  createTransportExecution,
  getTransportExecution,
  listTransportExecutions,
  startTransportExecution,
  completeTransportExecution,
  failTransportExecution,
  cancelTransportExecution,
  createTransportAttempt,
  markAttemptSent,
  acknowledgeAttempt,
  failAttempt,
  declareTransportCapability,
  listTransportCapabilities,
} from '../src/lib/services/transport.service'
import { initializeBootstrap } from '../src/lib/bootstrap'
import { NotFoundError, ValidationError } from '../src/lib/domain/errors'

const databaseUrl = process.env.DATABASE_URL || ''
const isPostgres =
  databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')
const describeOrSkip = isPostgres ? describe : describe.skip

beforeAll(() => {
  if (!isPostgres) return
  initializeBootstrap()
})

// ---------------------------------------------------------------------------
// Fixture: isolated tenant + 3 Nodes + Bundle + Route
// ---------------------------------------------------------------------------

interface TransportFixture {
  tenantId: string
  sourceNodeId: string
  intermediateNodeId: string
  destinationNodeId: string
  participantId: string
  bundleId: string
  routeId: string
}

const FUTURE_EXPIRY = () => new Date(Date.now() + 60 * 60 * 1000) // +1h

async function createTransportFixture(label: string): Promise<TransportFixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const labelLc = label.toLowerCase()

  const tenant = await createTenant({
    name: `Phase 14D Transport — ${label}`,
    slug: `p14d-${labelLc}-${stamp}`,
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
    payload: '{"transport":"test"}',
    idempotencyKey: `bundle-${labelLc}-${stamp}`,
    expiryTime: FUTURE_EXPIRY(),
  })

  const route = await createRoutePlan(tenant.id, {
    bundleId: bundle.id,
    expiresAt: FUTURE_EXPIRY(),
  })

  return {
    tenantId: tenant.id,
    sourceNodeId: sourceNode.id,
    intermediateNodeId: intermediateNode.id,
    destinationNodeId: destNode.id,
    participantId: participant.id,
    bundleId: bundle.id,
    routeId: route.id,
  }
}

async function createSecondTenant(label: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return createTenant({
    name: `Phase 14D Other — ${label}`,
    slug: `p14d-other-${label.toLowerCase()}-${stamp}`,
    plan: 'growth',
  })
}

// ===========================================================================
// T1 — Tenant isolation
// ===========================================================================

describeOrSkip('Phase 14D: T1 — Tenant isolation', () => {
  it('Tenant A cannot access Tenant B transport executions', async () => {
    const f = await createTransportFixture('T1')
    const tenantB = await createSecondTenant('T1')

    const execution = await createTransportExecution(f.tenantId, {
      routeId: f.routeId,
      bundleId: f.bundleId,
      idempotencyKey: 't1-key',
    })

    // Tenant A can read it.
    const fetched = await getTransportExecution(f.tenantId, execution.id)
    expect(fetched.id).toBe(execution.id)

    // Tenant B cannot read it.
    await expect(getTransportExecution(tenantB.id, execution.id)).rejects.toBeInstanceOf(NotFoundError)

    // Tenant B cannot list it.
    const tenantBExecs = await listTransportExecutions(tenantB.id)
    expect(tenantBExecs.find((e) => e.id === execution.id)).toBeUndefined()
  })
})

// ===========================================================================
// T2 — Bundle immutability
// ===========================================================================

describeOrSkip('Phase 14D: T2 — Bundle immutability', () => {
  it('Transport execution references Bundle but cannot mutate its identity', async () => {
    const f = await createTransportFixture('T2')

    const bundleBefore = await getBundle(f.tenantId, f.bundleId)
    const beforeId = bundleBefore.id
    const beforePayload = bundleBefore.payloadBytesJson
    const beforeHash = bundleBefore.payloadHash
    const beforeDest = bundleBefore.destinationNodeId

    const execution = await createTransportExecution(f.tenantId, {
      routeId: f.routeId,
      bundleId: f.bundleId,
      idempotencyKey: 't2-key',
    })

    // Bundle is UNCHANGED — TransportExecution references, does not modify.
    const bundleAfter = await getBundle(f.tenantId, f.bundleId)
    expect(bundleAfter.id).toBe(beforeId)
    expect(bundleAfter.payloadBytesJson).toBe(beforePayload)
    expect(bundleAfter.payloadHash).toBe(beforeHash)
    expect(bundleAfter.destinationNodeId).toBe(beforeDest)

    // The execution references the Bundle via FK.
    expect(execution.bundleId).toBe(f.bundleId)
  })
})

// ===========================================================================
// T3 — Route immutability
// ===========================================================================

describeOrSkip('Phase 14D: T3 — Route immutability', () => {
  it('Transport execution references Route but does not modify it', async () => {
    const f = await createTransportFixture('T3')

    const routeBefore = await getRoute(f.tenantId, f.routeId)
    const beforeSource = routeBefore.sourceNodeId
    const beforeDest = routeBefore.destinationNodeId
    const beforeStatus = routeBefore.status

    const execution = await createTransportExecution(f.tenantId, {
      routeId: f.routeId,
      bundleId: f.bundleId,
      idempotencyKey: 't3-key',
    })

    // Route is UNCHANGED.
    const routeAfter = await getRoute(f.tenantId, f.routeId)
    expect(routeAfter.sourceNodeId).toBe(beforeSource)
    expect(routeAfter.destinationNodeId).toBe(beforeDest)
    expect(routeAfter.status).toBe(beforeStatus)

    // The execution references the Route via FK.
    expect(execution.routeId).toBe(f.routeId)
  })
})

// ===========================================================================
// T4 — Execution lifecycle
// ===========================================================================

describeOrSkip('Phase 14D: T4 — Execution lifecycle', () => {
  it('created → started → completed is valid; completed → started is invalid', async () => {
    const f = await createTransportFixture('T4')

    const execution = await createTransportExecution(f.tenantId, {
      routeId: f.routeId,
      bundleId: f.bundleId,
      idempotencyKey: 't4-key',
    })
    expect(execution.status).toBe('created')

    // created → started (valid).
    const started = await startTransportExecution(f.tenantId, execution.id)
    expect(started.status).toBe('started')
    expect(started.startedAt).toBeDefined()

    // started → completed (valid).
    const completed = await completeTransportExecution(f.tenantId, execution.id)
    expect(completed.status).toBe('completed')
    expect(completed.completedAt).toBeDefined()

    // completed → started (invalid — terminal).
    await expect(startTransportExecution(f.tenantId, execution.id)).rejects.toBeInstanceOf(ValidationError)
    // completed → completed (invalid — already terminal).
    await expect(completeTransportExecution(f.tenantId, execution.id)).rejects.toBeInstanceOf(ValidationError)
  })

  it('started → failed is valid; failed cannot revert', async () => {
    const f = await createTransportFixture('T4b')

    const execution = await createTransportExecution(f.tenantId, {
      routeId: f.routeId,
      bundleId: f.bundleId,
      idempotencyKey: 't4b-key',
    })
    await startTransportExecution(f.tenantId, execution.id)

    const failed = await failTransportExecution(f.tenantId, execution.id, 'transport_timeout')
    expect(failed.status).toBe('failed')
    expect(failed.failureReason).toBe('transport_timeout')

    // failed → started (invalid — terminal).
    await expect(startTransportExecution(f.tenantId, execution.id)).rejects.toBeInstanceOf(ValidationError)
  })

  it('cancel transitions non-terminal to cancelled', async () => {
    const f = await createTransportFixture('T4c')

    const execution = await createTransportExecution(f.tenantId, {
      routeId: f.routeId,
      bundleId: f.bundleId,
      idempotencyKey: 't4c-key',
    })
    await startTransportExecution(f.tenantId, execution.id)

    const cancelled = await cancelTransportExecution(f.tenantId, execution.id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancelledAt).toBeDefined()

    // cancelled → started (invalid — terminal).
    await expect(startTransportExecution(f.tenantId, execution.id)).rejects.toBeInstanceOf(ValidationError)
  })
})

// ===========================================================================
// T5 — Failure recovery
// ===========================================================================

describeOrSkip('Phase 14D: T5 — Failure recovery', () => {
  it('a failed execution can create another execution attempt', async () => {
    const f = await createTransportFixture('T5')

    // First execution fails.
    const exec1 = await createTransportExecution(f.tenantId, {
      routeId: f.routeId,
      bundleId: f.bundleId,
      idempotencyKey: 't5-key-1',
    })
    await startTransportExecution(f.tenantId, exec1.id)
    await failTransportExecution(f.tenantId, exec1.id, 'attempt_1_failed')

    // A NEW execution can be created (recovery — different idempotencyKey).
    const exec2 = await createTransportExecution(f.tenantId, {
      routeId: f.routeId,
      bundleId: f.bundleId,
      idempotencyKey: 't5-key-2',
    })
    expect(exec2.id).not.toBe(exec1.id)
    expect(exec2.attemptNumber).toBe(1) // fresh execution, attempt 1

    // The failed execution's attempts do NOT block the new execution.
    await startTransportExecution(f.tenantId, exec2.id)
    const completed = await completeTransportExecution(f.tenantId, exec2.id)
    expect(completed.status).toBe('completed')
  })

  it('a failed attempt does not fail the execution', async () => {
    const f = await createTransportFixture('T5b')

    const execution = await createTransportExecution(f.tenantId, {
      routeId: f.routeId,
      bundleId: f.bundleId,
      idempotencyKey: 't5b-key',
    })
    await startTransportExecution(f.tenantId, execution.id)

    // First attempt fails.
    const attempt1 = await createTransportAttempt(f.tenantId, {
      executionId: execution.id,
      fromNodeId: f.sourceNodeId,
      toNodeId: f.intermediateNodeId,
    })
    await markAttemptSent(f.tenantId, attempt1.id)
    await failAttempt(f.tenantId, attempt1.id, 'timeout')

    // Execution is still started (NOT failed by the failed attempt).
    const execStillStarted = await getTransportExecution(f.tenantId, execution.id)
    expect(execStillStarted.status).toBe('started')

    // A second attempt can be created (recovery within the same execution).
    const attempt2 = await createTransportAttempt(f.tenantId, {
      executionId: execution.id,
      fromNodeId: f.sourceNodeId,
      toNodeId: f.intermediateNodeId,
    })
    expect(attempt2.id).not.toBe(attempt1.id)

    // Second attempt succeeds.
    await markAttemptSent(f.tenantId, attempt2.id)
    const acked = await acknowledgeAttempt(f.tenantId, attempt2.id)
    expect(acked.status).toBe('acknowledged')

    // Execution can now complete.
    const completed = await completeTransportExecution(f.tenantId, execution.id)
    expect(completed.status).toBe('completed')
  })
})

// ===========================================================================
// T6 — Concurrent execution creation
// ===========================================================================

describeOrSkip('Phase 14D: T6 — Concurrent execution creation', () => {
  it('two identical execution requests converge to one durable execution', async () => {
    const f = await createTransportFixture('T6')

    const input = {
      routeId: f.routeId,
      bundleId: f.bundleId,
      idempotencyKey: 't6-concurrent-key',
    }

    const results = await Promise.allSettled([
      createTransportExecution(f.tenantId, input),
      createTransportExecution(f.tenantId, input),
      createTransportExecution(f.tenantId, input),
    ])

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createTransportExecution>>> =>
        r.status === 'fulfilled',
    )
    const rejected = results.filter((r) => r.status === 'rejected')

    // All converge (P2002 catch + re-read).
    expect(rejected.length).toBe(0)
    expect(fulfilled.length).toBe(3)

    // All resolved IDs are identical.
    const ids = new Set(fulfilled.map((r) => r.value.id))
    expect(ids.size).toBe(1)

    // Exactly one execution row.
    const count = await db.transportExecution.count({
      where: { tenantId: f.tenantId, idempotencyKey: 't6-concurrent-key' },
    })
    expect(count).toBe(1)
  })
})

// ===========================================================================
// T7 — Attempt ordering
// ===========================================================================

describeOrSkip('Phase 14D: T7 — Attempt ordering', () => {
  it('attempts maintain deterministic ordering via createdAt', async () => {
    const f = await createTransportFixture('T7')

    const execution = await createTransportExecution(f.tenantId, {
      routeId: f.routeId,
      bundleId: f.bundleId,
      idempotencyKey: 't7-key',
    })
    await startTransportExecution(f.tenantId, execution.id)

    // Create 3 attempts sequentially.
    const a1 = await createTransportAttempt(f.tenantId, {
      executionId: execution.id,
      fromNodeId: f.sourceNodeId,
      toNodeId: f.intermediateNodeId,
    })
    const a2 = await createTransportAttempt(f.tenantId, {
      executionId: execution.id,
      fromNodeId: f.intermediateNodeId,
      toNodeId: f.destinationNodeId,
    })
    const a3 = await createTransportAttempt(f.tenantId, {
      executionId: execution.id,
      fromNodeId: f.sourceNodeId,
      toNodeId: f.destinationNodeId,
    })

    // Re-read with ordering by createdAt ascending.
    const refetched = await getTransportExecution(f.tenantId, execution.id)
    expect(refetched.attempts.length).toBe(3)

    // Ordering is deterministic (by createdAt ascending).
    expect(refetched.attempts[0].id).toBe(a1.id)
    expect(refetched.attempts[1].id).toBe(a2.id)
    expect(refetched.attempts[2].id).toBe(a3.id)

    // Each attempt records its from/to Node.
    expect(refetched.attempts[0].fromNodeId).toBe(f.sourceNodeId)
    expect(refetched.attempts[0].toNodeId).toBe(f.intermediateNodeId)
    expect(refetched.attempts[1].fromNodeId).toBe(f.intermediateNodeId)
    expect(refetched.attempts[1].toNodeId).toBe(f.destinationNodeId)
  })
})

// ===========================================================================
// T8 — Capability isolation
// ===========================================================================

describeOrSkip('Phase 14D: T8 — Capability isolation', () => {
  it('TransportCapability is a declaration, not network ownership/bandwidth/pricing', async () => {
    const f = await createTransportFixture('T8')

    // Declare a capability.
    const cap1 = await declareTransportCapability(f.tenantId, f.sourceNodeId, 'STORE_AND_FORWARD')
    const cap2 = await declareTransportCapability(f.tenantId, f.sourceNodeId, 'STORE_AND_FORWARD')
    expect(cap2.id).toBe(cap1.id) // idempotent

    // Multiple different capabilities per Node.
    const cap3 = await declareTransportCapability(f.tenantId, f.sourceNodeId, 'BUNDLE_TRANSFER')
    expect(cap3.id).not.toBe(cap1.id)

    // List capabilities.
    const caps = await listTransportCapabilities(f.tenantId, f.sourceNodeId)
    expect(caps.length).toBe(2)
    expect(caps.map((c) => c.capability).sort()).toEqual(['BUNDLE_TRANSFER', 'STORE_AND_FORWARD'])

    // The capability model has NO network ownership/bandwidth/pricing fields.
    // Verify by checking the schema doesn't have those fields.
    // (This is enforced structurally by the Phase 14D architecture contract tests.)
    expect(cap1.capability).toBe('STORE_AND_FORWARD')
    expect(cap1.status).toBe('active')
  })

  it('suspended Nodes cannot declare transport capabilities', async () => {
    const f = await createTransportFixture('T8b')

    const suspendedNode = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'Suspended cap node',
      idempotencyKey: 't8b-suspended',
    })
    await suspendNode(f.tenantId, suspendedNode.id)

    await expect(
      declareTransportCapability(f.tenantId, suspendedNode.id, 'TRANSPORT_EXECUTION'),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
