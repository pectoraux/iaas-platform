/// <reference types="bun-types" />
/**
 * WORK-025 — NetworkInstance + Network Lifecycle PostgreSQL Integration Tests
 *
 * Proves the persistence halves of NET-001-AC01..04 and NET-002-AC01..04
 * (IAAS-DOM-ARCH-6 §3.3–3.4) against real PostgreSQL:
 *
 *   - durable instance identity distinct from definition/version identity;
 *     many instances per published version (NET-001-AC01)
 *   - published-source gate: instances only realize PUBLISHED versions;
 *     lifecycle state owned by the lifecycle subsystem, independent of the
 *     definition lifecycle (NET-001-AC02)
 *   - tenant isolation on read/list/transition/history (NET-001-AC03)
 *   - actor authorization (viewer denied) + audit rows for create and every
 *     transition (NET-001-AC04)
 *   - the frozen state machine as one lifecycle: happy path, pause/resume,
 *     teardown, invalid-transition negatives incl. stage-bypass and terminal
 *     states (NET-002-AC01)
 *   - explicit failure/rollback exits + published-version immutability
 *     through the full lifecycle (NET-002-AC02)
 *   - the same lifecycle for different network verticals (NET-002-AC03)
 *   - historical evidence preservation after TERMINATED/ARCHIVED (V6 §3.3)
 *   - concurrency: racing transitions converge to exactly one winner
 *
 * Run: bun test tests/work-025-network-lifecycle-pg.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import {
  createNetwork,
  createNetworkVersion,
  publishNetworkVersion,
  type VersionConfiguration,
} from '../src/lib/services/network.service'
import {
  createNetworkInstance,
  getNetworkInstance,
  listNetworkInstances,
  transitionNetworkInstanceLifecycle,
  getNetworkInstanceLifecycleHistory,
  LIFECYCLE_STATE,
  type NetworkLifecycleActor,
} from '../src/lib/services/network-lifecycle.service'
import {
  NotFoundError,
  ConflictError,
  ValidationError,
  ForbiddenError,
} from '../src/lib/domain/errors'

let tenantA: string
let tenantB: string

// Actors for the authorization tests (identity/roles are owned by the
// existing identity boundary; the lifecycle service owns the decision).
const ownerActor: NetworkLifecycleActor = { actorId: 'w025-owner-1', role: 'owner' }
const operatorActor: NetworkLifecycleActor = { actorId: 'w025-operator-1', role: 'operator' }
const adminActor: NetworkLifecycleActor = { actorId: 'w025-admin-1', role: 'admin' }
const viewerActor: NetworkLifecycleActor = { actorId: 'w025-viewer-1', role: 'viewer' }

const TEST_CONFIG: VersionConfiguration = {
  asset_types: ['w025-asset'],
  capabilities: [
    { type: 'w025.capability', unit: 'unit', schema_version: 1, fields: { value: 'number' } },
  ],
  verification: { checks: ['schema_validation'] },
  reward: { type: 'fixed_rate', rate: '0.01', unit: 'unit', currency: 'USD' },
}

/** Create a network + PUBLISHED version in the given tenant/vertical. */
async function createPublishedVersion(tenantId: string, vertical: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const network = await createNetwork(tenantId, {
    name: `W025 Net ${vertical}`,
    slug: `w025-${vertical}-${suffix}`,
    vertical,
  })
  const version = await createNetworkVersion(tenantId, network.id, TEST_CONFIG)
  const published = await publishNetworkVersion(tenantId, network.id, version.id, ownerActor.actorId)
  return { network, version: published! }
}

beforeAll(async () => {
  const stamp = Date.now()
  const tA = await createTenant({ name: 'W025 Lifecycle Tenant A', slug: `w025-a-${stamp}`, plan: 'growth' })
  tenantA = tA.id
  const tB = await createTenant({ name: 'W025 Lifecycle Tenant B', slug: `w025-b-${stamp}`, plan: 'growth' })
  tenantB = tB.id
})

// ---------------------------------------------------------------------------
// NET-001-AC01 — distinct durable identity; many instances per version
// ---------------------------------------------------------------------------

