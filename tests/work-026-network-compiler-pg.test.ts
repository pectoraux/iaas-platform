/// <reference types="bun-types" />
/**
 * WORK-026 — Network-as-Code Validation and Resolution PostgreSQL Integration Tests
 *
 * Proves the persistence halves of NET-003-AC01..04 and NET-004-AC01..04
 * (IAAS-DOM-ARCH-6 §3.5) against real PostgreSQL:
 *
 *   - deterministic fail-closed validation; published NetworkVersion
 *     byte-immutability before/after resolution (NET-003-AC01)
 *   - invalid/unpublished/cross-tenant versions rejected with NO plan row and
 *     NO audit row (rejected before resolution side effects, NET-003-AC02)
 *   - dependency resolution: acyclic enforcement with the exact cycle,
 *     deterministic canonical topological order (NET-003-AC03)
 *   - capability resolution against the materialized catalog (incl. tamper
 *     fail-closure) + resource discovery through the authoritative verified
 *     assignments, identical mechanics across verticals (NET-003-AC04)
 *   - determinism: idempotent re-resolution, checksum stability under
 *     unchanged repository state, repo-state sensitivity, canonical resource
 *     ordering independent of creation order (NET-004-AC01)
 *   - resolution never allocates/reserves/commits/provisions/activates and
 *     never mutates NetworkInstance lifecycle state (NET-004-AC02)
 *   - explicit plan output: exact section set, independently verified
 *     sha256(planJson) checksum, explicit empty discovery (NET-004-AC03)
 *   - tenant isolation + actor authorization + atomic audit + racing
 *     resolutions converging to exactly one artifact (NET-004-AC04)
 *
 * Run: bun test tests/work-026-network-compiler-pg.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { createHash } from 'node:crypto'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import {
  createNetwork,
  createNetworkVersion,
  publishNetworkVersion,
  type VersionConfiguration,
} from '../src/lib/services/network.service'
import { createOperator, createAsset, assignAssetToNetwork } from '../src/lib/services/registry.service'
import { createNetworkInstance, transitionNetworkInstanceLifecycle, LIFECYCLE_STATE } from '../src/lib/services/network-lifecycle.service'
import {
  validateNetworkVersion,
  validateNetworkManifest,
  resolveDependencyOrder,
  resolveNetworkPlan,
  getNetworkPlan,
  listNetworkPlans,
  canonicalJsonStringify,
  computePlanChecksum,
  type NetworkCompilerActor,
} from '../src/lib/services/network-compiler.service'
import {
  NotFoundError,
  ConflictError,
  ValidationError,
  ForbiddenError,
} from '../src/lib/domain/errors'

let tenantA: string
let tenantB: string

// Actors for the authorization tests (identity/roles are owned by the
// existing identity boundary; the compiler owns the decision).
const ownerActor: NetworkCompilerActor = { actorId: 'w026-owner-1', role: 'owner' }
const operatorActor: NetworkCompilerActor = { actorId: 'w026-operator-1', role: 'operator' }
const adminActor: NetworkCompilerActor = { actorId: 'w026-admin-1', role: 'admin' }
const viewerActor: NetworkCompilerActor = { actorId: 'w026-viewer-1', role: 'viewer' }

const TEST_CONFIG: VersionConfiguration = {
  asset_types: ['w026-asset'],
  capabilities: [
    { type: 'w026.capability.alpha', unit: 'unit', schema_version: 1, fields: { value: 'number' } },
    { type: 'w026.capability.beta', unit: 'unit', schema_version: 1, fields: { value: 'number' } },
  ],
  verification: { checks: ['schema_validation'] },
  reward: { type: 'fixed_rate', rate: '0.01', unit: 'unit', currency: 'USD' },
}

const DEPENDENCY_CONFIG: VersionConfiguration = {
  ...TEST_CONFIG,
  capabilities: [
    { type: 'w026.dep.a', unit: 'unit', schema_version: 1, fields: {} },
    { type: 'w026.dep.b', unit: 'unit', schema_version: 1, fields: {} },
    { type: 'w026.dep.c', unit: 'unit', schema_version: 1, fields: {} },
    { type: 'w026.dep.d', unit: 'unit', schema_version: 1, fields: {} },
  ],
  // a requires b; c requires b; b requires d — canonical order: d, b, a, c.
  dependencies: [
    { from: 'w026.dep.a', to: 'w026.dep.b' },
    { from: 'w026.dep.c', to: 'w026.dep.b' },
    { from: 'w026.dep.b', to: 'w026.dep.d' },
  ],
}

let slugCounter = 0
function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now()}-${slugCounter++}`
}

/** Create a network + version (published unless config says otherwise). */
async function createVersion(
  tenantId: string,
  vertical: string,
  config: VersionConfiguration,
  options?: { publish?: boolean },
) {
  const network = await createNetwork(tenantId, {
    name: `W026 Net ${vertical}`,
    slug: uniqueSlug(`w026-${vertical}`),
    vertical,
  })
  const version = await createNetworkVersion(tenantId, network.id, config)
  if (options?.publish === false) return { network, version }
  const published = await publishNetworkVersion(tenantId, network.id, version.id, ownerActor.actorId)
  return { network, version: published! }
}

