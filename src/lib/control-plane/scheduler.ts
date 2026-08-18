// =============================================================================
// Control Plane: Deterministic Scheduler (Phase 12B — slice 1)
// =============================================================================
// The scheduler is the heart of the control plane. It turns a NetworkRequest
// into an AllocationDecision — making the network a coordinator, not just a
// registry.
//
// INVARIANTS (from the frozen Phase 12A spec):
//   1. Vertical-neutral: no energy/compute/storage/telecom/construction/
//      industrial/blockchain logic. The scheduler reasons about capabilities,
//      capacity, and availability — NOT about what the resource physically is.
//   2. Request isolation (§6.6): the requester's membership must be active and
//      authorized (consumer or orchestrator role) in the same network.
//   3. Network Scope Integrity (§8.6): the request, requester membership,
//      and all candidate resource memberships must be in the same network.
//   4. Determinism + reproducibility (§8.7): given the same
//      (NetworkVersion, NetworkRequest, resource/capacity snapshot,
//      schedulerVersion), the decision is identical. The decisionSnapshotHash
//      captures the inputs.
//   5. Capacity correctness: the selected resource must have enough verified
//      capacity for all requested capabilities. Concurrent requests cannot
//      oversubscribe (enforced at the capacity layer, like Phase 11B OCC).
//
// This scheduler is PURE: it does not mutate state, does not touch the DB,
// and does not import the kernel. It produces an AllocationDecision that the
// caller (control-plane API) uses to create reservations/commitments via the
// kernel's NetworkRuntime.
// =============================================================================

import { createHash } from 'crypto'
import type {
  NetworkRequest,
  ParticipantMembership,
  ParticipantRole,
  NetworkResourceMembership,
  AllocationDecision,
  CapacityEntry,
  CapabilityRequirement,
  ConstraintEvaluator,
  ConstraintObservationSnapshot,
  CapacitySourceSnapshot,
  CapacityConstraint,
  ServiceConstraint,
} from './types'
import {
  authorizeRequest,
  assertNetworkScopeIntegrity,
  computeDecisionSnapshotHash,
  DefaultConstraintEvaluator,
  compareCanonicalStrings,
} from './types'

/**
 * The scheduler version. Bumped when the scheduling algorithm changes.
 * Recorded on every AllocationDecision for reproducibility (§8.7).
 */
export const SCHEDULER_VERSION = 'deterministic-v1'

/**
 * The input to the scheduler. Contains everything the scheduler needs to
 * make a deterministic decision.
 */
export interface SchedulerInput {
  readonly networkVersionId: string
  readonly request: NetworkRequest
  readonly requesterMembership: ParticipantMembership
  readonly requesterRoles: ParticipantRole[]
  readonly candidateMemberships: NetworkResourceMembership[]
  /**
   * The remaining capacity for each candidate membership. Keyed by
   * membershipId. This is the capacity AFTER prior reservations/commitments
   * — the scheduler does not oversubscribe.
   */
  readonly remainingCapacity: Map<string, CapacityEntry[]>
  /**
   * The membership that authorizes each candidate resource (for Network
   * Scope Integrity verification). Keyed by participantMembershipId.
   */
  readonly authorizingMemberships: Map<string, ParticipantMembership>
  /**
   * The constraint evaluator for ServiceConstraints (latency, availability,
   * quality). Optional — defaults to DefaultConstraintEvaluator.
   *
   * PHASE 12B FIX (defect 2): the scheduler must evaluate ServiceConstraints,
   * not just scalar capacity. The evaluator is a generic policy predicate
   * with no vertical semantics. Vertical-specific measurement happens later
   * in the evidence/verification pipeline.
   */
  readonly constraintEvaluator?: ConstraintEvaluator
  /**
   * Constraint observation snapshots for each candidate membership, keyed
   * by membershipId. These provide the declared/policy-backed values
   * (latency: 14ms, availability: 99.95%, etc.) that the evaluator uses
   * to determine whether a candidate satisfies the request's constraints.
   *
   * PHASE 12B FIX (defect from audit): the original evaluator only checked
   * whether the candidate's verificationProfile contained the service type
   * string — it ignored the threshold. Now the evaluator receives actual
   * observed values and evaluates operator + threshold correctly.
   */
  readonly observationSnapshots?: Map<string, ConstraintObservationSnapshot>
  /**
   * Authoritative capacity source snapshots for each candidate membership,
   * keyed by membershipId. Each membership may have multiple capacity sources
   * (e.g., GPU pool A, GPU pool B). Used for CapacityConstraint evaluation.
   *
   * PHASE 12B FIX (defect from audit): CapacityConstraint evaluation now uses
   * the authoritative capacity state (with source identity), NOT the observation
   * snapshot. This ensures a single truth channel for capacity — the same
   * state the scheduler uses for CapabilityRequirement checking.
   */
  readonly capacitySources?: Map<string, CapacitySourceSnapshot[]>
}

