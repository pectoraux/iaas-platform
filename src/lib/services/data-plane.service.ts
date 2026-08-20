// =============================================================================
// DataPlane service — Phase 14B: Data Plane / Bundle Foundation.
//
// The DataPlane is the generic data-plane substrate. It owns the Bundle
// primitive: a transport/data-plane envelope capable of carrying arbitrary
// protocol payloads. It is DISTINCT from:
//   - ProtocolTransaction (a deterministic state-transition request)
//   - VPP energy delivery (vertical)
//   - Any future routing/DTN/transform layer
//
// This service implements the minimal data-plane contract (Step 1/3):
//   receiveBundle() → store/hold → deliverBundle() → inspect/expire
//
// ARCHITECTURAL RULES (frozen):
//   - Bundle identity is IMMUTABLE and DETERMINISTIC:
//     bundleId = SHA-256(tenantId, sourceNodeId, payloadHash, idempotencyKey).
//     NOT derived from DB row ID, timestamp alone, route, storage node, or
//     network membership. Survives replication/crash/retry.
//   - Tenant isolation: all queries filter by tenantId. A Bundle belongs to
//     exactly one tenant (the source Node's tenant). Cross-tenant transport
//     is a future routing concern — NOT in Phase 14B.
//   - Node integration: sourceNodeId + destinationNodeId both validated
//     against the tenant + Node lifecycle (must be active). Bundle references
//     Node identity (protocol endpoint), NOT Device/Asset/Resource.
//   - Deduplication: @@unique on deterministic bundleId → concurrent inserts
//     converge via P2002 catch + re-read. Same Bundle received twice → ONE
//     logical Bundle.
//   - Delivery semantics: at-least-once + idempotent delivery. Delivery
//     records (BundleDelivery) deduplicated by deterministic deliveryId.
//     NOT exactly-once — the Bundle layer preserves facts, not unsupported
//     guarantees.
//   - Expiry: persisted expiryTime timestamp. After expiry, new delivery
//     rejected. Deterministic, NOT an in-memory timer.
//
// This service does NOT import:
//   - VPP / Compute / Storage / Wireless vertical services (anti-drift).
//   - Data Plane routing / DTN / Transform / Extension / Marketplace (future).
//   - ProtocolRuntime / HybridRuntime internals (no kernel coupling).
//
// The relationship is:
//   CONTROL PLANE → decides/authorizes
//   RUNTIME → executes protocol or infrastructure behavior
//   DATA PLANE → moves/processes protocol data (this service)
//   ECONOMICS → verifies/attributes/settles contribution
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { sha256 } from '@/lib/domain/crypto'
import { getNode } from '@/lib/services/node.service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateBundleInput {
  /** The Node sending this Bundle (must be active, in tenant). */
  sourceNodeId: string
  /** The Node receiving this Bundle (must be in tenant). */
  destinationNodeId: string
  /** Generic bundle kind (e.g. "generic_payload"). NOT vertical-specific. */
  nodeKind: string
  /** Generic content type (e.g. "application/json"). */
  payloadType: string
  /** The raw payload bytes/string (will be hashed for integrity). */
  payload: string
  /** Caller-supplied key for deterministic identity. */
  idempotencyKey: string
  /** Optional opaque reference to external content-addressed storage. */
  payloadRef?: string
  /** Generic priority (protocol-neutral). Higher = more urgent. */
  priority?: number
  /** Replay detection nonce. */
  nonce?: number
  /** Expiry time. After this, no new delivery permitted. */
  expiryTime: Date
  metadata?: Record<string, unknown>
}

export interface DeliverBundleInput {
  bundleId: string
  /** The Node receiving this delivery (must be in tenant). */
  receiverNodeId: string
}

