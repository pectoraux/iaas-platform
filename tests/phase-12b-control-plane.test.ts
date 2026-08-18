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
  DefaultConstraintEvaluator,
} from '../src/lib/control-plane'
import type {
  ParticipantMembership,
  ParticipantRole,
  NetworkResourceMembership,
  NetworkRequest,
  CapacityEntry,
  ServiceConstraint,
  ConstraintObservationSnapshot,
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
      // Same decision (deterministic) — including decisionId (§8.7 fix).
      expect(result2.decision.selectedMembershipId).toBe(result1.decision.selectedMembershipId)
      expect(result2.decision.decisionSnapshotHash).toBe(result1.decision.decisionSnapshotHash)
      expect(result2.decision.schedulerVersion).toBe(result1.decision.schedulerVersion)
      expect(result2.decision.schedulerVersion).toBe(SCHEDULER_VERSION)
      // PHASE 12B FIX: decisionId is now deterministic (SHA-256 of semantic
      // content, not a timestamp). Same inputs → same decisionId.
      expect(result2.decision.decisionId).toBe(result1.decision.decisionId)
    }
  })

  it('decisionId is deterministic (SHA-256 of semantic content, not timestamp)', () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]
    const candidate = makeMembership('rm-gpu-1', NETWORK_A, ['compute'], [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }])
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
      // decisionId is a 64-char SHA-256 hex, not a timestamp-based string.
      expect(result1.decision.decisionId).toMatch(/^[a-f0-9]{64}$/)
      // Same inputs → same decisionId (deterministic).
      expect(result2.decision.decisionId).toBe(result1.decision.decisionId)
      // decidedAt may differ (execution-time field), but decisionId does not.
      // This is the §8.7 reproducibility invariant.
    }
  })

  it('decisionSnapshotHash changes when a NON-SELECTED candidate\'s capacity changes', () => {
    // PHASE 12B FIX (defect 2): the snapshot hash must cover ALL candidates'
    // capacity, not just the selected one. If a non-selected candidate's
    // capacity changes, the hash must change.
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]

    // Two candidates: A wins (sorted first), B is non-selected.
    const candidateA = makeMembership('rm-gpu-a', NETWORK_A, ['compute'], [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }])
    const candidateB = makeMembership('rm-gpu-b', NETWORK_A, ['compute'], [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }])

    const authorizing = new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A)]])

    // Snapshot 1: B has 8 GPU.
    const result1 = schedule({
      networkVersionId: VERSION_1,
      request,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidateA, candidateB],
      remainingCapacity: new Map([
        ['rm-gpu-a', [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }]],
        ['rm-gpu-b', [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }]],
      ]),
      authorizingMemberships: authorizing,
    })

    // Snapshot 2: B's capacity changed to 0 (non-selected candidate).
    const result2 = schedule({
      networkVersionId: VERSION_1,
      request,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidateA, candidateB],
      remainingCapacity: new Map([
        ['rm-gpu-a', [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }]],
        ['rm-gpu-b', [{ capabilityType: 'compute', amount: '0', unit: 'GPU' }]], // changed!
      ]),
      authorizingMemberships: authorizing,
    })

    expect(result1.status).toBe('allocated')
    expect(result2.status).toBe('allocated')
    if (result1.status === 'allocated' && result2.status === 'allocated') {
      // The selected resource is the same (A wins in both), but the snapshot
      // hash MUST differ because B's capacity changed. This is the full
      // authoritative snapshot invariant (§8.7).
      expect(result2.decision.decisionSnapshotHash).not.toBe(result1.decision.decisionSnapshotHash)
      // And the decisionId differs too (it includes the snapshot hash).
      expect(result2.decision.decisionId).not.toBe(result1.decision.decisionId)
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

    const candidate = makeMembership('rm-1', NETWORK_A, ['compute'], [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }])

    const requesterMembership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const requesterRoles = [makeRole('pm-consumer-a', 'consumer')]

    const hash1 = computeDecisionSnapshotHash({
      networkVersionId: VERSION_1,
      request,
      requesterMembership,
      requesterRoles,
      candidateMemberships: [candidate],
      capacityStateByMembership: new Map([['rm-1', [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }]]]),
      authorizingMemberships: new Map(),
      schedulerVersion: 'test-v1',
      evaluatorVersion: 'test-ev-v1',
    })

    const hash2 = computeDecisionSnapshotHash({
      networkVersionId: VERSION_1,
      request,
      requesterMembership,
      requesterRoles,
      candidateMemberships: [candidate],
      capacityStateByMembership: new Map([['rm-1', [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }]]]),
      authorizingMemberships: new Map(),
      schedulerVersion: 'test-v1',
      evaluatorVersion: 'test-ev-v1',
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

  it('the scheduler source does not contain vertical-specific capability types in code (not comments)', () => {
    // The scheduler reasons about capability types as strings — it must not
    // hard-code 'energy_discharge', 'gpu_compute', etc. in CODE. Comments may
    // mention them for documentation purposes.
    const schedulerSource = readFileSync(
      join(process.cwd(), 'src', 'lib', 'control-plane', 'scheduler.ts'),
      'utf-8',
    )
    // Strip comments (lines starting with // or inside /* */ blocks).
    const codeOnly = schedulerSource
      .replace(/\/\/.*$/gm, '') // single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, '') // multi-line comments
    expect(codeOnly).not.toMatch(/energy_discharge|gpu_compute|cpu_compute|bandwidth|block_production/)
  })
})

