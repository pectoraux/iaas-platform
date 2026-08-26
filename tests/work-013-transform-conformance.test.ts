/// <reference types="bun-types" />
/**
 * WORK-013 — Transform Stack End-to-End Conformance (DB-free architecture tests)
 *
 * Verifies W013-AC05, W013-AC06, W013-AC07, W013-AC08, W013-AC10:
 *   - TransformRegistry is catalog authority, never executes
 *   - TransformRuntime is sole executor, resolves via Registry
 *   - TransformRecord is immutable, never mutated
 *   - V3 anti-dependencies mechanically enforced
 *   - No concrete transform implementations introduced
 *
 * PostgreSQL end-to-end integration tests are in:
 *   tests/work-013-transform-conformance-pg.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()

function readSrc(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

// ---------------------------------------------------------------------------
// W013-AC05 — TransformRegistry remains catalog authority, never executes
// ---------------------------------------------------------------------------

describe('WORK-013 — Registry authority (W013-AC05)', () => {
  const REGISTRY_SRC = readSrc('src/lib/services/transform-registry.service.ts')

  test('TransformRegistry does NOT export execute/reverse/estimateCost/verify', () => {
    expect(REGISTRY_SRC).not.toMatch(/export\s+(async\s+)?function\s+execute\b/)
    expect(REGISTRY_SRC).not.toMatch(/export\s+(async\s+)?function\s+reverse\b/)
    expect(REGISTRY_SRC).not.toMatch(/export\s+(async\s+)?function\s+estimateCost\b/)
    expect(REGISTRY_SRC).not.toMatch(/export\s+(async\s+)?function\s+verify\b/)
  })

  test('TransformRegistry does NOT import TransformRuntime', () => {
    expect(REGISTRY_SRC).not.toContain('transform-runtime.service')
  })

  test('TransformRegistry does NOT import TransformRecord (does not create/mutate records)', () => {
    expect(REGISTRY_SRC).not.toContain('transform-record.service')
    expect(REGISTRY_SRC).not.toContain('createTransformRecord')
  })
})

// ---------------------------------------------------------------------------
// W013-AC06 — TransformRuntime is sole executor, resolves via Registry
// ---------------------------------------------------------------------------

describe('WORK-013 — Runtime executor authority (W013-AC06)', () => {
  const RUNTIME_SRC = readSrc('src/lib/services/transform-runtime.service.ts')

  test('TransformRuntime resolves via TransformRegistry (getTransform)', () => {
    expect(RUNTIME_SRC).toContain("from '@/lib/services/transform-registry.service'")
    expect(RUNTIME_SRC).toContain('getTransform')
  })

  test('TransformRuntime does NOT export registerTransform/listTransforms/updateCertification/revokeTransform', () => {
    expect(RUNTIME_SRC).not.toMatch(/export\s+(async\s+)?function\s+registerTransform\b/)
    expect(RUNTIME_SRC).not.toMatch(/export\s+(async\s+)?function\s+listTransforms\b/)
    expect(RUNTIME_SRC).not.toMatch(/export\s+(async\s+)?function\s+updateCertification\b/)
    expect(RUNTIME_SRC).not.toMatch(/export\s+(async\s+)?function\s+revokeTransform\b/)
  })
})

// ---------------------------------------------------------------------------
// W013-AC07 — TransformRecord remains immutable, not mutated after creation
// ---------------------------------------------------------------------------

describe('WORK-013 — TransformRecord immutability (W013-AC07)', () => {
  const RECORD_SRC = readSrc('src/lib/services/transform-record.service.ts')
  const RUNTIME_SRC = readSrc('src/lib/services/transform-runtime.service.ts')
  const REGISTRY_SRC = readSrc('src/lib/services/transform-registry.service.ts')

  test('TransformRecord service does NOT export update/delete functions', () => {
    expect(RECORD_SRC).not.toMatch(/export\s+(async\s+)?function\s+updateTransformRecord\b/)
    expect(RECORD_SRC).not.toMatch(/export\s+(async\s+)?function\s+deleteTransformRecord\b/)
    expect(RECORD_SRC).not.toMatch(/export\s+(async\s+)?function\s+mutateTransformRecord\b/)
  })

  test('TransformRuntime does NOT call update/delete on TransformRecord', () => {
    expect(RUNTIME_SRC).not.toContain('updateTransformRecord')
    expect(RUNTIME_SRC).not.toContain('deleteTransformRecord')
  })

  test('TransformRegistry does NOT import or call TransformRecord at all', () => {
    expect(REGISTRY_SRC).not.toContain('transform-record.service')
    expect(REGISTRY_SRC).not.toContain('createTransformRecord')
    expect(REGISTRY_SRC).not.toContain('getTransformRecord')
  })
})

// ---------------------------------------------------------------------------
// W013-AC08 — V3 anti-dependencies mechanically enforced
// ---------------------------------------------------------------------------

describe('WORK-013 — V3 anti-dependencies (W013-AC08)', () => {
  const REGISTRY_SRC = readSrc('src/lib/services/transform-registry.service.ts')
  const RUNTIME_SRC = readSrc('src/lib/services/transform-runtime.service.ts')
  const RECORD_SRC = readSrc('src/lib/services/transform-record.service.ts')

  const allSrc = REGISTRY_SRC + '\n' + RUNTIME_SRC + '\n' + RECORD_SRC

  test('NO vertical service imports across the Transform Stack', () => {
    const verticalPattern = /(?:vpp|compute|storage|wireless|manufacturing)\.service/
    expect(verticalPattern.test(REGISTRY_SRC)).toBe(false)
    expect(verticalPattern.test(RUNTIME_SRC)).toBe(false)
    expect(verticalPattern.test(RECORD_SRC)).toBe(false)
  })

  test('NO EconomicPipeline import across the Transform Stack', () => {
    expect(allSrc).not.toContain('economic-pipeline')
  })

  test('NO Route/Transport import across the Transform Stack', () => {
    const dataPlanePattern = /(?:routing|transport|delivery-confirmation)\.service/
    expect(dataPlanePattern.test(allSrc)).toBe(false)
  })

  test('NO RuntimeRegistry import across the Transform Stack', () => {
    expect(allSrc).not.toMatch(/^import.*RuntimeRegistry/m)
    expect(allSrc).not.toMatch(/from\s+['"]@\/lib\/kernel\/runtime['"]/m)
  })

  test('NO kernel import across the Transform Stack', () => {
    expect(allSrc).not.toMatch(/^import.*@\/lib\/kernel/m)
  })
})

// ---------------------------------------------------------------------------
// W013-AC10 — no concrete transform implementations introduced
// ---------------------------------------------------------------------------

describe('WORK-013 — no concrete transforms (W013-AC10)', () => {
  const RUNTIME_SRC = readSrc('src/lib/services/transform-runtime.service.ts')

  test('TransformRuntime does NOT contain concrete transform classes', () => {
    expect(RUNTIME_SRC).not.toMatch(/class\s+\w*Compression\w*/)
    expect(RUNTIME_SRC).not.toMatch(/class\s+\w*Encryption\w*/)
    expect(RUNTIME_SRC).not.toMatch(/class\s+\w*VPP\w*/)
    expect(RUNTIME_SRC).not.toMatch(/class\s+\w*Compute\w*/)
  })

  test('no new Prisma schema models for concrete transforms', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).not.toMatch(/model\s+CompressionTransform\b/)
    expect(schema).not.toMatch(/model\s+EncryptionTransform\b/)
    expect(schema).not.toMatch(/model\s+VPPTransform\b/)
  })
})