/** Create operator + asset + ACTIVE verified assignment in a network. */
async function createVerifiedResource(
  tenantId: string,
  networkId: string,
  capabilityType: string,
  quantity: string,
  unit: string,
  status?: string,
) {
  const operator = await createOperator(tenantId, { displayName: `W026 Op ${slugCounter}` })
  const asset = await createAsset(tenantId, {
    operatorId: operator.id,
    assetType: 'w026-asset',
    name: `W026 Asset ${slugCounter}`,
  })
  const assignment = await assignAssetToNetwork(
    tenantId,
    asset.id,
    networkId,
    capabilityType,
    quantity,
    unit,
  )
  if (status && status !== 'active') {
    await db.assetNetworkAssignment.update({ where: { id: assignment.id }, data: { status } })
  }
  return { operator, asset, assignment }
}

beforeAll(async () => {
  const stamp = Date.now()
  const tA = await createTenant({ name: 'W026 Compiler Tenant A', slug: `w026-a-${stamp}`, plan: 'growth' })
  tenantA = tA.id
  const tB = await createTenant({ name: 'W026 Compiler Tenant B', slug: `w026-b-${stamp}`, plan: 'growth' })
  tenantB = tB.id
})

// ---------------------------------------------------------------------------
// NET-003-AC01 — deterministic fail-closed validation; version immutability
// ---------------------------------------------------------------------------

describe('WORK-026 — deterministic fail-closed validation (NET-003-AC01)', () => {
  it('resolves a valid published version into a plan artifact', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const plan = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    expect(plan.id).toBeTruthy()
    expect(plan.networkVersionId).toBe(version.id)
    expect(plan.planChecksum).toMatch(/^[0-9a-f]{64}$/)
    expect(plan.plan.planSchemaVersion).toBe(1)
  })

  it('NEVER mutates the published NetworkVersion: byte-identical before/after resolution', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const before = await db.networkVersion.findUnique({ where: { id: version.id } })
    await resolveNetworkPlan(tenantA, version.id, ownerActor)
    await resolveNetworkPlan(tenantA, version.id, operatorActor) // re-resolution too
    const after = await db.networkVersion.findUnique({ where: { id: version.id } })
    expect(after).toEqual(before)
  })

  it('validation is deterministic: the same invalid version yields the IDENTICAL issue list', async () => {
    const badConfig = {
      ...TEST_CONFIG,
      capabilities: [],
      reward: { ...TEST_CONFIG.reward, rate: 'not-a-number' },
      dependencies: [{ from: 'w026.dep.a', to: 'w026.dep.a' }],
    } as unknown as VersionConfiguration
    const { version } = await createVersion(tenantA, 'generic', badConfig)

    const first = await validateNetworkVersion(tenantA, version.id)
    const second = await validateNetworkVersion(tenantA, version.id)
    expect(first.valid).toBe(false)
    expect(first.issues.length).toBeGreaterThanOrEqual(3)
    expect(second.issues).toEqual(first.issues) // identical, byte for byte

    // Issues are canonically ordered (by code).
    const codes = first.issues.map((i) => i.code)
    expect([...codes].sort()).toEqual(codes)
    expect(codes).toContain('M005_CAPABILITIES_INVALID')
    expect(codes).toContain('M011_REWARD_RATE_INVALID')
    expect(codes).toContain('M015_DEPENDENCY_SELF')
  })

  it('the pure manifest validator is total and deterministic for arbitrary garbage', () => {
    const inputs: unknown[] = [
      null,
      42,
      'string',
      [],
      {},
      { asset_types: 'x', capabilities: 'x', verification: 'x', reward: 'x', dependencies: 'x' },
      { ...TEST_CONFIG, asset_types: ['a', 'a'] },
      { ...TEST_CONFIG, capabilities: [...TEST_CONFIG.capabilities, TEST_CONFIG.capabilities[0]] },
      {
        ...TEST_CONFIG,
        capabilities: [
          { type: 'x', unit: 'u', schema_version: 0, fields: { k: 1 } },
        ],
      },
      { ...TEST_CONFIG, verification: { checks: [] } },
      { ...TEST_CONFIG, reward: { ...TEST_CONFIG.reward, platform_fee_pct: 200 } },
      { ...TEST_CONFIG, dependencies: [{ from: 'nope', to: 'w026.capability.alpha' }] },
      { ...TEST_CONFIG, dependencies: [{ from: 'w026.capability.alpha', to: 'w026.capability.alpha' }] },
    ]
    for (const input of inputs) {
      const a = validateNetworkManifest(input)
      const b = validateNetworkManifest(input)
      expect(a).toEqual(b) // deterministic
      expect(a.length).toBeGreaterThan(0) // fail-closed: garbage never validates
    }
    expect(validateNetworkManifest(TEST_CONFIG)).toEqual([]) // the reference config validates
  })

  it('validateNetworkVersion is read-only: no plan rows, no audit rows, no version writes', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const plansBefore = await db.networkPlan.count({ where: { networkVersionId: version.id } })
    const auditsBefore = await db.auditLog.count({ where: { resourceType: 'network_plan' } })
    await validateNetworkVersion(tenantA, version.id)
    expect(await db.networkPlan.count({ where: { networkVersionId: version.id } })).toBe(plansBefore)
    expect(await db.auditLog.count({ where: { resourceType: 'network_plan' } })).toBe(auditsBefore)
  })
})