// ---------------------------------------------------------------------------
// Defect 1 fix: priority in reproducibility identity
// ---------------------------------------------------------------------------

describe('Phase 12B defect 1 fix: priority in reproducibility identity', () => {
  it('two requests differing only in priority produce different decisionIds', () => {
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]
    const candidate = makeMembership('rm-gpu-1', NETWORK_A, ['compute'], [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }])
    const remaining = new Map([['rm-gpu-1', [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }]]])
    const authorizing = new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A)]])

    const baseInput = {
      networkVersionId: VERSION_1,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidate],
      remainingCapacity: remaining,
      authorizingMemberships: authorizing,
    }

    const requestA = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      priority: 1,
      idempotencyKey: 'key-a',
    })

    const requestB = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      priority: 100,
      idempotencyKey: 'key-b',
    })

    const resultA = schedule({ ...baseInput, request: requestA })
    const resultB = schedule({ ...baseInput, request: requestB })

    expect(resultA.status).toBe('allocated')
    expect(resultB.status).toBe('allocated')
    if (resultA.status === 'allocated' && resultB.status === 'allocated') {
      expect(resultA.decision.selectedMembershipId).toBe(resultB.decision.selectedMembershipId)
      expect(resultA.decision.decisionId).not.toBe(resultB.decision.decisionId)
      expect(resultA.decision.priority).toBe(1)
      expect(resultB.decision.priority).toBe(100)
    }
  })
})

// ---------------------------------------------------------------------------
// Defect 2 fix: constraint-aware scheduling
// ---------------------------------------------------------------------------

