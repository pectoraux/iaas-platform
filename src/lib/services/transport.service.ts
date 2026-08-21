// =============================================================================
// Transport service — Phase 14D: Transport Execution Foundation.
//
// TransportExecution is the minimal generic transport execution abstraction that
// allows Routes and Bundles to be executed by future network implementations.
// It is DISTINCT from:
//   - Bundle (the data-plane object — TransportExecution references it, does NOT
//     modify Bundle identity/payload, per T2).
//   - Route (the planned path — TransportExecution references it, does NOT
//     modify Route, per T3).
//   - InfrastructureAdapter (physical asset execution — TransportExecution is
//     data-plane transport, not asset telemetry/execute).
//
// This service implements the minimal transport execution lifecycle (Step 7):
//   createTransportExecution → startTransportExecution → completeTransportExecution
//   createTransportAttempt → acknowledgeAttempt / failAttempt
//   declareTransportCapability / listTransportCapabilities
//
// ARCHITECTURAL RULES (frozen):
//   - Dependency direction: Bundle → Route → TransportExecution → TransportAdapter
//   - Transport executes routing decisions; it does NOT make routing decisions.
//   - TransportExecution identity is immutable (cuid). Idempotent creation via
//     deterministic key (tenantId, routeId, bundleId, idempotencyKey) → concurrent
//     calls converge (T6).
//   - Tenant isolation: all queries filter by tenantId (T1).
//   - Bundle immutability (T2): TransportExecution references Bundle, does NOT
//     modify Bundle identity/payload/destination.
//   - Route immutability (T3): TransportExecution references Route, does NOT
//     modify Route.
//   - Lifecycle enforcement (T4): created → started → completed (valid);
//     completed → started (invalid — terminal). failed is recoverable (T5).
//   - Attempt ordering (T7): attempts maintain deterministic ordering via createdAt.
//   - Capability isolation (T8): TransportCapability is a declaration, NOT
//     network ownership/bandwidth/pricing/connectivity.
//
// This service does NOT import:
//   - VPP / Compute / Storage / Wireless vertical services (anti-drift).
//   - ProtocolRuntime / HybridRuntime / economic pipeline (no kernel coupling).
//   - Routing internals (routing.service — transport executes, does not decide).
//   - DTN / Transform / Extension / Marketplace / SDK (future — Step 5).
//
// NOT in scope (Step 5 — explicit non-goals):
//   TCP/UDP/QUIC/Bluetooth/WiFi/LoRa/satellite, DTN forwarding algorithm,
//   congestion control, routing algorithm, radio selection, bandwidth marketplace.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { getNode } from '@/lib/services/node.service'
import { getBundle } from '@/lib/services/data-plane.service'
import { getRoute } from '@/lib/services/routing.service'
import type { TransportAdapter } from '@/lib/kernel/adapters/transport-adapter'
import { MockTransportAdapter } from '@/lib/kernel/adapters/transport-adapter'

// ---------------------------------------------------------------------------
// Adapter registry — the dependency direction TransportExecution → TransportAdapter
// is REAL: the service invokes the adapter to execute attempts. Future network
// implementations (DTNTransportAdapter, TransitNetTransportAdapter, etc.) will
// be registered here. The default for Phase 14D is MockTransportAdapter (no
// network calls — records execution STATE only).
// ---------------------------------------------------------------------------

let transportAdapter: TransportAdapter = new MockTransportAdapter()

/**
 * Register a transport adapter. Future network implementations call this to
 * plug into the transport execution layer. The adapter MUST implement the
 * TransportAdapter contract (executeTransportAttempt, getCapabilities, validate).
 */
export function registerTransportAdapter(adapter: TransportAdapter): void {
  transportAdapter = adapter
}

/**
 * Get the currently registered transport adapter (for testing/inspection).
 */
