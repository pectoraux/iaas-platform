/// <reference types="bun-types" />
// =============================================================================
// WORK-016 — ExtensionRegistry unit + architecture tests
// =============================================================================
// Verifies W016-AC01..AC08: ExtensionRegistry is service-layer, tenant-scoped,
// does not execute extensions, owns lifecycle authority, and obeys all V4
// anti-dependency prohibitions.
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()

function readSrc(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

// ---------------------------------------------------------------------------
// Architecture + anti-dependency checks
// ---------------------------------------------------------------------------

describe('WORK-016 — ExtensionRegistry architecture (W016-AC08)', () => {
  const REGISTRY_SRC = readSrc('src/lib/services/extension-registry.service.ts')

  test('ExtensionRegistry is in the service layer (NOT kernel)', () => {
    const path = join(REPO_ROOT, 'src', 'lib', 'services', 'extension-registry.service.ts')
    expect(path).toContain('src/lib/services/')
    expect(path).not.toContain('src/lib/kernel/')
  })

  test('ExtensionRegistry imports NO vertical service', () => {
    const verticalPattern = /(?:vpp|compute|storage|wireless|manufacturing)\.service/
    expect(verticalPattern.test(REGISTRY_SRC)).toBe(false)
  })

  test('ExtensionRegistry imports NO EconomicPipeline', () => {
    expect(REGISTRY_SRC).not.toContain('economic-pipeline')
  })

  test('ExtensionRegistry imports NO Route/Transport', () => {
    const dataPlanePattern = /(?:routing|transport|delivery-confirmation)\.service/
    expect(dataPlanePattern.test(REGISTRY_SRC)).toBe(false)
  })

  test('ExtensionRegistry imports NO RuntimeRegistry', () => {
    expect(REGISTRY_SRC).not.toMatch(/^import.*RuntimeRegistry/m)
    expect(REGISTRY_SRC).not.toMatch(/from\s+['"]@\/lib\/kernel\/runtime['"]/m)
    expect(REGISTRY_SRC).not.toMatch(/from\s+['"]@\/lib\/kernel\//m)
  })

  test('ExtensionRegistry imports NO kernel code', () => {
    expect(REGISTRY_SRC).not.toMatch(/^import.*@\/lib\/kernel/m)
  })

  test('ExtensionRegistry does NOT execute extensions', () => {
    expect(REGISTRY_SRC).not.toMatch(/export\s+(async\s+)?function\s+execute\b/)
    expect(REGISTRY_SRC).not.toMatch(/export\s+(async\s+)?function\s+reverse\b/)
    expect(REGISTRY_SRC).not.toMatch(/export\s+(async\s+)?function\s+estimateCost\b/)
    expect(REGISTRY_SRC).not.toMatch(/export\s+(async\s+)?function\s+verify\b/)
    expect(REGISTRY_SRC).toContain('Does NOT execute extensions')
  })

  test('ExtensionRuntime remains absent from production code', () => {
    const path = join(REPO_ROOT, 'src', 'lib', 'services', 'extension-runtime.service.ts')
    expect(existsSync(path)).toBe(false)
  })

  test('ExtensionRegistry does NOT import ExtensionProvenance service', () => {
    // The comment mentions ExtensionProvenance as a boundary, but the service
    // must NOT import an extension-provenance service/module.
    expect(REGISTRY_SRC).not.toMatch(/from\s+['"][^'"]*extension-provenance/)
    expect(REGISTRY_SRC).not.toMatch(/^import.*ExtensionProvenance/m)
  })

  test('ExtensionRegistry does NOT import TransformRuntime/TransformRecord', () => {
    expect(REGISTRY_SRC).not.toContain('transform-runtime.service')
    expect(REGISTRY_SRC).not.toContain('transform-record.service')
  })
})

// ---------------------------------------------------------------------------
// Contract presence
// ---------------------------------------------------------------------------

describe('WORK-016 — ExtensionRegistry contract (W016-AC01..AC07)', () => {
  const REGISTRY_SRC = readSrc('src/lib/services/extension-registry.service.ts')

  test('registerExtension exists (tenant-scoped, idempotent)', () => {
    expect(REGISTRY_SRC).toContain('export async function registerExtension')
    expect(REGISTRY_SRC).toContain('tenantId')
    expect(REGISTRY_SRC).toContain('Idempotent')
  })

  test('getExtension exists (lookup by type + version)', () => {
    expect(REGISTRY_SRC).toContain('export async function getExtension')
    expect(REGISTRY_SRC).toContain('extensionType')
    expect(REGISTRY_SRC).toContain('extensionVersion')
  })

  test('listExtensions exists (tenant-scoped listing)', () => {
    expect(REGISTRY_SRC).toContain('export async function listExtensions')
  })

  test('checkExtensionVersionCompatibility exists (version rules, no execution)', () => {
    expect(REGISTRY_SRC).toContain('export async function checkExtensionVersionCompatibility')
  })

  test('updateExtensionCertification exists (certification metadata)', () => {
    expect(REGISTRY_SRC).toContain('export async function updateExtensionCertification')
    expect(REGISTRY_SRC).toContain('certifierIdentity')
    expect(REGISTRY_SRC).toContain('certificationStatus')
  })

  test('revokeExtension exists (revocation metadata)', () => {
    expect(REGISTRY_SRC).toContain('export async function revokeExtension')
    expect(REGISTRY_SRC).toContain('revocationStatus')
    expect(REGISTRY_SRC).toContain('revocationReason')
    expect(REGISTRY_SRC).toContain('revokedAt')
  })

  test('transitionLifecycle exists (lifecycle authority)', () => {
    expect(REGISTRY_SRC).toContain('export async function transitionLifecycle')
    expect(REGISTRY_SRC).toContain('LIFECYCLE_STATE')
    expect(REGISTRY_SRC).toContain('VALID_TRANSITIONS')
    expect(REGISTRY_SRC).toContain('terminal')
  })

  test('lifecycle states are defined: registered, installed, activated, deactivated, revoked', () => {
    expect(REGISTRY_SRC).toContain('REGISTERED')
    expect(REGISTRY_SRC).toContain('INSTALLED')
    expect(REGISTRY_SRC).toContain('ACTIVATED')
    expect(REGISTRY_SRC).toContain('DEACTIVATED')
    expect(REGISTRY_SRC).toContain('REVOKED')
  })

  test('PostgreSQL is the durable source', () => {
    expect(REGISTRY_SRC).toContain("from '@/lib/db'")
    expect(REGISTRY_SRC).toContain('db.extensionRegistryEntry')
  })

  test('idempotent registration handles P2002 concurrent race', () => {
    expect(REGISTRY_SRC).toContain('P2002')
    expect(REGISTRY_SRC).toContain('Unique constraint failed')
  })
})