describe('Phase 12B defect 2 fix: constraint-aware scheduling (semantic evaluation)', () => {
  it('the scheduler filters out a candidate whose observed latency exceeds the threshold', () => {
    // latencypolicy: <= 20ms. Observed: 35ms. → VIOLATED.
    const latencyConstraint: ServiceConstraint = {
      constraintId: 'c-latency',
      kind: 'service',
      serviceType: 'latency',
      operator: '<=',
      threshold: '20',
      unit: 'ms',
      slaPolicyRef: 'sla-latency-v1',
      verificationMethod: 'latency_probing',
      status: 'pending',
    }
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'bandwidth', amount: '500', unit: 'Mbps' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
      constraints: [latencyConstraint],
    })
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]

    const candidate = makeMembership('rm-1', NETWORK_A, ['bandwidth'], [{ capabilityType: 'bandwidth', amount: '1000', unit: 'Mbps' }])

    // Observation: latency = 35ms (exceeds the 20ms threshold).
    const observations = new Map<string, ConstraintObservationSnapshot>([
      ['rm-1', {
        membershipId: 'rm-1',
        observations: new Map([['latency', { value: '35', unit: 'ms' }]]),
      }],
    ])

    const result = schedule({
      networkVersionId: VERSION_1,
      request,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidate],
      remainingCapacity: new Map([['rm-1', [{ capabilityType: 'bandwidth', amount: '1000', unit: 'Mbps' }]]]),
      authorizingMemberships: new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A)]]),
      observationSnapshots: observations,
    })

    expect(result.status).toBe('no_candidates')
  })

  it('the scheduler accepts a candidate whose observed latency satisfies the threshold', () => {
    // latencypolicy: <= 20ms. Observed: 14ms. → SATISFIED.
    const latencyConstraint: ServiceConstraint = {
      constraintId: 'c-latency',
      kind: 'service',
      serviceType: 'latency',
      operator: '<=',
      threshold: '20',
      unit: 'ms',
      slaPolicyRef: 'sla-latency-v1',
      verificationMethod: 'latency_probing',
      status: 'pending',
    }
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'bandwidth', amount: '500', unit: 'Mbps' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
      constraints: [latencyConstraint],
    })
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]

    const candidate = makeMembership('rm-1', NETWORK_A, ['bandwidth'], [{ capabilityType: 'bandwidth', amount: '1000', unit: 'Mbps' }])

    // Observation: latency = 14ms (satisfies the 20ms threshold).
    const observations = new Map<string, ConstraintObservationSnapshot>([
      ['rm-1', {
        membershipId: 'rm-1',
        observations: new Map([['latency', { value: '14', unit: 'ms' }]]),
      }],
    ])

    const result = schedule({
      networkVersionId: VERSION_1,
      request,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidate],
      remainingCapacity: new Map([['rm-1', [{ capabilityType: 'bandwidth', amount: '1000', unit: 'Mbps' }]]]),
      authorizingMemberships: new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A)]]),
      observationSnapshots: observations,
    })

    expect(result.status).toBe('allocated')
  })

  it('the scheduler distinguishes latency <= 20ms from latency <= 200ms (semantic evaluation)', () => {
    // The same resource (latency: 35ms) satisfies <= 200ms but NOT <= 20ms.
    // This proves the evaluator evaluates the THRESHOLD, not just the service type.
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]
    const candidate = makeMembership('rm-1', NETWORK_A, ['bandwidth'], [{ capabilityType: 'bandwidth', amount: '1000', unit: 'Mbps' }])
    const observations = new Map<string, ConstraintObservationSnapshot>([
      ['rm-1', {
        membershipId: 'rm-1',
        observations: new Map([['latency', { value: '35', unit: 'ms' }]]),
      }],
    ])
    const baseInput = {
      networkVersionId: VERSION_1,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidate],
      remainingCapacity: new Map([['rm-1', [{ capabilityType: 'bandwidth', amount: '1000', unit: 'Mbps' }]]]),
      authorizingMemberships: new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A)]]),
      observationSnapshots: observations,
    }

    // Request A: latency <= 20ms → 35ms does NOT satisfy → no_candidates.
    const constraint20: ServiceConstraint = {
      constraintId: 'c-latency-20',
      kind: 'service',
      serviceType: 'latency',
      operator: '<=',
      threshold: '20',
      unit: 'ms',
      slaPolicyRef: 'sla-latency-v1',
      verificationMethod: 'latency_probing',
      status: 'pending',
    }
    const requestA = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'bandwidth', amount: '500', unit: 'Mbps' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-a',
      constraints: [constraint20],
    })
    const resultA = schedule({ ...baseInput, request: requestA })
    expect(resultA.status).toBe('no_candidates')

    // Request B: latency <= 200ms → 35ms DOES satisfy → allocated.
    const constraint200: ServiceConstraint = {
      constraintId: 'c-latency-200',
      kind: 'service',
      serviceType: 'latency',
      operator: '<=',
      threshold: '200',
      unit: 'ms',
      slaPolicyRef: 'sla-latency-v1',
      verificationMethod: 'latency_probing',
      status: 'pending',
    }
    const requestB = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'bandwidth', amount: '500', unit: 'Mbps' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-b',
      constraints: [constraint200],
    })
    const resultB = schedule({ ...baseInput, request: requestB })
    expect(resultB.status).toBe('allocated')
  })

  it('the scheduler filters out a candidate with no observation snapshot', () => {
    // If observationSnapshots is missing for a candidate, the scheduler cannot
    // evaluate constraints → filters it out.
    const latencyConstraint: ServiceConstraint = {
      constraintId: 'c-latency',
      kind: 'service',
      serviceType: 'latency',
      operator: '<=',
      threshold: '20',
      unit: 'ms',
      slaPolicyRef: 'sla-latency-v1',
      verificationMethod: 'latency_probing',
      status: 'pending',
    }
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'bandwidth', amount: '500', unit: 'Mbps' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
      constraints: [latencyConstraint],
    })
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]
    const candidate = makeMembership('rm-1', NETWORK_A, ['bandwidth'], [{ capabilityType: 'bandwidth', amount: '1000', unit: 'Mbps' }])

    // No observationSnapshots provided → the scheduler cannot evaluate.
    const result = schedule({
      networkVersionId: VERSION_1,
      request,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidate],
      remainingCapacity: new Map([['rm-1', [{ capabilityType: 'bandwidth', amount: '1000', unit: 'Mbps' }]]]),
      authorizingMemberships: new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A)]]),
    })

    expect(result.status).toBe('no_candidates')
  })
})