describe('WORK-025 — NetworkInstance identity (NET-001-AC01)', () => {
  it('creates an instance with its OWN identity, distinct from definition and version identity', async () => {
    const { network, version } = await createPublishedVersion(tenantA, 'generic')
    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)

    expect(instance.id).toBeTruthy()
    expect(instance.id).not.toBe(version.id)
    expect(instance.id).not.toBe(network.id)
    expect(instance.networkVersionId).toBe(version.id)
    expect(instance.networkId).toBe(network.id)
    expect(instance.version).toBe(version.version)
    expect(instance.lifecycleState).toBe(LIFECYCLE_STATE.PLANNED)
    expect(instance.tenantId).toBe(tenantA)
  })

  it('many instances may derive from the SAME published version without redefining it', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const first = await createNetworkInstance(tenantA, { networkVersionId: version.id, label: 'deployment-1' }, ownerActor)
    const second = await createNetworkInstance(tenantA, { networkVersionId: version.id, label: 'deployment-2' }, ownerActor)

    expect(first.id).not.toBe(second.id)
    expect(first.networkVersionId).toBe(version.id)
    expect(second.networkVersionId).toBe(version.id)

    const perVersion = await listNetworkInstances(tenantA, { networkVersionId: version.id })
    expect(perVersion.length).toBe(2)
    expect(new Set(perVersion.map((i) => i.id))).toEqual(new Set([first.id, second.id]))
  })

  it('persists and reloads the instance from PostgreSQL (durable identity)', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const created = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    const reloaded = await getNetworkInstance(tenantA, created.id)
    expect(reloaded.id).toBe(created.id)
    expect(reloaded.lifecycleState).toBe(LIFECYCLE_STATE.PLANNED)
    expect(reloaded.label).toBeNull()
  })

  it('rejects invalid labels (empty / too long)', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    await expect(
      createNetworkInstance(tenantA, { networkVersionId: version.id, label: '   ' }, ownerActor),
    ).rejects.toThrow(ValidationError)
    await expect(
      createNetworkInstance(tenantA, { networkVersionId: version.id, label: 'x'.repeat(201) }, ownerActor),
    ).rejects.toThrow(ValidationError)
  })
})

// ---------------------------------------------------------------------------
// NET-001-AC02 — exactly one immutable PUBLISHED source version; lifecycle
// authority independence
// ---------------------------------------------------------------------------

describe('WORK-025 — source-version binding + lifecycle authority (NET-001-AC02)', () => {
  it('REFUSES to create an instance from an UNPUBLISHED (mutable draft) version', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const network = await createNetwork(tenantA, { name: 'W025 Draft Net', slug: `w025-draft-${suffix}`, vertical: 'generic' })
    const draft = await createNetworkVersion(tenantA, network.id, TEST_CONFIG)

    await expect(
      createNetworkInstance(tenantA, { networkVersionId: draft.id }, ownerActor),
    ).rejects.toThrow(ConflictError)
  })

  it('unknown version ids are NOT_FOUND', async () => {
    await expect(
      createNetworkInstance(tenantA, { networkVersionId: 'does-not-exist' }, ownerActor),
    ).rejects.toThrow(NotFoundError)
  })

  it('instance lifecycle state is INDEPENDENT of the NetworkDefinition lifecycle', async () => {
    // The definition is 'active' with a current version — the instance still
    // starts at PLANNED, and instance transitions never touch definition
    // status/currentVersionId.
    const { network, version } = await createPublishedVersion(tenantA, 'generic')
    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)

    const defBefore = await db.networkDefinition.findUnique({ where: { id: network.id } })
    expect(defBefore?.status).toBe('active')
    expect(instance.lifecycleState).toBe(LIFECYCLE_STATE.PLANNED)

    await transitionNetworkInstanceLifecycle(tenantA, instance.id, LIFECYCLE_STATE.PROVISIONING, ownerActor)
    await transitionNetworkInstanceLifecycle(tenantA, instance.id, LIFECYCLE_STATE.VALIDATING, ownerActor)
    await transitionNetworkInstanceLifecycle(tenantA, instance.id, LIFECYCLE_STATE.ACTIVE, ownerActor)

    const defAfter = await db.networkDefinition.findUnique({ where: { id: network.id } })
    expect(defAfter?.status).toBe('active')
    expect(defAfter?.currentVersionId).toBe(version.id)
  })
})

// ---------------------------------------------------------------------------
// NET-001-AC03 — tenant isolation
// ---------------------------------------------------------------------------

