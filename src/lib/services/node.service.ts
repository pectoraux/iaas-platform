// =============================================================================
// Node service — Phase 14A: Node Registration & Participation Foundation.
//
// A Node is a protocol participation endpoint. It is DISTINCT from Asset,
// Device, ParticipantIdentity, and ResourceIdentity (constitution §1).
//
// This service implements the minimal generic lifecycle:
//   registerNode → activateNode → suspendNode / revokeNode
//   joinNetwork / leaveNetwork
//
// ARCHITECTURAL RULES (frozen):
//   - Node identity is immutable (cuid). Never derived from device/IP/MAC/
//     network membership/runtime process ID.
//   - Idempotent registration: deterministic key
//     (tenantId, participantId, nodeKind, idempotencyKey). Concurrent calls
//     with the same key converge to the same durable Node.
//   - Tenant isolation: all queries filter by tenantId.
//   - Device ownership: a participant cannot register a Node against another
//     tenant's Device (N3).
//   - Network authorization: joinNetwork requires a valid ParticipantMembership
//     in the target network, owned by the Node's participant (N8). Network
//     Scope Integrity (§8.6) is enforced via assertNetworkScopeIntegrity.
//   - Lifecycle enforcement: suspended/revoked Nodes cannot join new networks (N5).
//
// This service does NOT import:
//   - VPP / Compute / Storage / Wireless vertical services (anti-drift rule 7).
//   - Data Plane / Bundle / Transform / Extension (future boundaries, rule 10).
//   - ProtocolRuntime / HybridRuntime internals (rule — no kernel coupling).
//
// ProtocolRuntime already uses string-based `sender`/`executor` identity. A
// Node's durable ID (a cuid string) can serve as that identity when a Node
// participates in protocol transactions. No kernel-level Node contract is
// created speculatively (Step 12).
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, NotFoundError, ValidationError, ForbiddenError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { sha256 } from '@/lib/domain/crypto'
import { assertNetworkScopeIntegrity } from '@/lib/control-plane/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisterNodeInput {
  /** The ParticipantIdentity that controls this Node (required for registration). */
  participantId: string
  /** Generic protocol endpoint kind (e.g. "protocol_endpoint"). NOT vertical-specific. */
  nodeKind: string
  displayName: string
  /** Caller-supplied key for deterministic idempotent registration. */
  idempotencyKey: string
  /** Optional backing Device (must belong to the same tenant). */
  deviceId?: string
  /** Optional ResourceIdentity backing (does not duplicate it). */
  resourceId?: string
  /** Generic protocol kinds this node may participate in. */
  protocolEligibility?: string[]
  metadata?: Record<string, unknown>
}

export interface JoinNetworkInput {
  nodeId: string
  networkId: string
  /** The ParticipantMembership authorizing this node's participation. */
  participantMembershipId: string
  protocolRole?: string
}

// ---------------------------------------------------------------------------
// Canonical payload hashing (for idempotency conflict detection)
// ---------------------------------------------------------------------------

/**
 * Compute a canonical payload hash for idempotency conflict detection.
 * If the same (tenantId, participantId, nodeKind, idempotencyKey) is reused
 * with a DIFFERENT payload, this hash will differ → ConflictError.
 *
 * Identity-binding fields (deviceId, resourceId) ARE included because they
 * describe what the node is backed by at registration. displayName and
 * protocolEligibility are included as they are part of the registration
 * intent. The Node's own `id` is NOT included (it is derived from the key).
 */
function computeNodePayloadHash(input: {
  nodeKind: string
  displayName: string
  deviceId?: string
  resourceId?: string
  protocolEligibility?: string[]
  metadata?: Record<string, unknown>
}): string {
  const canonical = JSON.stringify({
    nodeKind: input.nodeKind,
    displayName: input.displayName,
    deviceId: input.deviceId ?? null,
    resourceId: input.resourceId ?? null,
    protocolEligibility: (input.protocolEligibility ?? []).slice().sort(),
    metadata: input.metadata ?? {},
  })
  return sha256(canonical)
}