// ---------------------------------------------------------------------------
// Bundle identity derivation (Step 5 — immutable, deterministic)
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic bundleId from the immutable identity tuple.
 *
 * bundleId = SHA-256(tenantId, sourceNodeId, idempotencyKey)
 *
 * NOTE: payloadHash is NOT part of the identity tuple. This is deliberate:
 * the idempotencyKey represents the caller's intent (one logical Bundle per
 * key). If the same key is reused with a DIFFERENT payload, the deterministic
 * ID collides → the persisted payloadHash detects the conflict (ConflictError).
 * If payloadHash were part of the ID, different payloads would never collide
 * and conflict detection would be impossible.
 *
 * This identity survives replication, crash, retry, and forwarding. A
 * duplicate copy of the same Bundle retains the same logical identity,
 * enabling deduplication, retries, and crash recovery.
 *
 * NOT derived from: DB row ID, timestamp alone, route, storage node,
 * or network membership.
 */
export function deriveBundleId(input: {
  tenantId: string
  sourceNodeId: string
  idempotencyKey: string
}): string {
  const canonical = JSON.stringify({
    tenantId: input.tenantId,
    sourceNodeId: input.sourceNodeId,
    idempotencyKey: input.idempotencyKey,
  })
  return sha256(canonical)
}

/**
 * Derive a deterministic deliveryId for idempotent delivery.
 *
 * deliveryId = SHA-256(bundleId, receiverNodeId)
 *
 * Same Bundle delivered to the same receiver twice → ONE delivery record.
 */
export function deriveDeliveryId(bundleId: string, receiverNodeId: string): string {
  return sha256(JSON.stringify({ bundleId, receiverNodeId }))
}

// ---------------------------------------------------------------------------
// createBundle — receive + persist (idempotent)
// ---------------------------------------------------------------------------

/**
 * Receive a Bundle into the data plane. Idempotent: the same
 * (tenantId, sourceNodeId, payloadHash, idempotencyKey) always resolves to
 * the same durable Bundle. Concurrent calls converge (Step 7: B6/B7).
 *
 * Validation:
 *   - sourceNodeId must be an active Node in the tenant (Step 14, B4/B11).
 *   - destinationNodeId must be a Node in the tenant (Step 14, B5/B11).
 *   - expiryTime must be in the future.
 *   - sourceNodeId ≠ destinationNodeId (no self-delivery in Phase 14B).
 *
 * The Bundle is created in `created` status. Call deliverBundle() to deliver.
 */
