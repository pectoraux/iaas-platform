/// <reference types="bun-types" />
/**
 * WORK-010 — TransformRegistry PostgreSQL Integration Tests
 *
 * Proves W010-AC01..AC05 against real PostgreSQL:
 *   - registration + idempotency
 *   - tenant-scoped lookup (cross-tenant isolation)
 *   - version compatibility
 *   - certification metadata
 *   - revocation metadata
 *   - concurrent registration convergence
 *
 * Run: bun test tests/work-010-transform-registry-pg.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import {
  registerTransform,
  getTransform,
  listTransforms,
  checkVersionCompatibility,
  updateCertification,
  revokeTransform,
} from '../src/lib/services/transform-registry.service'
import { NotFoundError, ConflictError } from '../src/lib/domain/errors'

let tenantA: string
let tenantB: string

beforeAll(async () => {
  const tA = await createTenant({
    name: 'WORK-010 Registry Tenant A',
    slug: `w010-reg-a-${Date.now()}`,
    plan: 'growth',
  })
  tenantA = tA.id

  const tB = await createTenant({
    name: 'WORK-010 Registry Tenant B',
    slug: `w010-reg-b-${Date.now()}`,
    plan: 'growth',
  })
  tenantB = tB.id
})

describe('WORK-010 — TransformRegistry PostgreSQL (W010-AC01..AC05)', () => {
  it('registers a transform and looks it up by (type, version) (W010-AC01)', async () => {
    const result = await registerTransform(tenantA, {
      transformType: `compression-${Date.now()}`,
      transformVersion: '1.0.0',
      description: 'Test compression transform',
      idempotencyKey: `reg-${Date.now()}`,
    })
    expect(result.id).toBeTruthy()
    expect(result.transformType).toContain('compression')
    expect(result.transformVersion).toBe('1.0.0')

    const fetched = await getTransform(tenantA, result.transformType, '1.0.0')
    expect(fetched.id).toBe(result.id)
  })

  it('idempotent registration returns the same entry (W010-AC04)', async () => {
    const type = `idempotent-${Date.now()}`
    const first = await registerTransform(tenantA, {
      transformType: type,
      transformVersion: '2.0.0',
      idempotencyKey: `idem-${Date.now()}`,
    })
    const second = await registerTransform(tenantA, {
      transformType: type,
      transformVersion: '2.0.0',
      idempotencyKey: `idem-different-key`,
    })
    expect(second.id).toBe(first.id)
  })

  it('tenant isolation: tenant B cannot see tenant A entries (W010-AC05)', async () => {
    const type = `isolated-${Date.now()}`
    await registerTransform(tenantA, {
      transformType: type,
      transformVersion: '1.0.0',
      idempotencyKey: `iso-${Date.now()}`,
    })
    // Tenant B lookup must throw NotFoundError.
    await expect(
      getTransform(tenantB, type, '1.0.0'),
    ).rejects.toThrow(NotFoundError)
  })

  it('tenant isolation: tenant B can register the same (type, version) independently (W010-AC05)', async () => {
    const type = `shared-type-${Date.now()}`
    const entryA = await registerTransform(tenantA, {
      transformType: type,
      transformVersion: '1.0.0',
      idempotencyKey: `shared-a-${Date.now()}`,
    })
    const entryB = await registerTransform(tenantB, {
      transformType: type,
      transformVersion: '1.0.0',
      idempotencyKey: `shared-b-${Date.now()}`,
    })
    expect(entryA.id).not.toBe(entryB.id)
    // Both tenants see their own entry.
    const fetchedA = await getTransform(tenantA, type, '1.0.0')
    const fetchedB = await getTransform(tenantB, type, '1.0.0')
    expect(fetchedA.id).toBe(entryA.id)
    expect(fetchedB.id).toBe(entryB.id)
  })

  it('version compatibility check works without executing transforms (W010-AC02)', async () => {
    const type = `compat-${Date.now()}`
    await registerTransform(tenantA, {
      transformType: type,
      transformVersion: '1.5.0',
      compatibleVersions: ['1.0.0', '1.5.0', '*'],
      idempotencyKey: `compat-${Date.now()}`,
    })
    const result = await checkVersionCompatibility(tenantA, type, '1.0.0')
    expect(result.compatible).toBe(true)
    const result2 = await checkVersionCompatibility(tenantA, type, '2.0.0')
    expect(result2.compatible).toBe(true) // '*' matches
  })

  it('certification metadata is updated (W010-AC03)', async () => {
    const type = `cert-${Date.now()}`
    await registerTransform(tenantA, {
      transformType: type,
      transformVersion: '1.0.0',
      idempotencyKey: `cert-${Date.now()}`,
    })
    const updated = await updateCertification(tenantA, type, '1.0.0', {
      certifierIdentity: 'certifier-alpha',
      certificationStatus: 'certified',
    })
    expect(updated.certificationStatus).toBe('certified')
    expect(updated.certifierIdentity).toBe('certifier-alpha')
    expect(updated.certifiedAt).toBeTruthy()
  })

  it('revocation metadata is updated and prevents double-revocation (W010-AC03)', async () => {
    const type = `revoke-${Date.now()}`
    await registerTransform(tenantA, {
      transformType: type,
      transformVersion: '1.0.0',
      idempotencyKey: `revoke-${Date.now()}`,
    })
    const revoked = await revokeTransform(tenantA, type, '1.0.0', {
      reason: 'Security vulnerability discovered',
    })
    expect(revoked.revocationStatus).toBe('revoked')
    expect(revoked.revocationReason).toBe('Security vulnerability discovered')
    expect(revoked.revokedAt).toBeTruthy()

    // Double-revocation must throw.
    await expect(
      revokeTransform(tenantA, type, '1.0.0', { reason: 'duplicate' }),
    ).rejects.toThrow(ConflictError)
  })

  it('listTransforms returns tenant-scoped entries (W010-AC01)', async () => {
    const type = `list-${Date.now()}`
    await registerTransform(tenantA, {
      transformType: type,
      transformVersion: '1.0.0',
      idempotencyKey: `list-1-${Date.now()}`,
    })
    await registerTransform(tenantA, {
      transformType: type,
      transformVersion: '2.0.0',
      idempotencyKey: `list-2-${Date.now()}`,
    })
    const entries = await listTransforms(tenantA, { transformType: type })
    expect(entries.length).toBeGreaterThanOrEqual(2)
    // Tenant B must see zero entries for this type.
    const entriesB = await listTransforms(tenantB, { transformType: type })
    expect(entriesB.length).toBe(0)
  })

  it('concurrent registrations with same tuple converge (W010-AC04)', async () => {
    const type = `concurrent-${Date.now()}`
    const promises = Array.from({ length: 5 }, (_, i) =>
      registerTransform(tenantA, {
        transformType: type,
        transformVersion: '1.0.0',
        idempotencyKey: `conc-${i}-${Date.now()}`,
      }),
    )
    const results = await Promise.all(promises)
    // All 5 must return the same entry id (idempotent convergence).
    const ids = new Set(results.map(r => r.id))
    expect(ids.size).toBe(1)
  })
})