// ---------------------------------------------------------------------------
// NET-003-AC02 — rejected BEFORE resolution side effects
// ---------------------------------------------------------------------------

describe('WORK-026 — fail-closed rejection before side effects (NET-003-AC02)', () => {
  it('rejects an UNPUBLISHED version with NO plan row and NO audit row', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG, { publish: false })
    const auditsBefore = await db.auditLog.count({ where: { resourceType: 'network_plan' } })

    await expect(resolveNetworkPlan(tenantA, version.id, ownerActor)).rejects.toThrow(ConflictError)

    expect(await db.networkPlan.count({ where: { networkVersionId: version.id } })).toBe(0)
    expect(await db.auditLog.count({ where: { resourceType: 'network_plan' } })).toBe(auditsBefore)
  })

  it('rejects an invalid PUBLISHED manifest with NO plan row and NO audit row', async () => {
    const badConfig = { ...TEST_CONFIG, capabilities: [] } as unknown as VersionConfiguration
    const { version } = await createVersion(tenantA, 'generic', badConfig)
    const auditsBefore = await db.auditLog.count({ where: { resourceType: 'network_plan' } })

    await expect(resolveNetworkPlan(tenantA, version.id, ownerActor)).rejects.toThrow(ValidationError)

    expect(await db.networkPlan.count({ where: { networkVersionId: version.id } })).toBe(0)
    expect(await db.auditLog.count({ where: { resourceType: 'network_plan' } })).toBe(auditsBefore)
  })

  it('rejects a cross-tenant version id uniformly as NOT_FOUND (no leakage)', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    await expect(resolveNetworkPlan(tenantB, version.id, ownerActor)).rejects.toThrow(NotFoundError)
    expect(await db.networkPlan.count({ where: { networkVersionId: version.id } })).toBe(0)
    await expect(validateNetworkVersion(tenantB, version.id)).rejects.toThrow(NotFoundError)
  })

  it('rejects an unknown version id as NOT_FOUND', async () => {
    await expect(resolveNetworkPlan(tenantA, 'does-not-exist', ownerActor)).rejects.toThrow(NotFoundError)
  })

  it('structural invalidity catalog: every canonical constraint is enforced end-to-end', async () => {
    const cases: Array<{ config: unknown; code: string }> = [
      { config: { ...TEST_CONFIG, asset_types: 'not-an-array' }, code: 'M002_ASSET_TYPES_INVALID' },
      { config: { ...TEST_CONFIG, asset_types: ['a', 'a'] }, code: 'M004_ASSET_TYPES_DUPLICATE' },
      { config: { ...TEST_CONFIG, capabilities: [] }, code: 'M005_CAPABILITIES_INVALID' },
      {
        config: {
          ...TEST_CONFIG,
          capabilities: [
            { type: 'x', unit: 'u', schema_version: 1, fields: {} },
            { type: 'x', unit: 'u', schema_version: 1, fields: {} },
          ],
        },
        code: 'M007_CAPABILITY_TYPE_DUPLICATE',
      },
      { config: { ...TEST_CONFIG, verification: { checks: [] } }, code: 'M009_VERIFICATION_CHECKS_INVALID' },
      { config: { ...TEST_CONFIG, verification: { checks: 'x' } }, code: 'M009_VERIFICATION_CHECKS_INVALID' },
      { config: { ...TEST_CONFIG, reward: { type: '', unit: 'u', currency: 'USD', rate: '1' } }, code: 'M010_REWARD_INVALID' },
      { config: { ...TEST_CONFIG, reward: { ...TEST_CONFIG.reward, rate: '-5' } }, code: 'M011_REWARD_RATE_INVALID' },
      { config: { ...TEST_CONFIG, reward: { ...TEST_CONFIG.reward, platform_fee_pct: 101 } }, code: 'M012_REWARD_FEE_INVALID' },
      { config: { ...TEST_CONFIG, dependencies: 'nope' }, code: 'M013_DEPENDENCIES_INVALID' },
      { config: { ...TEST_CONFIG, dependencies: [{ from: '', to: 'w026.capability.alpha' }] }, code: 'M014_DEPENDENCY_INVALID' },
      { config: { ...TEST_CONFIG, dependencies: [{ from: 'w026.capability.alpha', to: 'w026.capability.alpha' }] }, code: 'M015_DEPENDENCY_SELF' },
      { config: { ...TEST_CONFIG, dependencies: [{ from: 'ghost', to: 'w026.capability.alpha' }] }, code: 'M016_DEPENDENCY_DANGLING' },
      {
        config: {
          ...TEST_CONFIG,
          dependencies: [
            { from: 'w026.capability.alpha', to: 'w026.capability.beta' },
            { from: 'w026.capability.alpha', to: 'w026.capability.beta' },
          ],
        },
        code: 'M017_DEPENDENCY_DUPLICATE',
      },
    ]
    for (const { config, code } of cases) {
      const { version } = await createVersion(tenantA, 'generic', config as VersionConfiguration)
      let error: unknown
      try {
        await resolveNetworkPlan(tenantA, version.id, ownerActor)
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as Error).message).toContain(code)
      expect(await db.networkPlan.count({ where: { networkVersionId: version.id } })).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// NET-003-AC03 — deterministic acyclic dependency resolution
// ---------------------------------------------------------------------------

describe('WORK-026 — dependency resolution (NET-003-AC03)', () => {
  it('rejects a dependency CYCLE with the exact cycle path and no side effects', async () => {
    const cyclic: VersionConfiguration = {
      ...TEST_CONFIG,
      capabilities: [
        { type: 'w026.cyc.a', unit: 'unit', schema_version: 1, fields: {} },
        { type: 'w026.cyc.b', unit: 'unit', schema_version: 1, fields: {} },
        { type: 'w026.cyc.c', unit: 'unit', schema_version: 1, fields: {} },
      ],
      dependencies: [
        { from: 'w026.cyc.a', to: 'w026.cyc.b' },
        { from: 'w026.cyc.b', to: 'w026.cyc.c' },
        { from: 'w026.cyc.c', to: 'w026.cyc.a' },
      ],
    }
    const { version } = await createVersion(tenantA, 'generic', cyclic)
    await expect(resolveNetworkPlan(tenantA, version.id, ownerActor)).rejects.toThrow(
      /Dependency graph contains a cycle: w026\.cyc\.a → w026\.cyc\.b → w026\.cyc\.c → w026\.cyc\.a/,
    )
    expect(await db.networkPlan.count({ where: { networkVersionId: version.id } })).toBe(0)
  })

  it('produces the deterministic canonical topological order', async () => {
    const { version } = await createVersion(tenantA, 'generic', DEPENDENCY_CONFIG)
    const plan = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    // a requires b; c requires b; b requires d. Prerequisites first, then
    // lexicographic tiebreak → the canonical order is d, b, a, c.
    expect(plan.plan.dependencyOrder).toEqual(['w026.dep.d', 'w026.dep.b', 'w026.dep.a', 'w026.dep.c'])
  })

  it('no declared dependencies → canonical lexicographic order', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const plan = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    expect(plan.plan.dependencyOrder).toEqual(['w026.capability.alpha', 'w026.capability.beta'])
  })

  it('the pure order resolver is deterministic for repeated calls and graph shapes', () => {
    const nodes = ['n1', 'n2', 'n3', 'n4']
    const deps = [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
      { from: 'n1', to: 'n3' },
      { from: 'n4', to: 'n1' },
    ]
    // Repeated calls → identical order.
    const orders = [0, 1, 2].map(() => resolveDependencyOrder(nodes, deps))
    expect(orders[0]).toEqual(orders[1])
    expect(orders[1]).toEqual(orders[2])
    // Prerequisites first: n3, then n2, then n1, then n4? n4 requires n1;
    // n1 requires n2,n3. Ready initially: {n3} (n1 needs n2,n3; n2 needs n3;
    // n4 needs n1) → n3, n2, n1, n4.
    expect(orders[0]).toEqual(['n3', 'n2', 'n1', 'n4'])
    // Independent nodes fall back to lexicographic order.
    expect(resolveDependencyOrder(['z', 'a', 'm'], [])).toEqual(['a', 'm', 'z'])
    // Diamond: d needs b,c; b needs a; c needs a → a, b, c, d.
    expect(
      resolveDependencyOrder(['d', 'c', 'b', 'a'], [
        { from: 'd', to: 'b' },
        { from: 'd', to: 'c' },
        { from: 'b', to: 'a' },
        { from: 'c', to: 'a' },
      ]),
    ).toEqual(['a', 'b', 'c', 'd'])
  })
})

// ---------------------------------------------------------------------------
// NET-003-AC04 — canonical capability/resource resolution, no vertical branches
// ---------------------------------------------------------------------------

describe('WORK-026 — capability + resource resolution (NET-003-AC04)', () => {
  it('capability resolution matches the materialized Capability catalog rows exactly', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const catalog = await db.capability.findMany({ where: { networkVersionId: version.id } })
    expect(catalog.length).toBe(2)

    const plan = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    const byType = new Map(catalog.map((c) => [c.capabilityType, c]))
    for (const resolved of plan.plan.capabilityResolution) {
      const row = byType.get(resolved.capabilityType)
      expect(row).toBeDefined()
      expect(resolved.materializedCapabilityId).toBe(row!.id)
      expect(resolved.unit).toBe(row!.unit)
      expect(resolved.schemaVersion).toBe(row!.schemaVersion)
    }
  })

  it('a TAMPERED capability catalog fails closed (integrity rejection)', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const catalog = await db.capability.findMany({ where: { networkVersionId: version.id } })
    // Remove one materialized row (direct DB tampering for the adversarial
    // setup) → the declared manifest no longer matches the catalog.
    await db.capability.delete({ where: { id: catalog[0].id } })
    await expect(resolveNetworkPlan(tenantA, version.id, ownerActor)).rejects.toThrow(ValidationError)
    expect(await db.networkPlan.count({ where: { networkVersionId: version.id } })).toBe(0)
    // Restoring the catalog row makes resolution succeed again.
    await db.capability.create({
      data: {
        tenantId: tenantA,
        networkVersionId: version.id,
        capabilityType: catalog[0].capabilityType,
        schemaVersion: catalog[0].schemaVersion,
        fieldsJson: catalog[0].fieldsJson,
        unit: catalog[0].unit,
      },
    })
    const plan = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    expect(plan.plan.capabilityResolution.length).toBe(2)
  })

  it('resource discovery resolves verified bindings and excludes ineligible ones', async () => {
    const { network, version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    // Two verified resources for alpha.
    const r1 = await createVerifiedResource(tenantA, network.id, 'w026.capability.alpha', '10', 'kW')
    const r2 = await createVerifiedResource(tenantA, network.id, 'w026.capability.alpha', '20', 'kW')
    // A suspended assignment (excluded).
    const suspended = await createVerifiedResource(tenantA, network.id, 'w026.capability.alpha', '99', 'kW', 'suspended')
    // An assignment with NO verified quantity (excluded — unverified capacity
    // is not implementation-ready).
    const operator = await createOperator(tenantA, { displayName: `W026 Op ${slugCounter}` })
    const asset = await createAsset(tenantA, { operatorId: operator.id, assetType: 'w026-asset', name: `W026 Asset ${slugCounter}` })
    const unverified = await assignAssetToNetwork(tenantA, asset.id, network.id, 'w026.capability.alpha')
    expect(unverified.verifiedQuantity).toBeNull()
    // An assignment in ANOTHER network (excluded by network scope).
    const other = await createVersion(tenantA, 'generic', TEST_CONFIG)
    await createVerifiedResource(tenantA, other.network.id, 'w026.capability.alpha', '55', 'kW')

    const plan = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    const alpha = plan.plan.resourceDiscovery.find((d) => d.capabilityType === 'w026.capability.alpha')!
    expect(alpha).toBeDefined()
    expect(alpha.resources.map((r) => r.resourceId).sort()).toEqual([r1.assignment.id, r2.assignment.id].sort())
    expect(alpha.resources.every((r) => r.verifiedQuantity !== '99')).toBe(true) // suspended excluded
    expect(alpha.resources.every((r) => r.resourceId !== unverified.id)).toBe(true) // unverified excluded

    // Beta has NO resources — explicitly empty, not hidden.
    const beta = plan.plan.resourceDiscovery.find((d) => d.capabilityType === 'w026.capability.beta')!
    expect(beta.resources).toEqual([])
  })

  it('discovered resources carry the authoritative verified quantity + unit', async () => {
    const { network, version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const r = await createVerifiedResource(tenantA, network.id, 'w026.capability.beta', '42.5', 'TB')
    const plan = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    const beta = plan.plan.resourceDiscovery.find((d) => d.capabilityType === 'w026.capability.beta')!
    expect(beta.resources.length).toBe(1)
    expect(beta.resources[0]).toEqual({
      resourceId: r.assignment.id,
      assetId: r.asset.id,
      verifiedQuantity: '42.5',
      verifiedUnit: 'TB',
    })
  })

  it('the SAME resolution mechanics for every vertical (no vertical-specific branch)', async () => {
    for (const vertical of ['generic', 'compute', 'storage', 'wireless']) {
      const { network, version } = await createVersion(tenantA, vertical, TEST_CONFIG)
      await createVerifiedResource(tenantA, network.id, 'w026.capability.alpha', '7', vertical === 'compute' ? 'GPU' : 'unit')
      const plan = await resolveNetworkPlan(tenantA, version.id, ownerActor)
      // Identical plan schema, identical stage lists, identical sections.
      expect(Object.keys(plan.plan).sort()).toEqual([
        'assetTypes',
        'capabilities',
        'capabilityResolution',
        'dependencies',
        'dependencyOrder',
        'planSchemaVersion',
        'remainingLaunchStages',
        'resolvedStages',
        'resourceDiscovery',
        'reward',
        'source',
        'verification',
      ])
      expect(plan.plan.resolvedStages).toEqual([
        'validation',
        'dependency_resolution',
        'capability_resolution',
        'resource_discovery',
      ])
      expect(plan.plan.remainingLaunchStages).toEqual([
        'allocation',
        'reservation',
        'commitment',
        'provisioning',
        'runtime_activation',
        'verification',
        'deployed',
      ])
      expect(plan.plan.source.vertical).toBe(vertical)
      expect(plan.plan.resourceDiscovery[0].resources.length).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// NET-004-AC01 — deterministic canonical resolution result
// ---------------------------------------------------------------------------

describe('WORK-026 — deterministic resolution (NET-004-AC01)', () => {
  it('re-resolution under UNCHANGED repository state returns the SAME artifact (idempotent)', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const first = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    const second = await resolveNetworkPlan(tenantA, version.id, operatorActor) // different actor: same artifact
    const third = await resolveNetworkPlan(tenantA, version.id, adminActor)
    expect(second.id).toBe(first.id)
    expect(second.planChecksum).toBe(first.planChecksum)
    expect(third.id).toBe(first.id)
    expect(await db.networkPlan.count({ where: { networkVersionId: version.id } })).toBe(1)
  })

  it('repository-state changes produce NEW canonical artifacts; reverting state restores the ORIGINAL checksum', async () => {
    const { network, version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const resource = await createVerifiedResource(tenantA, network.id, 'w026.capability.alpha', '10', 'kW')

    const plan1 = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    expect(plan1.plan.resourceDiscovery[0].resources.length).toBe(1)

    // Repository state changes (new verified resource) → new checksum + new row.
    await createVerifiedResource(tenantA, network.id, 'w026.capability.alpha', '20', 'kW')
    const plan2 = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    expect(plan2.id).not.toBe(plan1.id)
    expect(plan2.planChecksum).not.toBe(plan1.planChecksum)
    expect(plan2.plan.resourceDiscovery[0].resources.length).toBe(2)
    expect(await db.networkPlan.count({ where: { networkVersionId: version.id } })).toBe(2)

    // Deactivating the added resource reverts the authoritative state →
    // re-resolution reproduces the ORIGINAL canonical result AND returns the
    // original artifact row (the same (version, checksum) pair).
    const assignments = await db.assetNetworkAssignment.findMany({
      where: { tenantId: tenantA, networkId: network.id, capabilityType: 'w026.capability.alpha' },
    })
    const second = assignments.find((a) => a.id !== resource.assignment.id)!
    await db.assetNetworkAssignment.update({ where: { id: second.id }, data: { status: 'suspended' } })
    const plan3 = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    expect(plan3.planChecksum).toBe(plan1.planChecksum)
    expect(plan3.id).toBe(plan1.id)
    expect(await db.networkPlan.count({ where: { networkVersionId: version.id } })).toBe(2) // no new row
  })

  it('canonical resource ordering is independent of creation/DB order', async () => {
    const { network, version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    // Create three resources; DB order is not guaranteed canonical.
    const created = [] as string[]
    for (let i = 0; i < 3; i++) {
      const r = await createVerifiedResource(tenantA, network.id, 'w026.capability.alpha', `${(i + 1) * 5}`, 'kW')
      created.push(r.assignment.id)
    }
    const plan = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    const discovered = plan.plan.resourceDiscovery[0].resources.map((r) => r.resourceId)
    expect(discovered).toEqual([...created].sort()) // canonical: sorted by resourceId
  })

  it('the canonical serialization + checksum are independently reproducible', async () => {
    const { version } = await createVersion(tenantA, 'generic', DEPENDENCY_CONFIG)
    const plan = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    const row = await db.networkPlan.findUnique({ where: { id: plan.id } })
    expect(row).toBeDefined()
    // The stored planJson re-serializes to itself (canonical fixed point).
    expect(canonicalJsonStringify(JSON.parse(row!.planJson))).toBe(row!.planJson)
    // The checksum is sha256(planJson), independently verified.
    expect(computePlanChecksum(row!.planJson)).toBe(row!.planChecksum)
    expect(createHash('sha256').update(row!.planJson, 'utf8').digest('hex')).toBe(plan.planChecksum)
  })
})

// ---------------------------------------------------------------------------
// NET-004-AC02 — no allocation / provisioning / activation / lifecycle mutation
// ---------------------------------------------------------------------------

describe('WORK-026 — resolution owns no later pipeline stage (NET-004-AC02)', () => {
  it('resolution creates NO NetworkInstance rows', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const before = await db.networkInstance.count({ where: { tenantId: tenantA } })
    await resolveNetworkPlan(tenantA, version.id, ownerActor)
    await resolveNetworkPlan(tenantA, version.id, ownerActor)
    expect(await db.networkInstance.count({ where: { tenantId: tenantA } })).toBe(before)
  })

  it('resolution does NOT mutate NetworkInstance lifecycle state', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const instance = await createNetworkInstance(tenantA, { networkVersionId: version.id }, ownerActor)
    await transitionNetworkInstanceLifecycle(
      tenantA,
      instance.id,
      LIFECYCLE_STATE.PROVISIONING,
      ownerActor,
    )
    await resolveNetworkPlan(tenantA, version.id, ownerActor)
    const reloaded = await db.networkInstance.findUnique({ where: { id: instance.id } })
    expect(reloaded!.lifecycleState).toBe(LIFECYCLE_STATE.PROVISIONING) // untouched
  })

  it('resolution performs NO allocation/reservation/commitment (no capacity rows)', async () => {
    const { network, version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    await createVerifiedResource(tenantA, network.id, 'w026.capability.alpha', '10', 'kW')
    const reservationsBefore = await db.capacityReservation.count()
    const commitmentsBefore = await db.vppDispatchAssignment.count()
    await resolveNetworkPlan(tenantA, version.id, ownerActor)
    expect(await db.capacityReservation.count()).toBe(reservationsBefore)
    expect(await db.vppDispatchAssignment.count()).toBe(commitmentsBefore)
    // Resource assignments are untouched (discovery is read-only).
    const assignments = await db.assetNetworkAssignment.findMany({
      where: { tenantId: tenantA, networkId: network.id },
    })
    expect(assignments.every((a) => a.status === 'active')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// NET-004-AC03 — explicit output for the next provisioning/launch stage
// ---------------------------------------------------------------------------

describe('WORK-026 — explicit resolution output (NET-004-AC03)', () => {
  it('the plan content has EXACTLY the documented sections (no hidden state)', async () => {
    const { version } = await createVersion(tenantA, 'generic', DEPENDENCY_CONFIG)
    const plan = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    const expected = [
      'planSchemaVersion',
      'source',
      'assetTypes',
      'capabilities',
      'verification',
      'reward',
      'dependencies',
      'dependencyOrder',
      'capabilityResolution',
      'resourceDiscovery',
      'resolvedStages',
      'remainingLaunchStages',
    ]
    expect(Object.keys(plan.plan).sort()).toEqual([...expected].sort())
    // The source section identifies the immutable published artifact fully.
    expect(Object.keys(plan.plan.source).sort()).toEqual([
      'networkId',
      'networkVersionId',
      'publishedAt',
      'runtimeKind',
      'version',
      'vertical',
    ])
    expect(plan.plan.source.networkVersionId).toBe(version.id)
    expect(plan.plan.source.runtimeKind).toBe('infrastructure')
    expect(plan.plan.source.publishedAt).toBe(version.publishedAt!.toISOString())
    // Declared policy is carried explicitly for the next stage.
    expect(plan.plan.verification).toEqual({ checks: ['schema_validation'] })
    expect(plan.plan.reward).toEqual(TEST_CONFIG.reward)
    // Dependencies are carried in the CANONICAL (from, to) order — the same
    // content as declared, deterministically ordered.
    expect(plan.plan.dependencies).toEqual(
      [...DEPENDENCY_CONFIG.dependencies!].sort((a, b) =>
        a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : 1,
      ),
    )
  })

  it('plans are durable and readable: getNetworkPlan + listNetworkPlans', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const created = await resolveNetworkPlan(tenantA, version.id, ownerActor)

    const reloaded = await getNetworkPlan(tenantA, created.id)
    expect(reloaded.id).toBe(created.id)
    expect(reloaded.planChecksum).toBe(created.planChecksum)
    expect(reloaded.plan.dependencyOrder).toEqual(created.plan.dependencyOrder)
    expect(reloaded.createdAt).toBe(created.createdAt)

    const listed = await listNetworkPlans(tenantA, { networkVersionId: version.id })
    expect(listed.map((p) => p.id)).toContain(created.id)
  })

  it('the plan explicitly surfaces zero-resource capabilities (nothing hidden)', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const plan = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    expect(plan.plan.resourceDiscovery.length).toBe(2) // one entry per declared capability
    expect(plan.plan.resourceDiscovery.every((d) => d.resources.length === 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// NET-004-AC04 — tenant isolation + authorization + audit + concurrency
// ---------------------------------------------------------------------------

describe('WORK-026 — tenant isolation + authorization + audit (NET-004-AC04)', () => {
  it('viewers are DENIED the persisting resolve operation', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    await expect(resolveNetworkPlan(tenantA, version.id, viewerActor)).rejects.toThrow(ForbiddenError)
    expect(await db.networkPlan.count({ where: { networkVersionId: version.id } })).toBe(0)
  })

  it('operator and admin may resolve; the read paths stay role-unrestricted but tenant-scoped', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const byOperator = await resolveNetworkPlan(tenantA, version.id, operatorActor)
    const byAdmin = await resolveNetworkPlan(tenantA, version.id, adminActor)
    expect(byAdmin.id).toBe(byOperator.id)
    // Reads: any actor shape is not required — validateNetworkVersion and
    // getNetworkPlan take no actor at all (tenant scope only).
    const outcome = await validateNetworkVersion(tenantA, version.id)
    expect(outcome.valid).toBe(true)
  })

  it('tenant B cannot READ tenant A plans (uniform NOT_FOUND; no cross-tenant listing)', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const plan = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    await expect(getNetworkPlan(tenantB, plan.id)).rejects.toThrow(NotFoundError)
    const bPlans = await listNetworkPlans(tenantB)
    expect(bPlans.map((p) => p.id)).not.toContain(plan.id)
  })

  it('successful resolution writes ONE audit row atomically with the artifact', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const before = await db.auditLog.count({
      where: { tenantId: tenantA, resourceType: 'network_plan' },
    })
    const plan = await resolveNetworkPlan(tenantA, version.id, ownerActor)
    const rows = await db.auditLog.findMany({
      where: { tenantId: tenantA, resourceType: 'network_plan', resourceId: plan.id },
    })
    expect(rows.length).toBe(1)
    expect(await db.auditLog.count({ where: { tenantId: tenantA, resourceType: 'network_plan' } })).toBe(before + 1)
    const metadata = JSON.parse(rows[0].metadataJson)
    expect(metadata.networkVersionId).toBe(version.id)
    expect(metadata.planChecksum).toBe(plan.planChecksum)
    expect(metadata.version).toBe(version.version)
    // Idempotent re-resolution does not duplicate the audit row.
    await resolveNetworkPlan(tenantA, version.id, ownerActor)
    expect(
      await db.auditLog.count({
        where: { tenantId: tenantA, resourceType: 'network_plan', resourceId: plan.id },
      }),
    ).toBe(1)
  })

  it('racing resolutions of the same version converge to EXACTLY ONE artifact', async () => {
    const { version } = await createVersion(tenantA, 'generic', TEST_CONFIG)
    const [a, b, c] = await Promise.all([
      resolveNetworkPlan(tenantA, version.id, ownerActor),
      resolveNetworkPlan(tenantA, version.id, operatorActor),
      resolveNetworkPlan(tenantA, version.id, adminActor),
    ])
    expect(new Set([a.id, b.id, c.id]).size).toBe(1)
    expect(await db.networkPlan.count({ where: { networkVersionId: version.id } })).toBe(1)
  })
})
