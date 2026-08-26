/**
 * Phase 5.1: Runtime Resolution Integration Tests (DB-backed)
 *
 * These tests close the two gaps identified in the Phase 5 audit:
 *
 *   ⚠️ Persisted-version → runtime integration test:
 *      Prove a real persisted NetworkVersion flows through the resolver
 *      and produces the correct NetworkRuntime implementation.
 *
 *   ⚠️ Published runtime immutability behavioral test:
 *      Prove the runtimeKind of a published version cannot be changed,
 *      and that an invalid runtimeKind (set via direct DB access) is
 *      rejected at publication.
 *
 * These tests require PostgreSQL (the canonical provider). They run in CI
 * via the postgres-integration-tests job. They cannot run in a SQLite-only
 * sandbox.
 *
 * Run: bun test tests/runtime-resolution-integration.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate, createNetworkVersion, publishNetworkVersion, getNetwork } from '../src/lib/services/network.service'
import { resolveRuntime } from '../src/lib/kernel/runtime'
import { InfrastructureRuntime } from '../src/lib/kernel/runtime/infrastructure-runtime'
import { ProtocolRuntime } from '../src/lib/kernel/runtime/protocol-runtime'
import { initializeBootstrap } from '../src/lib/bootstrap'

let tenantId: string
let networkId: string

beforeAll(async () => {
  // WORK-004 (BASE-001): the test is its own composition root — it must
  // initialize the bootstrap so the RuntimeRegistry has the concrete runtimes
  // registered before resolveRuntime() is called. This mirrors the documented
  // bootstrap boundary (src/lib/bootstrap/index.ts: tests call
  // initializeBootstrap() directly as their own composition root).
  initializeBootstrap()

  const tenant = await createTenant({
    name: 'Phase 5.1 Runtime Integration',
    slug: `p51-rt-${Date.now()}`,
    plan: 'growth',
  })
  tenantId = tenant.id

  // Instantiate the energy-vpp template — this creates a network + a published
  // version with runtimeKind='infrastructure' (the template default).
  const { network } = await instantiateTemplate(tenantId, 'energy-vpp')
  networkId = network.id
})

// ---------------------------------------------------------------------------
// Test 1: A persisted, published NetworkVersion flows through the resolver
// ---------------------------------------------------------------------------

describe('Phase 5.1: persisted NetworkVersion → runtime resolution', () => {
  it('a published energy-vpp version (runtimeKind=infrastructure) resolves to InfrastructureRuntime', async () => {
    // Load the network with its published version.
    const network = await getNetwork(tenantId, networkId)
    expect(network.currentVersionId).toBeTruthy()

    const publishedVersion = await db.networkVersion.findUnique({
      where: { id: network.currentVersionId! },
    })
    expect(publishedVersion).toBeTruthy()
    expect(publishedVersion!.publishedAt).toBeTruthy() // it IS published
    expect(publishedVersion!.runtimeKind).toBe('infrastructure') // template default

    // Resolve the runtime from the persisted version's runtimeKind.
    const runtime = resolveRuntime(publishedVersion!.runtimeKind as any)

    // The resolver must return the InfrastructureRuntime implementation.
    expect(runtime).toBeInstanceOf(InfrastructureRuntime)
    expect(runtime.kind).toBe('infrastructure')
  })

  it('resolveRuntime returns the SAME instance for the same kind (registry is stable)', async () => {
    // The registry is a singleton — resolving the same kind twice returns
    // the same instance. This proves the registry is not creating a new
    // runtime per call (which would defeat the purpose of a registry).
    const version = await db.networkVersion.findFirst({
      where: { networkId, publishedAt: { not: null } },
    })
    expect(version).toBeTruthy()

    const runtime1 = resolveRuntime(version!.runtimeKind as any)
    const runtime2 = resolveRuntime(version!.runtimeKind as any)
    expect(runtime1).toBe(runtime2) // same instance
  })
})

// ---------------------------------------------------------------------------
// Test 2: runtimeKind immutability for published versions
// ---------------------------------------------------------------------------

describe('Phase 5.1: published runtimeKind is immutable', () => {
  it('creating a second version with a different runtimeKind does NOT change the first version', async () => {
    // The first version is published with runtimeKind='infrastructure'.
    const network = await getNetwork(tenantId, networkId)
    const firstVersionId = network.currentVersionId!
    const firstVersion = await db.networkVersion.findUnique({ where: { id: firstVersionId } })
    expect(firstVersion!.runtimeKind).toBe('infrastructure')
    expect(firstVersion!.publishedAt).toBeTruthy()

    // Create a SECOND draft version with runtimeKind='protocol'.
    // This is allowed — a new runtime choice requires a new NetworkVersion.
    const config = JSON.parse(firstVersion!.configurationJson)
    const secondVersion = await createNetworkVersion(tenantId, networkId, config, undefined, 'protocol')
    expect(secondVersion.runtimeKind).toBe('protocol')
    expect(secondVersion.publishedAt).toBeNull() // draft, not published

    // The FIRST version's runtimeKind is unchanged.
    const firstVersionAfter = await db.networkVersion.findUnique({ where: { id: firstVersionId } })
    expect(firstVersionAfter!.runtimeKind).toBe('infrastructure') // unchanged
    expect(firstVersionAfter!.publishedAt).toBeTruthy() // still published
  })

  it('publishing a version with an invalid runtimeKind (set via direct DB) is rejected', async () => {
    // Simulate direct DB access that sets an invalid runtimeKind on a draft.
    const network = await getNetwork(tenantId, networkId)
    const config = JSON.parse(
      (await db.networkVersion.findFirst({ where: { networkId } }))!.configurationJson,
    )
    const version = await createNetworkVersion(tenantId, networkId, config, undefined, 'infrastructure')

    // Direct DB access: set an invalid runtimeKind (bypassing the application).
    await db.networkVersion.update({
      where: { id: version.id },
      data: { runtimeKind: 'banana' }, // invalid
    })

    // Now attempt to publish. The publication-readiness gate validates
    // runtimeKind against the allowed set — this must be rejected.
    await expect(
      publishNetworkVersion(tenantId, networkId, version.id),
    ).rejects.toThrow(/Invalid runtimeKind/)

    // The version must NOT be published (publishedAt still null).
    const unpublished = await db.networkVersion.findUnique({ where: { id: version.id } })
    expect(unpublished!.publishedAt).toBeNull()
    expect(unpublished!.runtimeKind).toBe('banana') // the invalid value remains in the draft
  })

  it('publishing a version with runtimeKind=protocol resolves to ProtocolRuntime (stub)', async () => {
    // A version with runtimeKind='protocol' CAN be published (the kind is
    // valid). It resolves to the ProtocolRuntime stub. Execution operations
    // on it will throw NotImplemented — that's expected for Phase 5.
    const network = await getNetwork(tenantId, networkId)
    const config = JSON.parse(
      (await db.networkVersion.findFirst({ where: { networkId } }))!.configurationJson,
    )
    const version = await createNetworkVersion(tenantId, networkId, config, undefined, 'protocol')

    // Publish — should succeed (protocol is a valid kind).
    // Note: energy_vpp vertical requires an accepted baseline policy.
    // The template's baseline evaluation runs in instantiateTemplate, but
    // for a manually-created version we need to run it first.
    const { runAndPersistBaselineEvaluation } = await import('../src/lib/services/baseline-evaluation.service')
    await runAndPersistBaselineEvaluation({ tenantId, networkVersionId: version.id, numScenarios: 50 })

    const published = await publishNetworkVersion(tenantId, networkId, version.id)
    expect(published).toBeTruthy()
    expect(published!.publishedAt).toBeTruthy()
    expect(published!.runtimeKind).toBe('protocol')

    // The published version resolves to ProtocolRuntime.
    const runtime = resolveRuntime(published!.runtimeKind as any)
    expect(runtime).toBeInstanceOf(ProtocolRuntime)
    expect(runtime.kind).toBe('protocol')
  })
})

// ---------------------------------------------------------------------------
// Test 3: A published version with an unregistered runtimeKind cannot execute
// ---------------------------------------------------------------------------

describe('Phase 5.1: unregistered runtimeKind on a published version throws on resolution', () => {
  it('a version with runtimeKind set to an unregistered value throws when resolved', async () => {
    // Simulate a published version with an unregistered runtimeKind.
    // (In practice this can't happen via the application because publication
    // validates runtimeKind, but this test proves the resolver is the last
    // line of defense.)
    const network = await getNetwork(tenantId, networkId)
    const config = JSON.parse(
      (await db.networkVersion.findFirst({ where: { networkId } }))!.configurationJson,
    )
    const version = await createNetworkVersion(tenantId, networkId, config, undefined, 'infrastructure')

    // Direct DB access: set an unregistered runtimeKind AND publish it.
    // (This bypasses the application's publication gate, simulating a
    // future migration bug or direct DB intervention.)
    await db.networkVersion.update({
      where: { id: version.id },
      data: { runtimeKind: 'edge', publishedAt: new Date() },
    })

    // Load the persisted version.
    const persisted = await db.networkVersion.findUnique({ where: { id: version.id } })
    expect(persisted!.runtimeKind).toBe('edge')
    expect(persisted!.publishedAt).toBeTruthy()

    // Resolving an unregistered kind must throw — no silent fallback.
    expect(() => resolveRuntime(persisted!.runtimeKind as any)).toThrow(/No runtime registered/)
  })
})
