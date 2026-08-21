// =============================================================================
// DeliveryConfirmation service — Phase 14E: Delivery Confirmation Foundation.
//
// DeliveryConfirmation is the "acknowledge" data-plane operation from
// constitution §8, made real. It is a DURABLE, IMMUTABLE RECEIPT that records
// receiver acknowledgment of a Bundle delivery / TransportAttempt.
//
// It is DISTINCT from:
//   - TransportAttempt.acknowledged (a status flag — mutated).
//   - BundleDelivery.acknowledged (a status flag — reserved in 14B, not exercised).
//
// DeliveryConfirmation IS the acknowledgment FACT — it does not mutate a status;
// it creates an immutable receipt. It records:
//   - WHO acknowledged (receiverNodeId)
//   - WHEN (confirmedAt — deterministic, persisted)
//   - WHAT (bundleId + optional transportAttemptId)
//   - PROOF (confirmationHash — integrity, links to the Bundle payloadHash)
//
// ARCHITECTURAL RULES (frozen):
//   - DeliveryConfirmation is IMMUTABLE. It is created once; it is never updated
//     (only metadata may be appended via a new confirmation, not by mutation).
//   - It does NOT replace the status flags (TransportAttempt.acknowledged,
//     BundleDelivery.acknowledged). It ADDS a durable receipt layer on top.
//   - It does NOT modify Bundle, Route, Node, TransportExecution, or
//     TransportAttempt (immutability preserved).
//   - Tenant isolation: all queries filter by tenantId.
//   - Idempotent creation: deterministic key (tenantId, bundleId,
//     receiverNodeId, idempotencyKey) → concurrent calls converge.
//   - The confirmationHash links to the Bundle.payloadHash for integrity proof.
//
// This service does NOT import:
//   - VPP / Compute / Storage / Wireless vertical services (anti-drift).
//   - ProtocolRuntime / HybridRuntime / economic pipeline (no kernel coupling).
//   - DTN / Transform / Extension / Marketplace / SDK (future — Step 4).
//   - Retransmission timers / sliding windows / custody transfer (future phase).
//
// NOT in scope (Step 4 — explicit non-goals):
//   retransmission timers, sliding windows, custody transfer, DTN forwarding,
//   congestion control, radio selection, bandwidth marketplace, pricing,
//   settlement, SDK, TransitNet, Cloudlet.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { sha256 } from '@/lib/domain/crypto'
import { getNode } from '@/lib/services/node.service'
import { getBundle } from '@/lib/services/data-plane.service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateDeliveryConfirmationInput {
  /** The Bundle being confirmed (must exist in tenant). */
  bundleId: string
  /** The Node issuing the confirmation (receiver — must be active in tenant). */
  receiverNodeId: string
  /** Caller-supplied key for deterministic identity (idempotency). */
  idempotencyKey: string
  /** Optional TransportAttempt being confirmed (1:1 link). */
  transportAttemptId?: string
  /** Optional metadata (e.g. receiver signature, proof details). */
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// createDeliveryConfirmation — idempotent immutable receipt creation
// ---------------------------------------------------------------------------

/**
 * Create a DeliveryConfirmation receipt. Idempotent: the same
 * (tenantId, bundleId, receiverNodeId, idempotencyKey) always resolves to the
 * same durable confirmation. Concurrent calls converge (D6).
 *
 * Validation:
 *   - The Bundle must exist in the tenant.
 *   - The receiver Node must exist and be active in the tenant (D4).
 *   - The receiver Node must be the Bundle's destination (D5 — only the
 *     destination can confirm delivery).
 *   - If transportAttemptId is provided, it must belong to the same Bundle's
 *     execution and the attempt's toNodeId must match the receiverNodeId.
 *
 * The confirmationHash is derived from the Bundle's payloadHash + receiverNodeId
 * + idempotencyKey — it proves the receiver is confirming THIS specific Bundle
 * content.
 *
 * The confirmation is IMMUTABLE — it is never updated. A duplicate confirmation
 * (same key) returns the existing receipt.
 */
