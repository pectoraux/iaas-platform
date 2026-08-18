// =============================================================================
// Control Plane: Contracts (Phase 12B — slice 1)
// =============================================================================
// The generic control-plane contracts specified in
// docs/phase-12a-universal-network-control-plane-specification.md (FROZEN at
// ea83522). These sit ABOVE the frozen kernel (NetworkRuntime, ProtocolRuntime,
// HybridRuntime — Phase 11B accepted) and are vertical-neutral.
//
// ARCHITECTURAL RULES (from the frozen spec):
//   1. The control plane may introduce generic control-plane objects
//      (ResourceIdentity, ParticipantMembership, NetworkRequest,
//      AllocationDecision, ServiceCommitment). It may NOT introduce
//      vertical-specific kernel primitives.
//   2. The control plane does NOT bypass the kernel. Execution goes through
//      NetworkRuntime; protocol state through ProtocolRuntime/HybridRuntime.
//   3. Network Scope Integrity (§8.6): every network-scoped relationship
//      requires referenced_membership.networkId == relationship.networkId.
//   4. The scheduler is vertical-neutral: no energy/compute/storage/telecom/
//      construction/industrial/blockchain logic in the control plane.
//
// This file defines contracts (types + pure helpers) only. No side effects on
// import. No database access. No kernel imports.
// =============================================================================

import { createHash, randomUUID } from 'crypto'

// ---------------------------------------------------------------------------
// Participant model (§5 of the frozen spec)
// ---------------------------------------------------------------------------

/**
 * The global participant identity (one per real-world org/principal).
 * Has NO networkId — a participant joins networks via ParticipantMembership.
 */
export interface ParticipantIdentity {
  readonly participantId: string
  readonly organizationId: string
  readonly metadata: Record<string, unknown>
}

/**
 * A participant's membership in a specific network. Network-scoped.
 */
export interface ParticipantMembership {
  readonly membershipId: string
  readonly participantId: string
  readonly networkId: string
  membershipStatus: 'pending' | 'active' | 'suspended' | 'revoked'
  readonly joinedAt: Date
  readonly metadata: Record<string, unknown>
}

/**
 * A role held by a participant within a specific network membership.
 * Separate from the membership so roles can change independently.
 */
export interface ParticipantRole {
  readonly roleAssignmentId: string
  readonly membershipId: string
  role: 'provider' | 'consumer' | 'verifier' | 'validator' | 'orchestrator' | 'observer'
  roleStatus: 'active' | 'suspended'
  readonly assignedAt: Date
  revokedAt?: Date
}

// ---------------------------------------------------------------------------
// Resource model (§4 of the frozen spec)
// ---------------------------------------------------------------------------

/**
 * The resource kind discriminator. NOT separate kernel models — one model
 * with a discriminator. The control plane selects the adapter based on kind.
 */
export type ResourceKind =
  | 'physical'
  | 'compute'
  | 'storage'
  | 'connectivity'
  | 'industrial'
  | 'human'
  | 'protocol'

/**
 * The global resource identity (one per physical/logical resource).
 * Has NO networkId — a resource joins networks via NetworkResourceMembership.
 */
export interface ResourceIdentity {
  readonly resourceId: string
  readonly controllerId: string // the participant that controls/contributes it globally
  readonly resourceKind: ResourceKind
  lifecycleStatus: 'registering' | 'active' | 'suspended' | 'decommissioned'
  readonly location?: { lat?: number; lon?: number; label?: string }
  readonly metadata: Record<string, unknown>
}

/**
 * A resource's membership in a specific network. Per-network bindings.
 * Binds to ParticipantMembershipId (not global participant) — §6.2.1.
 */
export interface NetworkResourceMembership {
  readonly membershipId: string
  readonly resourceId: string
  readonly networkId: string
  readonly participantMembershipId: string // §6.2.1 — network-scoped authority
  capabilities: string[] // capability types offered in THIS network
  verifiedCapacity: CapacityEntry[] // verified per-network
  controlMode: string // adapter selection for THIS network
  verificationProfile: string
  availability?: { start: Date; end: Date }
  membershipStatus: 'registering' | 'active' | 'suspended' | 'withdrawn'
}

/**
 * A scalar capacity entry. The kernel primitive — multi-dimensional
 * commitments are composed via ServiceCommitment (§6.7), not by making
 * CapacityEntry multi-dimensional.
 */
export interface CapacityEntry {
  readonly capabilityType: string
  readonly amount: string // decimal as string
  readonly unit: string
}

// ---------------------------------------------------------------------------
// NetworkRequest (§6.6.1 — the actor-neutral scheduler input)
// ---------------------------------------------------------------------------

/**
 * A network-scoped request for capability execution. Actor-neutral (not
 * buyer-specific). Authorized by requesterMembershipId (network-scoped).
 */
export interface NetworkRequest {
  readonly requestId: string
  readonly requesterMembershipId: string // §6.2.1 — network-scoped authority
  readonly networkId: string
  readonly capabilityRequirements: CapabilityRequirement[]
  readonly timeWindow: { start: Date; end: Date }
  readonly constraints?: CommitmentConstraint[] // additional SLA/quality constraints
  readonly priority?: number
  readonly idempotencyKey: string
  status: 'pending' | 'scheduled' | 'fulfilled' | 'rejected' | 'expired'
  readonly submittedAt: Date
}

