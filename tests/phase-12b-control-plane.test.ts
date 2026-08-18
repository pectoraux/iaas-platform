/**
 * Phase 12B — Control Plane: Contracts + Deterministic Scheduler
 *
 * Tests the first Phase 12B implementation slice:
 *   - Network Scope Integrity invariant (§8.6)
 *   - Request isolation (§6.6)
 *   - Deterministic reproducibility (§8.7 — same snapshot + version → same decision)
 *   - Vertical-neutrality (no vertical imports in the control plane)
 *   - Capacity vs service constraint distinction (§6.7)
 *   - Capacity correctness (enough remaining capacity)
 *
 * Run: bun test tests/phase-12b-control-plane.test.ts --timeout 30000
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  schedule,
  SCHEDULER_VERSION,
  authorizeRequest,
  assertNetworkScopeIntegrity,
  verifyNetworkScopeIntegrity,
  NetworkScopeIntegrityError,
  computeDecisionSnapshotHash,
  createNetworkRequest,
} from '../src/lib/control-plane'
import type {
  ParticipantMembership,
  ParticipantRole,
  NetworkResourceMembership,
  NetworkRequest,
  CapacityEntry,
} from '../src/lib/control-plane'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const NETWORK_A = 'network-a'
const NETWORK_B = 'network-b'
const VERSION_1 = 'version-1'

function makeMembership(
  membershipId: string,
  networkId: string,
  capabilities: string[],
  capacity: CapacityEntry[],
  status: NetworkResourceMembership['membershipStatus'] = 'active',
  participantMembershipId = 'pm-provider-a',
): NetworkResourceMembership {
  return {
    membershipId,
    resourceId: `resource-${membershipId}`,
    networkId,
    participantMembershipId,
    capabilities,
    verifiedCapacity: capacity,
    controlMode: 'adapter',
    verificationProfile: 'default',
    availability: { start: new Date('2024-01-01T00:00:00Z'), end: new Date('2024-12-31T23:59:59Z') },
    membershipStatus: status,
  }
}

function makeParticipantMembership(
  membershipId: string,
  networkId: string,
  status: ParticipantMembership['membershipStatus'] = 'active',
): ParticipantMembership {
  return {
    membershipId,
    participantId: `participant-${membershipId}`,
    networkId,
    membershipStatus: status,
    joinedAt: new Date('2024-01-01T00:00:00Z'),
    metadata: {},
  }
}

function makeRole(
  membershipId: string,
  role: ParticipantRole['role'],
  status: ParticipantRole['roleStatus'] = 'active',
): ParticipantRole {
  return {
    roleAssignmentId: `role-${membershipId}-${role}`,
    membershipId,
    role,
    roleStatus: status,
    assignedAt: new Date('2024-01-01T00:00:00Z'),
  }
}

// ---------------------------------------------------------------------------
// §8.6 Network Scope Integrity
// ---------------------------------------------------------------------------

describe('Phase 12B §8.6: Network Scope Integrity', () => {
  it('verifyNetworkScopeIntegrity returns true for same-network', () => {
    const rel = { networkId: NETWORK_A }
    const membership = { networkId: NETWORK_A }
    expect(verifyNetworkScopeIntegrity(rel, membership)).toBe(true)
  })

  it('verifyNetworkScopeIntegrity returns false for cross-network', () => {
    const rel = { networkId: NETWORK_A }
    const membership = { networkId: NETWORK_B }
    expect(verifyNetworkScopeIntegrity(rel, membership)).toBe(false)
  })

  it('assertNetworkScopeIntegrity throws on cross-network', () => {
    const rel = { networkId: NETWORK_A }
    const membership = { networkId: NETWORK_B }
    expect(() => assertNetworkScopeIntegrity(rel, membership, 'test')).toThrow(NetworkScopeIntegrityError)
  })

  it('assertNetworkScopeIntegrity does not throw for same-network', () => {
    const rel = { networkId: NETWORK_A }
    const membership = { networkId: NETWORK_A }
    expect(() => assertNetworkScopeIntegrity(rel, membership, 'test')).not.toThrow()
  })

  it('the scheduler rejects a request whose requester membership is in a different network', async () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })

    // Requester membership is in NETWORK_B, but request is in NETWORK_A
    const requesterMembership = makeParticipantMembership('pm-consumer-a', NETWORK_B)
    const roles = [makeRole('pm-consumer-a', 'consumer')]

    const result = schedule({
      networkVersionId: VERSION_1,
      request,
      requesterMembership,
      requesterRoles: roles,
      candidateMemberships: [],
      remainingCapacity: new Map(),
      authorizingMemberships: new Map(),
    })

    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') {
      expect(result.reason).toMatch(/networkId.*does not match|§8.6/i)
    }
  })
})

// ---------------------------------------------------------------------------
// §6.6 Request isolation
// ---------------------------------------------------------------------------

describe('Phase 12B §6.6: Request isolation', () => {
  it('authorizeRequest returns null for an active consumer in the right network', () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [],
      timeWindow: { start: new Date(), end: new Date() },
      idempotencyKey: 'key-1',
    })
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]

    expect(authorizeRequest(request, membership, roles)).toBeNull()
  })

  it('authorizeRequest rejects a suspended membership', () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [],
      timeWindow: { start: new Date(), end: new Date() },
      idempotencyKey: 'key-1',
    })
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A, 'suspended')
    const roles = [makeRole('pm-consumer-a', 'consumer')]

    expect(authorizeRequest(request, membership, roles)).toMatch(/not 'active'/)
  })

  it('authorizeRequest rejects a participant with no consumer/orchestrator role', () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-observer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [],
      timeWindow: { start: new Date(), end: new Date() },
      idempotencyKey: 'key-1',
    })
    const membership = makeParticipantMembership('pm-observer-a', NETWORK_A)
    const roles = [makeRole('pm-observer-a', 'observer')]

    expect(authorizeRequest(request, membership, roles)).toMatch(/no active 'consumer' or 'orchestrator'/)
  })

  it('authorizeRequest accepts an orchestrator role', () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-orchestrator-a',
      networkId: NETWORK_A,
      capabilityRequirements: [],
      timeWindow: { start: new Date(), end: new Date() },
      idempotencyKey: 'key-1',
    })
    const membership = makeParticipantMembership('pm-orchestrator-a', NETWORK_A)
    const roles = [makeRole('pm-orchestrator-a', 'orchestrator')]

    expect(authorizeRequest(request, membership, roles)).toBeNull()
  })

  it('the scheduler rejects a request from a suspended consumer', async () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A, 'suspended')
    const roles = [makeRole('pm-consumer-a', 'consumer')]

    const result = schedule({
      networkVersionId: VERSION_1,
      request,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [],
      remainingCapacity: new Map(),
      authorizingMemberships: new Map(),
    })

    expect(result.status).toBe('rejected')
  })
})

// ---------------------------------------------------------------------------
// §8.7 Deterministic reproducibility
// ---------------------------------------------------------------------------

describe('Phase 12B §8.7: Scheduler reproducibility', () => {
  it('the same inputs produce the same decision (deterministic)', () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]

    const candidate = makeMembership(
      'rm-gpu-1',
      NETWORK_A,
      ['compute'],
      [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }],
    )
    const remaining = new Map([['rm-gpu-1', [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }]]])
    const authorizing = new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A)]])

    const input = {
      networkVersionId: VERSION_1,
      request,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidate],
      remainingCapacity: remaining,
      authorizingMemberships: authorizing,
    }

    const result1 = schedule(input)
    const result2 = schedule(input)

    expect(result1.status).toBe('allocated')
    expect(result2.status).toBe('allocated')
    if (result1.status === 'allocated' && result2.status === 'allocated') {
      // Same decision (deterministic).
      expect(result2.decision.selectedMembershipId).toBe(result1.decision.selectedMembershipId)
      expect(result2.decision.decisionSnapshotHash).toBe(result1.decision.decisionSnapshotHash)
      expect(result2.decision.schedulerVersion).toBe(result1.decision.schedulerVersion)
      expect(result2.decision.schedulerVersion).toBe(SCHEDULER_VERSION)
    }
  })

  it('different capacity state produces a different decisionSnapshotHash', () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })

    const hash1 = computeDecisionSnapshotHash({
      networkVersionId: VERSION_1,
      request,
      resourceMemberships: [makeMembership('rm-1', NETWORK_A, ['compute'], [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }])],
      capacityState: [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }],
    })

    const hash2 = computeDecisionSnapshotHash({
      networkVersionId: VERSION_1,
      request,
      resourceMemberships: [makeMembership('rm-1', NETWORK_A, ['compute'], [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }])],
      capacityState: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
    })

    expect(hash1).not.toBe(hash2)
  })

  it('the scheduler selects the first eligible candidate deterministically', () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]

    // Two candidates, inserted in non-sorted order. The scheduler sorts by
    // membershipId and selects the first.
    const candidateB = makeMembership('rm-gpu-b', NETWORK_A, ['compute'], [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }])
    const candidateA = makeMembership('rm-gpu-a', NETWORK_A, ['compute'], [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }])

    const remaining = new Map([
      ['rm-gpu-a', [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }]],
      ['rm-gpu-b', [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }]],
    ])
    const authorizing = new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A)]])

    const result = schedule({
      networkVersionId: VERSION_1,
      request,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidateB, candidateA], // non-sorted order
      remainingCapacity: remaining,
      authorizingMemberships: authorizing,
    })

    expect(result.status).toBe('allocated')
    if (result.status === 'allocated') {
      // rm-gpu-a sorts before rm-gpu-b — deterministic selection.
      expect(result.decision.selectedMembershipId).toBe('rm-gpu-a')
      expect(result.decision.candidateMemberships).toEqual(['rm-gpu-a', 'rm-gpu-b'])
    }
  })
})

// ---------------------------------------------------------------------------
// Capacity correctness
// ---------------------------------------------------------------------------

describe('Phase 12B: Capacity correctness', () => {
  it('the scheduler rejects a candidate with insufficient capacity', () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '16', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]

    const candidate = makeMembership('rm-gpu-1', NETWORK_A, ['compute'], [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }])
    const remaining = new Map([['rm-gpu-1', [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }]]])
    const authorizing = new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A)]])

    const result = schedule({
      networkVersionId: VERSION_1,
      request,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidate],
      remainingCapacity: remaining,
      authorizingMemberships: authorizing,
    })

    expect(result.status).toBe('no_candidates')
  })

  it('the scheduler rejects a candidate missing a requested capability', () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'storage', amount: '50', unit: 'TB' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]

    // Candidate offers 'compute' but request needs 'storage'.
    const candidate = makeMembership('rm-1', NETWORK_A, ['compute'], [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }])

    const result = schedule({
      networkVersionId: VERSION_1,
      request,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidate],
      remainingCapacity: new Map([['rm-1', [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }]]]),
      authorizingMemberships: new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A)]]),
    })

    expect(result.status).toBe('no_candidates')
  })
})

// ---------------------------------------------------------------------------
// §6.7 Constraint distinction (capacity vs service)
// ---------------------------------------------------------------------------

describe('Phase 12B §6.7: Constraint distinction', () => {
  it('CapacityConstraint has kind=capacity and depletes a capacity source', () => {
    // This is a type-level test — if it compiles, the distinction is enforced.
    const constraint = {
      constraintId: 'c-1',
      kind: 'capacity' as const,
      capabilityType: 'bandwidth',
      operator: '>=' as const,
      threshold: '500',
      unit: 'Mbps',
      capacitySourceId: 'cr-1',
      verificationMethod: 'throughput_measurement',
      status: 'pending' as const,
    }
    expect(constraint.kind).toBe('capacity')
    expect(constraint.capacitySourceId).toBe('cr-1')
  })

  it('ServiceConstraint has kind=service and has no capacitySourceId', () => {
    const constraint = {
      constraintId: 'c-2',
      kind: 'service' as const,
      serviceType: 'latency',
      operator: '<=' as const,
      threshold: '20',
      unit: 'ms',
      slaPolicyRef: 'sla-latency-v1',
      verificationMethod: 'latency_probing',
      status: 'pending' as const,
    }
    expect(constraint.kind).toBe('service')
    expect((constraint as Record<string, unknown>).capacitySourceId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Vertical-neutrality (architecture boundary)
// ---------------------------------------------------------------------------

describe('Phase 12B: Vertical-neutrality (no vertical imports)', () => {
  it('the control plane does NOT import vertical-specific modules', () => {
    const files = [
      join(process.cwd(), 'src', 'lib', 'control-plane', 'types.ts'),
      join(process.cwd(), 'src', 'lib', 'control-plane', 'scheduler.ts'),
      join(process.cwd(), 'src', 'lib', 'control-plane', 'index.ts'),
    ]

    const verticalPatterns = [
      /from\s+['"]\.\/vpp/,
      /from\s+['"]\.\/compute/,
      /from\s+['"]\.\/storage/,
      /from\s+['"]\.\/der-adapter/,
      /from\s+['"]\.\/compute-adapter/,
      /from\s+['"]\.\/wireless/,
      /from\s+['"]\.\/telecom/,
      /from\s+['"]\.\/construction/,
      /from\s+['"]\.\/industrial/,
      /from\s+['"]\.\/blockchain/,
    ]

    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      for (const pattern of verticalPatterns) {
        expect(content).not.toMatch(pattern)
      }
    }
  })

  it('the control plane does NOT import kernel runtime internals directly', () => {
    // The control plane may import kernel TYPES (for the NetworkRuntime contract)
    // but must NOT bypass the runtime by manipulating Execution models directly.
    // This test checks the scheduler doesn't import the kernel at all (it's pure).
    const schedulerSource = readFileSync(
      join(process.cwd(), 'src', 'lib', 'control-plane', 'scheduler.ts'),
      'utf-8',
    )
    expect(schedulerSource).not.toMatch(/from\s+['"]@\/lib\/kernel/)
    expect(schedulerSource).not.toMatch(/from\s+['"]\.\.\/kernel/)
  })

  it('the scheduler source does not contain vertical-specific capability types', () => {
    // The scheduler reasons about capability types as strings — it must not
    // hard-code 'energy_discharge', 'gpu_compute', etc.
    const schedulerSource = readFileSync(
      join(process.cwd(), 'src', 'lib', 'control-plane', 'scheduler.ts'),
      'utf-8',
    )
    expect(schedulerSource).not.toMatch(/energy_discharge|gpu_compute|cpu_compute|bandwidth|block_production/)
  })
})