describe('WORK-025 — tenant isolation (NET-001-AC03)', () => {
  it('tenant B cannot READ tenant A instances (uniform NOT_FOUND)', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    await expect(getNetworkInstance(tenantB, instance.id)).rejects.toThrow(NotFoundError)
  })

  it('tenant B cannot TRANSITION tenant A instances — and the state is untouched', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    await expect(
      transitionNetworkInstanceLifecycle(tenantB, instance.id, LIFECYCLE_STATE.PROVISIONING, operatorActor),
    ).rejects.toThrow(NotFoundError)
    const untouched = await getNetworkInstance(tenantA, instance.id)
    expect(untouched.lifecycleState).toBe(LIFECYCLE_STATE.PLANNED)
  })

  it('tenant B listing does not leak tenant A instances', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    const bInstances = await listNetworkInstances(tenantB)
    const bDirect = await db.networkInstance.findMany({ where: { tenantId: tenantB } })
    expect(bInstances.length).toBe(bDirect.length)
  })

  it('tenant B cannot read tenant A instance HISTORY (uniform NOT_FOUND)', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    await expect(getNetworkInstanceLifecycleHistory(tenantB, instance.id)).rejects.toThrow(NotFoundError)
  })

  it('tenant A cannot create an instance from tenant B VERSION (cross-tenant version id)', async () => {
    const { version } = await createPublishedVersion(tenantB, 'generic')
    await expect(
      createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor),
    ).rejects.toThrow(NotFoundError)
  })
})

// ---------------------------------------------------------------------------
// NET-001-AC04 — authorization + audit
// ---------------------------------------------------------------------------

describe('WORK-025 — authorization + audit (NET-001-AC04)', () => {
  it('viewers are DENIED create and transition operations', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    await expect(
      createNetworkInstance(tenantA, { networkVersionId: version.id }, viewerActor),
    ).rejects.toThrow(ForbiddenError)

    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, operatorActor)
    await expect(
      transitionNetworkInstanceLifecycle(tenantA, instance.id, LIFECYCLE_STATE.PROVISIONING, viewerActor),
    ).rejects.toThrow(ForbiddenError)
    const untouched = await getNetworkInstance(tenantA, instance.id)
    expect(untouched.lifecycleState).toBe(LIFECYCLE_STATE.PLANNED)
  })

  it('operator and admin actors are authorized for create and transitions', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const byOperator = await createNetworkInstance(tenantA, { networkVersionId: version.id }, operatorActor)
    const byAdmin = await createNetworkInstance(tenantA, { networkVersionId: version.id }, adminActor)
    await transitionNetworkInstanceLifecycle(tenantA, byOperator.id, LIFECYCLE_STATE.PROVISIONING, operatorActor)
    await transitionNetworkInstanceLifecycle(tenantA, byAdmin.id, LIFECYCLE_STATE.PROVISIONING, adminActor)
    expect((await getNetworkInstance(tenantA, byOperator.id)).lifecycleState).toBe(LIFECYCLE_STATE.PROVISIONING)
    expect((await getNetworkInstance(tenantA, byAdmin.id)).lifecycleState).toBe(LIFECYCLE_STATE.PROVISIONING)
  })

  it('creation writes an atomic network_instance.created audit row', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id, label: 'audited' }, ownerActor)

    const rows = await db.auditLog.findMany({
      where: { tenantId: tenantA, resourceType: 'network_instance', resourceId: instance.id, eventType: 'network_instance.created' },
    })
    expect(rows.length).toBe(1)
    const metadata = JSON.parse(rows[0].metadataJson)
    expect(metadata.networkVersionId).toBe(version.id)
    expect(metadata.initialLifecycleState).toBe(LIFECYCLE_STATE.PLANNED)
    expect(metadata.label).toBe('audited')
    expect(rows[0].actorId).toBe(ownerActor.actorId)
  })

  it('every transition writes a network_instance.lifecycle_transition audit row with from/to', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    await transitionNetworkInstanceLifecycle(tenantA, instance.id, LIFECYCLE_STATE.PROVISIONING, operatorActor, { reason: 'provisioning started' })

    const rows = await db.auditLog.findMany({
      where: { tenantId: tenantA, resourceType: 'network_instance', resourceId: instance.id, eventType: 'network_instance.lifecycle_transition' },
    })
    expect(rows.length).toBe(1)
    const metadata = JSON.parse(rows[0].metadataJson)
    expect(metadata.from).toBe(LIFECYCLE_STATE.PLANNED)
    expect(metadata.to).toBe(LIFECYCLE_STATE.PROVISIONING)
    expect(metadata.reason).toBe('provisioning started')
    expect(metadata.actorRole).toBe('operator')
    expect(rows[0].actorId).toBe(operatorActor.actorId)
  })
})

