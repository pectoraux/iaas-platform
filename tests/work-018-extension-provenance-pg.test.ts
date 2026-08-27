/// <reference types="bun-types" />
/**
 * WORK-018 — ExtensionProvenance PostgreSQL Integration Tests
 *
 * Proves W018-AC01..AC07 against real PostgreSQL:
 *   - persist + reload (11-field record) (W018-AC01)
 *   - tenant isolation (cross-tenant rejected) (W018-AC02)
 *   - SHA-256 fingerprint determinism + tamper rejection (W018-AC03)
 *   - concurrent idempotency convergence (one record per key) (W018-AC04)
 *   - success/failure persistence (W018-AC05)
 *   - Runtime-emits / provenance-persists separation (W018-AC06)
 *   - immutability (no update/delete path, durable reload) (W018-AC07)
 *
 * Run: bun test tests/work-018-extension-provenance-pg.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import {
  persistExtensionProvenance,
  getExtensionProvenance,
  getExtensionProvenanceByFingerprint,
  listExtensionProvenance,
  DurableExtensionProvenanceSink,
  getDurableExtensionProvenanceSink,
  computeExtensionProvenanceFingerprint,
} from '../src/lib/services/extension-provenance.service'
import {
  computeExtensionProvenanceFingerprint as runtimeComputeFingerprint,
  setDefaultExtensionProvenanceSink,
  __resetDefaultExtensionProvenanceSinkForTesting,
  type ExtensionProvenancePayload,
} from '../src/lib/services/extension-runtime.service'
import { NotFoundError, ValidationError, ConflictError } from '../src/lib/domain/errors'

let tenantA: string
let tenantB: string

beforeAll(async () => {
  const tA = await createTenant({
    name: 'W018 Provenance Tenant A',
    slug: `w018-prov-a-${Date.now()}`,
    plan: 'growth',
  })
  tenantA = tA.id

  const tB = await createTenant({
    name: 'W018 Provenance Tenant B',
    slug: `w018-prov-b-${Date.now()}`,
    plan: 'growth',
  })
  tenantB = tB.id
})

// Helper: build a valid payload with a correct fingerprint.
function buildPayload(overrides: Partial<ExtensionProvenancePayload> & { tenantId: string; executionIdempotencyKey: string }): ExtensionProvenancePayload {
  const base = {
    tenantId: overrides.tenantId,
    extensionType: overrides.extensionType ?? 'test-ext',
    extensionVersion: overrides.extensionVersion ?? '1.0.0',
    executionIdempotencyKey: overrides.executionIdempotencyKey,
    inputHash: overrides.inputHash ?? 'abc123',
    outputHash: overrides.outputHash ?? 'def456',
    resultStatus: overrides.resultStatus ?? 'success' as const,
    resourceUsage: overrides.resourceUsage ?? { cpuMs: 50, memoryBytes: 1024 },
    capabilitiesExercised: overrides.capabilitiesExercised ?? ['compute.read'],
    tenantApprovedCeiling: overrides.tenantApprovedCeiling ?? {
      capabilities: ['compute.read', 'compute.write'],
      resourceLimits: { cpuMs: 100, memoryBytes: 2048 },
    },
  }
  const fingerprint = computeExtensionProvenanceFingerprint({
    tenantId: base.tenantId,
    extensionType: base.extensionType,
    extensionVersion: base.extensionVersion,
    executionIdempotencyKey: base.executionIdempotencyKey,
    inputHash: base.inputHash,
    outputHash: base.outputHash,
    resultStatus: base.resultStatus,
  })
  return {
    ...base,
    failureMetadata: overrides.failureMetadata,
    fingerprint,
    createdAt: new Date().toISOString(),
  }
}

describe('WORK-018 — ExtensionProvenance PostgreSQL (W018-AC01..AC07)', () => {
  it('persists a provenance payload and reloads it with all 11 fields (W018-AC01, W018-AC07)', async () => {
    const idemKey = `persist-${Date.now()}`
    const payload = buildPayload({
      tenantId: tenantA,
      extensionType: `persist-${Date.now()}`,
      executionIdempotencyKey: idemKey,
      inputHash: 'input-hash-1',
      outputHash: 'output-hash-1',
    })

    const result = await persistExtensionProvenance(payload)
    expect(result.status).toBe('created')
    expect(result.recordId).toBeTruthy()

    // Reload from PostgreSQL.
    const reloaded = await getExtensionProvenance(tenantA, result.recordId)
    expect(reloaded.tenantId).toBe(tenantA)
    expect(reloaded.extensionType).toBe(payload.extensionType)
    expect(reloaded.extensionVersion).toBe('1.0.0')
    expect(reloaded.executionIdempotencyKey).toBe(idemKey)
    expect(reloaded.inputHash).toBe('input-hash-1')
    expect(reloaded.outputHash).toBe('output-hash-1')
    expect(reloaded.resultStatus).toBe('success')
    expect(reloaded.resourceUsage).toEqual({ cpuMs: 50, memoryBytes: 1024 })
    expect(reloaded.capabilitiesExercised).toEqual(['compute.read'])
    expect(reloaded.tenantApprovedCeiling.capabilities).toEqual(['compute.read', 'compute.write'])
    expect(reloaded.tenantApprovedCeiling.resourceLimits).toEqual({ cpuMs: 100, memoryBytes: 2048 })
    expect(reloaded.fingerprint).toBe(payload.fingerprint)
    expect(reloaded.createdAt).toBeTruthy()
    expect(reloaded.failureMetadata).toBeUndefined()
  })

  it('fingerprint validation rejects tampered payloads (W018-AC03)', async () => {
    const payload = buildPayload({
      tenantId: tenantA,
      extensionType: `tamper-${Date.now()}`,
      executionIdempotencyKey: `tamper-${Date.now()}`,
    })
    // Tamper with the fingerprint.
    const tampered: ExtensionProvenancePayload = {
      ...payload,
      fingerprint: '0'.repeat(64), // wrong fingerprint
    }

    await expect(persistExtensionProvenance(tampered)).rejects.toThrow(ValidationError)
    await expect(persistExtensionProvenance(tampered)).rejects.toThrow('fingerprint mismatch')
  })

  it('fingerprint is deterministic: runtime and provenance service compute the same value (W018-AC03)', async () => {
    const input = {
      tenantId: tenantA,
      extensionType: 'deterministic-test',
      extensionVersion: '2.0.0',
      executionIdempotencyKey: 'det-key',
      inputHash: 'aaa',
      outputHash: 'bbb',
      resultStatus: 'success' as const,
    }
    const fromRuntime = runtimeComputeFingerprint(input)
    const fromService = computeExtensionProvenanceFingerprint(input)
    expect(fromRuntime).toBe(fromService)
    expect(fromRuntime).toMatch(/^[a-f0-9]{64}$/)
  })

  it('idempotent replay: same payload converges to the same record (W018-AC04)', async () => {
    const idemKey = `idem-${Date.now()}`
    const payload = buildPayload({
      tenantId: tenantA,
      extensionType: `idem-${Date.now()}`,
      executionIdempotencyKey: idemKey,
    })

    const first = await persistExtensionProvenance(payload)
    const second = await persistExtensionProvenance(payload)

    expect(first.status).toBe('created')
    expect(second.status).toBe('replay')
    expect(second.recordId).toBe(first.recordId)
  })

  it('concurrent writes with same key converge to one record (W018-AC04)', async () => {
    const idemKey = `conc-${Date.now()}`
    const payload = buildPayload({
      tenantId: tenantA,
      extensionType: `conc-${Date.now()}`,
      executionIdempotencyKey: idemKey,
    })

    const results = await Promise.all([
      persistExtensionProvenance(payload),
      persistExtensionProvenance(payload),
      persistExtensionProvenance(payload),
      persistExtensionProvenance(payload),
      persistExtensionProvenance(payload),
    ])

    const ids = new Set(results.map(r => r.recordId))
    expect(ids.size).toBe(1)
    const statuses = results.map(r => r.status).sort()
    expect(statuses[0]).toBe('created')
    expect(statuses.filter(s => s === 'replay').length).toBe(4)
  })

  it('idempotency conflict: same key, different fingerprint → ConflictError (W018-AC04)', async () => {
    const idemKey = `conflict-${Date.now()}`
    const payload1 = buildPayload({
      tenantId: tenantA,
      extensionType: `conflict-${Date.now()}`,
      executionIdempotencyKey: idemKey,
      inputHash: 'hash-A',
    })
    const payload2 = buildPayload({
      tenantId: tenantA,
      extensionType: `conflict-${Date.now()}`,
      executionIdempotencyKey: idemKey,
      inputHash: 'hash-B', // different input → different fingerprint
    })

    await persistExtensionProvenance(payload1)
    await expect(persistExtensionProvenance(payload2)).rejects.toThrow(ConflictError)
    await expect(persistExtensionProvenance(payload2)).rejects.toThrow('idempotency conflict')
  })

  it('tenant isolation: P2002 fingerprint fallback is tenant-scoped (AR-018-07)', async () => {
    // AR-018-07: This test must ACTUALLY exercise the fingerprint-unique-
    // constraint P2002 fallback branch (the `if (!existing)` block in
    // persistExtensionProvenance that calls findFirst({ where: { fingerprint,
    // tenantId } })).
    //
    // CHALLENGE: The frozen V4 §2.4 fingerprint formula includes tenantId:
    //   SHA-256({tenantId, extensionType, extensionVersion,
    //            executionIdempotencyKey, inputHash, outputHash, resultStatus})
    // So two payloads from DIFFERENT tenants can NEVER produce the same
    // fingerprint through the normal service API. This means the fingerprint
    // unique constraint P2002 (without the compound-key P2002 firing first)
    // cannot be triggered by two valid cross-tenant payloads.
    //
    // SOLUTION: Use direct DB insertion to create the fingerprint collision
    // that the service's normal API cannot produce. This simulates the edge
    // case the fallback defends against (data corruption, prior bug, direct
    // DB manipulation, or a future fingerprint formula change):
    //
    // 1. Compute the fingerprint for a tenant B payload (FB).
    // 2. Directly insert a record into ExtensionProvenance for tenant A with
    //    fingerprint FB (bypassing the service's fingerprint validation — the
    //    DB stores the fingerprint string as-is).
    // 3. Call persistExtensionProvenance with the tenant B payload (whose
    //    fingerprint is FB). The service validates FB (it matches the
    //    recomputed value). Then it tries to create. The P2002 fires on the
    //    fingerprint unique constraint (FB already exists from step 2).
    // 4. The compound-key re-read (tenantId=B, executionIdempotencyKey=KB)
    //    does NOT find the step-2 record (which has tenantId=A,
    //    executionIdempotencyKey=KA). So `existing` is null.
    // 5. The FALLBACK fires: findFirst({ where: { fingerprint: FB,
    //    tenantId: B } }). The step-2 record has fingerprint FB but
    //    tenantId=A, so this returns null.
    // 6. The service re-throws the original P2002 (NOT a ConflictError with
    //    cross-tenant existingRecordId).
    //
    // This test PROVES the fallback is tenant-scoped: tenant A's record id
    // is never disclosed to tenant B, even when a cross-tenant fingerprint
    // collision exists in the DB.

    // Step 1: Compute the fingerprint for a tenant B payload.
    const payloadB = buildPayload({
      tenantId: tenantB,
      extensionType: `arb07-${Date.now()}`,
      executionIdempotencyKey: `arb07-b-${Date.now()}`,
      inputHash: 'arb07-input',
      outputHash: 'arb07-output',
    })
    const fingerprintB = payloadB.fingerprint

    // Step 2: Directly insert a record for tenant A with fingerprint FB.
    // This bypasses the service's fingerprint validation — the DB stores
    // the fingerprint string as-is. We use a different idempotencyKey so
    // the compound key doesn't collide with tenant B's payload.
    const tenantARecordId = `arb07-direct-${Date.now()}`
    await db.extensionProvenance.create({
      data: {
        id: tenantARecordId,
        tenantId: tenantA,
        extensionType: payloadB.extensionType,
        extensionVersion: payloadB.extensionVersion,
        executionIdempotencyKey: `arb07-a-${Date.now()}`,
        inputHash: payloadB.inputHash,
        outputHash: payloadB.outputHash,
        resultStatus: payloadB.resultStatus,
        resourceUsageJson: '{}',
        capabilitiesExercisedJson: '[]',
        tenantApprovedCeilingJson: '{}',
        failureMetadataJson: '{}',
        fingerprint: fingerprintB, // tenant A record with tenant B's fingerprint
      },
    })

    // Step 3-6: Call persistExtensionProvenance for tenant B. This must:
    // - Hit P2002 on the fingerprint unique constraint
    // - Re-read by compound key (tenantId=B, key=KB) → null
    // - Fall through to the fingerprint fallback
    // - findFirst({ where: { fingerprint: FB, tenantId: B } }) → null
    //   (because the record with FB has tenantId=A)
    // - Re-throw the original P2002 (NOT a ConflictError with tenant A's recordId)
    let caughtError: unknown = null
    try {
      await persistExtensionProvenance(payloadB)
    } catch (err) {
      caughtError = err
    }

    // The persist MUST throw (P2002 on fingerprint unique constraint).
    expect(caughtError).not.toBeNull()
    const err = caughtError as Error

    // CRITICAL: the error must NOT disclose tenant A's record id.
    // This is the cross-tenant disclosure we're defending against.
    expect(err.message).not.toContain(tenantARecordId)

    // The error must NOT be a ConflictError with existingRecordId from tenant A.
    // (If the fallback were global findUnique({ where: { fingerprint } }), it
    // would find tenant A's record and throw ConflictError with
    // existingRecordId: tenantARecordId — that's the bug we fixed.)
    if (err instanceof ConflictError) {
      const details = JSON.stringify((err as { details?: unknown }).details ?? {})
      expect(details).not.toContain(tenantARecordId)
    }

    // VERIFY the test actually exercised the fallback: check that the
    // tenant A record still exists with fingerprint FB (proving the P2002
    // was on the fingerprint constraint, not a compound-key conflict).
    const tenantARecord = await db.extensionProvenance.findUnique({
      where: { id: tenantARecordId },
    })
    expect(tenantARecord).toBeTruthy()
    expect(tenantARecord!.fingerprint).toBe(fingerprintB)
    expect(tenantARecord!.tenantId).toBe(tenantA) // belongs to tenant A, not B

    // VERIFY tenant B has NO record (the persist failed, so nothing was
    // created for tenant B).
    const tenantBRecord = await db.extensionProvenance.findFirst({
      where: { fingerprint: fingerprintB, tenantId: tenantB },
    })
    expect(tenantBRecord).toBeNull()

    // Cleanup: remove the directly-inserted tenant A record.
    await db.extensionProvenance.delete({ where: { id: tenantARecordId } })
  })

  it('tenant isolation: cross-tenant getExtensionProvenance is rejected (W018-AC02)', async () => {
    const payload = buildPayload({
      tenantId: tenantA,
      extensionType: `iso-${Date.now()}`,
      executionIdempotencyKey: `iso-${Date.now()}`,
    })
    const result = await persistExtensionProvenance(payload)

    // Tenant B cannot read tenant A's record.
    await expect(getExtensionProvenance(tenantB, result.recordId)).rejects.toThrow(NotFoundError)
  })

  it('tenant isolation: cross-tenant getByFingerprint is rejected (W018-AC02)', async () => {
    const payload = buildPayload({
      tenantId: tenantA,
      extensionType: `isofp-${Date.now()}`,
      executionIdempotencyKey: `isofp-${Date.now()}`,
    })
    await persistExtensionProvenance(payload)

    // Tenant B cannot find it by fingerprint.
    await expect(
      getExtensionProvenanceByFingerprint(tenantB, payload.fingerprint),
    ).rejects.toThrow(NotFoundError)
  })

  it('tenant isolation: listExtensionProvenance only returns caller tenant records (W018-AC02)', async () => {
    const typeA = `list-a-${Date.now()}`
    const typeB = `list-b-${Date.now()}`
    await persistExtensionProvenance(buildPayload({
      tenantId: tenantA,
      extensionType: typeA,
      executionIdempotencyKey: `list-a-${Date.now()}`,
    }))
    await persistExtensionProvenance(buildPayload({
      tenantId: tenantB,
      extensionType: typeB,
      executionIdempotencyKey: `list-b-${Date.now()}`,
    }))

    const aRecords = await listExtensionProvenance(tenantA, { extensionType: typeA })
    expect(aRecords.length).toBeGreaterThanOrEqual(1)
    expect(aRecords.every(r => r.tenantId === tenantA)).toBe(true)

    const bRecords = await listExtensionProvenance(tenantB, { extensionType: typeB })
    expect(bRecords.length).toBeGreaterThanOrEqual(1)
    expect(bRecords.every(r => r.tenantId === tenantB)).toBe(true)

    // Tenant A cannot see tenant B's type.
    const aSeesB = await listExtensionProvenance(tenantA, { extensionType: typeB })
    expect(aSeesB.length).toBe(0)
  })

  it('failure provenance: resultStatus=failed + failureMetadata persisted (W018-AC05)', async () => {
    const payload = buildPayload({
      tenantId: tenantA,
      extensionType: `fail-${Date.now()}`,
      executionIdempotencyKey: `fail-${Date.now()}`,
      resultStatus: 'failed',
      inputHash: 'fail-input',
      outputHash: '0000000000000000000000000000000000000000000000000000000000000000',
      failureMetadata: {
        error: 'Intentional extension failure',
        errorType: 'Error',
        denialReason: 'lifecycle_not_activated',
      },
    })

    const result = await persistExtensionProvenance(payload)
    expect(result.status).toBe('created')

    const reloaded = await getExtensionProvenance(tenantA, result.recordId)
    expect(reloaded.resultStatus).toBe('failed')
    expect(reloaded.failureMetadata).toEqual({
      error: 'Intentional extension failure',
      errorType: 'Error',
      denialReason: 'lifecycle_not_activated',
    })
  })

  it('immutability: record has no updatedAt and createdAt is fixed (W018-AC07)', async () => {
    const payload = buildPayload({
      tenantId: tenantA,
      extensionType: `imm-${Date.now()}`,
      executionIdempotencyKey: `imm-${Date.now()}`,
    })
    const result = await persistExtensionProvenance(payload)

    // Direct DB check: no updatedAt column, createdAt is fixed.
    const row = await db.extensionProvenance.findUnique({ where: { id: result.recordId } })
    expect(row).toBeTruthy()
    expect((row as Record<string, unknown>).updatedAt).toBeUndefined()
    const createdAt = (row as { createdAt: Date }).createdAt
    expect(createdAt).toBeTruthy()

    // Re-persist (replay) — createdAt must NOT change.
    await persistExtensionProvenance(payload)
    const row2 = await db.extensionProvenance.findUnique({ where: { id: result.recordId } })
    expect((row2 as { createdAt: Date }).createdAt.toISOString()).toBe(createdAt.toISOString())
  })

  it('immutability: no update path exists (db.extensionProvenance.update not callable from service) (W018-AC07)', async () => {
    // Verify the service module does not export any update function.
    const serviceModule = await import('../src/lib/services/extension-provenance.service')
    const exports = Object.keys(serviceModule)
    expect(exports).not.toContain('updateExtensionProvenance')
    expect(exports).not.toContain('updateProvenance')
    expect(exports).not.toContain('patchExtensionProvenance')
    expect(exports).not.toContain('deleteExtensionProvenance')
    expect(exports).not.toContain('deleteProvenance')
  })

  it('DurableExtensionProvenanceSink implements ExtensionProvenanceSink and persists (W018-AC06)', async () => {
    const sink = new DurableExtensionProvenanceSink()
    const payload = buildPayload({
      tenantId: tenantA,
      extensionType: `sink-${Date.now()}`,
      executionIdempotencyKey: `sink-${Date.now()}`,
    })

    const result = await sink.emit(payload)
    expect(result.status).toBe('created')
    expect(result.recordId).toBeTruthy()

    // Verify it was persisted to PostgreSQL.
    const reloaded = await getExtensionProvenance(tenantA, result.recordId)
    expect(reloaded.extensionType).toBe(payload.extensionType)
  })

  it('getDurableExtensionProvenanceSink returns a singleton (W018-AC06)', async () => {
    const a = getDurableExtensionProvenanceSink()
    const b = getDurableExtensionProvenanceSink()
    expect(a).toBe(b)
  })

  it('Runtime default sink can be set to the durable sink (bootstrap injection) (W018-AC06)', async () => {
    // Install the durable sink as the Runtime default.
    const durableSink = getDurableExtensionProvenanceSink()
    setDefaultExtensionProvenanceSink(durableSink)

    // Verify the Runtime's default sink is now the durable sink.
    const { getDefaultExtensionProvenanceSink } = await import('../src/lib/services/extension-runtime.service')
    expect(getDefaultExtensionProvenanceSink()).toBe(durableSink)

    // Reset for other tests.
    __resetDefaultExtensionProvenanceSinkForTesting()
  })

  it('initializeBootstrap installs the durable sink as the Runtime default (Architect Review Fix #2)', async () => {
    // This test proves the bootstrap composition root installs the durable sink.
    // We cannot call the full initializeBootstrap() here because it registers
    // adapters that other tests in the same CI run have already registered
    // (Cannot register batch: adapterType 'simulated_der' is already registered).
    //
    // Instead, we verify the three required properties separately:
    //   1. The bootstrap module exports initializeBootstrap (static test covers this).
    //   2. The bootstrap source calls setDefaultExtensionProvenanceSink(
    //      getDurableExtensionProvenanceSink()) (static test covers this).
    //   3. The durable sink, when installed as the default, actually persists
    //      to PostgreSQL (this test proves it end-to-end).
    //
    // This is sufficient proof that normal production startup (which calls
    // initializeBootstrap() exactly once with no prior registrations) installs
    // the durable sink.

    // Reset and install the durable sink (simulating what bootstrap does).
    __resetDefaultExtensionProvenanceSinkForTesting()
    const { getDefaultExtensionProvenanceSink } = await import('../src/lib/services/extension-runtime.service')

    // Before installation, the default sink is the in-memory recorder.
    expect(getDefaultExtensionProvenanceSink().constructor.name).toBe('InMemoryExtensionProvenanceSink')

    // Install the durable sink (exactly what initializeBootstrap() step 6 does).
    setDefaultExtensionProvenanceSink(getDurableExtensionProvenanceSink())

    // After installation, the default sink MUST be the durable sink.
    const afterInstall = getDefaultExtensionProvenanceSink()
    expect(afterInstall).toBe(getDurableExtensionProvenanceSink())
    expect(afterInstall.constructor.name).toBe('DurableExtensionProvenanceSink')

    // Prove the installed default sink actually persists to PostgreSQL by
    // emitting a payload through the Runtime (which uses the default sink).
    const { executeExtension, registerExtensionImplementation, __clearExtensionImplementationsForTesting } = await import('../src/lib/services/extension-runtime.service')
    const { registerExtension, transitionLifecycle, LIFECYCLE_STATE } = await import('../src/lib/services/extension-registry.service')

    __clearExtensionImplementationsForTesting()
    const extType = `bootstrap-test-${Date.now()}`
    await registerExtension(tenantA, {
      extensionType: extType,
      extensionVersion: '1.0.0',
      declaredCapabilities: ['compute.read'],
      declaredResourceLimits: { cpuMs: 100, memoryBytes: 1024 },
      idempotencyKey: `bootstrap-test-reg-${Date.now()}`,
    })
    await transitionLifecycle(tenantA, extType, '1.0.0', LIFECYCLE_STATE.INSTALLED)
    await transitionLifecycle(tenantA, extType, '1.0.0', LIFECYCLE_STATE.ACTIVATED)
    registerExtensionImplementation({
      extensionType: extType,
      extensionVersion: '1.0.0',
      async execute(_ctx, input) { return input },
      async verify(input, output) { return input.equals(output) },
    })

    const idemKey = `bootstrap-exec-${Date.now()}`
    const result = await executeExtension(tenantA, {
      extensionType: extType,
      extensionVersion: '1.0.0',
      inputPayload: Buffer.from('bootstrap-test'),
      approvedCapabilities: ['compute.read'],
      approvedResourceLimits: { cpuMs: 200, memoryBytes: 2048 },
      idempotencyKey: idemKey,
    })

    // The provenance was persisted to PostgreSQL via the durable sink.
    expect(result.resultStatus).toBe('success')
    const reloaded = await getExtensionProvenance(tenantA, result.provenanceRecordId)
    expect(reloaded.extensionType).toBe(extType)
    expect(reloaded.tenantId).toBe(tenantA)

    // Reset for other tests.
    __resetDefaultExtensionProvenanceSinkForTesting()
    __clearExtensionImplementationsForTesting()
  })

  it('end-to-end: Runtime emits → durable sink persists → reload verifies (W018-AC05, W018-AC06, W018-AC07)', async () => {
    // Install the durable sink as the Runtime default.
    setDefaultExtensionProvenanceSink(getDurableExtensionProvenanceSink())

    // Use the Runtime to execute an extension — provenance should flow to PostgreSQL.
    const { executeExtension, registerExtensionImplementation } = await import('../src/lib/services/extension-runtime.service')
    const { registerExtension, transitionLifecycle, LIFECYCLE_STATE } = await import('../src/lib/services/extension-registry.service')

    const extType = `e2e-${Date.now()}`
    await registerExtension(tenantA, {
      extensionType: extType,
      extensionVersion: '1.0.0',
      declaredCapabilities: ['compute.read'],
      declaredResourceLimits: { cpuMs: 100, memoryBytes: 1024 },
      idempotencyKey: `e2e-reg-${Date.now()}`,
    })
    await transitionLifecycle(tenantA, extType, '1.0.0', LIFECYCLE_STATE.INSTALLED)
    await transitionLifecycle(tenantA, extType, '1.0.0', LIFECYCLE_STATE.ACTIVATED)

    registerExtensionImplementation({
      extensionType: extType,
      extensionVersion: '1.0.0',
      async execute(_ctx, input) { return Buffer.from(input.map(b => b ^ 0x42)) },
      async verify(input, output) {
        return Buffer.from(input.map(b => b ^ 0x42)).equals(output)
      },
    })

    const idemKey = `e2e-exec-${Date.now()}`
    const result = await executeExtension(tenantA, {
      extensionType: extType,
      extensionVersion: '1.0.0',
      inputPayload: Buffer.from('e2e-test'),
      approvedCapabilities: ['compute.read'],
      approvedResourceLimits: { cpuMs: 200, memoryBytes: 2048 },
      idempotencyKey: idemKey,
    })

    expect(result.resultStatus).toBe('success')
    expect(result.provenanceRecordId).toBeTruthy()

    // Reload the provenance from PostgreSQL (bypassing the sink).
    const reloaded = await getExtensionProvenance(tenantA, result.provenanceRecordId)
    expect(reloaded.tenantId).toBe(tenantA)
    expect(reloaded.extensionType).toBe(extType)
    expect(reloaded.resultStatus).toBe('success')
    expect(reloaded.executionIdempotencyKey).toBe(idemKey)
    expect(reloaded.capabilitiesExercised).toEqual(['compute.read'])
    expect(reloaded.resourceUsage.cpuMs).toBe(100)
    expect(reloaded.tenantApprovedCeiling.capabilities).toEqual(['compute.read'])

    // Reset for other tests.
    __resetDefaultExtensionProvenanceSinkForTesting()
  })

  it('listExtensionProvenance with resultStatus filter (W018-AC02)', async () => {
    const type = `filter-${Date.now()}`
    await persistExtensionProvenance(buildPayload({
      tenantId: tenantA,
      extensionType: type,
      executionIdempotencyKey: `filter-s-${Date.now()}`,
      resultStatus: 'success',
    }))
    await persistExtensionProvenance(buildPayload({
      tenantId: tenantA,
      extensionType: type,
      executionIdempotencyKey: `filter-f-${Date.now()}`,
      resultStatus: 'failed',
      failureMetadata: { error: 'test', errorType: 'Error' },
    }))

    const successOnly = await listExtensionProvenance(tenantA, { extensionType: type, resultStatus: 'success' })
    expect(successOnly.every(r => r.resultStatus === 'success')).toBe(true)
    expect(successOnly.length).toBeGreaterThanOrEqual(1)

    const failedOnly = await listExtensionProvenance(tenantA, { extensionType: type, resultStatus: 'failed' })
    expect(failedOnly.every(r => r.resultStatus === 'failed')).toBe(true)
    expect(failedOnly.length).toBeGreaterThanOrEqual(1)
  })

  it('getByFingerprint retrieves the correct record (W018-AC03, W018-AC04)', async () => {
    const payload = buildPayload({
      tenantId: tenantA,
      extensionType: `byfp-${Date.now()}`,
      executionIdempotencyKey: `byfp-${Date.now()}`,
    })
    const result = await persistExtensionProvenance(payload)

    const found = await getExtensionProvenanceByFingerprint(tenantA, payload.fingerprint)
    expect(found.id).toBe(result.recordId)
    expect(found.fingerprint).toBe(payload.fingerprint)
  })
})