export function getTransportAdapter(): TransportAdapter {
  return transportAdapter
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateTransportExecutionInput {
  /** The Route being executed. */
  routeId: string
  /** The Bundle being moved (must match Route.bundleId). */
  bundleId: string
  /** Caller-supplied key for deterministic identity (T6 idempotency). */
  idempotencyKey: string
  metadata?: Record<string, unknown>
}

export interface CreateTransportAttemptInput {
  executionId: string
  fromNodeId: string
  toNodeId: string
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// createTransportExecution — idempotent creation (T6)
// ---------------------------------------------------------------------------

/**
 * Create a TransportExecution for a Route+Bundle. Idempotent: the same
 * (tenantId, routeId, bundleId, idempotencyKey) always resolves to the same
 * durable execution. Concurrent calls converge (T6).
 *
 * Validation:
 *   - The Route must exist in the tenant.
 *   - The Bundle must exist in the tenant.
 *   - The Bundle must match the Route's bundleId (consistency).
 *
 * The execution is created in `created` status. Call startTransportExecution()
 * to transition to `started`. Terminal states cannot transition back (T4).
 */
export async function createTransportExecution(
  tenantId: string,
  input: CreateTransportExecutionInput,
  actorId?: string,
) {
  if (!input.routeId) throw new ValidationError('routeId is required')
  if (!input.bundleId) throw new ValidationError('bundleId is required')
  if (!input.idempotencyKey) throw new ValidationError('idempotencyKey is required')

  // Validate Route exists in tenant (also validates Bundle via Route.bundleId).
  const route = await getRoute(tenantId, input.routeId)

  // Validate Bundle exists in tenant (T2 — references, does not modify).
  const bundle = await getBundle(tenantId, input.bundleId)

  // Consistency: the Bundle must match the Route's bundleId.
  if (route.bundleId !== input.bundleId) {
    throw new ValidationError(
      `Bundle ${input.bundleId} does not match Route ${input.routeId}'s bundle ${route.bundleId}`,
    )
  }

  // Idempotent insert: try to create, catch P2002, re-read. This handles
  // concurrent execution creation convergence (T6).
  try {
    const execution = await db.transportExecution.create({
      data: {
        tenantId,
        routeId: input.routeId,
        bundleId: input.bundleId,
        idempotencyKey: input.idempotencyKey,
        status: 'created',
        attemptNumber: 1,
        metadataJson: JSON.stringify(input.metadata ?? {}),
      },
    })

    await appendAudit({
      tenantId,
      actorId,
      eventType: AuditEvents.TransportExecutionCreated,
      resourceType: 'transport_execution',
      resourceId: execution.id,
      metadata: {
        routeId: input.routeId,
        bundleId: input.bundleId,
        attemptNumber: 1,
      },
    })

    return execution
  } catch (err: unknown) {
    // P2002: concurrent createTransportExecution won the insert race.
    if (isPrismaUniqueConstraintError(err)) {
      const existing = await db.transportExecution.findFirst({
        where: {
          tenantId,
          routeId: input.routeId,
          bundleId: input.bundleId,
          idempotencyKey: input.idempotencyKey,
        },
      })
      if (!existing) throw err
      // Idempotent replay — return the existing execution (T6).
      return existing
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// getTransportExecution / listTransportExecutions — tenant-scoped reads (T1)
// ---------------------------------------------------------------------------

export async function getTransportExecution(tenantId: string, executionId: string) {
  const execution = await db.transportExecution.findFirst({
    where: { id: executionId, tenantId },
    include: {
      route: true,
      bundle: true,
      attempts: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!execution) throw new NotFoundError('transport_execution', executionId)
  return execution
}

export interface ListTransportExecutionFilter {
  routeId?: string
  bundleId?: string
  status?: string
}

export async function listTransportExecutions(
  tenantId: string,
  filter?: ListTransportExecutionFilter,
) {
  return db.transportExecution.findMany({
    where: {
      tenantId,
      ...(filter?.routeId ? { routeId: filter.routeId } : {}),
      ...(filter?.bundleId ? { bundleId: filter.bundleId } : {}),
      ...(filter?.status ? { status: filter.status } : {}),
    },
    include: {
      route: true,
      bundle: true,
      attempts: { orderBy: { createdAt: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
  })
}

// ---------------------------------------------------------------------------
// Lifecycle: start / complete / fail / cancel (T4 lifecycle enforcement)
// ---------------------------------------------------------------------------

/**
 * Start a transport execution. Only `created` executions can start (T4).
 */
export async function startTransportExecution(
  tenantId: string,
  executionId: string,
  actorId?: string,
) {
  const execution = await getTransportExecution(tenantId, executionId)
  if (execution.status !== 'created') {
    throw new ValidationError(
      `TransportExecution ${executionId} is ${execution.status}; only created executions can start`,
    )
  }
  const updated = await db.transportExecution.update({
    where: { id: executionId },
    data: { status: 'started', startedAt: new Date() },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.TransportExecutionStarted,
    resourceType: 'transport_execution',
    resourceId: executionId,
  })
  return updated
}

/**
 * Complete a transport execution. Only `started` executions can complete (T4).
 */
export async function completeTransportExecution(
  tenantId: string,
  executionId: string,
  actorId?: string,
) {
  const execution = await getTransportExecution(tenantId, executionId)
  if (execution.status !== 'started') {
    throw new ValidationError(
      `TransportExecution ${executionId} is ${execution.status}; only started executions can complete`,
    )
  }
  const updated = await db.transportExecution.update({
    where: { id: executionId },
    data: { status: 'completed', completedAt: new Date() },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.TransportExecutionCompleted,
    resourceType: 'transport_execution',
    resourceId: executionId,
  })
  return updated
}

/**
 * Fail a transport execution. Only `started` executions can fail (T4).
 * A failed execution can create another execution attempt (T5 — recovery).
 */
export async function failTransportExecution(
  tenantId: string,
  executionId: string,
  failureReason: string,
  actorId?: string,
) {
  const execution = await getTransportExecution(tenantId, executionId)
  if (execution.status !== 'started') {
    throw new ValidationError(
      `TransportExecution ${executionId} is ${execution.status}; only started executions can fail`,
    )
  }
  const updated = await db.transportExecution.update({
    where: { id: executionId },
    data: { status: 'failed', completedAt: new Date(), failureReason },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.TransportExecutionFailed,
    resourceType: 'transport_execution',
    resourceId: executionId,
    metadata: { failureReason },
  })
  return updated
}

/**
 * Cancel a transport execution. Only non-terminal executions can be cancelled.
 */
export async function cancelTransportExecution(
  tenantId: string,
  executionId: string,
  actorId?: string,
) {
  const execution = await getTransportExecution(tenantId, executionId)
  if (execution.status === 'completed' || execution.status === 'failed' || execution.status === 'cancelled') {
    throw new ValidationError(
      `TransportExecution ${executionId} is ${execution.status} (terminal)`,
    )
  }
  const updated = await db.transportExecution.update({
    where: { id: executionId },
    data: { status: 'cancelled', cancelledAt: new Date() },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.TransportExecutionCancelled,
    resourceType: 'transport_execution',
    resourceId: executionId,
  })
  return updated
}

// ---------------------------------------------------------------------------
// TransportAttempt — individual attempts within an execution (T7)
// ---------------------------------------------------------------------------

/**
 * Create a transport attempt. Attempts maintain DETERMINISTIC ordering via
 * attemptNumber (1-based, scoped to executionId). Under concurrency, the
 * attemptNumber is allocated via count+1 with P2002 catch + retry, so two
 * concurrent attempts never share the same attemptNumber (T7).
 *
 * The TransportAdapter is invoked to execute the attempt (the dependency
 * direction TransportExecution → TransportAdapter is REAL). The adapter result
 * is recorded as the attempt status. The MockTransportAdapter (default) makes
 * no network calls — it records execution STATE only.
 *
 * Node lifecycle enforcement: fromNodeId + toNodeId must be active Nodes.
 *
 * Lifecycle (Step 6 — tightened):
 *   created → sent → acknowledged | failed
 *   The attempt is created in 'created' status. The adapter is invoked, which
 *   transitions it to 'sent' then 'acknowledged' or 'failed'. The caller may
 *   also use markAttemptSent() + acknowledgeAttempt()/failAttempt() for
 *   explicit two-phase control.
 */
export async function createTransportAttempt(
  tenantId: string,
  input: CreateTransportAttemptInput,
  actorId?: string,
) {
  if (!input.executionId) throw new ValidationError('executionId is required')
  if (!input.fromNodeId) throw new ValidationError('fromNodeId is required')
  if (!input.toNodeId) throw new ValidationError('toNodeId is required')
  if (input.fromNodeId === input.toNodeId) {
    throw new ValidationError('fromNodeId and toNodeId must differ')
  }

  // Validate execution exists in tenant.
  const execution = await getTransportExecution(tenantId, input.executionId)
  if (execution.status === 'cancelled') {
    throw new ValidationError(`TransportExecution ${input.executionId} is cancelled`)
  }
  if (execution.status === 'completed' || execution.status === 'failed') {
    throw new ValidationError(
      `TransportExecution ${input.executionId} is ${execution.status} (terminal); cannot create new attempts`,
    )
  }

  // Validate Nodes exist + are active.
  const fromNode = await getNode(tenantId, input.fromNodeId)
  if (fromNode.status !== 'active') {
    throw new ValidationError(
      `From Node ${input.fromNodeId} is ${fromNode.status}; only active Nodes can be transport endpoints`,
    )
  }
  const toNode = await getNode(tenantId, input.toNodeId)
  if (toNode.status !== 'active') {
    throw new ValidationError(
      `To Node ${input.toNodeId} is ${toNode.status}; only active Nodes can be transport endpoints`,
    )
  }

  // Allocate attemptNumber deterministically under concurrency (T7).
  // Count existing attempts + 1. If a concurrent insert wins the same number,
  // P2002 fires → re-count and retry with the next number.
  const attempt = await allocateAttemptNumber(tenantId, input.executionId, async (attemptNumber) => {
    return db.transportAttempt.create({
      data: {
        executionId: input.executionId,
        attemptNumber,
        fromNodeId: input.fromNodeId,
        toNodeId: input.toNodeId,
        status: 'created',
        startedAt: new Date(),
        metadataJson: JSON.stringify(input.metadata ?? {}),
      },
    })
  })

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.TransportAttemptCreated,
    resourceType: 'transport_attempt',
    resourceId: attempt.id,
    metadata: {
      executionId: input.executionId,
      attemptNumber: attempt.attemptNumber,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
    },
  })

  return attempt
}

/**
 * Execute a transport attempt via the registered TransportAdapter. This is the
 * REAL dependency direction: TransportExecution → TransportAdapter. The adapter
 * is invoked, and the result transitions the attempt status.
 *
 * The adapter does NOT throw on transport failure — it returns a failed result
 * so the caller can record the attempt and decide whether to retry (T5).
 *
 * If the adapter returns 'acknowledged', the attempt is marked acknowledged.
 * If the adapter returns 'failed', the attempt is marked failed (but the
 * execution is NOT failed — T5 recovery).
 */
export async function executeAttemptViaAdapter(
  tenantId: string,
  attemptId: string,
  actorId?: string,
) {
  const attempt = await db.transportAttempt.findUnique({
    where: { id: attemptId },
    include: { execution: true },
  })
  if (!attempt || attempt.execution.tenantId !== tenantId) {
    throw new NotFoundError('transport_attempt', attemptId)
  }
  if (attempt.status !== 'created') {
    throw new ValidationError(
      `TransportAttempt ${attemptId} is ${attempt.status}; only created attempts can be executed`,
    )
  }

  // Mark as sent (created → sent).
  await db.transportAttempt.update({
    where: { id: attemptId },
    data: { status: 'sent' },
  })

  // Invoke the adapter (the dependency direction is REAL).
  const result = await transportAdapter.executeTransportAttempt({
    executionId: attempt.executionId,
    bundleId: attempt.execution.bundleId,
    routeId: attempt.execution.routeId,
    fromNodeId: attempt.fromNodeId,
    toNodeId: attempt.toNodeId,
    attemptNumber: attempt.attemptNumber,
  })

  // Record the result.
  if (result.status === 'acknowledged') {
    const updated = await db.transportAttempt.update({
      where: { id: attemptId },
      data: { status: 'acknowledged', completedAt: new Date() },
    })
    await appendAudit({
      tenantId,
      actorId,
      eventType: AuditEvents.TransportAttemptAcknowledged,
      resourceType: 'transport_attempt',
      resourceId: attemptId,
    })
    return updated
  }

  // result.status === 'failed'
  const updated = await db.transportAttempt.update({
    where: { id: attemptId },
    data: { status: 'failed', completedAt: new Date(), errorCode: result.errorCode ?? 'unknown' },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.TransportAttemptFailed,
    resourceType: 'transport_attempt',
    resourceId: attemptId,
    metadata: { errorCode: result.errorCode ?? 'unknown' },
  })
  return updated
}

/**
 * Allocate a deterministic attemptNumber under concurrency. Retries up to 3
 * times if a concurrent insert wins the same number (P2002).
 */
async function allocateAttemptNumber<T>(
  tenantId: string,
  executionId: string,
  createFn: (attemptNumber: number) => Promise<T>,
): Promise<T> {
  for (let i = 0; i < 3; i++) {
    const count = await db.transportAttempt.count({ where: { executionId } })
    const attemptNumber = count + 1
    try {
      return await createFn(attemptNumber)
    } catch (err: unknown) {
      if (isPrismaUniqueConstraintError(err)) {
        // Concurrent insert won this number — retry with count+1.
        continue
      }
      throw err
    }
  }
  throw new ConflictError(
    `Failed to allocate attemptNumber for execution ${executionId} after 3 retries (concurrency contention)`,
  )
}

/**
 * Acknowledge a transport attempt (sent → acknowledged).
 * Step 6: an attempt MUST be 'sent' before it can be acknowledged.
 * 'created → acknowledged' is REJECTED (must go through 'sent' first).
 */
export async function acknowledgeAttempt(
  tenantId: string,
  attemptId: string,
  actorId?: string,
) {
  const attempt = await db.transportAttempt.findUnique({
    where: { id: attemptId },
    include: { execution: true },
  })
  if (!attempt || attempt.execution.tenantId !== tenantId) {
    throw new NotFoundError('transport_attempt', attemptId)
  }
  if (attempt.status !== 'sent') {
    throw new ValidationError(
      `TransportAttempt ${attemptId} is ${attempt.status}; only sent attempts can be acknowledged (created → sent → acknowledged)`,
    )
  }
  const updated = await db.transportAttempt.update({
    where: { id: attemptId },
    data: { status: 'acknowledged', completedAt: new Date() },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.TransportAttemptAcknowledged,
    resourceType: 'transport_attempt',
    resourceId: attemptId,
  })
  return updated
}

/**
 * Mark an attempt as sent (created → sent).
 */
export async function markAttemptSent(
  tenantId: string,
  attemptId: string,
  actorId?: string,
) {
  const attempt = await db.transportAttempt.findUnique({
    where: { id: attemptId },
    include: { execution: true },
  })
  if (!attempt || attempt.execution.tenantId !== tenantId) {
    throw new NotFoundError('transport_attempt', attemptId)
  }
  if (attempt.status !== 'created') {
    throw new ValidationError(
      `TransportAttempt ${attemptId} is ${attempt.status}; only created attempts can be sent`,
    )
  }
  const updated = await db.transportAttempt.update({
    where: { id: attemptId },
    data: { status: 'sent' },
  })
  return updated
}

/**
 * Fail a transport attempt (sent → failed). Does NOT fail the execution
 * (T5 — the execution can create another attempt).
 *
 * Step 6: an attempt MUST be 'sent' before it can fail.
 * 'created → failed' is REJECTED (must go through 'sent' first).
 * 'acknowledged → failed' is REJECTED (acknowledged is terminal).
 */
export async function failAttempt(
  tenantId: string,
  attemptId: string,
  errorCode: string,
  actorId?: string,
) {
  const attempt = await db.transportAttempt.findUnique({
    where: { id: attemptId },
    include: { execution: true },
  })
  if (!attempt || attempt.execution.tenantId !== tenantId) {
    throw new NotFoundError('transport_attempt', attemptId)
  }
  if (attempt.status !== 'sent') {
    throw new ValidationError(
      `TransportAttempt ${attemptId} is ${attempt.status}; only sent attempts can fail (created → sent → failed)`,
    )
  }
  const updated = await db.transportAttempt.update({
    where: { id: attemptId },
    data: { status: 'failed', completedAt: new Date(), errorCode },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.TransportAttemptFailed,
    resourceType: 'transport_attempt',
    resourceId: attemptId,
    metadata: { errorCode },
  })
  return updated
}

// ---------------------------------------------------------------------------
// TransportCapability — declaration (T8)
// ---------------------------------------------------------------------------

/**
 * Declare a transport capability for a Node. Idempotent: same
 * (nodeId, capability) → same declaration. This is a declaration, NOT
 * network ownership/bandwidth/pricing/connectivity (T8).
 */
export async function declareTransportCapability(
  tenantId: string,
  nodeId: string,
  capability: string,
  actorId?: string,
) {
  // Validate Node exists + is active.
  const node = await getNode(tenantId, nodeId)
  if (node.status !== 'active') {
    throw new ValidationError(
      `Node ${nodeId} is ${node.status}; only active Nodes can declare transport capabilities`,
    )
  }

  // Idempotent: find or create.
  const existing = await db.transportCapability.findUnique({
    where: { nodeId_capability: { nodeId, capability } },
  })
  if (existing) return existing

  return db.transportCapability.create({
    data: { tenantId, nodeId, capability, status: 'active' },
  })
}

/**
 * List transport capabilities for a Node (or all in tenant).
 */
export async function listTransportCapabilities(
  tenantId: string,
  nodeId?: string,
) {
  return db.transportCapability.findMany({
    where: {
      tenantId,
      ...(nodeId ? { nodeId } : {}),
    },
    orderBy: { createdAt: 'desc' },
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
