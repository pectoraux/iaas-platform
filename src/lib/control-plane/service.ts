// =============================================================================
// Control Plane: Service (Phase 12B — Slice 2)
// =============================================================================
// Orchestrates the atomic control-plane workflow:
//
//   BEGIN
//     1. resolve/validate requester membership
//     2. validate Network Scope Integrity (§8.6)
//     3. resolve idempotency identity (deterministic requestId)
//     4. compare canonical request payload (IDEMPOTENCY_CONFLICT if mismatch)
//     5. load authoritative resource + capacity snapshot
//     6. run pure scheduler (no DB mutation)
//     7. persist AllocationDecision (exact scheduler output)
//     8. call existing CapacityService.createCapacityReservation(..., tx)
//     9. mark request scheduled
//   COMMIT
//
// CRITICAL RULES:
//   - The scheduler is pure — it never mutates DB state.
//   - The AllocationDecision stores the EXACT decisionSnapshotHash from the
//     pure scheduler. The DB never recomputes a different hash.
//   - Capacity reservation flows through the EXISTING capacity service.
//     The control plane does not duplicate CapacityResource/Reservation/
//     Commitment.
//   - Idempotency: same (network, requester, idempotencyKey) + same payload
//     → return existing. Same identity + different payload → CONFLICT.
// =============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { createHash } from 'crypto'
import { schedule, SCHEDULER_VERSION } from './scheduler'
import {
  createNetworkRequest,
  deriveRequestId,
  DefaultConstraintEvaluator,
  compareCanonicalStrings,
} from './types'
import type { ExtendedTransactionClient } from '@/lib/db'
import {
  createDefaultCapacityProviderRegistry,
  type CapacityProviderRegistry,
  type CapacityReservationResult,
} from './capacity-provider'
import type {
  NetworkRequest,
  AllocationDecision,
  NetworkResourceMembership,
  CapacityEntry,
  CapacitySourceSnapshot,
  ConstraintObservationSnapshot,
  ParticipantMembership,
  ParticipantRole,
} from './types'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class IdempotencyConflictError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly storedPayloadHash: string,
    public readonly newPayloadHash: string,
  ) {
    super(
      `Idempotency conflict: requestId=${requestId} was previously submitted ` +
        `with a different payload. Stored hash=${storedPayloadHash}, ` +
        `new hash=${newPayloadHash}. An idempotency key identifies an ` +
        `operation, not arbitrary payloads.`,
    )
    this.name = 'IdempotencyConflictError'
  }
}

export class RequestAuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestAuthorizationError'
  }
}

export class NetworkScopeIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetworkScopeIntegrityError'
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubmitNetworkRequestInput {
  requesterMembershipId: string
  networkId: string
  networkVersionId: string // REQUIRED — must reference a published NetworkVersion
  capabilityRequirements: { capabilityType: string; amount: string; unit: string }[]
  timeWindow: { start: Date; end: Date }
  constraints?: unknown[]
  priority?: number
  idempotencyKey: string
}

export interface SubmitNetworkRequestResult {
  request: NetworkRequest
  decision: AllocationDecision
  reservations: CapacityReservationResult[] // one per allocated capability
}

// ---------------------------------------------------------------------------
// Payload hash (for idempotency conflict detection)
// ---------------------------------------------------------------------------

/**
 * Compute the canonical payload hash of a NetworkRequest.
 * This covers the SEMANTIC content — not the requestId (which is derived
 * from the identity inputs). Two requests with the same idempotency key
 * but different capability requirements, time windows, constraints, or
 * priorities will have different payload hashes.
 *
 * PURE: same inputs → same hash.
 */