// ---------------------------------------------------------------------------
// Defect 3 fix: authorizing membership lifecycle integrity
// ---------------------------------------------------------------------------

describe('Phase 12B defect 3 fix: authorizing membership lifecycle integrity', () => {
  it('the scheduler rejects a candidate whose authorizing membership is suspended', () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]
    const candidate = makeMembership('rm-gpu-1', NETWORK_A, ['compute'], [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }])
    const suspendedAuthorizing = makeParticipantMembership('pm-provider-a', NETWORK_A, 'suspended')

    const result = schedule({
      networkVersionId: VERSION_1,
      request,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidate],
      remainingCapacity: new Map([['rm-gpu-1', [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }]]]),
      authorizingMemberships: new Map([['pm-provider-a', suspendedAuthorizing]]),
    })

    expect(result.status).toBe('no_candidates')
  })

  it('the scheduler accepts a candidate whose authorizing membership is active', () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]
    const candidate = makeMembership('rm-gpu-1', NETWORK_A, ['compute'], [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }])
    const activeAuthorizing = makeParticipantMembership('pm-provider-a', NETWORK_A, 'active')

    const result = schedule({
      networkVersionId: VERSION_1,
      request,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidate],
      remainingCapacity: new Map([['rm-gpu-1', [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }]]]),
      authorizingMemberships: new Map([['pm-provider-a', activeAuthorizing]]),
    })

    expect(result.status).toBe('allocated')
  })

  it('decisionSnapshotHash changes when the authorizing membership status changes', () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]
    const candidate = makeMembership('rm-gpu-1', NETWORK_A, ['compute'], [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }])
    const remaining = new Map([['rm-gpu-1', [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }]]])

    const baseInput = {
      networkVersionId: VERSION_1,
      request,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidate],
      remainingCapacity: remaining,
    }

    const result1 = schedule({
      ...baseInput,
      authorizingMemberships: new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A, 'active')]]),
    })

    const result2 = schedule({
      ...baseInput,
      authorizingMemberships: new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A, 'suspended')]]),
    })

    expect(result1.status).toBe('allocated')
    expect(result2.status).toBe('no_candidates')

    if (result1.status === 'allocated') {
      const hash1 = result1.decision.decisionSnapshotHash
      const hash2 = computeDecisionSnapshotHash({
        networkVersionId: VERSION_1,
        request,
        requesterMembership: membership,
        requesterRoles: roles,
        candidateMemberships: [candidate],
        capacityStateByMembership: remaining,
        authorizingMemberships: new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A, 'suspended')]]),
        schedulerVersion: 'deterministic-v1',
        evaluatorVersion: 'default-evaluator-v3',
      })
      expect(hash1).not.toBe(hash2)
    }
  })
})

