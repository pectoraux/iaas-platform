// =============================================================================
// Network Lifecycle service — IAAS-DOM-ARCH-6 §3.3–3.4 / WORK-025
// =============================================================================
// The service-layer authority for NetworkInstance identity and lifecycle.
//
// Contract source: spec/domain-architecture-v6.md §3.3 (Network instance),
// §3.4 (Network lifecycle), §15 (authority matrix), spec/domain-requirements-v6.md
// NET-001 / NET-002, spec/work-orders/WORK-025.md.
//
// ARCHITECTURAL BOUNDARIES (frozen by IAAS-DOM-ARCH-6):
//   - Service-layer, NOT kernel (this module is in src/lib/services/).
//   - Owns the NetworkInstance lifecycle state machine — the SINGLE
//     authoritative owner for instance lifecycle (authority matrix:
//     "network instance/lifecycle | Network Lifecycle | Workflow engine,
//     Runtime").
//   - NetworkDefinition/NetworkVersion remain authoritative for intent and
//     immutable publication; this service only READS the published version.
//     It NEVER writes NetworkVersion rows (published versions cannot be
//     mutated by instance lifecycle).
//   - Instance lifecycle is DISTINCT from NetworkDefinition, NetworkRequest,
//     Execution, and resource lifecycles (no state from those machines is
//     read, reused, or aliased here).
//   - Tenant isolation is mandatory on every query (NET-001-AC03).
//   - Mutating operations are actor-authorized (role-based; viewers are
//     denied) and audited; audit rows commit atomically with the transition.
//   - PostgreSQL is the durable source of instance identity + state.
//
// This service does NOT:
//   - implement Network-as-Code validation/resolution/launch planning
//     (WORK-026 — NET-003/NET-004);
//   - implement composition, exports/imports, or federation semantics
//     (WORK-027+, explicitly out of WORK-025 scope);
//   - execute anything, allocate capacity, or touch the control plane;
//   - import vertical, kernel, control-plane, data-plane, runtime, or
//     economic services;
//   - delete instances — terminal states retain the row + audit trail
//     (V6 §3.3: "retains audit/evidence after termination/archive").
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit } from '@/lib/domain/audit'
import type { UserRole } from '@/lib/domain/auth'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The frozen V6 §3.4 Network instance lifecycle states. */
export type NetworkInstanceLifecycleState =
  | 'planned'
  | 'provisioning'
  | 'validating'
  | 'active'
  | 'paused'
  | 'draining'
  | 'terminated'
  | 'archived'

/**
 * The actor performing a lifecycle operation. Identity/roles are owned by the
 * existing identity boundary (PlatformUser/UserRole) — this service only
 * makes the authorization DECISION for NetworkInstance lifecycle operations:
 * mutating operations require admin | owner | operator; viewers are denied.
 */
export interface NetworkLifecycleActor {
  actorId: string
  role: UserRole
}

export interface CreateNetworkInstanceInput {
  /** The immutable PUBLISHED NetworkVersion this instance realizes. */
  networkVersionId: string
  /** Optional descriptive label. NOT identity — the durable id is identity. */
  label?: string
}

export interface LifecycleTransitionOptions {
  /** Optional recorded reason (e.g. failure cause, rollback rationale). */
  reason?: string
}

export interface NetworkInstanceResult {
  id: string
  tenantId: string
  networkVersionId: string
  /** The source version's owning NetworkDefinition id (read-only context). */
  networkId: string
  /** The source version's immutable version number. */
  version: number
  label: string | null
  lifecycleState: string
  createdAt: string
  updatedAt: string
}

export interface NetworkInstanceAuditEntry {
  eventType: string
  from: string | null
  to: string | null
  reason: string | null
  actorId: string | null
  occurredAt: string
}

// ---------------------------------------------------------------------------
// Lifecycle state constants (V6 §3.4)
// ---------------------------------------------------------------------------
// The frozen chart (uppercase in the architecture document) maps 1:1 onto
// these stored lowercase values, following the repository's storage
// convention (Node/Extension/Execution state columns are lowercase):
//
//   PLANNED → PROVISIONING → VALIDATING → ACTIVE ⇌ PAUSED
//           → DRAINING → TERMINATED → ARCHIVED (terminal)
//
// Failure/rollback transitions are explicit (V6 §3.4): a failed PROVISIONING
// or VALIDATING stage — and a PLANNED instance abandoned before provisioning
// — transition directly to TERMINATED without ever touching the published
// NetworkVersion. Rollback of a live deployment goes ACTIVE/PAUSED →
// DRAINING → TERMINATED (a NEW instance may then be created from the same or
// a later published version — the version itself is never rewritten).