export function computePayloadHash(input: SubmitNetworkRequestInput): string {
  const canonical = JSON.stringify({
    capabilityRequirements: input.capabilityRequirements
      .map((r) => ({ ...r }))
      .sort((a, b) => {
        if (a.capabilityType !== b.capabilityType) return compareCanonicalStrings(a.capabilityType, b.capabilityType)
        if (a.unit !== b.unit) return compareCanonicalStrings(a.unit, b.unit)
        return compareCanonicalStrings(a.amount, b.amount)
      }),
    timeWindow: {
      start: input.timeWindow.start.toISOString(),
      end: input.timeWindow.end.toISOString(),
    },
    constraints: input.constraints ?? [],
    priority: input.priority ?? null,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

// ---------------------------------------------------------------------------
// The atomic control-plane service
// ---------------------------------------------------------------------------

/**
 * Submit a NetworkRequest atomically:
 *   1. Resolve the requester membership from the DB.
 *   2. Validate authorization (active + consumer/orchestrator role).
 *   3. Validate Network Scope Integrity.
 *   4. Resolve idempotency identity (deterministic requestId).
 *   5. Check for existing request with the same identity.
 *      - If exists + same payload → return existing result (idempotent).
 *      - If exists + different payload → IDEMPOTENCY_CONFLICT.
 *   6. Persist the NetworkRequest.
 *   7. Load the authoritative resource/capacity snapshot from the DB.
 *   8. Run the pure scheduler (no DB mutation).
 *   9. Persist the AllocationDecision (exact scheduler output).
 *  10. Call the existing capacity service to create a reservation.
 *  11. Mark the request as scheduled.
 *
 * All steps 6-11 happen inside a single db.$transaction.
 *
 * The scheduler is PURE — it receives the snapshot as input and returns an
 * AllocationDecision. The DB stores the exact decisionSnapshotHash.
 */
export async function submitNetworkRequest(
  input: SubmitNetworkRequestInput,
): Promise<SubmitNetworkRequestResult> {
  // 1-4: Resolve identity (outside the transaction — these are reads).
  const requestId = deriveRequestId(
    input.networkId,
    input.requesterMembershipId,
    input.idempotencyKey,
  )
  const payloadHash = computePayloadHash(input)

  // Check for an existing request with the same identity.
  const existing = await db.networkRequest.findUnique({
    where: { id: requestId },
  })

  if (existing) {
    // Idempotency check: same identity + same payload → return existing.
    // Same identity + different payload → CONFLICT.
    if (existing.payloadHash !== payloadHash) {
      throw new IdempotencyConflictError(
        requestId,
        existing.payloadHash,
        payloadHash,
      )
    }

    // Same payload → check if a decision exists.
    const existingDecision = await db.allocationDecision.findUnique({
      where: { requestId },
    })

    if (existingDecision) {
      // Load the multi-reservation bindings.
      const existingReservations = await db.allocationReservation.findMany({
        where: { decisionId: existingDecision.id },
      })
      return {
        request: dbRequestToNetworkRequest(existing),
        decision: dbDecisionToAllocationDecision(existingDecision),
        reservations: existingReservations.map((r) => ({
          reservationId: r.reservationId,
          capabilityType: r.capabilityType,
          unit: r.unit,
          allocatedAmount: r.allocatedAmount,
        })),
      }
    }

    // Request exists but no decision yet — fall through to scheduling.
  }

  // 5-11: Atomic transaction.
  const result = await db.$transaction(async (tx) => {
    // 5. Resolve the requester membership.
    const requesterMembership = await tx.participantMembership.findUnique({
      where: { id: input.requesterMembershipId },
      include: { roles: true },
    })

    if (!requesterMembership) {
      throw new RequestAuthorizationError(
        `Requester membership '${input.requesterMembershipId}' not found`,
      )
    }

    // 6. Validate Network Scope Integrity.
    if (requesterMembership.networkId !== input.networkId) {
      throw new NetworkScopeIntegrityError(
        `Requester membership networkId '${requesterMembership.networkId}' ` +
          `does not match request networkId '${input.networkId}' (§8.6)`,
      )
    }

    // 7. Validate authorization (active + consumer/orchestrator role).
    if (requesterMembership.status !== 'active') {
      throw new RequestAuthorizationError(
        `Requester membership is '${requesterMembership.status}', not 'active'`,
      )
    }

    const hasAuthorizingRole = requesterMembership.roles.some(
      (r) =>
        (r.role === 'consumer' || r.role === 'orchestrator') &&
        r.status === 'active' &&
        !r.revokedAt,
    )

    if (!hasAuthorizingRole) {
      throw new RequestAuthorizationError(
        `Requester has no active 'consumer' or 'orchestrator' role`,
      )
    }

    // 8. Persist the NetworkRequest (or find existing).
    const request = await tx.networkRequest.upsert({
      where: { id: requestId },
      create: {
        id: requestId,
        requesterMembershipId: input.requesterMembershipId,
        networkId: input.networkId,
        networkVersionId: input.networkVersionId,
        capabilityRequirementsJson: JSON.stringify(
          input.capabilityRequirements
            .map((r) => ({ ...r }))
            .sort((a, b) => {
              if (a.capabilityType !== b.capabilityType) return compareCanonicalStrings(a.capabilityType, b.capabilityType)
              if (a.unit !== b.unit) return compareCanonicalStrings(a.unit, b.unit)
              return compareCanonicalStrings(a.amount, b.amount)
            }),
        ),
        constraintsJson: input.constraints ? JSON.stringify(input.constraints) : null,
        priority: input.priority,
        timeWindowStart: input.timeWindow.start,
        timeWindowEnd: input.timeWindow.end,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        status: 'pending',
      },
      update: {}, // don't update if exists (we already checked payload above)
    })

    // Check if a decision already exists for this request.
    const existingDecision = await tx.allocationDecision.findUnique({
      where: { requestId },
    })
    if (existingDecision) {
      const existingReservations = await tx.allocationReservation.findMany({
        where: { decisionId: existingDecision.id },
      })
      return {
        request: dbRequestToNetworkRequest(request),
        decision: dbDecisionToAllocationDecision(existingDecision),
        reservations: existingReservations.map((r) => ({
          reservationId: r.reservationId,
          capabilityType: r.capabilityType,
          unit: r.unit,
          allocatedAmount: r.allocatedAmount,
        })),
      }
    }

    // 9. Validate the NetworkVersion: exists + same network + published.
    const networkVersion = await tx.networkVersion.findUnique({
      where: { id: input.networkVersionId },
    })
    if (!networkVersion) {
      throw new RequestAuthorizationError(
        `NetworkVersion '${input.networkVersionId}' not found`,
      )
    }
    if (networkVersion.networkId !== input.networkId) {
      throw new NetworkScopeIntegrityError(
        `NetworkVersion.networkId '${networkVersion.networkId}' does not match request.networkId '${input.networkId}'`,
      )
    }
    if (!networkVersion.publishedAt) {
      throw new RequestAuthorizationError(
        `NetworkVersion '${input.networkVersionId}' is not published (publishedAt is null)`,
      )
    }

    // 9. Load the authoritative resource + capacity snapshot.
    const resourceMemberships = await tx.networkResourceMembership.findMany({
      where: {
        networkId: input.networkId,
        status: 'active',
      },
      include: {
        resource: true,
        participantMembership: true,
      },
    })

    // Build the scheduler input from DB records.
    const candidateMemberships: NetworkResourceMembership[] = resourceMemberships.map((rm) => ({
      membershipId: rm.id,
      resourceId: rm.resourceId,
      networkId: rm.networkId,
      participantMembershipId: rm.participantMembershipId,
      capabilities: JSON.parse(rm.capabilitiesJson) as string[],
      verifiedCapacity: JSON.parse(rm.verifiedCapacityJson) as CapacityEntry[],
      controlMode: rm.controlMode,
      verificationProfile: rm.verificationProfile,
      availability: rm.availabilityStart && rm.availabilityEnd
        ? { start: rm.availabilityStart, end: rm.availabilityEnd }
        : undefined,
      membershipStatus: rm.status as NetworkResourceMembership['membershipStatus'],
    }))

    const remainingCapacity = new Map<string, CapacityEntry[]>()
    const authorizingMemberships = new Map<string, ParticipantMembership>()
    const requesterRoles: ParticipantRole[] = requesterMembership.roles.map((r) => ({
      roleAssignmentId: r.id,
      membershipId: r.membershipId,
      role: r.role as ParticipantRole['role'],
      roleStatus: r.status as ParticipantRole['roleStatus'],
      assignedAt: r.assignedAt,
      revokedAt: r.revokedAt ?? undefined,
    }))

    for (const rm of resourceMemberships) {
      const capacity: CapacityEntry[] = JSON.parse(rm.verifiedCapacityJson)
      remainingCapacity.set(rm.id, capacity)

      const auth = rm.participantMembership
      authorizingMemberships.set(rm.participantMembershipId, {
        membershipId: auth.id,
        participantId: auth.participantId,
        networkId: auth.networkId,
        membershipStatus: auth.status as ParticipantMembership['membershipStatus'],
        joinedAt: auth.joinedAt,
        metadata: {},
      })
    }

    // 10. Run the pure scheduler.
    const networkRequest: NetworkRequest = {
      requestId: request.id,
      requesterMembershipId: input.requesterMembershipId,
      networkId: input.networkId,
      capabilityRequirements: input.capabilityRequirements,
      timeWindow: input.timeWindow,
      constraints: input.constraints as any,
      priority: input.priority,
      idempotencyKey: input.idempotencyKey,
      status: 'pending',
      submittedAt: request.createdAt,
    }

    const schedulerResult = schedule({
      networkVersionId: input.networkVersionId, // REQUIRED — no 'default' fallback
      request: networkRequest,
      requesterMembership: {
        membershipId: requesterMembership.id,
        participantId: requesterMembership.participantId,
        networkId: requesterMembership.networkId,
        membershipStatus: requesterMembership.status as ParticipantMembership['membershipStatus'],
        joinedAt: requesterMembership.joinedAt,
        metadata: {},
      },
      requesterRoles,
      candidateMemberships,
      remainingCapacity,
      authorizingMemberships,
    })

    if (schedulerResult.status === 'rejected') {
      await tx.networkRequest.update({
        where: { id: requestId },
        data: { status: 'rejected' },
      })
      throw new RequestAuthorizationError(
        `Scheduler rejected the request: ${schedulerResult.reason}`,
      )
    }

    if (schedulerResult.status === 'no_candidates') {
      await tx.networkRequest.update({
        where: { id: requestId },
        data: { status: 'rejected' },
      })
      throw new RequestAuthorizationError(
        `No eligible resources: ${schedulerResult.reason}`,
      )
    }

    const decision = schedulerResult.decision

    // 11. Create capacity reservations via the CapacityProvider boundary.
    //     The control plane does NOT pass ResourceIdentity.id as an assetId
    //     to the existing CapacityService. Instead, it resolves the appropriate
    //     CapacityProvider based on the selected resource's resourceKind,
    //     and the provider translates to the existing capacity primitive.
    //
    //     Each capability gets a DISTINCT reservation with a distinct sourceId
    //     (requestId:capabilityType) to prevent the capacity service's
    //     idempotency from collapsing multiple capabilities into one.
    const providerRegistry = createDefaultCapacityProviderRegistry()

    // Resolve the selected resource's kind + tenantId.
    const selectedMembership = resourceMemberships.find(
      (rm) => rm.id === decision.selectedMembershipId,
    )
    if (!selectedMembership) {
      throw new RequestAuthorizationError(
        `Selected membership ${decision.selectedMembershipId} not found in loaded snapshot`,
      )
    }

    const selectedResource = await tx.resourceIdentity.findUnique({
      where: { id: selectedMembership.resourceId },
    })
    if (!selectedResource) {
      throw new RequestAuthorizationError(
        `ResourceIdentity '${selectedMembership.resourceId}' not found`,
      )
    }

    const network = await tx.networkDefinition.findUnique({
      where: { id: input.networkId },
    })
    if (!network) {
      throw new RequestAuthorizationError(
        `Network ${input.networkId} not found`,
      )
    }

    const provider = providerRegistry.resolve(selectedResource.resourceKind)

    const reservationResults: CapacityReservationResult[] = []
    for (const cap of decision.allocatedCapacity) {
      const reservationResult = await provider.createReservation({
        resourceId: selectedMembership.resourceId,
        networkId: input.networkId,
        tenantId: network.tenantId,
        capabilityType: cap.capabilityType,
        amount: cap.amount,
        unit: cap.unit,
        startTime: decision.allocationWindow.start,
        endTime: decision.allocationWindow.end,
        sourceType: 'network_request',
        sourceId: decision.requestId,
        tx: tx as unknown as ExtendedTransactionClient,
      })
      reservationResults.push(reservationResult)
    }

    // 12. Persist the AllocationDecision (exact scheduler output).
    await tx.allocationDecision.create({
      data: {
        id: decision.decisionId,
        requestId: decision.requestId,
        networkId: decision.networkId,
        candidateMembershipsJson: JSON.stringify(decision.candidateMemberships),
        selectedMembershipId: decision.selectedMembershipId,
        allocatedCapacityJson: JSON.stringify(decision.allocatedCapacity),
        allocationWindowStart: decision.allocationWindow.start,
        allocationWindowEnd: decision.allocationWindow.end,
        priority: decision.priority ?? null,
        schedulerVersion: decision.schedulerVersion,
        evaluatorVersion: decision.evaluatorVersion,
        decisionSnapshotHash: decision.decisionSnapshotHash,
        decidedAt: decision.decidedAt,
        expiresAt: decision.expiresAt,
        status: 'active',
        // Persist the multi-reservation bindings (one per capability).
        reservations: {
          create: reservationResults.map((r) => ({
            capabilityType: r.capabilityType,
            unit: r.unit,
            allocatedAmount: r.allocatedAmount,
            reservationId: r.reservationId,
          })),
        },
      },
    })

    // 13. Mark the request as scheduled.
    await tx.networkRequest.update({
      where: { id: requestId },
      data: {
        status: 'scheduled',
        scheduledAt: new Date(),
      },
    })

    return {
      request: networkRequest,
      decision,
      reservations: reservationResults,
    }
  })

  return result
}

// ---------------------------------------------------------------------------
// DB ↔ domain mappers
// ---------------------------------------------------------------------------

function dbRequestToNetworkRequest(row: {
  id: string
  requesterMembershipId: string
  networkId: string
  capabilityRequirementsJson: string
  constraintsJson: string | null
  priority: number | null
  timeWindowStart: Date
  timeWindowEnd: Date
  idempotencyKey: string
  status: string
  createdAt: Date
}): NetworkRequest {
  return {
    requestId: row.id,
    requesterMembershipId: row.requesterMembershipId,
    networkId: row.networkId,
    capabilityRequirements: JSON.parse(row.capabilityRequirementsJson),
    timeWindow: { start: row.timeWindowStart, end: row.timeWindowEnd },
    constraints: row.constraintsJson ? JSON.parse(row.constraintsJson) : undefined,
    priority: row.priority ?? undefined,
    idempotencyKey: row.idempotencyKey,
    status: row.status as NetworkRequest['status'],
    submittedAt: row.createdAt,
  }
}

function dbDecisionToAllocationDecision(row: {
  id: string
  requestId: string
  networkId: string
  candidateMembershipsJson: string
  selectedMembershipId: string
  allocatedCapacityJson: string
  allocationWindowStart: Date
  allocationWindowEnd: Date
  priority: number | null
  schedulerVersion: string
  evaluatorVersion: string
  decisionSnapshotHash: string
  decidedAt: Date
  expiresAt: Date
}): AllocationDecision {
  return {
    decisionId: row.id,
    networkId: row.networkId,
    requestId: row.requestId,
    candidateMemberships: JSON.parse(row.candidateMembershipsJson),
    selectedMembershipId: row.selectedMembershipId,
    allocatedCapacity: JSON.parse(row.allocatedCapacityJson),
    allocationWindow: { start: row.allocationWindowStart, end: row.allocationWindowEnd },
    priority: row.priority ?? undefined,
    schedulerVersion: row.schedulerVersion,
    evaluatorVersion: row.evaluatorVersion,
    decisionSnapshotHash: row.decisionSnapshotHash,
    decidedAt: row.decidedAt,
    expiresAt: row.expiresAt,
  }
}