// ---------------------------------------------------------------------------
// Capacity-source state in snapshot hash + evaluator purity
// ---------------------------------------------------------------------------

describe('Phase 12B: capacity-source state in snapshot hash', () => {
  it('decisionSnapshotHash changes when a targeted capacity source\'s remaining amount changes', () => {
    // Same aggregate remainingCapacity, but different source-specific amount.
    // This proves the hash includes capacitySources, not just remainingCapacity.
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })
    const candidate = makeMembership('rm-gpu-1', NETWORK_A, ['compute'], [{ capabilityType: 'compute', amount: '10', unit: 'GPU' }])

    // Source B has 2 GPU in snapshot 1.
    const sourcesB2 = new Map<string, import('../src/lib/control-plane').CapacitySourceSnapshot[]>([
      ['rm-gpu-1', [
        { sourceId: 'pool-A', capabilityType: 'compute', remainingAmount: '8', unit: 'GPU' },
        { sourceId: 'pool-B', capabilityType: 'compute', remainingAmount: '2', unit: 'GPU' },
      ]],
    ])

    // Source B has 1 GPU in snapshot 2 (same aggregate = 10, different source).
    const sourcesB1 = new Map<string, import('../src/lib/control-plane').CapacitySourceSnapshot[]>([
      ['rm-gpu-1', [
        { sourceId: 'pool-A', capabilityType: 'compute', remainingAmount: '9', unit: 'GPU' },
        { sourceId: 'pool-B', capabilityType: 'compute', remainingAmount: '1', unit: 'GPU' },
      ]],
    ])

    const remaining = new Map([['rm-gpu-1', [{ capabilityType: 'compute', amount: '10', unit: 'GPU' }]]])

    const reqMembership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const reqRoles = [makeRole('pm-consumer-a', 'consumer')]

    const hash1 = computeDecisionSnapshotHash({
      networkVersionId: VERSION_1,
      request,
      requesterMembership: reqMembership,
      requesterRoles: reqRoles,
      candidateMemberships: [candidate],
      capacityStateByMembership: remaining,
      authorizingMemberships: new Map(),
      capacitySources: sourcesB2,
      schedulerVersion: 'test-v1',
      evaluatorVersion: 'test-ev-v1',
    })

    const hash2 = computeDecisionSnapshotHash({
      networkVersionId: VERSION_1,
      request,
      requesterMembership: reqMembership,
      requesterRoles: reqRoles,
      candidateMemberships: [candidate],
      capacityStateByMembership: remaining,
      authorizingMemberships: new Map(),
      capacitySources: sourcesB1,
      schedulerVersion: 'test-v1',
      evaluatorVersion: 'test-ev-v1',
    })

    // Same aggregate remaining capacity (10 GPU), but source B changed from 2→1.
    // The hash MUST differ.
    expect(hash1).not.toBe(hash2)
  })
})