// ---------------------------------------------------------------------------
// NET-002-AC01 — the frozen state machine as ONE lifecycle (no stage bypass)
// ---------------------------------------------------------------------------

describe('WORK-025 — lifecycle state machine (NET-002-AC01)', () => {
  it('walks the canonical happy path: planned → provisioning → validating → active', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)

    let current = await transitionNetworkInstanceLifecycle(tenantA, instance.id, LIFECYCLE_STATE.PROVISIONING, ownerActor)
    expect(current.lifecycleState).toBe(LIFECYCLE_STATE.PROVISIONING)
    current = await transitionNetworkInstanceLifecycle(tenantA, instance.id, LIFECYCLE_STATE.VALIDATING, ownerActor)
    expect(current.lifecycleState).toBe(LIFECYCLE_STATE.VALIDATING)
    current = await transitionNetworkInstanceLifecycle(tenantA, instance.id, LIFECYCLE_STATE.ACTIVE, ownerActor)
    expect(current.lifecycleState).toBe(LIFECYCLE_STATE.ACTIVE)
    expect(current.id).toBe(instance.id)
    expect(current.networkVersionId).toBe(version.id)
  })

  it('supports reversible suspension: active ⇌ paused', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    for (const s of [LIFECYCLE_STATE.PROVISIONING, LIFECYCLE_STATE.VALIDATING, LIFECYCLE_STATE.ACTIVE]) {
      await transitionNetworkInstanceLifecycle(tenantA, instance.id, s, ownerActor)
    }
    await transitionNetworkInstanceLifecycle(tenantA, instance.id, LIFECYCLE_STATE.PAUSED, ownerActor)
    await transitionNetworkInstanceLifecycle(tenantA, instance.id, LIFECYCLE_STATE.ACTIVE, ownerActor)
    const final = await getNetworkInstance(tenantA, instance.id)
    expect(final.lifecycleState).toBe(LIFECYCLE_STATE.ACTIVE)
  })

  it('walks the full teardown chain: active → draining → terminated → archived', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    for (const s of [LIFECYCLE_STATE.PROVISIONING, LIFECYCLE_STATE.VALIDATING, LIFECYCLE_STATE.ACTIVE]) {
      await transitionNetworkInstanceLifecycle(tenantA, instance.id, s, ownerActor)
    }
    for (const s of [LIFECYCLE_STATE.DRAINING, LIFECYCLE_STATE.TERMINATED, LIFECYCLE_STATE.ARCHIVED]) {
      await transitionNetworkInstanceLifecycle(tenantA, instance.id, s, ownerActor)
    }
    const final = await getNetworkInstance(tenantA, instance.id)
    expect(final.lifecycleState).toBe(LIFECYCLE_STATE.ARCHIVED)
  })

  it('REJECTS stage-bypass and invalid transitions with ValidationError (negative matrix)', async () => {
    // Fresh instances in specific states via helper paths.
    async function instanceIn(state: string): Promise<string> {
      const { version } = await createPublishedVersion(tenantA, 'generic')
      const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
      const path: Record<string, string[]> = {
        planned: [],
        provisioning: [LIFECYCLE_STATE.PROVISIONING],
        validating: [LIFECYCLE_STATE.PROVISIONING, LIFECYCLE_STATE.VALIDATING],
        active: [LIFECYCLE_STATE.PROVISIONING, LIFECYCLE_STATE.VALIDATING, LIFECYCLE_STATE.ACTIVE],
        paused: [LIFECYCLE_STATE.PROVISIONING, LIFECYCLE_STATE.VALIDATING, LIFECYCLE_STATE.ACTIVE, LIFECYCLE_STATE.PAUSED],
        draining: [LIFECYCLE_STATE.PROVISIONING, LIFECYCLE_STATE.VALIDATING, LIFECYCLE_STATE.ACTIVE, LIFECYCLE_STATE.DRAINING],
        terminated: [LIFECYCLE_STATE.PROVISIONING, LIFECYCLE_STATE.TERMINATED],
        archived: [LIFECYCLE_STATE.PROVISIONING, LIFECYCLE_STATE.TERMINATED, LIFECYCLE_STATE.ARCHIVED],
      }
      for (const s of path[state]) {
        await transitionNetworkInstanceLifecycle(tenantA, instance.id, s, ownerActor)
      }
      return instance.id
    }

    const negatives: Array<[string, string]> = [
      // Stage bypass (a later stage cannot skip a required earlier one).
      ['planned', 'validating'],
      ['planned', 'active'],
      ['planned', 'paused'],
      ['planned', 'draining'],
      ['planned', 'archived'],
      ['provisioning', 'active'],
      ['provisioning', 'paused'],
      ['provisioning', 'draining'],
      ['validating', 'paused'],
      ['validating', 'draining'],
      // Teardown ordering (must drain first; archived only from terminated).
      ['active', 'terminated'],
      ['paused', 'terminated'],
      ['draining', 'archived'],
      // Terminal semantics (no resurrection).
      ['terminated', 'active'],
      ['terminated', 'draining'],
      ['terminated', 'provisioning'],
      ['archived', 'active'],
      ['archived', 'terminated'],
      ['archived', 'planned'],
      // Same-state self-loops.
      ['planned', 'planned'],
      ['active', 'active'],
      ['archived', 'archived'],
    ]

    for (const [from, to] of negatives) {
      const id = await instanceIn(from)
      // ARCHIVED is the absolute terminal state → ConflictError; every other
      // invalid transition → ValidationError (frozen-table violation).
      const expectedError = from === LIFECYCLE_STATE.ARCHIVED ? ConflictError : ValidationError
      await expect(
        transitionNetworkInstanceLifecycle(tenantA, id, to, ownerActor),
      ).rejects.toThrow(expectedError)
      const unchanged = await getNetworkInstance(tenantA, id)
      expect(unchanged.lifecycleState).toBe(from) // rejected transition leaves NO durable effect
    }
  })

  it('ARCHIVED is terminal: ConflictError with an explicit terminal message', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    for (const s of [LIFECYCLE_STATE.PROVISIONING, LIFECYCLE_STATE.TERMINATED, LIFECYCLE_STATE.ARCHIVED]) {
      await transitionNetworkInstanceLifecycle(tenantA, instance.id, s, ownerActor)
    }
    await expect(
      transitionNetworkInstanceLifecycle(tenantA, instance.id, LIFECYCLE_STATE.ACTIVE, ownerActor),
    ).rejects.toThrow(ConflictError)
  })

  it('unknown target states are rejected (fail closed)', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    await expect(
      transitionNetworkInstanceLifecycle(tenantA, instance.id, 'DESTROYED', ownerActor),
    ).rejects.toThrow(ValidationError)
  })
})