/**
 * The result of a scheduling attempt.
 */
export type SchedulerResult =
  | { status: 'allocated'; decision: AllocationDecision }
  | { status: 'rejected'; reason: string }
  | { status: 'no_candidates'; reason: string }

/**
 * The deterministic, vertical-neutral scheduler.
 *
 * Algorithm:
 *   1. Authorize the request (request isolation — §6.6).
 *   2. Verify Network Scope Integrity for all candidate memberships (§8.6).
 *   3. Filter candidates: active, offer the requested capabilities, have
 *      enough remaining capacity, available within the time window.
 *   4. Sort candidates deterministically (by membershipId — stable, no
 *      non-determinism).
 *   5. Select the first eligible candidate.
 *   6. Compute the decisionSnapshotHash (§8.7).
 *   7. Return the AllocationDecision.
 *
 * PURE: same inputs → same output. No side effects.
 */
export function schedule(input: SchedulerInput): SchedulerResult {
  const { request, requesterMembership, requesterRoles, candidateMemberships } = input
  const evaluator = input.constraintEvaluator ?? new DefaultConstraintEvaluator()

  // 1. Request isolation (§6.6): authorize the requester.
  const authError = authorizeRequest(request, requesterMembership, requesterRoles)
  if (authError) {
    return { status: 'rejected', reason: `Request not authorized: ${authError}` }
  }

  // 2. Network Scope Integrity (§8.6): verify the requester membership is in
  //    the same network as the request.
  assertNetworkScopeIntegrity(request, requesterMembership, 'NetworkRequest.requesterMembership')

  // 3. Filter candidates.
  const eligible: NetworkResourceMembership[] = []
  for (const membership of candidateMemberships) {
    // 3a. Network scope integrity: membership must be in the same network.
    if (membership.networkId !== request.networkId) {
      continue // skip cross-network candidates (would violate §8.6)
    }

    // 3b. The authorizing participant membership must be in the same network.
    const authorizing = input.authorizingMemberships.get(membership.participantMembershipId)
    if (!authorizing) {
      continue // no authorizing membership found — skip
    }
    if (authorizing.networkId !== request.networkId) {
      continue // §8.6 violation — skip
    }

    // 3c. PHASE 12B FIX (defect 3): the authorizing membership MUST be active.
    // The original only checked networkId; it did not check membershipStatus.
    // A suspended authorizing membership means the resource's authority is
    // suspended — the candidate is ineligible.
    if (authorizing.membershipStatus !== 'active') {
      continue
    }

    // 3d. The resource membership must be active.
    if (membership.membershipStatus !== 'active') {
      continue
    }

    // 3e. The membership must offer ALL requested capability types.
    if (!request.capabilityRequirements.every((req) => membership.capabilities.includes(req.capabilityType))) {
      continue
    }

    // 3f. The membership must have enough remaining capacity for each request.
    const remaining = input.remainingCapacity.get(membership.membershipId) ?? []
    if (!hasEnoughCapacity(request.capabilityRequirements, remaining)) {
      continue
    }

    // 3g. PHASE 12B FIX: evaluate constraints using SEPARATE authority channels.
    //   - CapacityConstraints → authoritative capacity state (with source identity)
    //   - ServiceConstraints → observation snapshots (SLA values)
    // This prevents two competing truth channels for capacity.
    if (request.constraints) {
      const observations = input.observationSnapshots?.get(membership.membershipId)
      const sources = input.capacitySources?.get(membership.membershipId) ?? []

      const allConstraintsSatisfied = request.constraints.every((constraint) => {
        if (constraint.kind === 'capacity') {
          // CapacityConstraint: use the authoritative capacity state with
          // source identity enforcement. NOT the observation snapshot.
          return evaluator.evaluateCapacity(
            constraint as CapacityConstraint,
            sources,
          )
        } else {
          // ServiceConstraint: use the observation snapshot (SLA values).
          if (!observations) return false
          return evaluator.evaluateService(
            constraint as ServiceConstraint,
            observations,
          )
        }
      })
      if (!allConstraintsSatisfied) {
        continue
      }
    }

    // 3h. The membership must be available within the requested time window.
    if (membership.availability) {
      if (request.timeWindow.start < membership.availability.start ||
          request.timeWindow.end > membership.availability.end) {
        continue
      }
    }

    eligible.push(membership)
  }

  if (eligible.length === 0) {
    return {
      status: 'no_candidates',
      reason: 'No eligible resource memberships satisfy the request (capability, capacity, availability, or network scope)',
    }
  }

  // 4. Sort deterministically (by membershipId — stable, no non-determinism).
  eligible.sort((a, b) => compareCanonicalStrings(a.membershipId, b.membershipId))

  // 5. Select the first eligible candidate.
  const selected = eligible[0]

  // 6. Compute the allocated capacity (the requested amounts).
  const allocatedCapacity: CapacityEntry[] = request.capabilityRequirements.map((req) => ({
    capabilityType: req.capabilityType,
    amount: req.amount,
    unit: req.unit,
  }))

  // 7. Compute the decisionSnapshotHash (§8.7) from the FULL AUTHORITATIVE
  //    snapshot — ALL candidate memberships + ALL their capacity states.
  //    PHASE 12B CORRECTION: the original passed only the selected resource's
  //    capacity. That was insufficient — a non-selected candidate's capacity
  //    change could alter the candidate set without changing the hash. Now
  //    the hash covers every candidate and every capacity state.
  const decisionSnapshotHash = computeDecisionSnapshotHash({
    networkVersionId: input.networkVersionId,
    request,
    requesterMembership,
    requesterRoles,
    candidateMemberships: candidateMemberships,
    capacityStateByMembership: input.remainingCapacity,
    authorizingMemberships: input.authorizingMemberships,
    observationSnapshots: input.observationSnapshots,
    capacitySources: input.capacitySources,
    schedulerVersion: SCHEDULER_VERSION,
    evaluatorVersion: evaluator.evaluatorVersion,
  })

  // 8. Compute the deterministic decisionId (§8.7 — reproducibility).
  //    PHASE 12B CORRECTION: the original used a timestamp, making the
  //    decision non-deterministic. The decisionId is now a SHA-256 of the
  //    decision's semantic content — same inputs → same decisionId.
  const decisionId = computeDecisionId({
    networkId: request.networkId,
    requestId: request.requestId,
    selectedMembershipId: selected.membershipId,
    allocatedCapacity,
    allocationWindow: request.timeWindow,
    priority: request.priority,
    schedulerVersion: SCHEDULER_VERSION,
    evaluatorVersion: evaluator.evaluatorVersion,
    decisionSnapshotHash,
  })

  // 9. decidedAt/expiresAt are execution-time fields, NOT part of the
  //    reproducibility identity. Two decisions with the same semantic content
  //    have the same decisionId but may have different decidedAt (they were
  //    computed at different wall-clock times). The reproducibility invariant
  //    is about the decision IDENTITY, not the execution timestamp.
  const decidedAt = new Date()
  const expiresAt = new Date(decidedAt.getTime() + 5 * 60 * 1000) // 5-minute decision TTL

  const decision: AllocationDecision = {
    decisionId,
    networkId: request.networkId,
    requestId: request.requestId,
    candidateMemberships: eligible.map((m) => m.membershipId),
    selectedMembershipId: selected.membershipId,
    allocatedCapacity,
    allocationWindow: request.timeWindow,
    priority: request.priority,
    fairnessScore: 1.0 / (eligible.indexOf(selected) + 1), // simple fairness: 1/n
    schedulerVersion: SCHEDULER_VERSION,
    evaluatorVersion: evaluator.evaluatorVersion,
    decisionSnapshotHash,
    decidedAt,
    expiresAt,
  }

  return { status: 'allocated', decision }
}