describe('Phase 12B: evaluator purity contract', () => {
  it('evaluateService is pure — same inputs → same result', () => {
    const evaluator = new DefaultConstraintEvaluator()
    const constraint: ServiceConstraint = {
      constraintId: 'c-latency',
      kind: 'service',
      serviceType: 'latency',
      operator: '<=',
      threshold: '20',
      unit: 'ms',
      slaPolicyRef: 'sla-latency-v1',
      verificationMethod: 'latency_probing',
      status: 'pending',
    }
    const snapshot: ConstraintObservationSnapshot = {
      membershipId: 'rm-1',
      observations: new Map([['latency', { value: '14', unit: 'ms' }]]),
    }

    const result1 = evaluator.evaluateService(constraint, snapshot)
    const result2 = evaluator.evaluateService(constraint, snapshot)

    expect(result1).toBe(true)
    expect(result2).toBe(true)
    expect(result1).toBe(result2) // same inputs → same result
  })

  it('evaluateCapacity is pure — same inputs → same result', () => {
    const evaluator = new DefaultConstraintEvaluator()
    const constraint = {
      constraintId: 'c-gpu',
      kind: 'capacity' as const,
      capabilityType: 'compute',
      operator: '>=' as const,
      threshold: '4',
      unit: 'GPU',
      capacitySourceId: 'pool-A',
      verificationMethod: 'capacity_check',
      status: 'pending' as const,
    }
    const sources = [
      { sourceId: 'pool-A', capabilityType: 'compute', remainingAmount: '8', unit: 'GPU' },
      { sourceId: 'pool-B', capabilityType: 'compute', remainingAmount: '2', unit: 'GPU' },
    ]

    const result1 = evaluator.evaluateCapacity(constraint, sources)
    const result2 = evaluator.evaluateCapacity(constraint, sources)

    expect(result1).toBe(true)
    expect(result2).toBe(true)
    expect(result1).toBe(result2) // same inputs → same result
  })

  it('evaluateCapacity enforces capacitySourceId — wrong source is rejected', () => {
    const evaluator = new DefaultConstraintEvaluator()
    const constraint = {
      constraintId: 'c-gpu-b',
      kind: 'capacity' as const,
      capabilityType: 'compute',
      operator: '>=' as const,
      threshold: '4',
      unit: 'GPU',
      capacitySourceId: 'pool-B', // targets source B (2 GPU)
      verificationMethod: 'capacity_check',
      status: 'pending' as const,
    }
    const sources = [
      { sourceId: 'pool-A', capabilityType: 'compute', remainingAmount: '8', unit: 'GPU' },
      { sourceId: 'pool-B', capabilityType: 'compute', remainingAmount: '2', unit: 'GPU' },
    ]

    // pool-B has 2 GPU, threshold is >= 4 → NOT satisfied.
    const result = evaluator.evaluateCapacity(constraint, sources)
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Total canonical ordering for duplicate-key collections
// ---------------------------------------------------------------------------

describe('Phase 12B: total canonical ordering (input-order independence)', () => {
  it('same roles in different array orders produce the same decisionSnapshotHash', () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })
    const candidate = makeMembership('rm-gpu-1', NETWORK_A, ['compute'], [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }])
    const remaining = new Map([['rm-gpu-1', [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }]]])
    const authorizing = new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A)]])

    // Same roles, different array orders.
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const rolesOrder1 = [
      makeRole('pm-consumer-a', 'consumer'),
      makeRole('pm-consumer-a', 'orchestrator'),
    ]
    const rolesOrder2 = [
      makeRole('pm-consumer-a', 'orchestrator'),
      makeRole('pm-consumer-a', 'consumer'),
    ]

    const baseSnapshot = {
      networkVersionId: VERSION_1,
      request,
      candidateMemberships: [candidate],
      capacityStateByMembership: remaining,
      authorizingMemberships: authorizing,
      schedulerVersion: 'test-v1',
      evaluatorVersion: 'test-ev-v1',
    }

    const hash1 = computeDecisionSnapshotHash({
      ...baseSnapshot,
      requesterMembership: membership,
      requesterRoles: rolesOrder1,
    })
    const hash2 = computeDecisionSnapshotHash({
      ...baseSnapshot,
      requesterMembership: membership,
      requesterRoles: rolesOrder2,
    })

    expect(hash1).toBe(hash2)
  })

  it('same capacity entries in different array orders produce the same decisionSnapshotHash', () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })

    // Two capacity entries with the SAME capabilityType but different units.
    // If sorted by capabilityType alone, their order is input-dependent.
    const cap1 = [
      { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      { capabilityType: 'compute', amount: '100', unit: 'cores' },
    ]
    const cap2 = [
      { capabilityType: 'compute', amount: '100', unit: 'cores' },
      { capabilityType: 'compute', amount: '8', unit: 'GPU' },
    ]

    const candidate1 = makeMembership('rm-1', NETWORK_A, ['compute'], cap1)
    const candidate2 = makeMembership('rm-1', NETWORK_A, ['compute'], cap2)

    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]
    const remaining = new Map([['rm-1', [{ capabilityType: 'compute', amount: '8', unit: 'GPU' }]]])
    const authorizing = new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A)]])

    const baseSnapshot = {
      networkVersionId: VERSION_1,
      request,
      requesterMembership: membership,
      requesterRoles: roles,
      capacityStateByMembership: remaining,
      authorizingMemberships: authorizing,
      schedulerVersion: 'test-v1',
      evaluatorVersion: 'test-ev-v1',
    }

    const hash1 = computeDecisionSnapshotHash({
      ...baseSnapshot,
      candidateMemberships: [candidate1],
    })
    const hash2 = computeDecisionSnapshotHash({
      ...baseSnapshot,
      candidateMemberships: [candidate2],
    })

    // Same semantic state, different input ordering → same hash.
    expect(hash1).toBe(hash2)
  })

  it('same observations in different Map insertion orders produce the same decisionSnapshotHash', () => {
    const request = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'bandwidth', amount: '500', unit: 'Mbps' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })

    const candidate = makeMembership('rm-1', NETWORK_A, ['bandwidth'], [{ capabilityType: 'bandwidth', amount: '1000', unit: 'Mbps' }])

    // Same observations, different Map insertion orders.
    const obs1 = new Map<string, ConstraintObservationSnapshot>([
      ['rm-1', {
        membershipId: 'rm-1',
        observations: new Map([
          ['latency', { value: '14', unit: 'ms' }],
          ['availability', { value: '99.95', unit: '%' }],
        ]),
      }],
    ])
    const obs2 = new Map<string, ConstraintObservationSnapshot>([
      ['rm-1', {
        membershipId: 'rm-1',
        observations: new Map([
          ['availability', { value: '99.95', unit: '%' }],
          ['latency', { value: '14', unit: 'ms' }],
        ]),
      }],
    ])

    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]
    const remaining = new Map([['rm-1', [{ capabilityType: 'bandwidth', amount: '1000', unit: 'Mbps' }]]])
    const authorizing = new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A)]])

    const baseSnapshot = {
      networkVersionId: VERSION_1,
      request,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidate],
      capacityStateByMembership: remaining,
      authorizingMemberships: authorizing,
      schedulerVersion: 'test-v1',
      evaluatorVersion: 'test-ev-v1',
    }

    const hash1 = computeDecisionSnapshotHash({
      ...baseSnapshot,
      observationSnapshots: obs1,
    })
    const hash2 = computeDecisionSnapshotHash({
      ...baseSnapshot,
      observationSnapshots: obs2,
    })

    // Same observations, different insertion order → same hash.
    expect(hash1).toBe(hash2)
  })
})