export const LIFECYCLE_STATE = {
  PLANNED: 'planned',
  PROVISIONING: 'provisioning',
  VALIDATING: 'validating',
  ACTIVE: 'active',
  PAUSED: 'paused',
  DRAINING: 'draining',
  TERMINATED: 'terminated',
  ARCHIVED: 'archived',
} as const

/** All frozen V6 §3.4 states, in chart order. */
export const NETWORK_INSTANCE_LIFECYCLE_STATES: readonly NetworkInstanceLifecycleState[] = [
  LIFECYCLE_STATE.PLANNED,
  LIFECYCLE_STATE.PROVISIONING,
  LIFECYCLE_STATE.VALIDATING,
  LIFECYCLE_STATE.ACTIVE,
  LIFECYCLE_STATE.PAUSED,
  LIFECYCLE_STATE.DRAINING,
  LIFECYCLE_STATE.TERMINATED,
  LIFECYCLE_STATE.ARCHIVED,
]

/** The only absolute terminal state (TERMINATED may still be archived). */
export const TERMINAL_LIFECYCLE_STATE = LIFECYCLE_STATE.ARCHIVED

/** Initial state of every NetworkInstance. */
export const INITIAL_LIFECYCLE_STATE = LIFECYCLE_STATE.PLANNED

/**
 * The authoritative transition table (V6 §3.4).
 *
 * Happy path (the canonical Network-as-Code launch pipeline represented as
 * ONE lifecycle, NET-002-AC01 — no stage can be bypassed):
 *   planned → provisioning → validating → active
 *
 * Reversible suspension: active ⇌ paused.
 * Teardown: active/paused → draining → terminated → archived.
 * Explicit failure/rollback exits: planned/provisioning/validating →
 * terminated.
 */
export const VALID_TRANSITIONS: Record<string, readonly string[]> = {
  [LIFECYCLE_STATE.PLANNED]: [LIFECYCLE_STATE.PROVISIONING, LIFECYCLE_STATE.TERMINATED],
  [LIFECYCLE_STATE.PROVISIONING]: [LIFECYCLE_STATE.VALIDATING, LIFECYCLE_STATE.TERMINATED],
  [LIFECYCLE_STATE.VALIDATING]: [LIFECYCLE_STATE.ACTIVE, LIFECYCLE_STATE.TERMINATED],
  [LIFECYCLE_STATE.ACTIVE]: [LIFECYCLE_STATE.PAUSED, LIFECYCLE_STATE.DRAINING],
  [LIFECYCLE_STATE.PAUSED]: [LIFECYCLE_STATE.ACTIVE, LIFECYCLE_STATE.DRAINING],
  [LIFECYCLE_STATE.DRAINING]: [LIFECYCLE_STATE.TERMINATED],
  [LIFECYCLE_STATE.TERMINATED]: [LIFECYCLE_STATE.ARCHIVED],
  [LIFECYCLE_STATE.ARCHIVED]: [], // terminal — no transitions out
}

/** Pure transition predicate (exported for state-machine unit tests). */
export function isValidLifecycleTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from]
  if (!allowed) return false
  return allowed.includes(to)
}

// ---------------------------------------------------------------------------
// Actor authorization (WORK-025 scope: "authorization")
// ---------------------------------------------------------------------------

const MUTATING_ROLES: readonly UserRole[] = ['admin', 'owner', 'operator']

function authorizeMutatingOperation(actor: NetworkLifecycleActor, operation: string): void {
  if (!MUTATING_ROLES.includes(actor.role)) {
    throw new ForbiddenError(
      `Actor is not authorized to ${operation} a NetworkInstance (role '${actor.role}' is read-only; ` +
        `requires one of: ${MUTATING_ROLES.join(', ')})`,
    )
  }
}

// ---------------------------------------------------------------------------
// Create (NET-001-AC01/AC02: distinct identity, exactly one immutable source)
// ---------------------------------------------------------------------------

/**
 * Create a NetworkInstance: one realized deployment of exactly one immutable
 * PUBLISHED NetworkVersion. The instance starts in PLANNED.
 *
 * Identity rules (V6 §3.3):
 *   - the instance gets its OWN durable id (distinct from definition/version
 *     identity);
 *   - the source version MUST be published (publishedAt set) — an instance
 *     can never source a mutable draft version;
 *   - many instances MAY derive from the same published version.
 */
