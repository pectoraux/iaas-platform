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
  readonly evaluatorVersion: string // PHASE 12B FIX (defect 3): for reproducibility
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
 *   (NetworkVersion, NetworkRequest [including priority + constraints],
 *    ALL candidate ResourceMemberships, ALL candidate capacity states,
 *    ALL authorizing membership states, Availability state)
 *
 * PHASE 12B CORRECTION 1: the original passed only the SELECTED resource's
 * capacity. Fixed to cover all candidates.
 *
 * PHASE 12B CORRECTION 2 (this fix): the original omitted request.priority
 * and request.constraints from the hash. Two requests differing only in
 * priority or constraints would produce the same hash — violating the
 * semantic-identity rule. Now included.
 *
 * PHASE 12B CORRECTION 3 (this fix): the original omitted the authorizing
 * ParticipantMembership state. If an authorizing membership's status changed
 * (e.g., active → suspended), candidate eligibility could change without the
 * hash changing. Now the authorizing membership states are included.
 *
 * PURE: same inputs → same hash.
 */
export function computeDecisionSnapshotHash(snapshot: {
  networkVersionId: string
  request: NetworkRequest
  candidateMemberships: NetworkResourceMembership[]
  capacityStateByMembership: Map<string, CapacityEntry[]>
  authorizingMemberships: Map<string, ParticipantMembership>
}): string {
  const canonical = canonicalize({
    networkVersionId: snapshot.networkVersionId,
    requestId: snapshot.request.requestId,
    requesterMembershipId: snapshot.request.requesterMembershipId,
    networkId: snapshot.request.networkId,
    capabilityRequirements: snapshot.request.capabilityRequirements,
    priority: snapshot.request.priority ?? null,
    // PHASE 12B FIX (defect 1): include priority + FULL constraint semantics.
    // The original omitted serviceType, operator, threshold, unit, slaPolicyRef.
    // Two constraints differing only in threshold (latency <= 20 vs <= 200) would
    // produce the same hash. Now ALL constraint fields are included.
    constraints: (snapshot.request.constraints ?? []).map((c) => {
      const base = {
        constraintId: c.constraintId,
        kind: c.kind,
        verificationMethod: c.verificationMethod,
        status: c.status,
      }
      if (c.kind === 'service') {
        const sc = c as ServiceConstraint
        return {
          ...base,
          serviceType: sc.serviceType,
          operator: sc.operator,
          threshold: sc.threshold,
          unit: sc.unit,
          slaPolicyRef: sc.slaPolicyRef,
        }
      }
      // CapacityConstraint — include its fields too.
      const cc = c as CapacityConstraint
      return {
        ...base,
        capabilityType: cc.capabilityType,
        operator: cc.operator,
        threshold: cc.threshold,
        unit: cc.unit,
        capacitySourceId: cc.capacitySourceId,
      }
    }).sort((a, b) => a.constraintId.localeCompare(b.constraintId)),
    timeWindow: {
      start: snapshot.request.timeWindow.start.toISOString(),
      end: snapshot.request.timeWindow.end.toISOString(),
    },
    // ALL candidate memberships, sorted deterministically.
    candidateMemberships: snapshot.candidateMemberships
      .map((m) => {
        // Look up the authorizing membership for this candidate.
        const authorizing = snapshot.authorizingMemberships.get(m.participantMembershipId)
        return {
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
          // PHASE 12B FIX (defect 3): include the authorizing membership's
          // state. If the authorizing membership is suspended, the candidate
          // is ineligible — and the hash must reflect that state.
          authorizingMembershipStatus: authorizing?.membershipStatus ?? 'missing',
        }
      })
      .sort((a, b) => a.membershipId.localeCompare(b.membershipId)),
  })
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

// ---------------------------------------------------------------------------
// Constraint observation + evaluation (§6.7 — semantically real constraints)
// ---------------------------------------------------------------------------

/**
 * A constraint observation snapshot — the declared/policy-backed values
 * for a resource membership's service-level attributes (latency, availability,
 * quality, jitter, etc.).
 *
 * PHASE 12B FIX (defect from audit): the original DefaultConstraintEvaluator
 * only checked whether the candidate's verificationProfile CONTAINED the
 * service type string — it ignored the operator/threshold/unit/slaPolicyRef.
 * That was type-checking, not constraint evaluation. A request for
 * `latency <= 20ms` and `latency <= 200ms` were treated identically.
 *
 * This snapshot provides the actual declared values so the evaluator can
 * evaluate operator + threshold correctly:
 *   `latency <= 20ms` requires an observed latency value ≤ 20.
 *
 * The observations come from the resource's declared profile (not from
 * real-time measurement — that happens in the evidence/verification pipeline).
 * For scheduling, the declared/policy-backed values are sufficient to filter
 * candidates.
 */
export interface ConstraintObservationSnapshot {
  /** The resource membership this snapshot is for. */
  readonly membershipId: string
  /**
   * Observed values keyed by serviceType (latency, availability, quality, etc.).
   * Each value has a numeric/string value + unit.
   */
  readonly observations: Map<string, { value: string; unit: string }>
}

/**
 * A constraint evaluator determines whether a candidate resource membership
 * satisfies a request's constraints, given the candidate's observation snapshot.
 *
 * This is a GENERIC contract — it does NOT contain vertical-specific semantics.
 * The evaluator receives the constraint (with operator + threshold + unit) and
 * the candidate's observed value for that service type, and evaluates whether
 * the threshold is met.
 *
 * PHASE 12B FIX: the evaluator now receives ConstraintObservationSnapshot
 * (actual values), not just the membership. It evaluates operator + threshold
 * against the observed value. And it has a version (evaluatorVersion) for
 * reproducibility.
 */
export interface ConstraintEvaluator {
  /** The evaluator version — recorded in the AllocationDecision for reproducibility. */
  readonly evaluatorVersion: string

  /**
   * Evaluate whether a candidate satisfies a constraint, given its
   * observation snapshot.
   *
   * @param constraint The constraint to evaluate (with operator, threshold, unit).
   * @param snapshot The candidate's observed values (latency: 14ms, availability: 99.95%, etc.).
   * @returns true if the observed value satisfies the constraint.
   */
  evaluate(constraint: CommitmentConstraint, snapshot: ConstraintObservationSnapshot): boolean
}

/**
 * The default constraint evaluator — evaluates operator + threshold against
 * the candidate's observed values.
 *
 * For CapacityConstraints: returns true (capacity is handled by the scalar
 * capacity check in the scheduler).
 *
 * For ServiceConstraints: looks up the observed value for the constraint's
 * serviceType in the snapshot, and evaluates whether it satisfies the
 * operator + threshold:
 *   `latency <= 20ms` → observed.latency.value <= 20
 *   `availability >= 99.9%` → observed.availability.value >= 99.9
 *   `quality == grade-A` → observed.quality.value == "grade-A"
 *
 * If the candidate has no observation for the serviceType, the constraint
 * is NOT satisfied (the candidate cannot prove it meets the SLA).
 */
export class DefaultConstraintEvaluator implements ConstraintEvaluator {
  readonly evaluatorVersion = 'default-evaluator-v1'

  evaluate(constraint: CommitmentConstraint, snapshot: ConstraintObservationSnapshot): boolean {
    if (constraint.kind === 'capacity') {
      // Capacity constraints are handled by the scalar capacity check in
      // the scheduler. The evaluator does not re-check them.
      return true
    }

    const serviceConstraint = constraint as ServiceConstraint

    // Look up the observed value for this service type.
    const observed = snapshot.observations.get(serviceConstraint.serviceType)
    if (!observed) {
      // No observation for this service type → the candidate cannot prove it
      // satisfies the constraint. Filter it out.
      return false
    }

    // Evaluate the operator + threshold against the observed value.
    return evaluateConstraint(
      serviceConstraint.operator,
      serviceConstraint.threshold,
      observed.value,
      serviceConstraint.unit,
      observed.unit,
    )
  }
}

/**
 * Evaluate a constraint operator against an observed value.
 *
 * Handles both numeric (latency, availability) and string (quality grade)
 * thresholds.
 *
 * PURE: same inputs → same result.
 */
function evaluateConstraint(
  operator: '>=' | '<=' | '==',
  threshold: string,
  observedValue: string,
  thresholdUnit: string,
  observedUnit: string,
): boolean {
  // Units must match (or be comparable). For now, require exact match.
  // A real implementation would handle unit conversion (ms vs s, etc.).
  if (thresholdUnit !== observedUnit) {
    return false
  }

  // Try numeric comparison first.
  const thresholdNum = parseFloat(threshold)
  const observedNum = parseFloat(observedValue)

  if (!isNaN(thresholdNum) && !isNaN(observedNum)) {
    // Numeric comparison.
    switch (operator) {
      case '>=': return observedNum >= thresholdNum
      case '<=': return observedNum <= thresholdNum
      case '==': return observedNum === thresholdNum
    }
  }

  // Fall back to string comparison (e.g., quality == "grade-A").
  if (operator === '==') {
    return observedValue === threshold
  }

  // For >= and <= on strings, use lexical comparison.
  if (operator === '>=') return observedValue >= threshold
  if (operator === '<=') return observedValue <= threshold
  return false // unreachable for valid operators
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