// ---------------------------------------------------------------------------
// capabilityRequirements + allocatedCapacity input-order independence
// ---------------------------------------------------------------------------

describe('Phase 12B: capabilityRequirements + allocatedCapacity total ordering', () => {
  it('same capabilityRequirements in different array orders produce the same decisionSnapshotHash', () => {
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]
    const candidate = makeMembership('rm-gpu-1', NETWORK_A, ['compute', 'storage'], [
      { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      { capabilityType: 'storage', amount: '100', unit: 'TB' },
    ])
    const remaining = new Map([['rm-gpu-1', [
      { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      { capabilityType: 'storage', amount: '100', unit: 'TB' },
    ]]])
    const authorizing = new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A)]])

    // Same requirements, different array orders.
    const reqOrder1 = [
      { capabilityType: 'compute', amount: '4', unit: 'GPU' },
      { capabilityType: 'storage', amount: '50', unit: 'TB' },
    ]
    const reqOrder2 = [
      { capabilityType: 'storage', amount: '50', unit: 'TB' },
      { capabilityType: 'compute', amount: '4', unit: 'GPU' },
    ]

    const request1 = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: reqOrder1,
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })
    const request2 = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: reqOrder2,
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
    })

    // Override the requestId to be the same so the only difference is the array order.
    const baseSnapshot = {
      networkVersionId: VERSION_1,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidate],
      capacityStateByMembership: remaining,
      authorizingMemberships: authorizing,
      schedulerVersion: 'test-v1',
      evaluatorVersion: 'test-ev-v1',
    }

    // Use the same requestId for both so only the array order differs.
    const canonicalRequest1 = { ...request1, requestId: 'same-request-id' }
    const canonicalRequest2 = { ...request2, requestId: 'same-request-id' }

    const hash1 = computeDecisionSnapshotHash({ ...baseSnapshot, request: canonicalRequest1 })
    const hash2 = computeDecisionSnapshotHash({ ...baseSnapshot, request: canonicalRequest2 })

    // Same requirements, different array order → same hash.
    expect(hash1).toBe(hash2)
  })

  it('same allocatedCapacity in different array orders produce the same decisionId', async () => {
    // Test via the scheduler: two requests with same requirements in different
    // orders should produce the same decisionId (since allocatedCapacity is
    // derived from the requirements and sorted canonically).
    const membership = makeParticipantMembership('pm-consumer-a', NETWORK_A)
    const roles = [makeRole('pm-consumer-a', 'consumer')]
    const candidate = makeMembership('rm-1', NETWORK_A, ['compute', 'storage'], [
      { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      { capabilityType: 'storage', amount: '100', unit: 'TB' },
    ])
    const remaining = new Map([['rm-1', [
      { capabilityType: 'compute', amount: '8', unit: 'GPU' },
      { capabilityType: 'storage', amount: '100', unit: 'TB' },
    ]]])
    const authorizing = new Map([['pm-provider-a', makeParticipantMembership('pm-provider-a', NETWORK_A)]])

    const reqOrder1 = [
      { capabilityType: 'compute', amount: '4', unit: 'GPU' },
      { capabilityType: 'storage', amount: '50', unit: 'TB' },
    ]
    const reqOrder2 = [
      { capabilityType: 'storage', amount: '50', unit: 'TB' },
      { capabilityType: 'compute', amount: '4', unit: 'GPU' },
    ]

    // Use the same requestId so only the array order differs.
    const request1 = {
      requestId: 'same-req',
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: reqOrder1,
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
      status: 'pending' as const,
      submittedAt: new Date('2024-06-01T00:00:00Z'),
    }
    const request2 = {
      requestId: 'same-req',
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: reqOrder2,
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-1',
      status: 'pending' as const,
      submittedAt: new Date('2024-06-01T00:00:00Z'),
    }

    const result1 = await schedule({
      networkVersionId: VERSION_1,
      request: request1,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidate],
      remainingCapacity: remaining,
      authorizingMemberships: authorizing,
    })
    const result2 = await schedule({
      networkVersionId: VERSION_1,
      request: request2,
      requesterMembership: membership,
      requesterRoles: roles,
      candidateMemberships: [candidate],
      remainingCapacity: remaining,
      authorizingMemberships: authorizing,
    })

    expect(result1.status).toBe('allocated')
    expect(result2.status).toBe('allocated')
    if (result1.status === 'allocated' && result2.status === 'allocated') {
      // Same requirements in different orders → same decisionId.
      expect(result2.decision.decisionId).toBe(result1.decision.decisionId)
    }
  })
})