/**
 * Compute a deterministic decisionId (§8.7 — reproducibility).
 *
 * The decisionId is SHA-256 of the decision's semantic content:
 *   (networkId, requestId, selectedMembershipId, allocatedCapacity,
 *    allocationWindow, priority, schedulerVersion, decisionSnapshotHash)
 *
 * PHASE 12B FIX (defect 1): priority is now included. Two decisions that
 * differ only in priority must have different decisionIds.
 *
 * This ensures two decisions with the same inputs produce the same decisionId.
 * The decidedAt/expiresAt are execution-time fields, not part of the identity.
 *
 * PURE: same inputs → same decisionId.
 */
function computeDecisionId(input: {
  networkId: string
  requestId: string
  selectedMembershipId: string
  allocatedCapacity: CapacityEntry[]
  allocationWindow: { start: Date; end: Date }
  priority?: number
  schedulerVersion: string
  evaluatorVersion: string
  decisionSnapshotHash: string
}): string {
  const canonical = JSON.stringify({
    networkId: input.networkId,
    requestId: input.requestId,
    selectedMembershipId: input.selectedMembershipId,
    allocatedCapacity: input.allocatedCapacity
      .map((c) => ({ ...c }))
      .sort((a, b) => compareCanonicalStrings(a.capabilityType, b.capabilityType)),
    allocationWindow: {
      start: input.allocationWindow.start.toISOString(),
      end: input.allocationWindow.end.toISOString(),
    },
    priority: input.priority ?? null,
    schedulerVersion: input.schedulerVersion,
    evaluatorVersion: input.evaluatorVersion,
    decisionSnapshotHash: input.decisionSnapshotHash,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

// ---------------------------------------------------------------------------
// Capacity helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Check if the remaining capacity satisfies all requested capabilities.
 * PURE: same inputs → same result.
 */
function hasEnoughCapacity(
  requirements: CapabilityRequirement[],
  remaining: CapacityEntry[],
): boolean {
  for (const req of requirements) {
    const available = remaining.find(
      (c) => c.capabilityType === req.capabilityType && c.unit === req.unit,
    )
    if (!available) {
      return false
    }
    // Decimal comparison as strings (both are decimal-as-string per the schema).
    // This is a simple lexical comparison for non-negative decimals of the same
    // scale; the real implementation would use a proper decimal comparison.
    if (compareDecimals(available.amount, req.amount) < 0) {
      return false
    }
  }
  return true
}

/**
 * Compare two decimal-as-string values. Returns negative if a < b, 0 if equal,
 * positive if a > b. Handles different scales (e.g., "1.5" vs "1.50").
 */
function compareDecimals(a: string, b: string): number {
  const aParts = a.split('.')
  const bParts = b.split('.')
  const aInt = parseInt(aParts[0], 10)
  const bInt = parseInt(bParts[0], 10)
  if (aInt !== bInt) {
    return aInt - bInt
  }
  const aFrac = aParts[1] ?? ''
  const bFrac = bParts[1] ?? ''
  const maxLen = Math.max(aFrac.length, bFrac.length)
  const aFracPadded = aFrac.padEnd(maxLen, '0')
  const bFracPadded = bFrac.padEnd(maxLen, '0')
  if (aFracPadded === bFracPadded) return 0
  return aFracPadded < bFracPadded ? -1 : 1
}