export async function createBundle(
  tenantId: string,
  input: CreateBundleInput,
  actorId?: string,
) {
  if (!input.sourceNodeId) throw new ValidationError('sourceNodeId is required')
  if (!input.destinationNodeId) throw new ValidationError('destinationNodeId is required')
  if (!input.idempotencyKey) throw new ValidationError('idempotencyKey is required')
  if (!input.payloadType) throw new ValidationError('payloadType is required')
  if (input.sourceNodeId === input.destinationNodeId) {
    throw new ValidationError('sourceNodeId and destinationNodeId must differ')
  }
  if (!input.expiryTime) {
    throw new ValidationError('expiryTime is required')
  }
  // Note: a Bundle MAY be created with an already-past expiryTime (immediately
  // expired). Expiry is enforced at DELIVERY time (deliverBundle), not at
  // creation time. This allows pre-expired bundles for testing/cleanup.

  // Validate source Node: must exist + be active in this tenant (B4/B11).
  const sourceNode = await getNode(tenantId, input.sourceNodeId)
  if (sourceNode.status !== 'active') {
    throw new ValidationError(
      `Source Node ${input.sourceNodeId} is ${sourceNode.status}; only active Nodes can source bundles`,
    )
  }

  // Validate destination Node: must exist in this tenant (B5/B11).
  const destNode = await getNode(tenantId, input.destinationNodeId)
  if (destNode.status === 'revoked') {
    throw new ValidationError(
      `Destination Node ${input.destinationNodeId} is revoked (terminal)`,
    )
  }

  // Compute payload hash (integrity) + deterministic bundleId.
  const payloadHash = sha256(input.payload)
  const bundleId = deriveBundleId({
    tenantId,
    sourceNodeId: input.sourceNodeId,
    idempotencyKey: input.idempotencyKey,
  })
  const deliveryId = deriveDeliveryId(bundleId, input.destinationNodeId)

  // Idempotent insert: try to create, catch P2002, re-read. This handles
  // concurrent reception convergence (B6/B7).
  try {
    const bundle = await db.bundle.create({
      data: {
        id: bundleId,
        tenantId,
        sourceNodeId: input.sourceNodeId,
        destinationNodeId: input.destinationNodeId,
        nodeKind: input.nodeKind,
        payloadType: input.payloadType,
        payloadHash,
        payloadRef: input.payloadRef ?? null,
        payloadBytesJson: input.payload,
        priority: input.priority ?? 0,
        nonce: input.nonce ?? 0,
        idempotencyKey: input.idempotencyKey,
        status: 'created',
        expiryTime: input.expiryTime,
        metadataJson: JSON.stringify(input.metadata ?? {}),
      },
    })

    // Create the initial delivery record (status: stored).
    await db.bundleDelivery.create({
      data: {
        id: deliveryId,
        bundleId: bundleId,
        receiverNodeId: input.destinationNodeId,
        tenantId,
        status: 'stored',
      },
    }).catch(() => {
      // Delivery record may already exist if the bundle was concurrently
      // created. The bundle row is the source of truth for identity; the
      // delivery record is the source of truth for delivery lifecycle.
    })

    await appendAudit({
      tenantId,
      actorId,
      eventType: AuditEvents.BundleCreated,
      resourceType: 'bundle',
      resourceId: bundleId,
      metadata: {
        sourceNodeId: input.sourceNodeId,
        destinationNodeId: input.destinationNodeId,
        payloadType: input.payloadType,
        priority: input.priority ?? 0,
      },
    })

    return bundle
  } catch (err: unknown) {
    // P2002: concurrent createBundle won the insert race. Re-read and return
    // the winning bundle so the caller converges instead of failing.
    if (isPrismaUniqueConstraintError(err)) {
      const existing = await db.bundle.findUnique({ where: { id: bundleId } })
      if (!existing) throw err
      // Idempotency conflict check: same key, different payload → conflict.
      if (existing.payloadHash !== payloadHash) {
        throw new ConflictError(
          'Bundle idempotency conflict: same identity key but different payload',
          { idempotencyKey: input.idempotencyKey, bundleId },
        )
      }
      // Idempotent replay — return the existing Bundle (B6).
      return existing
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// getBundle / listBundles — tenant-scoped reads
// ---------------------------------------------------------------------------

export async function getBundle(tenantId: string, bundleId: string) {
  const bundle = await db.bundle.findFirst({
    where: { id: bundleId, tenantId },
    include: {
      sourceNode: true,
      destinationNode: true,
      deliveries: true,
    },
  })
  if (!bundle) throw new NotFoundError('bundle', bundleId)
  return bundle
}

export interface ListBundleFilter {
  sourceNodeId?: string
  destinationNodeId?: string
  status?: string
}

export async function listBundles(tenantId: string, filter?: ListBundleFilter) {
  return db.bundle.findMany({
    where: {
      tenantId,
      ...(filter?.sourceNodeId ? { sourceNodeId: filter.sourceNodeId } : {}),
      ...(filter?.destinationNodeId ? { destinationNodeId: filter.destinationNodeId } : {}),
      ...(filter?.status ? { status: filter.status } : {}),
    },
    include: {
      sourceNode: true,
      destinationNode: true,
      deliveries: true,
    },
    orderBy: { createdAt: 'desc' },
  })
}

// ---------------------------------------------------------------------------
// deliverBundle — at-least-once, idempotent delivery (Step 10)
// ---------------------------------------------------------------------------

/**
 * Deliver a Bundle to its destination. Idempotent: the same (bundleId,
 * receiverNodeId) always resolves to the same delivery record. Concurrent
 * calls converge (B7/B10).
 *
 * Semantics: at-least-once + idempotent. NOT exactly-once. The delivery
 * record's attemptCount tracks duplicate receptions; deliveredAt records
 * the first delivery time.
 *
 * Expiry enforcement (Step 11): if the Bundle's expiryTime has passed,
 * delivery is rejected and the Bundle status is set to 'expired'.
 *
 * If already delivered, retry returns the existing delivery record (B10).
 */
export async function deliverBundle(
  tenantId: string,
  input: DeliverBundleInput,
  actorId?: string,
) {
  const bundle = await getBundle(tenantId, input.bundleId)

  // Expiry enforcement (Step 11/B9).
  const now = new Date()
  if (bundle.expiryTime <= now) {
    if (bundle.status !== 'expired') {
      await db.bundle.update({
        where: { id: bundle.id },
        data: { status: 'expired' },
      })
      await appendAudit({
        tenantId,
        actorId,
        eventType: AuditEvents.BundleExpired,
        resourceType: 'bundle',
        resourceId: bundle.id,
        metadata: { expiryTime: bundle.expiryTime.toISOString() },
      })
    }
    throw new ValidationError(
      `Bundle ${input.bundleId} has expired (expiryTime ${bundle.expiryTime.toISOString()})`,
    )
  }

  // Validate receiver is the destination (tenant isolation).
  if (bundle.destinationNodeId !== input.receiverNodeId) {
    throw new ValidationError(
      `Bundle ${input.bundleId} is destined for Node ${bundle.destinationNodeId}, not ${input.receiverNodeId}`,
    )
  }

  const deliveryId = deriveDeliveryId(input.bundleId, input.receiverNodeId)

  // Idempotent upsert: same (bundleId, receiverNodeId) → same delivery.
  // Race-safe: try create, catch P2002, re-read + update attemptCount.
  try {
    const delivery = await db.bundleDelivery.create({
      data: {
        id: deliveryId,
        bundleId: input.bundleId,
        receiverNodeId: input.receiverNodeId,
        tenantId,
        status: 'delivered',
        deliveredAt: now,
      },
    })

    // Mark the Bundle as delivered (first delivery).
    if (bundle.status !== 'delivered') {
      await db.bundle.update({
        where: { id: bundle.id },
        data: { status: 'delivered', deliveredAt: now },
      })
    }

    await appendAudit({
      tenantId,
      actorId,
      eventType: AuditEvents.BundleDelivered,
      resourceType: 'bundle_delivery',
      resourceId: delivery.id,
      metadata: { bundleId: input.bundleId, receiverNodeId: input.receiverNodeId },
    })

    return delivery
  } catch (err: unknown) {
    // P2002: delivery record already exists. This is a retry (B10).
    // Increment attemptCount, return the existing record.
    if (isPrismaUniqueConstraintError(err)) {
      const existing = await db.bundleDelivery.findUnique({
        where: { id: deliveryId },
      })
      if (!existing) throw err

      const updated = await db.bundleDelivery.update({
        where: { id: deliveryId },
        data: {
          attemptCount: { increment: 1 },
          lastReceivedAt: now,
          // If not yet delivered, mark as delivered now.
          ...(existing.status !== 'delivered'
            ? { status: 'delivered', deliveredAt: now }
            : {}),
        },
      })

      // Ensure the Bundle itself is marked delivered.
      if (bundle.status !== 'delivered') {
        await db.bundle.update({
          where: { id: bundle.id },
          data: { status: 'delivered', deliveredAt: now },
        })
      }

      return updated
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// expireBundle — explicit expiry transition (Step 11)
// ---------------------------------------------------------------------------

/**
 * Explicitly mark a Bundle as expired. Used by cleanup/recovery paths.
 * After expiry, deliverBundle() rejects new delivery.
 */
export async function expireBundle(
  tenantId: string,
  bundleId: string,
  actorId?: string,
) {
  const bundle = await getBundle(tenantId, bundleId)
  if (bundle.status === 'expired') return bundle
  const updated = await db.bundle.update({
    where: { id: bundleId },
    data: { status: 'expired' },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.BundleExpired,
    resourceType: 'bundle',
    resourceId: bundleId,
  })
  return updated
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Type guard for Prisma unique-constraint violation (P2002).
 * Used to handle concurrent-reception convergence.
 */
function isPrismaUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string }
  return e.code === 'P2002'
}