export async function createDeliveryConfirmation(
  tenantId: string,
  input: CreateDeliveryConfirmationInput,
  actorId?: string,
) {
  if (!input.bundleId) throw new ValidationError('bundleId is required')
  if (!input.receiverNodeId) throw new ValidationError('receiverNodeId is required')
  if (!input.idempotencyKey) throw new ValidationError('idempotencyKey is required')

  // Validate Bundle exists in tenant (references, does not modify).
  const bundle = await getBundle(tenantId, input.bundleId)

  // Validate receiver Node exists + is active (D4).
  const receiverNode = await getNode(tenantId, input.receiverNodeId)
  if (receiverNode.status !== 'active') {
    throw new ValidationError(
      `Receiver Node ${input.receiverNodeId} is ${receiverNode.status}; only active Nodes can issue delivery confirmations`,
    )
  }

  // The receiver MUST be the Bundle's destination (D5 — only the destination
  // can confirm delivery).
  if (bundle.destinationNodeId !== input.receiverNodeId) {
    throw new ValidationError(
      `Receiver Node ${input.receiverNodeId} is not the destination of Bundle ${input.bundleId} (destination: ${bundle.destinationNodeId})`,
    )
  }

  // Optional: validate transportAttemptId belongs to this Bundle's execution
  // and the attempt's toNodeId matches the receiver.
  if (input.transportAttemptId) {
    const attempt = await db.transportAttempt.findUnique({
      where: { id: input.transportAttemptId },
      include: { execution: true },
    })
    if (!attempt || attempt.execution.tenantId !== tenantId) {
      throw new NotFoundError('transport_attempt', input.transportAttemptId)
    }
    if (attempt.execution.bundleId !== input.bundleId) {
      throw new ValidationError(
        `TransportAttempt ${input.transportAttemptId} does not belong to Bundle ${input.bundleId}`,
      )
    }
    if (attempt.toNodeId !== input.receiverNodeId) {
      throw new ValidationError(
        `TransportAttempt ${input.transportAttemptId} toNode (${attempt.toNodeId}) does not match receiver ${input.receiverNodeId}`,
      )
    }
  }

  // Compute the confirmationHash — integrity proof linking the Bundle content
  // to the receiver's acknowledgment.
  const confirmationHash = sha256(
    JSON.stringify({
      bundleId: input.bundleId,
      payloadHash: bundle.payloadHash,
      receiverNodeId: input.receiverNodeId,
      idempotencyKey: input.idempotencyKey,
    }),
  )

  // Idempotent insert: try to create, catch P2002, re-read. This handles
  // concurrent confirmation creation convergence (D6).
  try {
    const confirmation = await db.deliveryConfirmation.create({
      data: {
        tenantId,
        bundleId: input.bundleId,
        transportAttemptId: input.transportAttemptId ?? null,
        receiverNodeId: input.receiverNodeId,
        idempotencyKey: input.idempotencyKey,
        confirmationHash,
        metadataJson: JSON.stringify(input.metadata ?? {}),
      },
    })

    await appendAudit({
      tenantId,
      actorId,
      eventType: AuditEvents.DeliveryConfirmationCreated,
      resourceType: 'delivery_confirmation',
      resourceId: confirmation.id,
      metadata: {
        bundleId: input.bundleId,
        receiverNodeId: input.receiverNodeId,
        transportAttemptId: input.transportAttemptId ?? null,
      },
    })

    return confirmation
  } catch (err: unknown) {
    // P2002: concurrent createDeliveryConfirmation won the insert race.
    if (isPrismaUniqueConstraintError(err)) {
      const existing = await db.deliveryConfirmation.findFirst({
        where: {
          tenantId,
          bundleId: input.bundleId,
          receiverNodeId: input.receiverNodeId,
          idempotencyKey: input.idempotencyKey,
        },
      })
      if (!existing) throw err
      // Idempotency conflict check: same key, different confirmationHash → conflict.
      if (existing.confirmationHash !== confirmationHash) {
        throw new ConflictError(
          'DeliveryConfirmation idempotency conflict: same identity key but different confirmationHash',
          { idempotencyKey: input.idempotencyKey, confirmationId: existing.id },
        )
      }
      // Idempotent replay — return the existing confirmation (D6).
      return existing
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// getDeliveryConfirmation / listDeliveryConfirmations — tenant-scoped reads
// ---------------------------------------------------------------------------

export async function getDeliveryConfirmation(tenantId: string, confirmationId: string) {
  const confirmation = await db.deliveryConfirmation.findFirst({
    where: { id: confirmationId, tenantId },
    include: {
      bundle: true,
      transportAttempt: { include: { execution: true } },
      receiverNode: true,
    },
  })
  if (!confirmation) throw new NotFoundError('delivery_confirmation', confirmationId)
  return confirmation
}

export interface ListDeliveryConfirmationFilter {
  bundleId?: string
  receiverNodeId?: string
  transportAttemptId?: string
}

export async function listDeliveryConfirmations(
  tenantId: string,
  filter?: ListDeliveryConfirmationFilter,
) {
  return db.deliveryConfirmation.findMany({
    where: {
      tenantId,
      ...(filter?.bundleId ? { bundleId: filter.bundleId } : {}),
      ...(filter?.receiverNodeId ? { receiverNodeId: filter.receiverNodeId } : {}),
      ...(filter?.transportAttemptId ? { transportAttemptId: filter.transportAttemptId } : {}),
    },
    include: {
      bundle: true,
      transportAttempt: true,
      receiverNode: true,
    },
    orderBy: { confirmedAt: 'desc' },
  })
}

/**
 * Verify a delivery confirmation's integrity. The confirmationHash should
 * match the Bundle's payloadHash + receiverNodeId + idempotencyKey.
 *
 * This is a read-only verification — it does NOT mutate anything.
 */
export async function verifyDeliveryConfirmation(
  tenantId: string,
  confirmationId: string,
): Promise<boolean> {
  const confirmation = await getDeliveryConfirmation(tenantId, confirmationId)
  const bundle = await getBundle(tenantId, confirmation.bundleId)

  const expectedHash = sha256(
    JSON.stringify({
      bundleId: confirmation.bundleId,
      payloadHash: bundle.payloadHash,
      receiverNodeId: confirmation.receiverNodeId,
      idempotencyKey: confirmation.idempotencyKey,
    }),
  )

  return confirmation.confirmationHash === expectedHash
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
