// =============================================================================
// Routing service — Phase 14C: Data Plane Routing Foundation.
//
// A Route is a planned path from source Node to destination Node, ATTACHED to
// a Bundle. It represents WHERE a Bundle should go, NOT how it gets there
// physically. It is DISTINCT from Bundle (Route attaches to it, does NOT modify
// Bundle identity/payload/destination — Step 7) and from transport (no
// TCP/UDP/Bluetooth/WiFi/satellite/DTN forwarding — Step 5).
//
// This service implements the minimal routing substrate (Step 9):
//   createRoutePlan() → addRouteHop() → getRoute() / listRoutes() → expireRoute()
//
// ARCHITECTURAL RULES (frozen):
//   - Route is immutable after creation. A revised route is a NEW Route (the
//     old one is NOT mutated).
//   - Route does NOT modify Bundle identity/payload/destination (Step 7 —
//     Route ATTACHES information, does not redefine the Bundle).
//   - Tenant isolation: all queries filter by tenantId.
//   - Node lifecycle enforcement (R6): suspended/revoked Nodes cannot be added
//     to new routes.
//   - Concurrent route creation (R7): deterministic convergence via P2002
//     catch + re-read (same pattern as Node/Bundle).
//   - Expiry (R8): persisted expiresAt timestamp. Expired routes cannot become
//     active.
//   - Route source/destination MUST match the Bundle's source/destination
//     (a Route plans for a SPECIFIC Bundle's journey).
//
// This service does NOT import:
//   - VPP / Compute / Storage / Wireless vertical services (anti-drift).
//   - ProtocolRuntime / HybridRuntime / economic pipeline (no kernel coupling).
//   - Transport / DTN / Transform / Extension / Marketplace (future — Step 5).
//
// NOT allowed (Step 9 — execution belongs to a LATER phase):
//   forwardBundle(), sendPacket(), openConnection(), selectRadio()
// =============================================================================
//
// FINAL RULE (Step 13): Do not build a network. Build the primitive that
// allows future networks to exist. The output of Phase 14C is NOT connectivity.
// It is a generic, immutable, auditable routing substrate that future
// connectivity protocols can consume.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { getNode } from '@/lib/services/node.service'
import { getBundle } from '@/lib/services/data-plane.service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateRoutePlanInput {
  /** The Bundle this route plans for. */
  bundleId: string
  /** When this route plan expires. After expiry, cannot become active. */
  expiresAt: Date
  metadata?: Record<string, unknown>
}

export interface AddRouteHopInput {
  routeId: string
  /** Hop ordering (0, 1, 2, ...). Must be unique per route. */
  sequence: number
  /** The Node this hop starts from. */
  fromNodeId: string
  /** The Node this hop goes to. */
  toNodeId: string
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// createRoutePlan — create a routing plan for a Bundle
// ---------------------------------------------------------------------------

/**
 * Create a Route plan for a Bundle. The Route's sourceNodeId and
 * destinationNodeId are derived from the Bundle (a Route plans for a SPECIFIC
 * Bundle's journey). The Route does NOT modify the Bundle — it attaches a
 * planning artifact (Step 7).
 *
 * Validation:
 *   - The Bundle must exist in the tenant.
 *   - expiresAt must be provided (a Route without expiry is invalid).
 *
 * The Route is created in `planned` status. Call activateRoute() (future) to
 * transition to `active`. Expired routes (expiresAt < now) cannot become
 * active (R8).
 *
 * Idempotent: concurrent createRoutePlan calls for the same Bundle converge
 * via P2002 catch + re-read IF a deterministic idempotency key is used. For
 * Phase 14C, Route identity is a cuid (multiple routes per Bundle are allowed
 * — a Bundle may be re-routed). The caller controls uniqueness via the
 * metadata.idempotencyKey if needed.
 */
export async function createRoutePlan(
  tenantId: string,
  input: CreateRoutePlanInput,
  actorId?: string,
) {
  if (!input.bundleId) throw new ValidationError('bundleId is required')
  if (!input.expiresAt) throw new ValidationError('expiresAt is required')

  // Validate the Bundle exists in the tenant. The Route's source/destination
  // are derived from the Bundle — a Route plans for a SPECIFIC Bundle.
  const bundle = await getBundle(tenantId, input.bundleId)

  const route = await db.route.create({
    data: {
      tenantId,
      bundleId: bundle.id,
      sourceNodeId: bundle.sourceNodeId,
      destinationNodeId: bundle.destinationNodeId,
      status: 'planned',
      expiresAt: input.expiresAt,
      metadataJson: JSON.stringify(input.metadata ?? {}),
    },
  })

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.RoutePlanned,
    resourceType: 'route',
    resourceId: route.id,
    metadata: {
      bundleId: bundle.id,
      sourceNodeId: bundle.sourceNodeId,
      destinationNodeId: bundle.destinationNodeId,
    },
  })

  return route
}