// ---------------------------------------------------------------------------
// NET-002-AC02 — explicit failure/rollback transitions + published-version
// immutability
// ---------------------------------------------------------------------------

describe('WORK-025 — failure/rollback + version immutability (NET-002-AC02)', () => {
  it('explicit failure exits: planned/provisioning/validating → terminated', async () => {
    // planned → terminated (abandoned before provisioning)
    const v1 = await createPublishedVersion(tenantA, 'generic')
    const abandoned = await createNetworkInstance(tenantA, { networkVersionId: v1.version.id }, ownerActor)
    await transitionNetworkInstanceLifecycle(tenantA, abandoned.id, LIFECYCLE_STATE.TERMINATED, ownerActor, { reason: 'abandoned' })
    expect((await getNetworkInstance(tenantA, abandoned.id)).lifecycleState).toBe(LIFECYCLE_STATE.TERMINATED)

    // provisioning → terminated (provisioning failure)
    const v2 = await createPublishedVersion(tenantA, 'generic')
    const failedProvision = await createNetworkInstance(tenantA, { networkVersionId: v2.version.id }, ownerActor)
    await transitionNetworkInstanceLifecycle(tenantA, failedProvision.id, LIFECYCLE_STATE.PROVISIONING, ownerActor)
    await transitionNetworkInstanceLifecycle(tenantA, failedProvision.id, LIFECYCLE_STATE.TERMINATED, ownerActor, { reason: 'provider error' })
    expect((await getNetworkInstance(tenantA, failedProvision.id)).lifecycleState).toBe(LIFECYCLE_STATE.TERMINATED)

    // validating → terminated (validation failure)
    const v3 = await createPublishedVersion(tenantA, 'generic')
    const failedValidation = await createNetworkInstance(tenantA, { networkVersionId: v3.version.id }, ownerActor)
    for (const s of [LIFECYCLE_STATE.PROVISIONING, LIFECYCLE_STATE.VALIDATING]) {
      await transitionNetworkInstanceLifecycle(tenantA, failedValidation.id, s, ownerActor)
    }
    await transitionNetworkInstanceLifecycle(tenantA, failedValidation.id, LIFECYCLE_STATE.TERMINATED, ownerActor, { reason: 'verification failed' })
    expect((await getNetworkInstance(tenantA, failedValidation.id)).lifecycleState).toBe(LIFECYCLE_STATE.TERMINATED)
  })

  it('the published NetworkVersion is BYTE-IDENTICAL after the full instance lifecycle', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const before = await db.networkVersion.findUnique({ where: { id: version.id } })
    expect(before?.publishedAt).not.toBeNull()

    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    const fullChain = [
      LIFECYCLE_STATE.PROVISIONING,
      LIFECYCLE_STATE.VALIDATING,
      LIFECYCLE_STATE.ACTIVE,
      LIFECYCLE_STATE.PAUSED,
      LIFECYCLE_STATE.ACTIVE,
      LIFECYCLE_STATE.DRAINING,
      LIFECYCLE_STATE.TERMINATED,
      LIFECYCLE_STATE.ARCHIVED,
    ]
    for (const s of fullChain) {
      await transitionNetworkInstanceLifecycle(tenantA, instance.id, s, ownerActor)
    }

    const after = await db.networkVersion.findUnique({ where: { id: version.id } })
    // The immutable published artifact is untouched by instance lifecycle.
    expect(after?.publishedAt?.toISOString()).toBe(before?.publishedAt?.toISOString())
    expect(after?.configurationJson).toBe(before?.configurationJson)
    expect(after?.baselinePolicyJson).toBe(before?.baselinePolicyJson)
    expect(after?.runtimeKind).toBe(before?.runtimeKind)
    expect(after?.version).toBe(before?.version)
    expect(after?.networkId).toBe(before?.networkId)

    // And a NEW instance may still be created from the same version (rollback
    // = new instance, never a version rewrite).
    const redeploy = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    expect(redeploy.lifecycleState).toBe(LIFECYCLE_STATE.PLANNED)
  })
})