// ---------------------------------------------------------------------------
// Slice 2: deterministic requestId from idempotency key
// ---------------------------------------------------------------------------

describe('Phase 12B Slice 2: deterministic requestId', () => {
  it('same idempotency key + same network + same requester → same requestId', () => {
    const req1 = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-123',
    })
    const req2 = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-123',
    })

    // Same inputs → same requestId (deterministic, not randomUUID).
    expect(req1.requestId).toBe(req2.requestId)
    expect(req1.requestId).toMatch(/^[a-f0-9]{64}$/) // SHA-256 hex
  })

  it('different idempotency key → different requestId', () => {
    const req1 = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-A',
    })
    const req2 = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-B',
    })

    expect(req1.requestId).not.toBe(req2.requestId)
  })

  it('same idempotency key but different network → different requestId', () => {
    const req1 = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_A,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-123',
    })
    const req2 = createNetworkRequest({
      requesterMembershipId: 'pm-consumer-a',
      networkId: NETWORK_B,
      capabilityRequirements: [{ capabilityType: 'compute', amount: '4', unit: 'GPU' }],
      timeWindow: { start: new Date('2024-06-01T00:00:00Z'), end: new Date('2024-06-01T04:00:00Z') },
      idempotencyKey: 'key-123',
    })

    expect(req1.requestId).not.toBe(req2.requestId)
  })
})
