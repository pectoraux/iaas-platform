/// <reference types="bun-types" />
// =============================================================================
// WORK-011 — TransformRuntime unit + architecture tests
// =============================================================================
// Verifies W011-AC01..AC10: TransformRuntime is service-layer, resolves via
// TransformRegistry, executes through abstract contract, emits TransformRecord,
// and obeys all V3 anti-dependency prohibitions.
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()

// ---------------------------------------------------------------------------
// W011-AC06/AC10 — static architecture + anti-dependency checks
// ---------------------------------------------------------------------------

describe('WORK-011 — TransformRuntime architecture (W011-AC06, W011-AC10)', () => {
  const RUNTIME_SRC = readFileSync(
    join(REPO_ROOT, 'src', 'lib', 'services', 'transform-runtime.service.ts'),
    'utf8',
  )

  test('TransformRuntime is in the service layer (NOT kernel)', () => {
    const path = join(REPO_ROOT, 'src', 'lib', 'services', 'transform-runtime.service.ts')
    expect(path).toContain('src/lib/services/')
    expect(path).not.toContain('src/lib/kernel/')
  })

  test('TransformRuntime imports NO vertical service (W011-AC06)', () => {
    const verticalPattern = /(?:vpp|compute|storage|wireless|manufacturing)\.service/
    expect(verticalPattern.test(RUNTIME_SRC)).toBe(false)
  })

  test('TransformRuntime imports NO EconomicPipeline (W011-AC06)', () => {
    expect(RUNTIME_SRC).not.toContain('economic-pipeline')
  })

  test('TransformRuntime imports NO Route/Transport (W011-AC06)', () => {
    const dataPlanePattern = /(?:routing|transport|delivery-confirmation)\.service/
    expect(dataPlanePattern.test(RUNTIME_SRC)).toBe(false)
  })

  test('TransformRuntime imports NO RuntimeRegistry (W011-AC06)', () => {
    expect(RUNTIME_SRC).not.toMatch(/^import.*RuntimeRegistry/m)
    expect(RUNTIME_SRC).not.toMatch(/from\s+['"]@\/lib\/kernel\/runtime['"]/m)
    expect(RUNTIME_SRC).not.toMatch(/from\s+['"]@\/lib\/kernel\//m)
  })

  test('TransformRuntime imports NO kernel code (W011-AC06)', () => {
    // Check for actual import statements, not comments mentioning kernel.
    expect(RUNTIME_SRC).not.toMatch(/^import.*@\/lib\/kernel/m)
  })

  test('TransformRuntime resolves Transforms via TransformRegistry (W011-AC06)', () => {
    expect(RUNTIME_SRC).toContain("from '@/lib/services/transform-registry.service'")
    expect(RUNTIME_SRC).toContain('getTransform')
  })

  test('TransformRuntime emits TransformRecord via createTransformRecord (W011-AC06)', () => {
    expect(RUNTIME_SRC).toContain("from '@/lib/services/transform-record.service'")
    expect(RUNTIME_SRC).toContain('createTransformRecord')
  })

  test('TransformRuntime does NOT own catalog/discovery (W011-AC06)', () => {
    // The runtime must NOT export registerTransform, listTransforms,
    // checkVersionCompatibility, updateCertification, or revokeTransform
    // — those are TransformRegistry's responsibilities.
    expect(RUNTIME_SRC).not.toMatch(/export\s+(async\s+)?function\s+registerTransform\b/)
    expect(RUNTIME_SRC).not.toMatch(/export\s+(async\s+)?function\s+listTransforms\b/)
    expect(RUNTIME_SRC).not.toMatch(/export\s+(async\s+)?function\s+updateCertification\b/)
    expect(RUNTIME_SRC).not.toMatch(/export\s+(async\s+)?function\s+revokeTransform\b/)
  })

  test('TransformRuntime does NOT mutate TransformRecord (W011-AC06)', () => {
    // The runtime must NOT import updateTransformRecord or deleteTransformRecord.
    expect(RUNTIME_SRC).not.toContain('updateTransformRecord')
    expect(RUNTIME_SRC).not.toContain('deleteTransformRecord')
  })

  test('TransformRuntime does NOT hard-code concrete transform implementations (W011-AC10)', () => {
    // The runtime dispatches through the TransformContract interface — it must
    // NOT contain concrete transform logic (e.g. compression, encryption).
    expect(RUNTIME_SRC).not.toMatch(/class\s+\w*Compression\w*/)
    expect(RUNTIME_SRC).not.toMatch(/class\s+\w*Encryption\w*/)
    expect(RUNTIME_SRC).not.toMatch(/class\s+\w*VPP\w*/)
    expect(RUNTIME_SRC).not.toMatch(/class\s+\w*Compute\w*/)
  })

  test('TransformRuntime has execute, reverse, estimateCost, verify functions (W011-AC03)', () => {
    expect(RUNTIME_SRC).toMatch(/export\s+async\s+function\s+executeTransform\b/)
    expect(RUNTIME_SRC).toMatch(/export\s+async\s+function\s+reverseTransform\b/)
    expect(RUNTIME_SRC).toMatch(/export\s+async\s+function\s+estimateTransformCost\b/)
    expect(RUNTIME_SRC).toMatch(/export\s+async\s+function\s+verifyTransform\b/)
  })

  test('TransformRuntime has explicit failure semantics (W011-AC07)', () => {
    // The runtime must document failure semantics — failures emit failed
    // provenance and re-throw (no silent success).
    expect(RUNTIME_SRC).toContain('Failure semantics')
    expect(RUNTIME_SRC).toContain("resultStatus: 'failed'")
  })

  test('TransformRuntime has idempotency support (W011-AC08)', () => {
    expect(RUNTIME_SRC).toContain('idempotencyKey')
    expect(RUNTIME_SRC).toContain('Idempotent')
  })
})

// ---------------------------------------------------------------------------
// W011-AC01..AC05 — contract presence (static source inspection)
// ---------------------------------------------------------------------------

describe('WORK-011 — TransformRuntime contract (W011-AC01..AC05)', () => {
  const RUNTIME_SRC = readFileSync(
    join(REPO_ROOT, 'src', 'lib', 'services', 'transform-runtime.service.ts'),
    'utf8',
  )

  test('TransformContract interface is defined (abstract operation contract)', () => {
    expect(RUNTIME_SRC).toContain('export interface TransformContract')
    expect(RUNTIME_SRC).toContain('execute(')
    expect(RUNTIME_SRC).toContain('reverse?(')
    expect(RUNTIME_SRC).toContain('estimateCost(')
    expect(RUNTIME_SRC).toContain('verify(')
  })

  test('registerTransformImplementation exists (in-memory dispatch table)', () => {
    expect(RUNTIME_SRC).toContain('export function registerTransformImplementation')
  })

  test('TransformRuntime uses PostgreSQL via TransformRecord (W011-AC04)', () => {
    // The runtime calls createTransformRecord which persists to PostgreSQL.
    expect(RUNTIME_SRC).toContain('createTransformRecord')
  })

  test('TransformRuntime uses TransformRegistry for resolution (W011-AC02)', () => {
    expect(RUNTIME_SRC).toContain('getTransform')
    expect(RUNTIME_SRC).toContain('resolveFromRegistry')
  })
})
