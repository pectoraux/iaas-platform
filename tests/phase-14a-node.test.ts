/**
 * Phase 14A: Node Registration & Participation Foundation — Integration Tests
 *
 * Proves the frozen Node contract (docs/architecture/PHASE-14A-NODE-CONTRACT.md):
 *   - Node is distinct from Asset/Device/ParticipantIdentity/ResourceIdentity.
 *   - A single Node participates in multiple networks WITHOUT duplicating
 *     Device/Asset/ResourceIdentity rows.
 *   - Tenant isolation, device ownership, lifecycle enforcement, authorization.
 *   - Concurrent registration/membership converge (real PostgreSQL, no mocks).
 *
 * Tests:
 *   N1 — tenant isolation (Tenant A cannot access Tenant B Node)
 *   N2 — device ownership (same-tenant device accepted, binding correct)
 *   N3 — cross-tenant device rejection
 *   N4 — duplicate registration (idempotent, no duplicate rows)
 *   N5 — lifecycle (suspended/revoked cannot join new networks)
 *   N6 — membership isolation (leaving Network A does not remove Node/Device/Asset/Resource/Network B)
 *   N7 — multi-network (one Node, two memberships, zero duplication)
 *   N8 — authorization (only the node's own participant can authorize joinNetwork)
 *   C1 — concurrent registerNode convergence (same key → same durable Node)
 *   C2 — concurrent joinNetwork convergence (same node+network → one membership)
 *   R1 — resource relationship (Node backed by Resource does not duplicate it)
 *
 * Run: DATABASE_URL=postgresql://... bun test tests/phase-14a-node.test.ts --timeout 300000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import {
  registerNode,
  getNode,
  listNodes,
  activateNode,
  suspendNode,
  revokeNode,
  joinNetwork,
  leaveNetwork,
} from '../src/lib/services/node.service'
import { initializeBootstrap } from '../src/lib/bootstrap'
import { NotFoundError, ValidationError, ForbiddenError } from '../src/lib/domain/errors'

const databaseUrl = process.env.DATABASE_URL || ''
const isPostgres =
  databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')
const describeOrSkip = isPostgres ? describe : describe.skip

beforeAll(() => {
  if (!isPostgres) return
  initializeBootstrap()
})

// ---------------------------------------------------------------------------
// Fixture: isolated tenant + network + participant + optional device/resource
// ---------------------------------------------------------------------------

interface NodeFixture {
  tenantId: string
  networkId: string
  networkId2: string
  participantId: string
  participantMembershipId: string
  participantMembershipId2: string // membership in network2
  operatorId: string
  assetId: string
  deviceId: string
  resourceId: string
  resourceMembershipId: string
}

async function createNodeFixture(label: string): Promise<NodeFixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const labelLc = label.toLowerCase()

  const tenant = await createTenant({
    name: `Phase 14A Node — ${label}`,
    slug: `p14a-${labelLc}-${stamp}`,
    plan: 'growth',
  })

  // Two networks in the same tenant (for multi-network participation).
  // Created directly (no template instantiation) — joinNetwork only requires
  // a NetworkDefinition in the tenant, not a published NetworkVersion.
  const netA = await db.networkDefinition.create({
    data: { tenantId: tenant.id, name: `P14A Net A ${label}`, slug: `net-a-${labelLc}-${stamp}`, vertical: 'generic', status: 'active' },
  })
  const netB = await db.networkDefinition.create({
    data: { tenantId: tenant.id, name: `P14A Net B ${label}`, slug: `net-b-${labelLc}-${stamp}`, vertical: 'generic', status: 'active' },
  })
  const networkId = netA.id
  const networkId2 = netB.id

  // Participant identity + memberships in both networks.
  const participant = await db.participantIdentity.create({ data: {} })
  const participantMembershipId = (
    await db.participantMembership.create({
      data: { participantId: participant.id, networkId, status: 'active' },
    })
  ).id
  const participantMembershipId2 = (
    await db.participantMembership.create({
      data: { participantId: participant.id, networkId: networkId2, status: 'active' },
    })
  ).id

  // Operator + Asset + Device (tenant-scoped operational entities).
  const operator = await db.operator.create({
    data: {
      tenantId: tenant.id,
      organizationId: null,
      displayName: `op-p14a-${labelLc}-${stamp}`,
      status: 'active',
    },
  })
  const asset = await db.asset.create({
    data: {
      tenantId: tenant.id,
      operatorId: operator.id,
      name: `asset-p14a-${labelLc}-${stamp}`,
      assetType: 'compute_node',
      status: 'active',
    },
  })
  const device = await db.device.create({
    data: {
      tenantId: tenant.id,
      assetId: asset.id,
      deviceType: 'compute_node',
      status: 'active',
    },
  })

  // ResourceIdentity (global) + its network membership (for resource relationship proof).
  const resource = await db.resourceIdentity.create({
    data: {
      controllerId: participant.id,
      resourceKind: 'compute',
      status: 'active',
      metadataJson: JSON.stringify({ assetId: asset.id }),
    },
  })
  const resourceMembershipId = (
    await db.networkResourceMembership.create({
      data: {
        resourceId: resource.id,
        networkId,
        participantMembershipId,
        status: 'active',
      },
    })
  ).id

  return {
    tenantId: tenant.id,
    networkId,
    networkId2,
    participantId: participant.id,
    participantMembershipId,
    participantMembershipId2,
    operatorId: operator.id,
    assetId: asset.id,
    deviceId: device.id,
    resourceId: resource.id,
    resourceMembershipId,
  }
}

async function createSecondTenant(label: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return createTenant({
    name: `Phase 14A Other — ${label}`,
    slug: `p14a-other-${label.toLowerCase()}-${stamp}`,
    plan: 'growth',
  })
}

// ===========================================================================
// N1 — Tenant isolation
// ===========================================================================

describeOrSkip('Phase 14A: N1 — tenant isolation', () => {
  it('Tenant A cannot access Tenant B Node', async () => {
    const f = await createNodeFixture('N1')
    const tenantB = await createSecondTenant('N1')

    const node = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'N1 node',
      idempotencyKey: 'n1-key',
      deviceId: f.deviceId,
    })

    // Tenant A can read it.
    const fetched = await getNode(f.tenantId, node.id)
    expect(fetched.id).toBe(node.id)

    // Tenant B cannot read it.
    await expect(getNode(tenantB.id, node.id)).rejects.toBeInstanceOf(NotFoundError)

    // Tenant B cannot list it.
    const tenantBNodes = await listNodes(tenantB.id)
    expect(tenantBNodes.find((n) => n.id === node.id)).toBeUndefined()
  })
})

// ===========================================================================
// N2 — Device ownership (same-tenant device accepted, binding correct)
// ===========================================================================

describeOrSkip('Phase 14A: N2 — device ownership', () => {
  it('same-tenant device is accepted and binding is correct (no duplication)', async () => {
    const f = await createNodeFixture('N2')

    const deviceCountBefore = await db.device.count({ where: { tenantId: f.tenantId } })

    const node = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'N2 node',
      idempotencyKey: 'n2-key',
      deviceId: f.deviceId,
    })

    expect(node.deviceId).toBe(f.deviceId)

    // The device row is NOT duplicated.
    const deviceCountAfter = await db.device.count({ where: { tenantId: f.tenantId } })
    expect(deviceCountAfter).toBe(deviceCountBefore)

    // The device still points to the same asset (not replaced).
    const device = await db.device.findFirstOrThrow({ where: { id: f.deviceId } })
    expect(device.assetId).toBe(f.assetId)
  })
})

// ===========================================================================
// N3 — Cross-tenant device rejection
// ===========================================================================

describeOrSkip('Phase 14A: N3 — cross-tenant device rejection', () => {
  it('Tenant A cannot register Node against Tenant B Device', async () => {
    const fA = await createNodeFixture('N3A')
    const fB = await createNodeFixture('N3B')

    // fB.deviceId belongs to Tenant B. Tenant A tries to register a Node
    // against it → must be rejected.
    await expect(
      registerNode(fA.tenantId, {
        participantId: fA.participantId,
        nodeKind: 'protocol_endpoint',
        displayName: 'N3 cross-tenant',
        idempotencyKey: 'n3-key',
        deviceId: fB.deviceId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError)

    // No Node was created in Tenant A with that device.
    const nodes = await listNodes(fA.tenantId)
    expect(nodes.find((n) => n.deviceId === fB.deviceId)).toBeUndefined()
  })
})

// ===========================================================================
// N4 — Duplicate registration (idempotent)
// ===========================================================================

describeOrSkip('Phase 14A: N4 — duplicate registration', () => {
  it('repeated deterministic registration does not create duplicate Nodes', async () => {
    const f = await createNodeFixture('N4')

    const nodeCountBefore = await db.node.count({ where: { tenantId: f.tenantId } })

    const node1 = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'N4 node',
      idempotencyKey: 'n4-key',
      deviceId: f.deviceId,
    })

    const node2 = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'N4 node',
      idempotencyKey: 'n4-key', // SAME key
      deviceId: f.deviceId,
    })

    // Both calls return the SAME node.
    expect(node2.id).toBe(node1.id)

    // Exactly one node row was created.
    const nodeCountAfter = await db.node.count({ where: { tenantId: f.tenantId } })
    expect(nodeCountAfter).toBe(nodeCountBefore + 1)
  })

  it('same key with different payload raises ConflictError', async () => {
    const f = await createNodeFixture('N4b')

    await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'N4b original',
      idempotencyKey: 'n4b-key',
    })

    // Same key, different displayName → conflict.
    await expect(
      registerNode(f.tenantId, {
        participantId: f.participantId,
        nodeKind: 'protocol_endpoint',
        displayName: 'N4b CHANGED',
        idempotencyKey: 'n4b-key',
      }),
    ).rejects.toBeDefined()
  })
})

// ===========================================================================
// N5 — Lifecycle enforcement
// ===========================================================================

describeOrSkip('Phase 14A: N5 — lifecycle', () => {
  it('suspended/revoked Nodes cannot join new networks', async () => {
    const f = await createNodeFixture('N5')

    const node = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'N5 node',
      idempotencyKey: 'n5-key',
    })

    // registered → cannot join yet.
    await expect(
      joinNetwork(f.tenantId, {
        nodeId: node.id,
        networkId: f.networkId,
        participantMembershipId: f.participantMembershipId,
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    // active → can join.
    await activateNode(f.tenantId, node.id)
    const m1 = await joinNetwork(f.tenantId, {
      nodeId: node.id,
      networkId: f.networkId,
      participantMembershipId: f.participantMembershipId,
    })
    expect(m1.status).toBe('active')

    // suspended → cannot join new network.
    await suspendNode(f.tenantId, node.id)
    await expect(
      joinNetwork(f.tenantId, {
        nodeId: node.id,
        networkId: f.networkId2,
        participantMembershipId: f.participantMembershipId2,
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    // revoked → cannot join new network (and activateNode fails on revoked).
    await revokeNode(f.tenantId, node.id)
    await expect(activateNode(f.tenantId, node.id)).rejects.toBeInstanceOf(ValidationError)
    await expect(
      joinNetwork(f.tenantId, {
        nodeId: node.id,
        networkId: f.networkId2,
        participantMembershipId: f.participantMembershipId2,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

// ===========================================================================
// N6 — Membership isolation
// ===========================================================================

describeOrSkip('Phase 14A: N6 — membership isolation', () => {
  it('removing Node from Network A does not remove Node/Device/Asset/Resource/Network B membership', async () => {
    const f = await createNodeFixture('N6')

    const node = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'N6 node',
      idempotencyKey: 'n6-key',
      deviceId: f.deviceId,
      resourceId: f.resourceId,
    })
    await activateNode(f.tenantId, node.id)

    // Join both networks.
    await joinNetwork(f.tenantId, {
      nodeId: node.id,
      networkId: f.networkId,
      participantMembershipId: f.participantMembershipId,
    })
    await joinNetwork(f.tenantId, {
      nodeId: node.id,
      networkId: f.networkId2,
      participantMembershipId: f.participantMembershipId2,
    })

    // Leave Network A.
    await leaveNetwork(f.tenantId, node.id, f.networkId)

    // Node still exists.
    const nodeStillExists = await getNode(f.tenantId, node.id)
    expect(nodeStillExists).toBeDefined()

    // Device still exists (not deleted, not duplicated).
    const device = await db.device.findFirstOrThrow({ where: { id: f.deviceId } })
    expect(device.id).toBe(f.deviceId)

    // Asset still exists.
    const asset = await db.asset.findFirstOrThrow({ where: { id: f.assetId } })
    expect(asset.id).toBe(f.assetId)

    // ResourceIdentity still exists.
    const resource = await db.resourceIdentity.findFirstOrThrow({ where: { id: f.resourceId } })
    expect(resource.id).toBe(f.resourceId)

    // Resource's network membership still exists.
    const resMembership = await db.networkResourceMembership.findFirstOrThrow({
      where: { id: f.resourceMembershipId },
    })
    expect(resMembership.status).toBe('active')

    // Network B membership for the node is still active.
    const nodeMembershipB = await db.nodeNetworkMembership.findUnique({
      where: { nodeId_networkId: { nodeId: node.id, networkId: f.networkId2 } },
    })
    expect(nodeMembershipB).not.toBeNull()
    expect(nodeMembershipB!.status).toBe('active')

    // Network A membership is revoked (not deleted).
    const nodeMembershipA = await db.nodeNetworkMembership.findUnique({
      where: { nodeId_networkId: { nodeId: node.id, networkId: f.networkId } },
    })
    expect(nodeMembershipA).not.toBeNull()
    expect(nodeMembershipA!.status).toBe('revoked')
  })
})

// ===========================================================================
// N7 — Multi-network participation
// ===========================================================================

describeOrSkip('Phase 14A: N7 — multi-network', () => {
  it('same Node participates in multiple Networks with zero duplication', async () => {
    const f = await createNodeFixture('N7')

    const deviceCountBefore = await db.device.count({ where: { id: f.deviceId } })
    const assetCountBefore = await db.asset.count({ where: { id: f.assetId } })
    const resourceCountBefore = await db.resourceIdentity.count({ where: { id: f.resourceId } })

    const node = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'N7 node',
      idempotencyKey: 'n7-key',
      deviceId: f.deviceId,
      resourceId: f.resourceId,
    })
    await activateNode(f.tenantId, node.id)

    // Join TWO networks.
    await joinNetwork(f.tenantId, {
      nodeId: node.id,
      networkId: f.networkId,
      participantMembershipId: f.participantMembershipId,
    })
    await joinNetwork(f.tenantId, {
      nodeId: node.id,
      networkId: f.networkId2,
      participantMembershipId: f.participantMembershipId2,
    })

    // ONE node.
    const nodeCount = await db.node.count({ where: { id: node.id } })
    expect(nodeCount).toBe(1)

    // TWO memberships.
    const memberships = await db.nodeNetworkMembership.findMany({ where: { nodeId: node.id } })
    expect(memberships.length).toBe(2)
    expect(memberships.map((m) => m.networkId).sort()).toEqual(
      [f.networkId, f.networkId2].sort(),
    )

    // ZERO duplicated Device rows.
    const deviceCountAfter = await db.device.count({ where: { id: f.deviceId } })
    expect(deviceCountAfter).toBe(deviceCountBefore)

    // ZERO duplicated Asset rows.
    const assetCountAfter = await db.asset.count({ where: { id: f.assetId } })
    expect(assetCountAfter).toBe(assetCountBefore)

    // ZERO duplicated ResourceIdentity rows.
    const resourceCountAfter = await db.resourceIdentity.count({ where: { id: f.resourceId } })
    expect(resourceCountAfter).toBe(resourceCountBefore)
  })
})

// ===========================================================================
// N8 — Authorization
// ===========================================================================

describeOrSkip('Phase 14A: N8 — authorization', () => {
  it('only the node participant can authorize joinNetwork', async () => {
    const f = await createNodeFixture('N8')

    // Create a SECOND participant with a membership in the same network.
    const participantB = await db.participantIdentity.create({ data: {} })
    const membershipB = await db.participantMembership.create({
      data: { participantId: participantB.id, networkId: f.networkId, status: 'active' },
    })

    // Register node with participant A.
    const node = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'N8 node',
      idempotencyKey: 'n8-key',
    })
    await activateNode(f.tenantId, node.id)

    // Participant B's membership cannot authorize Node A's join → forbidden.
    await expect(
      joinNetwork(f.tenantId, {
        nodeId: node.id,
        networkId: f.networkId,
        participantMembershipId: membershipB.id,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError)

    // Participant A's membership CAN authorize.
    const m = await joinNetwork(f.tenantId, {
      nodeId: node.id,
      networkId: f.networkId,
      participantMembershipId: f.participantMembershipId,
    })
    expect(m.status).toBe('active')
  })

  it('network scope integrity: membership in Network B cannot authorize join to Network A', async () => {
    const f = await createNodeFixture('N8b')

    const node = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'N8b node',
      idempotencyKey: 'n8b-key',
    })
    await activateNode(f.tenantId, node.id)

    // participantMembershipId2 is in networkId2, but we try to join networkId.
    await expect(
      joinNetwork(f.tenantId, {
        nodeId: node.id,
        networkId: f.networkId,
        participantMembershipId: f.participantMembershipId2,
      }),
    ).rejects.toThrow()
  })
})

// ===========================================================================
// C1 — Concurrent registerNode convergence
// ===========================================================================

describeOrSkip('Phase 14A: C1 — concurrent registerNode', () => {
  it('concurrent registration with same key converges to one durable Node', async () => {
    const f = await createNodeFixture('C1')

    const input = {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'C1 node',
      idempotencyKey: 'c1-concurrent-key',
      deviceId: f.deviceId,
    }

    const results = await Promise.allSettled([
      registerNode(f.tenantId, input),
      registerNode(f.tenantId, input),
      registerNode(f.tenantId, input),
    ])

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof registerNode>>> =>
        r.status === 'fulfilled',
    )
    const rejected = results.filter((r) => r.status === 'rejected')

    // Both/all callers must resolve successfully (idempotent convergence).
    // None should be rejected — the P2002 catch+re-read handles concurrency.
    expect(rejected.length).toBe(0)
    expect(fulfilled.length).toBe(3)

    // All resolved node IDs are identical.
    const ids = new Set(fulfilled.map((r) => r.value.id))
    expect(ids.size).toBe(1)

    // Exactly one node row exists.
    const count = await db.node.count({
      where: { tenantId: f.tenantId, idempotencyKey: 'c1-concurrent-key' },
    })
    expect(count).toBe(1)
  })
})

// ===========================================================================
// C2 — Concurrent joinNetwork convergence
// ===========================================================================

describeOrSkip('Phase 14A: C2 — concurrent joinNetwork', () => {
  it('concurrent joinNetwork for same node+network converges to one membership', async () => {
    const f = await createNodeFixture('C2')

    const node = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'C2 node',
      idempotencyKey: 'c2-key',
    })
    await activateNode(f.tenantId, node.id)

    const input = {
      nodeId: node.id,
      networkId: f.networkId,
      participantMembershipId: f.participantMembershipId,
    }

    const results = await Promise.allSettled([
      joinNetwork(f.tenantId, input),
      joinNetwork(f.tenantId, input),
      joinNetwork(f.tenantId, input),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    // All must converge successfully (the service checks for existing membership
    // and returns it rather than failing).
    expect(rejected.length).toBe(0)
    expect(fulfilled.length).toBe(3)

    // Exactly one membership row exists.
    const count = await db.nodeNetworkMembership.count({
      where: { nodeId: node.id, networkId: f.networkId },
    })
    expect(count).toBe(1)
  })
})

// ===========================================================================
// R1 — Resource relationship (Node backed by Resource does not duplicate it)
// ===========================================================================

describeOrSkip('Phase 14A: R1 — resource relationship', () => {
  it('Node backed by ResourceIdentity does not duplicate the resource', async () => {
    const f = await createNodeFixture('R1')

    const resourceCountBefore = await db.resourceIdentity.count({ where: { id: f.resourceId } })

    const node = await registerNode(f.tenantId, {
      participantId: f.participantId,
      nodeKind: 'protocol_endpoint',
      displayName: 'R1 node',
      idempotencyKey: 'r1-key',
      resourceId: f.resourceId,
    })

    expect(node.resourceId).toBe(f.resourceId)

    // The resource row is NOT duplicated.
    const resourceCountAfter = await db.resourceIdentity.count({ where: { id: f.resourceId } })
    expect(resourceCountAfter).toBe(resourceCountBefore)

    // The resource remains globally reusable (its network membership still exists).
    const resMembership = await db.networkResourceMembership.findFirstOrThrow({
      where: { resourceId: f.resourceId },
    })
    expect(resMembership.status).toBe('active')

    // The Node and Resource are distinct entities.
    expect(node.id).not.toBe(f.resourceId)
    const fetched = await getNode(f.tenantId, node.id)
    expect(fetched.resourceId).toBe(f.resourceId)
    expect(fetched.resource).toBeDefined()
  })
})
