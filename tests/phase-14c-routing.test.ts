/**
 * Phase 14C: Data Plane Routing Foundation — Integration Tests
 *
 * Proves the frozen Route contract (docs/architecture/PHASE-14C-ROUTING-CONTRACT.md):
 *   - Route is a planning artifact ATTACHED to a Bundle (does NOT modify Bundle).
 *   - Route identity is immutable (cuid). Route does NOT redefine Bundle.
 *   - RouteHop ordering is deterministic (sequence).
 *   - Tenant isolation, Node lifecycle enforcement, concurrent convergence, expiry.
 *
 * Tests:
 *   R1 — Route creation: route created, tenant-scoped, bundle linked.
 *   R2 — Route immutability: bundle unchanged, destination unchanged, payload unchanged.
 *   R3 — Ordered hops: hop ordering deterministic, sequence preserved.
 *   R4 — Multi-hop route: Node A → Node B → Node C works.
 *   R5 — Tenant isolation: Tenant A cannot access Tenant B routes.
 *   R6 — Node lifecycle: suspended/revoked Nodes cannot be added to new routes.
 *   R7 — Concurrent route creation: multiple identical requests converge.
 *   R8 — Expiry: expired routes cannot become active.
 *
 * Run: DATABASE_URL=postgresql://... bun test tests/phase-14c-routing.test.ts --timeout 300000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { registerNode, activateNode, suspendNode, revokeNode } from '../src/lib/services/node.service'
import { createBundle, getBundle } from '../src/lib/services/data-plane.service'
import {
  createRoutePlan,
  addRouteHop,
  getRoute,
  listRoutes,
  activateRoute,
  completeRoute,
  failRoute,
  expireRoute,
  declareNodeCapability,
  updateNodeReachability,
} from '../src/lib/services/routing.service'
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
// Fixture: isolated tenant + 3 Nodes (source, intermediate, destination) + Bundle
// ---------------------------------------------------------------------------

interface RoutingFixture {
  tenantId: string
  sourceNodeId: string
  intermediateNodeId: string
  destinationNodeId: string
  participantId: string
  bundleId: string
}

const FUTURE_EXPIRY = () => new Date(Date.now() + 60 * 60 * 1000) // +1h
const PAST_EXPIRY = () => new Date(Date.now() - 60 * 60 * 1000) // -1h

async function createRoutingFixture(label: string): Promise<RoutingFixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const labelLc = label.toLowerCase()

  const tenant = await createTenant({
    name: `Phase 14C Routing — ${label}`,
    slug: `p14c-${labelLc}-${stamp}`,
    plan: 'growth',
  })

  const participant = await db.participantIdentity.create({ data: {} })

  // Three active Nodes for multi-hop routing.
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

  // Create a Bundle for the route to attach to.
  const bundle = await createBundle(tenant.id, {
    sourceNodeId: sourceNode.id,
    destinationNodeId: destNode.id,
    nodeKind: 'generic_payload',
    payloadType: 'application/json',
    payload: '{"route":"test"}',
    idempotencyKey: `bundle-${labelLc}-${stamp}`,
    expiryTime: FUTURE_EXPIRY(),
  })

  return {
    tenantId: tenant.id,
    sourceNodeId: sourceNode.id,
    intermediateNodeId: intermediateNode.id,
    destinationNodeId: destNode.id,
    participantId: participant.id,
    bundleId: bundle.id,
  }
}

async function createSecondTenant(label: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return createTenant({
    name: `Phase 14C Other — ${label}`,
    slug: `p14c-other-${label.toLowerCase()}-${stamp}`,
    plan: 'growth',
  })
}

// ===========================================================================
// R1 — Route creation
// ===========================================================================

describeOrSkip('Phase 14C: R1 — Route creation', () => {
  it('route is created, tenant-scoped, and bundle-linked', async () => {
    const f = await createRoutingFixture('R1')

    const route = await createRoutePlan(f.tenantId, {
      bundleId: f.bundleId,
      expiresAt: FUTURE_EXPIRY(),
    })

    expect(route.id).toBeDefined()
    expect(route.tenantId).toBe(f.tenantId)
    expect(route.bundleId).toBe(f.bundleId)
    expect(route.status).toBe('planned')

    // Route source/destination are DERIVED from the Bundle.
    expect(route.sourceNodeId).toBe(f.sourceNodeId)
    expect(route.destinationNodeId).toBe(f.destinationNodeId)

    // Re-read to confirm persistence.
    const refetched = await getRoute(f.tenantId, route.id)
    expect(refetched.id).toBe(route.id)
    expect(refetched.bundleId).toBe(f.bundleId)
  })
})

// ===========================================================================
// R2 — Route immutability (Bundle unchanged)
// ===========================================================================

describeOrSkip('Phase 14C: R2 — Route immutability', () => {
  it('Route does NOT modify Bundle identity, destination, or payload', async () => {
    const f = await createRoutingFixture('R2')

    // Capture Bundle state before route creation.
    const bundleBefore = await getBundle(f.tenantId, f.bundleId)
    const beforeDest = bundleBefore.destinationNodeId
    const beforePayload = bundleBefore.payloadBytesJson
    const beforeId = bundleBefore.id
    const beforeHash = bundleBefore.payloadHash

    // Create a route for this Bundle.
    const route = await createRoutePlan(f.tenantId, {
      bundleId: f.bundleId,
      expiresAt: FUTURE_EXPIRY(),
    })

    // Add a hop.
    await addRouteHop(f.tenantId, {
      routeId: route.id,
      sequence: 0,
      fromNodeId: f.sourceNodeId,
      toNodeId: f.intermediateNodeId,
    })

    // Bundle is UNCHANGED — Route attaches information, does not redefine Bundle.
    const bundleAfter = await getBundle(f.tenantId, f.bundleId)
    expect(bundleAfter.id).toBe(beforeId)
    expect(bundleAfter.destinationNodeId).toBe(beforeDest)
    expect(bundleAfter.payloadBytesJson).toBe(beforePayload)
    expect(bundleAfter.payloadHash).toBe(beforeHash)
    expect(bundleAfter.sourceNodeId).toBe(bundleBefore.sourceNodeId)
  })
})

// ===========================================================================
// R3 — Ordered hops (deterministic sequence)
// ===========================================================================

describeOrSkip('Phase 14C: R3 — Ordered hops', () => {
  it('hop ordering is deterministic and sequence is preserved', async () => {
    const f = await createRoutingFixture('R3')

    const route = await createRoutePlan(f.tenantId, {
      bundleId: f.bundleId,
      expiresAt: FUTURE_EXPIRY(),
    })

    // Add hops out of order — they must be retrievable in sequence order.
    await addRouteHop(f.tenantId, {
      routeId: route.id,
      sequence: 2,
      fromNodeId: f.intermediateNodeId,
      toNodeId: f.destinationNodeId,
    })
    await addRouteHop(f.tenantId, {
      routeId: route.id,
      sequence: 0,
      fromNodeId: f.sourceNodeId,
      toNodeId: f.intermediateNodeId,
    })
    await addRouteHop(f.tenantId, {
      routeId: route.id,
      sequence: 1,
      fromNodeId: f.sourceNodeId,
      toNodeId: f.intermediateNodeId,
    })

    const refetched = await getRoute(f.tenantId, route.id)
    expect(refetched.hops.length).toBe(3)

    // Hops are ordered by sequence ascending.
    expect(refetched.hops[0].sequence).toBe(0)
    expect(refetched.hops[1].sequence).toBe(1)
    expect(refetched.hops[2].sequence).toBe(2)

    // Duplicate sequence is rejected (idempotent convergence — returns existing).
    const dup = await addRouteHop(f.tenantId, {
      routeId: route.id,
      sequence: 0,
      fromNodeId: f.sourceNodeId,
      toNodeId: f.intermediateNodeId,
    })
    expect(dup.id).toBe(refetched.hops[0].id) // same hop, not a new one

    // Still only 3 hops.
    const refetched2 = await getRoute(f.tenantId, route.id)
    expect(refetched2.hops.length).toBe(3)
  })
})

// ===========================================================================
// R4 — Multi-hop route
// ===========================================================================

describeOrSkip('Phase 14C: R4 — Multi-hop route', () => {
  it('Node A → Node B → Node C multi-hop route works', async () => {
    const f = await createRoutingFixture('R4')

    const route = await createRoutePlan(f.tenantId, {
      bundleId: f.bundleId,
      expiresAt: FUTURE_EXPIRY(),
    })

    // Hop 0: Source → Intermediate
    await addRouteHop(f.tenantId, {
      routeId: route.id,
      sequence: 0,
      fromNodeId: f.sourceNodeId,
      toNodeId: f.intermediateNodeId,
    })
    // Hop 1: Intermediate → Destination
    await addRouteHop(f.tenantId, {
      routeId: route.id,
      sequence: 1,
      fromNodeId: f.intermediateNodeId,
      toNodeId: f.destinationNodeId,
    })

    const refetched = await getRoute(f.tenantId, route.id)
    expect(refetched.hops.length).toBe(2)

    // Hop 0: source → intermediate
    expect(refetched.hops[0].fromNodeId).toBe(f.sourceNodeId)
    expect(refetched.hops[0].toNodeId).toBe(f.intermediateNodeId)

    // Hop 1: intermediate → destination
    expect(refetched.hops[1].fromNodeId).toBe(f.intermediateNodeId)
    expect(refetched.hops[1].toNodeId).toBe(f.destinationNodeId)

    // The route's overall source/destination match the Bundle.
    expect(refetched.sourceNodeId).toBe(f.sourceNodeId)
    expect(refetched.destinationNodeId).toBe(f.destinationNodeId)
  })
})

// ===========================================================================
// R5 — Tenant isolation
// ===========================================================================

describeOrSkip('Phase 14C: R5 — Tenant isolation', () => {
  it('Tenant A cannot access Tenant B routes', async () => {
    const fA = await createRoutingFixture('R5')
    const tenantB = await createSecondTenant('R5')

    const route = await createRoutePlan(fA.tenantId, {
      bundleId: fA.bundleId,
      expiresAt: FUTURE_EXPIRY(),
    })

    // Tenant A can read it.
    const fetched = await getRoute(fA.tenantId, route.id)
    expect(fetched.id).toBe(route.id)

    // Tenant B cannot read it.
    await expect(getRoute(tenantB.id, route.id)).rejects.toBeInstanceOf(NotFoundError)

    // Tenant B cannot list it.
    const tenantBRoutes = await listRoutes(tenantB.id)
    expect(tenantBRoutes.find((r) => r.id === route.id)).toBeUndefined()

    // Tenant B cannot add hops to Tenant A's route.
    await expect(
      addRouteHop(tenantB.id, {
        routeId: route.id,
        sequence: 0,
        fromNodeId: fA.sourceNodeId,
        toNodeId: fA.intermediateNodeId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

// ===========================================================================
// R6 — Node lifecycle enforcement
// ===========================================================================

describeOrSkip('Phase 14C: R6 — Node lifecycle', () => {
  it('suspended/revoked Nodes cannot be added to new routes', async () => {
    const f = await createRoutingFixture('R6')

    const route = await createRoutePlan(f.tenantId, {
      bundleId: f.bundleId,
      expiresAt: FUTURE_EXPIRY(),
    })

    // Create a suspended Node.
    const suspendedNode = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'Suspended hop node',
      idempotencyKey: 'r6-suspended',
    })
    await suspendNode(f.tenantId, suspendedNode.id)

    // Cannot use a suspended Node as a hop endpoint.
    await expect(
      addRouteHop(f.tenantId, {
        routeId: route.id,
        sequence: 0,
        fromNodeId: f.sourceNodeId,
        toNodeId: suspendedNode.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    await expect(
      addRouteHop(f.tenantId, {
        routeId: route.id,
        sequence: 0,
        fromNodeId: suspendedNode.id,
        toNodeId: f.destinationNodeId,
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    // Create a revoked Node.
    const revokedNode = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'Revoked hop node',
      idempotencyKey: 'r6-revoked',
    })
    await activateNode(f.tenantId, revokedNode.id)
    await revokeNode(f.tenantId, revokedNode.id)

    await expect(
      addRouteHop(f.tenantId, {
        routeId: route.id,
        sequence: 0,
        fromNodeId: f.sourceNodeId,
        toNodeId: revokedNode.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    // Active Nodes CAN be added.
    const hop = await addRouteHop(f.tenantId, {
      routeId: route.id,
      sequence: 0,
      fromNodeId: f.sourceNodeId,
      toNodeId: f.intermediateNodeId,
    })
    expect(hop.status).toBe('planned')
  })
})

// ===========================================================================
// R7 — Concurrent route creation convergence
// ===========================================================================

describeOrSkip('Phase 14C: R7 — Concurrent route creation', () => {
  it('multiple concurrent addRouteHop with same sequence converge to one hop', async () => {
    const f = await createRoutingFixture('R7')

    const route = await createRoutePlan(f.tenantId, {
      bundleId: f.bundleId,
      expiresAt: FUTURE_EXPIRY(),
    })

    const input = {
      routeId: route.id,
      sequence: 0,
      fromNodeId: f.sourceNodeId,
      toNodeId: f.intermediateNodeId,
    }

    // Three concurrent addRouteHop calls with the same sequence.
    const results = await Promise.allSettled([
      addRouteHop(f.tenantId, input),
      addRouteHop(f.tenantId, input),
      addRouteHop(f.tenantId, input),
    ])

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof addRouteHop>>> =>
        r.status === 'fulfilled',
    )
    const rejected = results.filter((r) => r.status === 'rejected')

    // All converge (P2002 catch + re-read).
    expect(rejected.length).toBe(0)
    expect(fulfilled.length).toBe(3)

    // All resolved hop IDs are identical.
    const ids = new Set(fulfilled.map((r) => r.value.id))
    expect(ids.size).toBe(1)

    // Exactly one hop row.
    const count = await db.routeHop.count({ where: { routeId: route.id, sequence: 0 } })
    expect(count).toBe(1)
  })
})

// ===========================================================================
// R8 — Expiry
// ===========================================================================

describeOrSkip('Phase 14C: R8 — Expiry', () => {
  it('expired routes cannot become active', async () => {
    const f = await createRoutingFixture('R8')

    // Create a route that is ALREADY expired.
    const route = await createRoutePlan(f.tenantId, {
      bundleId: f.bundleId,
      expiresAt: PAST_EXPIRY(),
    })

    // Attempt activation → rejected.
    await expect(activateRoute(f.tenantId, route.id)).rejects.toBeInstanceOf(ValidationError)

    // Route status is now 'expired'.
    const expired = await getRoute(f.tenantId, route.id)
    expect(expired.status).toBe('expired')

    // Cannot add hops to an expired route.
    await expect(
      addRouteHop(f.tenantId, {
        routeId: route.id,
        sequence: 0,
        fromNodeId: f.sourceNodeId,
        toNodeId: f.intermediateNodeId,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('non-expired route can be activated and completed', async () => {
    const f = await createRoutingFixture('R8b')

    const route = await createRoutePlan(f.tenantId, {
      bundleId: f.bundleId,
      expiresAt: FUTURE_EXPIRY(),
    })

    // Add a hop.
    await addRouteHop(f.tenantId, {
      routeId: route.id,
      sequence: 0,
      fromNodeId: f.sourceNodeId,
      toNodeId: f.destinationNodeId,
    })

    // Activate.
    const active = await activateRoute(f.tenantId, route.id)
    expect(active.status).toBe('active')

    // Complete.
    const completed = await completeRoute(f.tenantId, route.id)
    expect(completed.status).toBe('completed')
    expect(completed.completedAt).toBeDefined()

    // Cannot re-activate a completed route.
    await expect(activateRoute(f.tenantId, route.id)).rejects.toBeInstanceOf(ValidationError)
  })

  it('explicit expireRoute transitions to expired', async () => {
    const f = await createRoutingFixture('R8c')

    const route = await createRoutePlan(f.tenantId, {
      bundleId: f.bundleId,
      expiresAt: FUTURE_EXPIRY(),
    })

    const active = await activateRoute(f.tenantId, route.id)
    expect(active.status).toBe('active')

    const expired = await expireRoute(f.tenantId, route.id)
    expect(expired.status).toBe('expired')

    // Cannot activate an expired route.
    await expect(activateRoute(f.tenantId, route.id)).rejects.toBeInstanceOf(ValidationError)
  })
})

// ===========================================================================
// Additional: Node capability + reachability
// ===========================================================================

describeOrSkip('Phase 14C: Node capability + reachability', () => {
  it('NodeCapability declaration is idempotent and tenant-scoped', async () => {
    const f = await createRoutingFixture('Cap')

    const cap1 = await declareNodeCapability(f.tenantId, f.sourceNodeId, 'CAN_FORWARD_BUNDLE')
    const cap2 = await declareNodeCapability(f.tenantId, f.sourceNodeId, 'CAN_FORWARD_BUNDLE')
    expect(cap2.id).toBe(cap1.id) // idempotent

    const caps = await db.nodeCapability.findMany({ where: { nodeId: f.sourceNodeId } })
    expect(caps.length).toBe(1)
    expect(caps[0].capability).toBe('CAN_FORWARD_BUNDLE')
  })

  it('NodeReachability is upserted (one record per Node)', async () => {
    const f = await createRoutingFixture('Reach')

    const r1 = await updateNodeReachability(
      f.tenantId,
      f.sourceNodeId,
      true,
      50,
      FUTURE_EXPIRY(),
    )
    expect(r1.reachable).toBe(true)
    expect(r1.latencyHint).toBe(50)

    // Upsert: updates the existing record (one per Node).
    const r2 = await updateNodeReachability(
      f.tenantId,
      f.sourceNodeId,
      false,
      100,
      FUTURE_EXPIRY(),
    )
    expect(r2.id).toBe(r1.id) // same record
    expect(r2.reachable).toBe(false)
    expect(r2.latencyHint).toBe(100)

    const count = await db.nodeReachability.count({ where: { nodeId: f.sourceNodeId } })
    expect(count).toBe(1)
  })
})
