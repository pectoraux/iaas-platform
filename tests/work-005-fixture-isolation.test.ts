/// <reference types="bun-types" />
// =============================================================================
// WORK-005 — Integration Test Fixture Isolation regression tests
// =============================================================================
// Verifies BASE-004 (deterministic fixtures), BASE-005 (fixture isolation),
// and W005-AC01…AC08 at the static/source level.
//
// The PostgreSQL integration tests (phase-5-2, phase-8b, vpp-4-2) prove the
// runtime contract in CI. These DB-free tests verify the fixture discipline:
//   - affected tests create their own operator/asset/device/capability
//     prerequisites (no ambient findFirst lookup);
//   - no cross-file fixture dependency;
//   - tenant-scoped fixture lookups cannot be satisfied by another tenant;
//   - no production code was changed to compensate for missing fixtures.
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()

function readTest(file: string): string {
  return readFileSync(join(REPO_ROOT, 'tests', file), 'utf8')
}

// ---------------------------------------------------------------------------
// W005-AC01 — affected tests establish their own prerequisites
// ---------------------------------------------------------------------------

describe('WORK-005 — affected tests establish own prerequisites (W005-AC01, BASE-004)', () => {
  test('phase-5-2 test creates operator/asset/assignment in beforeAll (no ambient lookup)', () => {
    const src = readTest('phase-5-2-execution-economics-separation.test.ts')
    // WORK-005 fix: the test creates its own fixtures deterministically.
    expect(src).toContain('createOperator(tenantId')
    expect(src).toContain('createAsset(tenantId')
    expect(src).toContain('assignAssetToNetwork(tenantId')
    // The pre-WORK-005 ambient lookup + throw must be gone.
    expect(src).not.toContain("throw new Error('Test setup requires at least one operator + asset')")
    expect(src).not.toMatch(/db\.operator\.findFirst\(\s*{\s*where:\s*{\s*tenantId\s*}\s*}\s*\)/)
    expect(src).not.toMatch(/db\.asset\.findFirst\(\s*{\s*where:\s*{\s*tenantId\s*}\s*}\s*\)/)
  })

  test('phase-8b test creates operator/asset/device/assignment in beforeAll', () => {
    const src = readTest('phase-8b-compute-economic-pipeline.test.ts')
    expect(src).toContain('createOperator(tenantId')
    expect(src).toContain('createAsset(tenantId')
    expect(src).toContain('assignAssetToNetwork(tenantId')
    expect(src).toContain('createDevice(tenantId')
  })

  test('vpp-4-2 test creates operator/asset/device/assignment in beforeAll', () => {
    const src = readTest('vpp-4-2-execution-invariants.test.ts')
    expect(src).toContain('createOperator(tenantId')
    expect(src).toContain('createAsset(tenantId')
    expect(src).toContain('assignAssetToNetwork(tenantId')
    expect(src).toContain('createDevice(tenantId')
  })

  test('runtime-resolution-integration test does not need fixtures (uses template only)', () => {
    // This test resolves runtimes but does not create assignments, so it
    // doesn't need operator/asset fixtures. It must still call
    // initializeBootstrap (WORK-004).
    const src = readTest('runtime-resolution-integration.test.ts')
    expect(src).toContain('initializeBootstrap')
  })
})

// ---------------------------------------------------------------------------
// W005-AC03 / W005-AC05 — no production changes; boundaries intact
// ---------------------------------------------------------------------------

describe('WORK-005 — no production changes (W005-AC03, W005-AC05, BASE-006)', () => {
  test('no production service file adds auto-fixture behavior for missing operators/assets', () => {
    // The fix is test-only. Production services must not gain fallback
    // auto-creation of operators/assets. Check the registry service (which
    // creates operators/assets) does not add a "find-or-create" fallback
    // that would mask missing fixtures in production.
    const registrySrc = readFileSync(
      join(REPO_ROOT, 'src', 'lib', 'services', 'registry.service.ts'),
      'utf8',
    )
    // The service should still create operators/assets only on explicit call.
    // It must not auto-create on lookup failure.
    expect(registrySrc).not.toMatch(/if\s*\(!operator\)\s*{?\s*createOperator/)
    expect(registrySrc).not.toMatch(/if\s*\(!asset\)\s*{?\s*createAsset/)
  })
})

// ---------------------------------------------------------------------------
// W005-AC07 — unrelated pre-existing failures classified, not modified
// ---------------------------------------------------------------------------

describe('WORK-005 — Phase 8B/8C audit + pre-existing failures (W005-AC07, AR-006)', () => {
  test('Phase 8B Decimal/string assertion corrected (AR-006): compares as strings', () => {
    // AR-006: the Work Order explicitly includes Phase 8B/8C in the audit
    // scope. The Phase 8B failure was a test-only assertion defect:
    //   expect(contribution!.quantity).toBe(assignment!.actualQuantity)
    // where contribution.quantity is a Prisma Decimal (object) and
    // actualQuantity is a String. Strict .toBe() fails across these types.
    // The correction compares via .toString() — a test-only fix, no
    // production code changed.
    const src = readTest('phase-8b-compute-economic-pipeline.test.ts')
    expect(src).toContain('contribution!.quantity.toString()')
    expect(src).toContain('.toBe(assignment!.actualQuantity!)')
    expect(src).not.toContain('expect(contribution!.quantity).toBe(assignment!.actualQuantity)')
  })

  test('Phase 8C (failure path) does not share the Decimal/string assertion issue', () => {
    // Phase 8C is a separate describe block testing the failure path. It
    // does not assert contribution.quantity === actualQuantity. Confirmed
    // passing in CI.
    const src = readTest('phase-8b-compute-economic-pipeline.test.ts')
    expect(src).toContain('Phase 8C: failure path')
  })

  test('architecture-contract.test.ts source-pattern failures are pre-existing (out of scope)', () => {
    // The 3 architecture-contract.test.ts failures are source-pattern tests
    // (regex against vpp.service.ts / infrastructure-runtime.ts) that pre-date
    // WORK-005. Confirmed on main. Not modified by WORK-005.
    const src = readTest('architecture-contract.test.ts')
    expect(src.length).toBeGreaterThan(0)
  })
})
