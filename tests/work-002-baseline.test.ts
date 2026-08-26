/// <reference types="bun-types" />
// =============================================================================
// WORK-002 — Repository Baseline & Reconciliation Matrix tests
// =============================================================================
// Verifies the docs/architecture/ deliverables required by WORK-002:
//   - docs/architecture/REPOSITORY-BASELINE.md exists and is truth-classified
//   - docs/architecture/RECONCILIATION-MATRIX.md exists and is truth-classified
//
// These are docs/ deliverables (outside spec/), so they are verified by a
// dedicated test rather than the spec/ validator (which is intentionally
// spec/-scoped for negative-test isolation).
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()
const DOCS_ARCH = join(REPO_ROOT, 'docs', 'architecture')

function readDoc(name: string): string {
  return readFileSync(join(DOCS_ARCH, name), 'utf8')
}

const TRUTH_CLASSIFICATIONS = ['OBSERVED', 'INFERRED', 'CONFIRMED', 'PROPOSED']

describe('WORK-002 — REPOSITORY-BASELINE.md', () => {
  const baseline = readDoc('REPOSITORY-BASELINE.md')

  test('exists and is non-empty', () => {
    expect(baseline.length).toBeGreaterThan(0)
  })

  test('references the audited commit (12c6b6c)', () => {
    expect(baseline).toContain('12c6b6c')
  })

  test('references IAAS-DOM-ARCH-1 and IAAS-GOV-ARCH-1', () => {
    expect(baseline).toContain('IAAS-DOM-ARCH-1')
    expect(baseline).toContain('IAAS-GOV-ARCH-1')
  })

  test('contains all four truth classifications', () => {
    for (const c of TRUTH_CLASSIFICATIONS) {
      expect(baseline).toContain(c)
    }
  })

  test('covers every required audit area (WORK-002 Repository Audit Coverage)', () => {
    // The baseline must inspect docs/architecture, src, prisma, tests, CI,
    // package/build/runtime config, scripts, and recent commits.
    expect(baseline).toContain('docs/architecture')
    expect(baseline).toContain('src/')
    expect(baseline).toContain('prisma/')
    expect(baseline).toContain('tests/')
    expect(baseline).toContain('.github/workflows')
    expect(baseline).toContain('package.json')
    expect(baseline).toContain('scripts/')
  })

  test('records the observed Prisma model count (67, not the stale 54)', () => {
    expect(baseline).toContain('67 models')
    // The stale "54" from PHASE-13-GAP-MATRIX must be reconciled, not silent.
    expect(baseline).toContain('54')
  })

  test('confirms anti-drift rules are OBSERVED-verified', () => {
    expect(baseline).toContain('CONFIRMED')
    expect(baseline).toContain('economic-pipeline.ts')
    expect(baseline).toContain('infrastructure-runtime')
    expect(baseline).toContain('protocol-runtime')
  })

  test('records mini-services as empty (no implementation)', () => {
    expect(baseline.toLowerCase()).toContain('mini-services')
  })

  test('records stale documentation findings for Architect adjudication', () => {
    // The three documentation defects (B-01, B-02, B-03) must be recorded,
    // NOT silently resolved.
    expect(baseline).toContain('B-01')
    expect(baseline).toContain('B-02')
    expect(baseline).toContain('B-03')
  })
})

describe('WORK-002 — RECONCILIATION-MATRIX.md', () => {
  const matrix = readDoc('RECONCILIATION-MATRIX.md')

  test('exists and is non-empty', () => {
    expect(matrix.length).toBeGreaterThan(0)
  })

  test('references IAAS-DOM-ARCH-1 and IAAS-GOV-ARCH-1', () => {
    expect(matrix).toContain('IAAS-DOM-ARCH-1')
    expect(matrix).toContain('IAAS-GOV-ARCH-1')
  })

  test('contains all four truth classifications', () => {
    for (const c of TRUTH_CLASSIFICATIONS) {
      expect(matrix).toContain(c)
    }
  })

  test('records the Phase-14F nodeIdentity documentation contradiction (R-08)', () => {
    expect(matrix).toContain('R-08')
    expect(matrix).toContain('nodeIdentity')
    expect(matrix).toContain('system:__unattributed__')
  })

  test('records the Gap Matrix summary staleness (R-04)', () => {
    expect(matrix).toContain('R-04')
    expect(matrix).toContain('54')
    expect(matrix).toContain('67')
  })

  test('records the FUTURE-NETWORK-COVERAGE staleness (R-05)', () => {
    expect(matrix).toContain('R-05')
    expect(matrix).toContain('FUTURE-NETWORK-COVERAGE')
  })

  test('states no stop-condition was triggered', () => {
    expect(matrix.toLowerCase()).toContain('no stop-condition')
  })

  test('does NOT promote INFERRED or PROPOSED into historical fact', () => {
    // The summary must show zero INFERRED and zero PROPOSED promoted to fact.
    expect(matrix).toContain('| INFERRED | 0 |')
    expect(matrix).toContain('| PROPOSED | 0 |')
  })
})

// =============================================================================
// AR-004 regression — Data Plane / Economic Pipeline independence (code-level)
// =============================================================================
// The architect's AR-004 finding corrected a spec summary that implied the
// Data Plane depends on the Economic Pipeline. The frozen architecture keeps
// them independent in BOTH directions. Rule 11 (constitution §16) already
// statically enforces Data-Plane ✗-> Economic. These tests enforce the REVERSE
// direction at the code level: the generic economic pipeline MUST NOT import
// any Phase 14 data-plane service, so an accidental Economic -> Data Plane
// dependency cannot be introduced silently.
// =============================================================================

describe('WORK-002 — AR-004 regression: Economic Pipeline ✗-> Data Plane (code)', () => {
  const ECONOMIC_PIPELINE = readFileSync(
    join(REPO_ROOT, 'src', 'lib', 'control-plane', 'economic-pipeline.ts'),
    'utf8',
  )

  const DATA_PLANE_SERVICES = [
    'data-plane.service',
    'routing.service',
    'transport.service',
    'delivery-confirmation.service',
    'transform-record.service',
  ]

  for (const svc of DATA_PLANE_SERVICES) {
    test(`economic-pipeline.ts does not import ${svc} (Economic ✗-> Data Plane)`, () => {
      // Match both static and dynamic imports of the data-plane service.
      const importPattern = new RegExp(`from\\s+['"][^'"]*${svc.replace(/\./g, '\\.')}['"]|import\\s*\\(\\s*['"][^'"]*${svc.replace(/\./g, '\\.')}['"]`)
      expect(importPattern.test(ECONOMIC_PIPELINE)).toBe(false)
    })
  }

  test('economic-pipeline.ts does not reference the Data Plane substrate as a dependency', () => {
    // Belt-and-suspenders: the economic pipeline source must not mention any
    // data-plane service module path at all (import or otherwise).
    for (const svc of DATA_PLANE_SERVICES) {
      expect(ECONOMIC_PIPELINE).not.toContain(svc)
    }
  })
})