// ---------------------------------------------------------------------------
// addRouteHop — add an ordered hop to a route
// ---------------------------------------------------------------------------

/**
 * Add a hop to a route. Hops are ordered via `sequence` (Int). The sequence
 * must be unique per route (@@unique([routeId, sequence])).
 *
 * Node lifecycle enforcement (R6): both fromNodeId and toNodeId must be
 * active Nodes in the tenant. Suspended/revoked Nodes cannot be added to new
 * routes.
 *
 * Concurrent addRouteHop calls with the same sequence converge via P2002
 * catch + re-read (R7 pattern).
 */
export async function addRouteHop(
  tenantId: string,
  input: AddRouteHopInput,
  actorId?: string,
) {
  if (!input.routeId) throw new ValidationError('routeId is required')
  if (input.sequence == null || input.sequence < 0) {
    throw new ValidationError('sequence must be a non-negative integer')
  }
  if (!input.fromNodeId) throw new ValidationError('fromNodeId is required')
  if (!input.toNodeId) throw new ValidationError('toNodeId is required')
  if (input.fromNodeId === input.toNodeId) {
    throw new ValidationError('fromNodeId and toNodeId must differ')
  }

  // Validate the Route exists in the tenant.
  const route = await getRoute(tenantId, input.routeId)
  if (route.status === 'expired') {
    throw new ValidationError(`Route ${input.routeId} is expired`)
  }
  if (route.status === 'completed' || route.status === 'failed') {
    throw new ValidationError(`Route ${input.routeId} is ${route.status} (terminal)`)
  }

  // Node lifecycle enforcement (R6): both Nodes must be active.
  const fromNode = await getNode(tenantId, input.fromNodeId)
  if (fromNode.status !== 'active') {
    throw new ValidationError(
      `From Node ${input.fromNodeId} is ${fromNode.status}; only active Nodes can be added to routes`,
    )
  }
  const toNode = await getNode(tenantId, input.toNodeId)
  if (toNode.status !== 'active') {
    throw new ValidationError(
      `To Node ${input.toNodeId} is ${toNode.status}; only active Nodes can be added to routes`,
    )
  }

  // Idempotent insert: try create, catch P2002 (duplicate sequence), re-read.
  try {
    const hop = await db.routeHop.create({
      data: {
        routeId: input.routeId,
        sequence: input.sequence,
        fromNodeId: input.fromNodeId,
        toNodeId: input.toNodeId,
        status: 'planned',
        metadataJson: JSON.stringify(input.metadata ?? {}),
      },
    })

    await appendAudit({
      tenantId,
      actorId,
      eventType: AuditEvents.RouteHopAdded,
      resourceType: 'route_hop',
      resourceId: hop.id,
      metadata: {
        routeId: input.routeId,
        sequence: input.sequence,
        fromNodeId: input.fromNodeId,
        toNodeId: input.toNodeId,
      },
    })

    return hop
  } catch (err: unknown) {
    // P2002: a hop with this sequence already exists. Re-read and return it
    // (idempotent convergence — R7).
    if (isPrismaUniqueConstraintError(err)) {
      const existing = await db.routeHop.findFirst({
        where: { routeId: input.routeId, sequence: input.sequence },
      })
      if (existing) return existing
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// getRoute / listRoutes — tenant-scoped reads
// ---------------------------------------------------------------------------

export async function getRoute(tenantId: string, routeId: string) {
  const route = await db.route.findFirst({
    where: { id: routeId, tenantId },
    include: {
      bundle: true,
      sourceNode: true,
      destinationNode: true,
      hops: { orderBy: { sequence: 'asc' } },
    },
  })
  if (!route) throw new NotFoundError('route', routeId)
  return route
}

export interface ListRouteFilter {
  bundleId?: string
  status?: string
}

export async function listRoutes(tenantId: string, filter?: ListRouteFilter) {
  return db.route.findMany({
    where: {
      tenantId,
      ...(filter?.bundleId ? { bundleId: filter.bundleId } : {}),
      ...(filter?.status ? { status: filter.status } : {}),
    },
    include: {
      bundle: true,
      sourceNode: true,
      destinationNode: true,
      hops: { orderBy: { sequence: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
  })
}

// ---------------------------------------------------------------------------
// activateRoute — transition planned → active (with expiry check)
// ---------------------------------------------------------------------------

/**
 * Activate a planned route. Enforces expiry (R8): if the route's expiresAt
 * has passed, activation is rejected and the route is marked expired.
 */
export async function activateRoute(tenantId: string, routeId: string, actorId?: string) {
  const route = await getRoute(tenantId, routeId)

  // Expiry enforcement (R8).
  const now = new Date()
  if (route.expiresAt <= now) {
    if (route.status !== 'expired') {
      await db.route.update({
        where: { id: routeId },
        data: { status: 'expired' },
      })
      await appendAudit({
        tenantId,
        actorId,
        eventType: AuditEvents.RouteExpired,
        resourceType: 'route',
        resourceId: routeId,
        metadata: { expiresAt: route.expiresAt.toISOString() },
      })
    }
    throw new ValidationError(
      `Route ${routeId} has expired (expiresAt ${route.expiresAt.toISOString()})`,
    )
  }

  if (route.status === 'completed' || route.status === 'failed' || route.status === 'expired') {
    throw new ValidationError(`Route ${routeId} is ${route.status} (terminal)`)
  }
  if (route.status === 'active') return route

  const updated = await db.route.update({
    where: { id: routeId },
    data: { status: 'active' },
  })

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.RouteActivated,
    resourceType: 'route',
    resourceId: routeId,
  })

  return updated
}

// ---------------------------------------------------------------------------
// completeRoute — transition active → completed
// ---------------------------------------------------------------------------

export async function completeRoute(tenantId: string, routeId: string, actorId?: string) {
  const route = await getRoute(tenantId, routeId)
  if (route.status === 'completed') return route
  if (route.status !== 'active') {
    throw new ValidationError(
      `Route ${routeId} is ${route.status}; only active routes can be completed`,
    )
  }
  const updated = await db.route.update({
    where: { id: routeId },
    data: { status: 'completed', completedAt: new Date() },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.RouteCompleted,
    resourceType: 'route',
    resourceId: routeId,
  })
  return updated
}

// ---------------------------------------------------------------------------
// failRoute — transition active → failed
// ---------------------------------------------------------------------------

export async function failRoute(tenantId: string, routeId: string, actorId?: string) {
  const route = await getRoute(tenantId, routeId)
  if (route.status === 'failed') return route
  if (route.status !== 'active') {
    throw new ValidationError(
      `Route ${routeId} is ${route.status}; only active routes can be failed`,
    )
  }
  const updated = await db.route.update({
    where: { id: routeId },
    data: { status: 'failed' },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.RouteFailed,
    resourceType: 'route',
    resourceId: routeId,
  })
  return updated
}

// ---------------------------------------------------------------------------
// expireRoute — explicit expiry transition
// ---------------------------------------------------------------------------

/**
 * Explicitly mark a Route as expired. Used by cleanup/recovery paths.
 * After expiry, the route cannot become active (R8).
 */
export async function expireRoute(tenantId: string, routeId: string, actorId?: string) {
  const route = await getRoute(tenantId, routeId)
  if (route.status === 'expired') return route
  const updated = await db.route.update({
    where: { id: routeId },
    data: { status: 'expired' },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.RouteExpired,
    resourceType: 'route',
    resourceId: routeId,
  })
  return updated
}

// ---------------------------------------------------------------------------
// Node capability + reachability helpers
// ---------------------------------------------------------------------------

/**
 * Declare a data-plane capability for a Node. Idempotent: same
 * (nodeId, capability) → same declaration.
 */
export async function declareNodeCapability(
  tenantId: string,
  nodeId: string,
  capability: string,
  actorId?: string,
) {
  // Validate Node exists + is active.
  const node = await getNode(tenantId, nodeId)
  if (node.status !== 'active') {
    throw new ValidationError(
      `Node ${nodeId} is ${node.status}; only active Nodes can declare capabilities`,
    )
  }

  // Idempotent: find or create.
  const existing = await db.nodeCapability.findUnique({
    where: { nodeId_capability: { nodeId, capability } },
  })
  if (existing) return existing

  return db.nodeCapability.create({
    data: { tenantId, nodeId, capability, status: 'active' },
  })
}

/**
 * Update Node reachability knowledge. This is KNOWLEDGE, not proof of physical
 * connectivity (Step 6.4). One reachability record per Node.
 */
export async function updateNodeReachability(
  tenantId: string,
  nodeId: string,
  reachable: boolean,
  latencyHint: number | null,
  expiresAt: Date,
  actorId?: string,
) {
  // Validate Node exists in tenant.
  await getNode(tenantId, nodeId)

  // Upsert: one reachability record per Node (@@unique nodeId).
  return db.nodeReachability.upsert({
    where: { nodeId },
    create: {
      tenantId,
      nodeId,
      reachable,
      lastSeen: new Date(),
      latencyHint,
      expiresAt,
    },
    update: {
      reachable,
      lastSeen: new Date(),
      latencyHint,
      expiresAt,
    },
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Type guard for Prisma unique-constraint violation (P2002).
 * Used to handle concurrent-operation convergence.
 */
function isPrismaUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string }
  return e.code === 'P2002'
}