export async function createNetworkInstance(
  tenantId: string,
  input: CreateNetworkInstanceInput,
  actor: NetworkLifecycleActor,
): Promise<NetworkInstanceResult> {
  authorizeMutatingOperation(actor, 'create')

  if (!input.networkVersionId) {
    throw new ValidationError('networkVersionId is required')
  }
  let label: string | null = null
  if (input.label !== undefined && input.label !== null) {
    const trimmed = input.label.trim()
    if (trimmed.length === 0) {
      throw new ValidationError('label must be a non-empty string when provided')
    }
    if (trimmed.length > 200) {
      throw new ValidationError('label must be at most 200 characters')
    }
    label = trimmed
  }

  // Tenant-scoped source-version resolution. A version id from another tenant
  // (or a nonexistent one) is uniformly NOT_FOUND — no cross-tenant leakage.
  const version = await db.networkVersion.findFirst({
    where: { id: input.networkVersionId, network: { tenantId } },
  })
  if (!version) {
    throw new NotFoundError('network_version', input.networkVersionId)
  }
  if (!version.publishedAt) {
    throw new ConflictError(
      `Cannot create a NetworkInstance from unpublished NetworkVersion ${version.id} ` +
        `(v${version.version}): instances must source an immutable PUBLISHED version`,
    )
  }

  // Durable creation + audit INSIDE one transaction: the identity and its
  // birth audit record commit (or roll back) atomically.
  const created = await db.$transaction(async (tx) => {
    const instance = await tx.networkInstance.create({
      data: {
        tenantId,
        networkVersionId: version.id,
        label,
        lifecycleState: INITIAL_LIFECYCLE_STATE,
      },
    })
    await appendAudit({
      tenantId,
      actorId: actor.actorId,
      eventType: 'network_instance.created',
      resourceType: 'network_instance',
      resourceId: instance.id,
      metadata: {
        networkVersionId: version.id,
        networkId: version.networkId,
        version: version.version,
        label,
        initialLifecycleState: INITIAL_LIFECYCLE_STATE,
      },
      tx,
    })
    return instance
  })

  return toResult(created, { networkId: version.networkId, version: version.version })
}

// ---------------------------------------------------------------------------
// Read (tenant-scoped; NET-001-AC03)
// ---------------------------------------------------------------------------

export async function getNetworkInstance(
  tenantId: string,
  instanceId: string,
): Promise<NetworkInstanceResult> {
  const instance = await db.networkInstance.findFirst({
    where: { id: instanceId, tenantId },
    include: { networkVersion: true },
  })
  if (!instance) throw new NotFoundError('network_instance', instanceId)
  return toResult(instance, {
    networkId: instance.networkVersion.networkId,
    version: instance.networkVersion.version,
  })
}

export async function listNetworkInstances(
  tenantId: string,
  filter?: { lifecycleState?: string; networkVersionId?: string },
): Promise<NetworkInstanceResult[]> {
  if (filter?.lifecycleState && !NETWORK_INSTANCE_LIFECYCLE_STATES.includes(filter.lifecycleState as NetworkInstanceLifecycleState)) {
    throw new ValidationError(
      `Unknown NetworkInstance lifecycle state: ${filter.lifecycleState}`,
    )
  }
  const instances = await db.networkInstance.findMany({
    where: {
      tenantId,
      ...(filter?.lifecycleState ? { lifecycleState: filter.lifecycleState } : {}),
      ...(filter?.networkVersionId ? { networkVersionId: filter.networkVersionId } : {}),
    },
    include: { networkVersion: true },
    orderBy: { createdAt: 'desc' },
  })
  return instances.map((i) => toResult(i, { networkId: i.networkVersion.networkId, version: i.networkVersion.version }))
}

// ---------------------------------------------------------------------------
// Lifecycle transitions (the authoritative state machine, NET-001-AC02 /
// NET-002-AC01/AC02)
// ---------------------------------------------------------------------------

/**
 * Execute an authoritative NetworkInstance lifecycle transition (V6 §3.4).
 *
 * Concurrency-safe: the instance row is locked FOR UPDATE inside the
 * transaction and the transition is validated against the LOCKED row, so two
 * racing transitions cannot both apply — exactly one wins and the loser
 * re-validates against the committed state (the same pattern as
 * NetworkVersion publication). The audit row commits atomically with the
 * transition.
 *
 * The transition NEVER writes NetworkVersion rows: the published source
 * version is immutable evidence, not lifecycle state.
 */
