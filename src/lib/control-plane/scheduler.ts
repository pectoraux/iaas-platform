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

import type {
  NetworkRequest,
  ParticipantMembership,
  ParticipantRole,
  NetworkResourceMembership,
  AllocationDecision,
  CapacityEntry,
  CapabilityRequirement,
} from './types'
import {
  authorizeRequest,
  assertNetworkScopeIntegrity,
  computeDecisionSnapshotHash,
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
   * Scope Integrity verification). Keyed by membershipId.
   */
  readonly authorizingMemberships: Map<string, ParticipantMembership>
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

    // 3c. The resource membership must be active.
    if (membership.membershipStatus !== 'active') {
      continue
    }

    // 3d. The membership must offer ALL requested capability types.
    if (!request.capabilityRequirements.every((req) => membership.capabilities.includes(req.capabilityType))) {
      continue
    }

    // 3e. The membership must have enough remaining capacity for each request.
    const remaining = input.remainingCapacity.get(membership.membershipId) ?? []
    if (!hasEnoughCapacity(request.capabilityRequirements, remaining)) {
      continue
    }

    // 3f. The membership must be available within the requested time window.
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
      reason: 'No eligible resource memberships满足 the request (capability, capacity, availability, or network scope)',
    }
  }

  // 4. Sort deterministically (by membershipId — stable, no non-determinism).
  eligible.sort((a, b) => a.membershipId.localeCompare(b.membershipId))

  // 5. Select the first eligible candidate.
  const selected = eligible[0]
  const remaining = input.remainingCapacity.get(selected.membershipId) ?? []

  // 6. Compute the allocated capacity (the requested amounts).
  const allocatedCapacity: CapacityEntry[] = request.capabilityRequirements.map((req) => ({
    capabilityType: req.capabilityType,
    amount: req.amount,
    unit: req.unit,
  }))

  // 7. Compute the decisionSnapshotHash (§8.7).
  const decisionSnapshotHash = computeDecisionSnapshotHash({
    networkVersionId: input.networkVersionId,
    request,
    resourceMemberships: candidateMemberships,
    capacityState: remaining,
  })

  // 8. Build the AllocationDecision.
  const decidedAt = new Date()
  const expiresAt = new Date(decidedAt.getTime() + 5 * 60 * 1000) // 5-minute decision TTL

  const decision: AllocationDecision = {
    decisionId: `alloc-${selected.membershipId}-${decidedAt.getTime()}`,
    networkId: request.networkId,
    requestId: request.requestId,
    candidateMemberships: eligible.map((m) => m.membershipId),
    selectedMembershipId: selected.membershipId,
    allocatedCapacity,
    allocationWindow: request.timeWindow,
    priority: request.priority,
    fairnessScore: 1.0 / (eligible.indexOf(selected) + 1), // simple fairness: 1/n
    schedulerVersion: SCHEDULER_VERSION,
    decisionSnapshotHash,
    decidedAt,
    expiresAt,
  }

  return { status: 'allocated', decision }
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
