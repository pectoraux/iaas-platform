/// <reference types="bun-types" />
/**
 * WORK-016 — ExtensionRegistry PostgreSQL Integration Tests
 *
 * Proves W016-AC01..AC07 against real PostgreSQL:
 *   - registration + idempotency
 *   - tenant-scoped lookup (cross-tenant isolation)
 *   - version compatibility
 *   - certification metadata
 *   - revocation metadata
 *   - lifecycle transitions (registered → installed → activated ⇌ deactivated → revoked)
 *   - concurrent registration convergence
 *
 * Run: bun test tests/work-016-extension-registry-pg.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import {
  registerExtension,
  getExtension,
  listExtensions,
  checkExtensionVersionCompatibility,
  updateExtensionCertification,
  revokeExtension,
  transitionLifecycle,
  LIFECYCLE_STATE,
} from '../src/lib/services/extension-registry.service'
import { NotFoundError, ConflictError, ValidationError } from '../src/lib/domain/errors'

let tenantA: string
let tenantB: string

beforeAll(async () => {
  const tA = await createTenant({
    name: 'W016 Registry Tenant A',
    slug: `w016-reg-a-${Date.now()}`,
    plan: 'growth',
  })
  tenantA = tA.id

  const tB = await createTenant({
    name: 'W016 Registry Tenant B',
    slug: `w016-reg-b-${Date.now()}`,
    plan: 'growth',
  })
  tenantB = tB.id
})

describe('WORK-016 — ExtensionRegistry PostgreSQL (W016-AC01..AC07)', () => {
  it('registers an extension and looks it up by (type, version) (W016-AC01)', async () => {
    const result = await registerExtension(tenantA, {
      extensionType: `routing-${Date.now()}`,
      extensionVersion: '1.0.0',
      description: 'Test routing extension',
      idempotencyKey: `reg-${Date.now()}`,
    })
    expect(result.id).toBeTruthy()
    expect(result.extensionType).toContain('routing')
    expect(result.extensionVersion).toBe('1.0.0')
    expect(result.lifecycleState).toBe('registered')

    const fetched = await getExtension(tenantA, result.extensionType, '1.0.0')
    expect(fetched.id).toBe(result.id)
  })

  it('idempotent registration returns the same entry (W016-AC05)', async () => {
    const type = `idempotent-${Date.now()}`
    const first = await registerExtension(tenantA, {
      extensionType: type,
      extensionVersion: '2.0.0',
      idempotencyKey: `idem-${Date.now()}`,
    })
    const second = await registerExtension(tenantA, {
      extensionType: type,
      extensionVersion: '2.0.0',
      idempotencyKey: `idem-different`,
    })
    expect(second.id).toBe(first.id)
  })

  it('tenant isolation: tenant B cannot see tenant A entries (W016-AC06)', async () => {
    const type = `isolated-${Date.now()}`
    await registerExtension(tenantA, {
      extensionType: type,
      extensionVersion: '1.0.0',
      idempotencyKey: `iso-${Date.now()}`,
    })
    await expect(
      getExtension(tenantB, type, '1.0.0'),
    ).rejects.toThrow(NotFoundError)
  })

  it('tenant isolation: tenant B can register the same (type, version) independently (W016-AC06)', async () => {
    const type = `shared-type-${Date.now()}`
    const entryA = await registerExtension(tenantA, {
      extensionType: type,
      extensionVersion: '1.0.0',
      idempotencyKey: `shared-a-${Date.now()}`,
    })
    const entryB = await registerExtension(tenantB, {
      extensionType: type,
      extensionVersion: '1.0.0',
      idempotencyKey: `shared-b-${Date.now()}`,
    })
    expect(entryA.id).not.toBe(entryB.id)
  })

  it('version compatibility check works without executing extensions (W016-AC02)', async () => {
    const type = `compat-${Date.now()}`
    await registerExtension(tenantA, {
      extensionType: type,
      extensionVersion: '1.5.0',
      compatibleVersions: ['1.0.0', '1.5.0', '*'],
      idempotencyKey: `compat-${Date.now()}`,
    })
    const result = await checkExtensionVersionCompatibility(tenantA, type, '1.0.0')
    expect(result.compatible).toBe(true)
  })

  it('certification metadata is updated (W016-AC03)', async () => {
    const type = `cert-${Date.now()}`
    await registerExtension(tenantA, {
      extensionType: type,
      extensionVersion: '1.0.0',
      idempotencyKey: `cert-${Date.now()}`,
    })
    const updated = await updateExtensionCertification(tenantA, type, '1.0.0', {
      certifierIdentity: 'certifier-alpha',
      certificationStatus: 'certified',
    })
    expect(updated.certificationStatus).toBe('certified')
    expect(updated.certifierIdentity).toBe('certifier-alpha')
    expect(updated.certifiedAt).toBeTruthy()
  })

  it('revocation metadata is updated and prevents double-revocation (W016-AC03)', async () => {
    const type = `revoke-${Date.now()}`
    await registerExtension(tenantA, {
      extensionType: type,
      extensionVersion: '1.0.0',
      idempotencyKey: `revoke-${Date.now()}`,
    })
    const revoked = await revokeExtension(tenantA, type, '1.0.0', {
      reason: 'Security vulnerability',
    })
    expect(revoked.revocationStatus).toBe('revoked')
    expect(revoked.revocationReason).toBe('Security vulnerability')
    expect(revoked.revokedAt).toBeTruthy()
    // Revocation also transitions lifecycle to revoked
    expect(revoked.lifecycleState).toBe('revoked')

    await expect(
      revokeExtension(tenantA, type, '1.0.0', { reason: 'duplicate' }),
    ).rejects.toThrow(ConflictError)
  })

  it('lifecycle transitions: registered → installed → activated → deactivated → revoked (W016-AC04)', async () => {
    const type = `lifecycle-${Date.now()}`
    const registered = await registerExtension(tenantA, {
      extensionType: type,
      extensionVersion: '1.0.0',
      idempotencyKey: `lc-${Date.now()}`,
    })
    expect(registered.lifecycleState).toBe('registered')

    const installed = await transitionLifecycle(tenantA, type, '1.0.0', LIFECYCLE_STATE.INSTALLED)
    expect(installed.lifecycleState).toBe('installed')

    const activated = await transitionLifecycle(tenantA, type, '1.0.0', LIFECYCLE_STATE.ACTIVATED)
    expect(activated.lifecycleState).toBe('activated')

    const deactivated = await transitionLifecycle(tenantA, type, '1.0.0', LIFECYCLE_STATE.DEACTIVATED)
    expect(deactivated.lifecycleState).toBe('deactivated')

    // Can reactivate
    const reactivated = await transitionLifecycle(tenantA, type, '1.0.0', LIFECYCLE_STATE.ACTIVATED)
    expect(reactivated.lifecycleState).toBe('activated')

    // Revoke (terminal)
    const revoked = await transitionLifecycle(tenantA, type, '1.0.0', LIFECYCLE_STATE.REVOKED)
    expect(revoked.lifecycleState).toBe('revoked')

    // Cannot transition from revoked
    await expect(
      transitionLifecycle(tenantA, type, '1.0.0', LIFECYCLE_STATE.ACTIVATED),
    ).rejects.toThrow(ConflictError)
  })

  it('invalid lifecycle transition is rejected (W016-AC04)', async () => {
    const type = `invalid-trans-${Date.now()}`
    await registerExtension(tenantA, {
      extensionType: type,
      extensionVersion: '1.0.0',
      idempotencyKey: `invalid-${Date.now()}`,
    })
    // registered → activated is invalid (must go through installed first)
    await expect(
      transitionLifecycle(tenantA, type, '1.0.0', LIFECYCLE_STATE.ACTIVATED),
    ).rejects.toThrow(ValidationError)
  })

  it('listExtensions returns tenant-scoped entries (W016-AC01)', async () => {
    const type = `list-${Date.now()}`
    await registerExtension(tenantA, {
      extensionType: type,
      extensionVersion: '1.0.0',
      idempotencyKey: `list-1-${Date.now()}`,
    })
    await registerExtension(tenantA, {
      extensionType: type,
      extensionVersion: '2.0.0',
      idempotencyKey: `list-2-${Date.now()}`,
    })
    const entries = await listExtensions(tenantA, { extensionType: type })
    expect(entries.length).toBeGreaterThanOrEqual(2)
    // Tenant B must see zero entries for this type
    const entriesB = await listExtensions(tenantB, { extensionType: type })
    expect(entriesB.length).toBe(0)
  })

  it('concurrent registrations with same tuple converge (W016-AC05)', async () => {
    const type = `concurrent-${Date.now()}`
    const promises = Array.from({ length: 5 }, (_, i) =>
      registerExtension(tenantA, {
        extensionType: type,
        extensionVersion: '1.0.0',
        idempotencyKey: `conc-${i}-${Date.now()}`,
      }),
    )
    const results = await Promise.all(promises)
    const ids = new Set(results.map(r => r.id))
    expect(ids.size).toBe(1)
  })
})