export async function transitionNetworkInstanceLifecycle(
  tenantId: string,
  instanceId: string,
  targetState: string,
  actor: NetworkLifecycleActor,
  options?: LifecycleTransitionOptions,
): Promise<NetworkInstanceResult> {
  authorizeMutatingOperation(actor, 'transition the lifecycle of')

  if (!NETWORK_INSTANCE_LIFECYCLE_STATES.includes(targetState as NetworkInstanceLifecycleState)) {
    throw new ValidationError(`Unknown NetworkInstance lifecycle state: ${targetState}`)
  }

  const updated = await db.$transaction(
    async (tx) => {
      // Lock the instance row FOR UPDATE. This blocks any concurrent
      // transition until this transaction commits, so the state validation
      // below runs against the exact row snapshot that gets updated.
      const lockedRows = await tx.$queryRaw<
        Array<{ id: string; tenantId: string; networkVersionId: string; lifecycleState: string }>
      >`
        SELECT "id", "tenantId", "networkVersionId", "lifecycleState"
        FROM "NetworkInstance"
        WHERE "id" = ${instanceId}::text
        FOR UPDATE
      `
      const locked = lockedRows[0]
      if (!locked || locked.tenantId !== tenantId) {
        // Cross-tenant instance ids are uniformly NOT_FOUND (no leakage).
        throw new NotFoundError('network_instance', instanceId)
      }

      const currentState = locked.lifecycleState

      // ARCHIVED is the absolute terminal state — no transitions out, ever.
      if (currentState === TERMINAL_LIFECYCLE_STATE) {
        throw new ConflictError(
          `NetworkInstance ${instanceId} is archived (terminal state) — no lifecycle transitions are permitted`,
        )
      }

      // Validate the transition against the frozen table.
      if (!isValidLifecycleTransition(currentState, targetState)) {
        throw new ValidationError(
          `Invalid NetworkInstance lifecycle transition: ${currentState} → ${targetState} ` +
            `(instance ${instanceId}); allowed from '${currentState}': ` +
            `${(VALID_TRANSITIONS[currentState] ?? []).join(', ') || '(none — terminal)'}`,
        )
      }

      await tx.networkInstance.update({
        where: { id: locked.id },
        data: { lifecycleState: targetState },
      })

      // Audit INSIDE the transaction: the evidence row commits/rolls back
      // atomically with the transition it attests.
      await appendAudit({
        tenantId,
        actorId: actor.actorId,
        eventType: 'network_instance.lifecycle_transition',
        resourceType: 'network_instance',
        resourceId: locked.id,
        metadata: {
          networkVersionId: locked.networkVersionId,
          from: currentState,
          to: targetState,
          reason: options?.reason ?? null,
          actorRole: actor.role,
        },
        tx,
      })

      return { id: locked.id, networkVersionId: locked.networkVersionId }
    },
    { timeout: 30000 },
  )

  const refreshed = await db.networkInstance.findUnique({
    where: { id: updated.id },
    include: { networkVersion: true },
  })
  if (!refreshed) throw new NotFoundError('network_instance', updated.id)
  return toResult(refreshed, {
    networkId: refreshed.networkVersion.networkId,
    version: refreshed.networkVersion.version,
  })
}

// ---------------------------------------------------------------------------
// Historical evidence (V6 §3.3: audit/evidence retained after
// termination/archive; WORK-025 verification: "historical evidence
// preservation")
// ---------------------------------------------------------------------------

/**
 * The immutable lifecycle evidence trail of an instance, read from the
 * append-only AuditLog: the creation record plus every transition, in order.
 * The trail is readable for TERMINATED and ARCHIVED instances — terminal
 * states preserve evidence (the rows are never deleted).
 */
export async function getNetworkInstanceLifecycleHistory(
  tenantId: string,
  instanceId: string,
): Promise<NetworkInstanceAuditEntry[]> {
  // Tenant-scoped existence check first (uniform NOT_FOUND for other
  // tenants' instances).
  await getNetworkInstance(tenantId, instanceId)

  const rows = await db.auditLog.findMany({
    where: {
      tenantId,
      resourceType: 'network_instance',
      resourceId: instanceId,
      eventType: { in: ['network_instance.created', 'network_instance.lifecycle_transition'] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })

  return rows.map((row) => {
    const metadata = JSON.parse(row.metadataJson) as Record<string, unknown>
    return {
      eventType: row.eventType,
      from: (metadata.from as string | undefined) ?? null,
      to: (metadata.to as string | undefined) ?? null,
      reason: (metadata.reason as string | null | undefined) ?? null,
      actorId: row.actorId,
      occurredAt: row.createdAt.toISOString(),
    }
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toResult(
  instance: {
    id: string
    tenantId: string
    networkVersionId: string
    label: string | null
    lifecycleState: string
    createdAt: Date
    updatedAt: Date
  },
  source: { networkId: string; version: number },
): NetworkInstanceResult {
  return {
    id: instance.id,
    tenantId: instance.tenantId,
    networkVersionId: instance.networkVersionId,
    networkId: source.networkId,
    version: source.version,
    label: instance.label,
    lifecycleState: instance.lifecycleState,
    createdAt: instance.createdAt.toISOString(),
    updatedAt: instance.updatedAt.toISOString(),
  }
}