// ---------------------------------------------------------------------------
// registerNode — idempotent registration
// ---------------------------------------------------------------------------

/**
 * Register a Node. Idempotent: the same (tenantId, participantId, nodeKind,
 * idempotencyKey) always resolves to the same durable Node. Concurrent calls
 * converge (Step 10).
 *
 * Tenant isolation (N1/N3): if a deviceId is provided, it MUST belong to the
 * same tenant. A participant cannot register a Node against another tenant's
 * Device.
 *
 * The Node is created in `registered` status. Call `activateNode` to enable
 * network participation.
 */
export async function registerNode(
  tenantId: string,
  input: RegisterNodeInput,
  actorId?: string,
) {
  if (!input.participantId) throw new ValidationError('participantId is required')
  if (!input.nodeKind) throw new ValidationError('nodeKind is required')
  if (!input.displayName) throw new ValidationError('displayName is required')
  if (!input.idempotencyKey) throw new ValidationError('idempotencyKey is required')

  // Validate ParticipantIdentity exists (global — no tenant scoping).
  const participant = await db.participantIdentity.findUnique({
    where: { id: input.participantId },
  })
  if (!participant) throw new NotFoundError('participant', input.participantId)

  // Device ownership (N3): if deviceId provided, it MUST belong to this tenant.
  let deviceTenantOk = true
  if (input.deviceId) {
    const device = await db.device.findFirst({
      where: { id: input.deviceId, tenantId },
    })
    if (!device) {
      // Cross-tenant device rejection (N3). Throw NotFound so the caller
      // cannot infer the device exists in another tenant.
      throw new NotFoundError('device', input.deviceId)
    }
    deviceTenantOk = true
  }

  // Resource validation: if resourceId provided, it must exist (global).
  if (input.resourceId) {
    const resource = await db.resourceIdentity.findUnique({
      where: { id: input.resourceId },
    })
    if (!resource) throw new NotFoundError('resource', input.resourceId)
  }

  const payloadHash = computeNodePayloadHash(input)
  const eligibilityJson = JSON.stringify(input.protocolEligibility ?? [])
  const metadataJson = JSON.stringify(input.metadata ?? {})

  // Idempotent insert: try to create, catch unique-constraint violation (P2002),
  // re-read the existing row. This handles concurrent registration convergence.
  try {
    const node = await db.node.create({
      data: {
        tenantId,
        participantId: input.participantId,
        deviceId: input.deviceId ?? null,
        resourceId: input.resourceId ?? null,
        nodeKind: input.nodeKind,
        displayName: input.displayName,
        status: 'registered',
        protocolEligibilityJson: eligibilityJson,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        metadataJson,
      },
    })

    await appendAudit({
      tenantId,
      actorId,
      eventType: AuditEvents.NodeRegistered,
      resourceType: 'node',
      resourceId: node.id,
      metadata: {
        participantId: input.participantId,
        nodeKind: input.nodeKind,
        deviceId: input.deviceId ?? null,
        resourceId: input.resourceId ?? null,
      },
    })

    return node
  } catch (err: unknown) {
    // Prisma P2002 = unique constraint violation. Concurrent registration with
    // the same deterministic key → the other caller won; re-read their result.
    if (isPrismaUniqueConstraintError(err)) {
      const existing = await db.node.findFirst({
        where: {
          tenantId,
          participantId: input.participantId,
          nodeKind: input.nodeKind,
          idempotencyKey: input.idempotencyKey,
        },
      })
      if (!existing) {
        // Extremely unlikely race: row vanished between insert and re-read.
        throw err
      }
      // Idempotency conflict check: same key, different payload → conflict.
      if (existing.payloadHash !== payloadHash) {
        throw new ConflictError(
          'Node idempotency conflict: same registration key but different payload',
          { idempotencyKey: input.idempotencyKey, nodeId: existing.id },
        )
      }
      // Idempotent replay — return the existing Node (N4).
      return existing
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// getNode / listNodes — tenant-scoped reads
// ---------------------------------------------------------------------------

export async function getNode(tenantId: string, nodeId: string) {
  const node = await db.node.findFirst({
    where: { id: nodeId, tenantId },
    include: {
      participant: true,
      device: true,
      resource: true,
      networkMemberships: { include: { participantMembership: true } },
    },
  })
  if (!node) throw new NotFoundError('node', nodeId)
  return node
}

export interface ListNodeFilter {
  participantId?: string
  deviceId?: string
  status?: string
  nodeKind?: string
}

export async function listNodes(tenantId: string, filter?: ListNodeFilter) {
  return db.node.findMany({
    where: {
      tenantId,
      ...(filter?.participantId ? { participantId: filter.participantId } : {}),
      ...(filter?.deviceId ? { deviceId: filter.deviceId } : {}),
      ...(filter?.status ? { status: filter.status } : {}),
      ...(filter?.nodeKind ? { nodeKind: filter.nodeKind } : {}),
    },
    include: {
      participant: true,
      device: { include: { asset: true } },
      resource: true,
      networkMemberships: true,
    },
    orderBy: { createdAt: 'desc' },
  })
}

// ---------------------------------------------------------------------------
// Lifecycle: activate / suspend / revoke
// ---------------------------------------------------------------------------

/** Activate a registered Node so it can join networks. */
export async function activateNode(tenantId: string, nodeId: string, actorId?: string) {
  const node = await getNode(tenantId, nodeId)
  if (node.status === 'revoked') {
    throw new ValidationError(`Node ${nodeId} is revoked (terminal state)`)
  }
  if (node.status === 'active') return node
  const updated = await db.node.update({
    where: { id: nodeId },
    data: { status: 'active' },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.NodeActivated,
    resourceType: 'node',
    resourceId: nodeId,
  })
  return updated
}

/** Suspend a Node. Suspended Nodes cannot join new networks (N5). */
export async function suspendNode(tenantId: string, nodeId: string, actorId?: string) {
  const node = await getNode(tenantId, nodeId)
  if (node.status === 'revoked') {
    throw new ValidationError(`Node ${nodeId} is revoked (terminal state)`)
  }
  const updated = await db.node.update({
    where: { id: nodeId },
    data: { status: 'suspended' },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.NodeSuspended,
    resourceType: 'node',
    resourceId: nodeId,
  })
  return updated
}

/** Revoke a Node (terminal). Revoked Nodes cannot join new networks (N5). */
export async function revokeNode(tenantId: string, nodeId: string, actorId?: string) {
  const node = await getNode(tenantId, nodeId)
  if (node.status === 'revoked') return node
  const updated = await db.node.update({
    where: { id: nodeId },
    data: { status: 'revoked' },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.NodeRevoked,
    resourceType: 'node',
    resourceId: nodeId,
  })
  return updated
}

// ---------------------------------------------------------------------------
// joinNetwork / leaveNetwork — multi-network participation
// ---------------------------------------------------------------------------

/**
 * Join a Node to a network/protocol. Idempotent: the same (nodeId, networkId)
 * always resolves to the same membership. Concurrent calls converge (Step 10).
 *
 * Authorization:
 *   - The Node must be `active` (N5: suspended/revoked cannot join).
 *   - The ParticipantMembership must exist and be `active`.
 *   - The membership's participantId MUST equal the Node's participantId (N8:
 *     only the node's own participant can authorize its network participation).
 *   - Network Scope Integrity (§8.6): membership.networkId === networkId.
 *   - The network must belong to the tenant (tenant isolation, N1).
 */
export async function joinNetwork(
  tenantId: string,
  input: JoinNetworkInput,
  actorId?: string,
) {
  const node = await getNode(tenantId, input.nodeId)

  // N5: lifecycle enforcement.
  if (node.status !== 'active') {
    throw new ValidationError(
      `Node ${input.nodeId} is ${node.status}; only active Nodes can join networks`,
    )
  }

  // Tenant isolation (N1): network must belong to this tenant.
  const network = await db.networkDefinition.findFirst({
    where: { id: input.networkId, tenantId },
  })
  if (!network) throw new NotFoundError('network', input.networkId)

  // Fetch the ParticipantMembership (network-scoped authority).
  const membership = await db.participantMembership.findUnique({
    where: { id: input.participantMembershipId },
  })
  if (!membership) {
    throw new NotFoundError('participant_membership', input.participantMembershipId)
  }
  if (membership.status !== 'active') {
    throw new ValidationError(
      `ParticipantMembership ${input.participantMembershipId} is ${membership.status}`,
    )
  }

  // N8: authorization — the membership's participant must be the Node's participant.
  if (membership.participantId !== node.participantId) {
    throw new ForbiddenError(
      `Node ${input.nodeId} participant ${node.participantId} does not match membership participant ${membership.participantId}`,
    )
  }

  // Network Scope Integrity (§8.6).
  assertNetworkScopeIntegrity(
    { networkId: input.networkId },
    { networkId: membership.networkId },
    'NodeNetworkMembership',
  )

  // Idempotent upsert: same (nodeId, networkId) → same membership.
  // Race-safe: try create, catch P2002, re-read existing. This guarantees
  // concurrent joinNetwork() calls converge even if both pass findUnique
  // before either commits the create.
  const existing = await db.nodeNetworkMembership.findUnique({
    where: { nodeId_networkId: { nodeId: input.nodeId, networkId: input.networkId } },
  })

  if (existing) {
    // If revoked/suspended previously, reactivate.
    if (existing.status !== 'active') {
      const reactivated = await db.nodeNetworkMembership.update({
        where: { id: existing.id },
        data: { status: 'active', protocolRole: input.protocolRole ?? existing.protocolRole },
      })
      await appendAudit({
        tenantId,
        actorId,
        eventType: AuditEvents.NodeJoinedNetwork,
        resourceType: 'node_network_membership',
        resourceId: reactivated.id,
        metadata: { nodeId: input.nodeId, networkId: input.networkId, reactivated: true },
      })
      return reactivated
    }
    return existing
  }

  try {
    const membership2 = await db.nodeNetworkMembership.create({
      data: {
        nodeId: input.nodeId,
        networkId: input.networkId,
        participantMembershipId: input.participantMembershipId,
        protocolRole: input.protocolRole ?? 'participant',
        status: 'active',
      },
    })

    await appendAudit({
      tenantId,
      actorId,
      eventType: AuditEvents.NodeJoinedNetwork,
      resourceType: 'node_network_membership',
      resourceId: membership2.id,
      metadata: { nodeId: input.nodeId, networkId: input.networkId },
    })

    return membership2
  } catch (err: unknown) {
    // P2002: concurrent joinNetwork won the insert race. Re-read and return
    // the winning membership so the caller converges instead of failing.
    if (isPrismaUniqueConstraintError(err)) {
      const winner = await db.nodeNetworkMembership.findUnique({
        where: { nodeId_networkId: { nodeId: input.nodeId, networkId: input.networkId } },
      })
      if (winner) return winner
    }
    throw err
  }
}

/**
 * Remove a Node from a network/protocol. Sets the membership status to
 * `revoked` (preserves history). Does NOT delete the Node, Device, Asset,
 * ResourceIdentity, or other network memberships (N6).
 */
export async function leaveNetwork(
  tenantId: string,
  nodeId: string,
  networkId: string,
  actorId?: string,
) {
  // Validate the Node belongs to this tenant (tenant isolation).
  await getNode(tenantId, nodeId)

  const membership = await db.nodeNetworkMembership.findUnique({
    where: { nodeId_networkId: { nodeId, networkId } },
  })
  if (!membership) {
    throw new NotFoundError('node_network_membership', `${nodeId}/${networkId}`)
  }

  const updated = await db.nodeNetworkMembership.update({
    where: { id: membership.id },
    data: { status: 'revoked' },
  })

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.NodeLeftNetwork,
    resourceType: 'node_network_membership',
    resourceId: membership.id,
    metadata: { nodeId, networkId },
  })

  return updated
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Type guard for Prisma unique-constraint violation (P2002).
 * Used to handle concurrent-registration convergence.
 */
function isPrismaUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string }
  return e.code === 'P2002'
}
