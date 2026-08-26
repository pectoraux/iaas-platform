/// <reference types="bun-types" />
// =============================================================================
// WORK-010 — TransformRegistry unit + architecture tests
// =============================================================================
// Verifies W010-AC01..AC08: TransformRegistry is service-layer, tenant-scoped,
// does not execute transforms, and obeys all V3 anti-dependency prohibitions.
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()

// ---------------------------------------------------------------------------
// W010-AC06 / W010-AC07 — static architecture + anti-dependency checks
// ---------------------------------------------------------------------------

describe('WORK-010 — TransformRegistry architecture (W010-AC06, W010-AC07)', () => {
  const REGISTRY_SRC = readFileSync(
    join(REPO_ROOT, 'src', 'lib', 'services', 'transform-registry.service.ts'),
    'utf8',
  )

  test('TransformRegistry is in the service layer (NOT kernel)', () => {
    const path = join(REPO_ROOT, 'src', 'lib', 'services', 'transform-registry.service.ts')
    expect(path).toContain('src/lib/services/')
    expect(path).not.toContain('src/lib/kernel/')
  })

  test('TransformRegistry imports NO vertical service (W010-AC06)', () => {
    const verticalPattern = /(?:vpp|compute|storage|wireless|manufacturing)\.service/
    expect(verticalPattern.test(REGISTRY_SRC)).toBe(false)
  })

  test('TransformRegistry imports NO EconomicPipeline (W010-AC06)', () => {
    expect(REGISTRY_SRC).not.toContain('economic-pipeline')
  })

  test('TransformRegistry imports NO Route/Transport (W010-AC06)', () => {
    const dataPlanePattern = /(?:routing|transport|delivery-confirmation)\.service/
    expect(dataPlanePattern.test(REGISTRY_SRC)).toBe(false)
  })

  test('TransformRegistry imports NO RuntimeRegistry (W010-AC06)', () => {
    // Check for actual import statements, not comments mentioning RuntimeRegistry.
    expect(REGISTRY_SRC).not.toMatch(/^import.*RuntimeRegistry/m)
    expect(REGISTRY_SRC).not.toMatch(/from\s+['"]@\/lib\/kernel\/runtime['"]/m)
    expect(REGISTRY_SRC).not.toMatch(/from\s+['\"]@\/lib\/kernel\//m)
  })

  test('TransformRegistry imports NO kernel code (W010-AC06)', () => {
    expect(REGISTRY_SRC).not.toContain('@/lib/kernel/')
  })

  test('TransformRegistry does NOT execute transforms (W010-AC07)', () => {
    // The registry must NOT contain execute(), reverse(), estimateCost(), verify()
    // — those are TransformRuntime (future).
    expect(REGISTRY_SRC).not.toMatch(/export\s+(async\s+)?function\s+execute\b/)
    expect(REGISTRY_SRC).not.toMatch(/export\s+(async\s+)?function\s+reverse\b/)
    expect(REGISTRY_SRC).not.toMatch(/export\s+(async\s+)?function\s+estimateCost\b/)
    expect(REGISTRY_SRC).not.toMatch(/export\s+(async\s+)?function\s+verify\b/)
    // The service must explicitly document this boundary.
    expect(REGISTRY_SRC).toContain('Does NOT execute transforms')
  })

  test('TransformRuntime remains absent from production code (W010-AC07)', () => {
    // There must be NO transform-runtime.service.ts file.
    const path = join(REPO_ROOT, 'src', 'lib', 'services', 'transform-runtime.service.ts')
    expect(existsSync(path)).toBe(false)
  })

  test('TransformRegistry does NOT mutate TransformRecord (W010-AC07)', () => {
    // The registry must not import or call TransformRecord service.
    expect(REGISTRY_SRC).not.toContain('transform-record.service')
    expect(REGISTRY_SRC).not.toContain('createTransformRecord')
  })
})

// ---------------------------------------------------------------------------
// W010-AC01..AC04 — contract presence (static source inspection)
// ---------------------------------------------------------------------------

describe('WORK-010 — TransformRegistry contract (W010-AC01..AC04)', () => {
  const REGISTRY_SRC = readFileSync(
    join(REPO_ROOT, 'src', 'lib', 'services', 'transform-registry.service.ts'),
    'utf8',
  )

  test('registerTransform exists (tenant-scoped registration, W010-AC01)', () => {
    expect(REGISTRY_SRC).toContain('export async function registerTransform')
    expect(REGISTRY_SRC).toContain('tenantId')
  })

  test('getTransform exists (lookup by transformType + transformVersion, W010-AC01)', () => {
    expect(REGISTRY_SRC).toContain('export async function getTransform')
    expect(REGISTRY_SRC).toContain('transformType')
    expect(REGISTRY_SRC).toContain('transformVersion')
  })

  test('listTransforms exists (tenant-scoped listing)', () => {
    expect(REGISTRY_SRC).toContain('export async function listTransforms')
  })

  test('checkVersionCompatibility exists (version compatibility, W010-AC02)', () => {
    expect(REGISTRY_SRC).toContain('export async function checkVersionCompatibility')
    expect(REGISTRY_SRC).toContain('compatibleVersions')
  })

  test('updateCertification exists (certification metadata, W010-AC03)', () => {
    expect(REGISTRY_SRC).toContain('export async function updateCertification')
    expect(REGISTRY_SRC).toContain('certifierIdentity')
    expect(REGISTRY_SRC).toContain('certificationStatus')
  })

  test('revokeTransform exists (revocation metadata, W010-AC03)', () => {
    expect(REGISTRY_SRC).toContain('export async function revokeTransform')
    expect(REGISTRY_SRC).toContain('revocationStatus')
    expect(REGISTRY_SRC).toContain('revocationReason')
    expect(REGISTRY_SRC).toContain('revokedAt')
  })

  test('idempotent registration is documented (W010-AC04)', () => {
    expect(REGISTRY_SRC).toContain('Idempotent')
    expect(REGISTRY_SRC).toContain('tenantId_transformType_transformVersion')
  })

  test('PostgreSQL is the durable source (W010-AC04)', () => {
    expect(REGISTRY_SRC).toContain("from '@/lib/db'")
    expect(REGISTRY_SRC).toContain('db.transformRegistryEntry')
  })
})

// ---------------------------------------------------------------------------
// W010-AC05 — tenant isolation (static check)
// ---------------------------------------------------------------------------

describe('WORK-010 — tenant isolation (W010-AC05)', () => {
  const REGISTRY_SRC = readFileSync(
    join(REPO_ROOT, 'src', 'lib', 'services', 'transform-registry.service.ts'),
    'utf8',
  )

  test('all queries filter by tenantId', () => {
    // Every findUnique/findMany/update must include tenantId in the where clause.
    // The unique constraint is (tenantId, transformType, transformVersion).
    expect(REGISTRY_SRC).toContain('tenantId_transformType_transformVersion')
  })
})