// ---------------------------------------------------------------------------
// NET-002-AC03 — the same lifecycle model for every network type
// ---------------------------------------------------------------------------

describe('WORK-025 — universal lifecycle across verticals (NET-002-AC03)', () => {
  it('generic, compute, storage, and wireless networks use the SAME lifecycle', async () => {
    for (const vertical of ['generic', 'compute', 'storage', 'wireless']) {
      const { version } = await createPublishedVersion(tenantA, vertical)
      const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
      // Identical path + identical semantics for every vertical.
      for (const s of [LIFECYCLE_STATE.PROVISIONING, LIFECYCLE_STATE.VALIDATING, LIFECYCLE_STATE.ACTIVE]) {
        await transitionNetworkInstanceLifecycle(tenantA, instance.id, s, ownerActor)
      }
      expect((await getNetworkInstance(tenantA, instance.id)).lifecycleState).toBe(LIFECYCLE_STATE.ACTIVE)
      // Identical failure semantics too.
      await expect(
        transitionNetworkInstanceLifecycle(tenantA, instance.id, LIFECYCLE_STATE.TERMINATED, ownerActor),
      ).rejects.toThrow(ValidationError) // must drain first — same rule everywhere
    }
  })

  it('listNetworkInstances filters by lifecycleState tenant-wide', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const a = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    const planned = await listNetworkInstances(tenantA, { lifecycleState: LIFECYCLE_STATE.PLANNED })
    expect(planned.length).toBeGreaterThanOrEqual(2)
    expect(planned.every((i) => i.lifecycleState === 'planned')).toBe(true)
    expect(planned.some((i) => i.id === a.id)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// V6 §3.3 — historical evidence preservation after termination/archive
// ---------------------------------------------------------------------------

describe('WORK-025 — historical evidence preservation (V6 §3.3)', () => {
  it('the full audit trail survives TERMINATED and ARCHIVED and reads back in order', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    const chain = [
      LIFECYCLE_STATE.PROVISIONING,
      LIFECYCLE_STATE.VALIDATING,
      LIFECYCLE_STATE.ACTIVE,
      LIFECYCLE_STATE.DRAINING,
      LIFECYCLE_STATE.TERMINATED,
      LIFECYCLE_STATE.ARCHIVED,
    ]
    for (const s of chain) {
      await transitionNetworkInstanceLifecycle(tenantA, instance.id, s, ownerActor)
    }

    // The instance row is RETAINED (never deleted) after terminal states.
    const archived = await getNetworkInstance(tenantA, instance.id)
    expect(archived.lifecycleState).toBe(LIFECYCLE_STATE.ARCHIVED)

    // The evidence trail is complete: 1 creation + 6 transitions, ordered,
    // with the exact from→to chain.
    const history = await getNetworkInstanceLifecycleHistory(tenantA, instance.id)
    expect(history.length).toBe(1 + chain.length)
    expect(history[0].eventType).toBe('network_instance.created')
    expect(history[0].from).toBeNull()
    expect(history[0].to).toBeNull()
    const transitions = history.slice(1)
    expect(transitions[0].from).toBe(LIFECYCLE_STATE.PLANNED)
    for (let i = 0; i < transitions.length; i++) {
      expect(transitions[i].eventType).toBe('network_instance.lifecycle_transition')
      expect(transitions[i].to).toBe(chain[i])
      if (i > 0) expect(transitions[i].from).toBe(chain[i - 1])
    }
    expect(transitions[transitions.length - 1].to).toBe(LIFECYCLE_STATE.ARCHIVED)
    // Timestamps are non-decreasing (append-only, ordered evidence).
    for (let i = 1; i < history.length; i++) {
      expect(new Date(history[i].occurredAt).getTime()).toBeGreaterThanOrEqual(
        new Date(history[i - 1].occurredAt).getTime(),
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Concurrency — racing transitions converge to exactly one winner
// ---------------------------------------------------------------------------

describe('WORK-025 — concurrency-safe transitions (FOR UPDATE re-validation)', () => {
  it('two racing IDENTICAL transitions: exactly one applies', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    for (const s of [LIFECYCLE_STATE.PROVISIONING, LIFECYCLE_STATE.VALIDATING, LIFECYCLE_STATE.ACTIVE]) {
      await transitionNetworkInstanceLifecycle(tenantA, instance.id, s, ownerActor)
    }

    const results = await Promise.allSettled([
      transitionNetworkInstanceLifecycle(tenantA, instance.id, LIFECYCLE_STATE.PAUSED, operatorActor),
      transitionNetworkInstanceLifecycle(tenantA, instance.id, LIFECYCLE_STATE.PAUSED, adminActor),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    // The loser re-validated against the committed state and failed cleanly.
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError)

    const final = await getNetworkInstance(tenantA, instance.id)
    expect(final.lifecycleState).toBe(LIFECYCLE_STATE.PAUSED)
  })

  it('two racing DIVERGENT transitions: exactly one applies', async () => {
    const { version } = await createPublishedVersion(tenantA, 'generic')
    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    for (const s of [LIFECYCLE_STATE.PROVISIONING, LIFECYCLE_STATE.VALIDATING]) {
      await transitionNetworkInstanceLifecycle(tenantA, instance.id, s, ownerActor)
    }

    // validating → active vs validating → terminated: whichever wins, the
    // loser's transition is invalid from the resulting committed state
    // (active → terminated requires draining; terminated → active is
    // forbidden entirely).
    const results = await Promise.allSettled([
      transitionNetworkInstanceLifecycle(tenantA, instance.id, LIFECYCLE_STATE.ACTIVE, operatorActor),
      transitionNetworkInstanceLifecycle(tenantA, instance.id, LIFECYCLE_STATE.TERMINATED, adminActor),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled.length).toBe(1)

    const final = await getNetworkInstance(tenantA, instance.id)
    const acceptable: string[] = [LIFECYCLE_STATE.ACTIVE, LIFECYCLE_STATE.TERMINATED]
    expect(acceptable).toContain(final.lifecycleState)
    if (final.lifecycleState === LIFECYCLE_STATE.ACTIVE) {
      const winner = fulfilled[0] as PromiseFulfilledResult<{ lifecycleState: string }>
      expect(winner.value.lifecycleState).toBe(LIFECYCLE_STATE.ACTIVE)
    }
  })
})