/**
 * A capability requirement in a NetworkRequest.
 */
export interface CapabilityRequirement {
  readonly capabilityType: string
  readonly amount: string
  readonly unit: string
}

// ---------------------------------------------------------------------------
// Commitment constraints (§6.7 — capacity vs service distinction)
// ---------------------------------------------------------------------------

/**
 * Common base for all commitment constraints.
 */
export interface CommitmentConstraint {
  readonly constraintId: string
  readonly kind: 'capacity' | 'service'
  readonly verificationMethod: string
  status: 'pending' | 'verified' | 'violated'
}

/**
 * A capacity constraint DEPLETES CapacityResource (bandwidth, GPU, TB, kW).
 */
export interface CapacityConstraint extends CommitmentConstraint {
  readonly kind: 'capacity'
  readonly capabilityType: string
  readonly operator: '>=' | '<=' | '=='
  readonly threshold: string
  readonly unit: string
  readonly capacitySourceId: string
}

/**
 * A service constraint is SLA-level and does NOT deplete capacity
 * (latency, availability, quality, jitter).
 */
export interface ServiceConstraint extends CommitmentConstraint {
  readonly kind: 'service'
  readonly serviceType: string
  readonly operator: '>=' | '<=' | '=='
  readonly threshold: string
  readonly unit: string
  readonly slaPolicyRef: string
}

// ---------------------------------------------------------------------------
// AllocationDecision (§6.6.2 — the scheduler's output)
// ---------------------------------------------------------------------------

/**
 * The output of the scheduler. Deterministic given the same inputs.
 */
export interface AllocationDecision {
  readonly decisionId: string
  readonly networkId: string
  readonly requestId: string // FK to NetworkRequest
  readonly candidateMemberships: string[] // NetworkResourceMembership IDs considered
  readonly selectedMembershipId: string // the chosen resource's membership
  readonly allocatedCapacity: CapacityEntry[]
  readonly allocationWindow: { start: Date; end: Date }
  readonly priority?: number
  readonly fairnessScore?: number
  readonly schedulerVersion: string
  readonly decisionSnapshotHash: string // §8.7 — SHA-256 of the canonical snapshot
  readonly decidedAt: Date
  readonly expiresAt: Date
}

// ---------------------------------------------------------------------------
// Network Scope Integrity (§8.6 — the cross-network invariant)
// ---------------------------------------------------------------------------

/**
 * Network Scope Integrity invariant (§8.6):
 * For every network-scoped relationship, the referenced membership's networkId
 * MUST equal the relationship's networkId.
 *
 * This function is the pure check; the structural enforcement (composite FKs)
 * is a Phase 12B schema concern. This check is the service-layer safety net.
 */
export function verifyNetworkScopeIntegrity(
  relationship: { networkId: string },
  referencedMembership: { networkId: string },
): boolean {
  return relationship.networkId === referencedMembership.networkId
}

/**
 * Assert Network Scope Integrity. Throws if the invariant is violated.
 * Used by the scheduler and control-plane API to enforce the invariant at
 * the service layer (in addition to the structural DB enforcement).
 */
export function assertNetworkScopeIntegrity(
  relationship: { networkId: string },
  referencedMembership: { networkId: string },
  context: string,
): void {
  if (!verifyNetworkScopeIntegrity(relationship, referencedMembership)) {
    throw new NetworkScopeIntegrityError(
      relationship.networkId,
      referencedMembership.networkId,
      context,
    )
  }
}

/**
 * Error thrown when Network Scope Integrity is violated.
 */
export class NetworkScopeIntegrityError extends Error {
  constructor(
    public readonly relationshipNetworkId: string,
    public readonly membershipNetworkId: string,
    public readonly context: string,
  ) {
    super(
      `Network Scope Integrity violation in ${context}: ` +
        `relationship.networkId='${relationshipNetworkId}' but ` +
        `referenced membership.networkId='${membershipNetworkId}'. ` +
        `Cross-network authority leakage is forbidden (§8.6).`,
    )
    this.name = 'NetworkScopeIntegrityError'
  }
}

// ---------------------------------------------------------------------------
// Request isolation (§6.6 — request authorization)
// ---------------------------------------------------------------------------

/**
 * Request isolation invariant (§6.6): a requester cannot cause an allocation
 * decision outside the permissions/constraints of its network membership.
 *
 * The scheduler MUST verify:
 *   1. The requester's membership is in the same network as the request.
 *   2. The requester's membership is active.
 *   3. The requester has an active 'consumer' role (or orchestrator).
 *
 * Returns null if authorized, or an error message explaining why not.
 */
export function authorizeRequest(
  request: NetworkRequest,
  requesterMembership: ParticipantMembership,
  requesterRoles: ParticipantRole[],
): string | null {
  // 1. Network scope integrity
  if (request.networkId !== requesterMembership.networkId) {
    return `Request networkId '${request.networkId}' does not match requester membership networkId '${requesterMembership.networkId}' (§8.6)`
  }

  // 2. Membership must be active
  if (requesterMembership.membershipStatus !== 'active') {
    return `Requester membership is '${requesterMembership.membershipStatus}', not 'active'`
  }

  // 3. Must have an active consumer or orchestrator role
  const authorizingRole = requesterRoles.find(
    (r) =>
      r.membershipId === requesterMembership.membershipId &&
      r.role === 'consumer' &&
      r.roleStatus === 'active' &&
      !r.revokedAt,
  )
  const orchestratorRole = requesterRoles.find(
    (r) =>
      r.membershipId === requesterMembership.membershipId &&
      r.role === 'orchestrator' &&
      r.roleStatus === 'active' &&
      !r.revokedAt,
  )

  if (!authorizingRole && !orchestratorRole) {
    return `Requester has no active 'consumer' or 'orchestrator' role in this network`
  }

  return null // authorized
}

// ---------------------------------------------------------------------------
// Decision snapshot hash (§8.7 — reproducibility)
// ---------------------------------------------------------------------------

/**
 * Compute the decision snapshot hash for reproducibility (§8.7).
 *
 * The hash is SHA-256 of the FULL AUTHORITATIVE snapshot:
 *   (NetworkVersion, NetworkRequest, ALL candidate ResourceMemberships,
 *    ALL candidate capacity states, Availability state)
 *
 * PHASE 12B CORRECTION (defect from audit): the original implementation
 * passed only the SELECTED resource's capacity state. That was insufficient
 * — if a non-selected candidate's capacity changed, the candidate set could
 * change, but the hash would remain the same. The hash MUST cover the
 * complete authoritative snapshot used for the decision, including all
 * candidates and all their capacity states.
 *
 * Given the same snapshot + schedulerVersion, the scheduler MUST produce the
 * same decision. The hash makes the decision's inputs auditable.
 *
 * PURE: same inputs → same hash.
 *
 * @param snapshot.networkVersionId — the NetworkVersion that defines the policy.
 * @param snapshot.request — the NetworkRequest being scheduled.
 * @param snapshot.candidateMemberships — ALL candidate resource memberships
 *   considered by the scheduler (the full set, not just the selected one).
 * @param snapshot.capacityStateByMembership — the remaining capacity for
 *   EVERY candidate membership, keyed by membershipId. This is the full
 *   capacity snapshot, not just the selected resource's capacity.
 */
export function computeDecisionSnapshotHash(snapshot: {
  networkVersionId: string
  request: NetworkRequest
  candidateMemberships: NetworkResourceMembership[]
  capacityStateByMembership: Map<string, CapacityEntry[]>
}): string {
  const canonical = canonicalize({
    networkVersionId: snapshot.networkVersionId,
    requestId: snapshot.request.requestId,
    requesterMembershipId: snapshot.request.requesterMembershipId,
    networkId: snapshot.request.networkId,
    capabilityRequirements: snapshot.request.capabilityRequirements,
    timeWindow: {
      start: snapshot.request.timeWindow.start.toISOString(),
      end: snapshot.request.timeWindow.end.toISOString(),
    },
    // ALL candidate memberships, sorted deterministically.
    candidateMemberships: snapshot.candidateMemberships
      .map((m) => ({
        membershipId: m.membershipId,
        resourceId: m.resourceId,
        capabilities: [...m.capabilities].sort(),
        verifiedCapacity: m.verifiedCapacity.map((c) => ({ ...c })).sort((a, b) =>
          a.capabilityType.localeCompare(b.capabilityType),
        ),
        membershipStatus: m.membershipStatus,
        // The remaining capacity for THIS membership — the full snapshot.
        remainingCapacity: (snapshot.capacityStateByMembership.get(m.membershipId) ?? [])
          .map((c) => ({ ...c }))
          .sort((a, b) => a.capabilityType.localeCompare(b.capabilityType)),
        availability: m.availability
          ? {
              start: m.availability.start.toISOString(),
              end: m.availability.end.toISOString(),
            }
          : null,
      }))
      .sort((a, b) => a.membershipId.localeCompare(b.membershipId)),
  })
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

// ---------------------------------------------------------------------------
// Canonical serialization (for deterministic hashing)
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  const sortedKeys = Object.keys(value as Record<string, unknown>).sort()
  const result: Record<string, unknown> = {}
  for (const key of sortedKeys) {
    result[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return result
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function createNetworkRequest(input: {
  requesterMembershipId: string
  networkId: string
  capabilityRequirements: CapabilityRequirement[]
  timeWindow: { start: Date; end: Date }
  constraints?: CommitmentConstraint[]
  priority?: number
  idempotencyKey: string
}): NetworkRequest {
  return {
    requestId: randomUUID(),
    requesterMembershipId: input.requesterMembershipId,
    networkId: input.networkId,
    capabilityRequirements: input.capabilityRequirements,
    timeWindow: input.timeWindow,
    constraints: input.constraints,
    priority: input.priority,
    idempotencyKey: input.idempotencyKey,
    status: 'pending',
    submittedAt: new Date(),
  }
}
