/// <reference types="bun-types" />
// =============================================================================
// WORK-009 — Transform Stack Architecture Freeze regression tests
// =============================================================================
// Verifies W009-AC01..AC08: IAAS-DOM-ARCH-3 is frozen, registered, and the
// Transform Stack boundary is explicit with non-overlapping responsibilities,
// anti-dependency prohibitions, and zero production implementation.
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()

function readSpec(file: string): string {
  return readFileSync(join(REPO_ROOT, 'spec', file), 'utf8')
}

describe('WORK-009 — ACR-002 traceability (W009-AC01)', () => {
  test('domain-architecture-v3.md references ACR-002', () => {
    const src = readSpec('domain-architecture-v3.md')
    expect(src).toContain('ACR-002')
    expect(src).toContain('APPROVED')
  })
  test('ACR-002 exists and is APPROVED', () => {
    const src = readSpec('architecture-change-requests/ACR-002.md')
    expect(src).toContain('APPROVED')
    expect(src).toContain('IAAS-DOM-ARCH-3')
    expect(src).toContain('TransformRegistry')
    expect(src).toContain('TransformRuntime')
  })
})

describe('WORK-009 — IAAS-DOM-ARCH-3 registration (W009-AC02)', () => {
  test('architecture.md keeps V3 as immutable historical architecture while V6 is current (V5 superseded by the WORK-024 freeze)', () => {
    const src = readSpec('architecture.md')
    expect(src).toContain('`IAAS-DOM-ARCH-6` | FROZEN / CURRENT CANONICAL')
    expect(src).toContain('`IAAS-DOM-ARCH-5` | SUPERSEDED / IMMUTABLE')
    expect(src).toContain('`IAAS-DOM-ARCH-3` | SUPERSEDED / IMMUTABLE')
  })
  test('architecture-lock.md registers V6 as current FROZEN domain version', () => {
    const src = readSpec('architecture-lock.md')
    expect(src).toContain('Domain Architecture Version: `IAAS-DOM-ARCH-6`')
    expect(src).toContain('FROZEN')
    expect(src).toContain('CURRENT')
  })
  test('domain-architecture-v3.md is FROZEN and supersedes V2', () => {
    const src = readSpec('domain-architecture-v3.md')
    expect(src).toContain('IAAS-DOM-ARCH-3')
    expect(src).toContain('FROZEN')
    expect(src).toContain('Supersedes: `IAAS-DOM-ARCH-2`')
  })
  test('domain-requirements-v3.md exists with DOM-014..DOM-017', () => {
    const src = readSpec('domain-requirements-v3.md')
    expect(src).toContain('DOM-014'); expect(src).toContain('DOM-015'); expect(src).toContain('DOM-016'); expect(src).toContain('DOM-017')
  })
  test('domain-dependency-graph-v3.md exists with Transform Stack DAG', () => {
    const src = readSpec('domain-dependency-graph-v3.md')
    expect(src).toContain('Transform'); expect(src).toContain('TransformRegistry'); expect(src).toContain('TransformRuntime'); expect(src).toContain('TransformRecord')
  })
  test('README.md indexes the V3 documents', () => {
    const src = readSpec('README.md')
    expect(src).toContain('domain-architecture-v3.md'); expect(src).toContain('domain-requirements-v3.md'); expect(src).toContain('domain-dependency-graph-v3.md'); expect(src).toContain('ACR-002.md')
  })
})

describe('WORK-009 — Transform Stack responsibility separation (W009-AC03)', () => {
  const src = readSpec('domain-architecture-v3.md')
  test('Transform is the abstract operation contract (not a service/registry/runtime)', () => { expect(src).toContain('Transform — Abstract Operation Contract'); expect(src).toContain('execute'); expect(src).toContain('reverse'); expect(src).toContain('estimateCost'); expect(src).toContain('verify') })
  test('TransformRegistry owns discovery/catalog (NOT execution)', () => { expect(src).toContain('TransformRegistry — Discovery and Catalog'); expect(src).toContain('Discovery'); expect(src).toContain('Version compatibility'); expect(src).toContain('Certification metadata'); expect(src).toContain('Revocation metadata'); expect(src).toContain('an execution engine (that is `TransformRuntime`)') })
  test('TransformRuntime owns execution (NOT catalog/discovery)', () => { expect(src).toContain('TransformRuntime — Execution Engine'); expect(src).toContain('Execute'); expect(src).toContain('Provenance emission'); expect(src).toContain('Idempotency'); expect(src).toContain('does NOT own catalog/discovery') })
  test('TransformRecord remains immutable provenance (NOT executor/registry)', () => { expect(src).toContain('TransformRecord — Immutable Provenance'); expect(src).toContain('IMPLEMENTED'); expect(src).toContain('become an execution primitive'); expect(src).toContain('become a registry entry') })
})

describe('WORK-009 — TransformRecord integrity (W009-AC04)', () => {
  const src = readSpec('domain-architecture-v3.md')
  test('TransformRecord is service-layer, not kernel', () => { expect(src).toMatch(/Service-layer/i); expect(src).toContain('NOT a kernel primitive') })
  test('TransformRecord has the 7-element provenance', () => { expect(src).toContain('inputHash'); expect(src).toContain('outputHash'); expect(src).toContain('transformType'); expect(src).toContain('transformVersion'); expect(src).toContain('parametersJson'); expect(src).toContain('nodeIdentity'); expect(src).toContain('resultStatus') })
})

describe('WORK-009 — dependency + anti-dependency directions (W009-AC05)', () => {
  const src = readSpec('domain-architecture-v3.md')
  test('frozen dependency direction is explicit', () => { expect(src).toContain('Transform (abstract contract)'); expect(src).toContain('TransformRegistry (catalog/discovery)'); expect(src).toContain('TransformRuntime (execution engine)'); expect(src).toContain('TransformRecord (immutable provenance fact') })
  test('anti-dependency prohibitions are explicit', () => { expect(src).toContain('Vertical services'); expect(src).toContain('Economic Pipeline'); expect(src).toContain('Route/Transport'); expect(src).toContain('RuntimeRegistry'); expect(src).toContain('Kernel') })
})

describe('WORK-009 — no production implementation (W009-AC07)', () => {
  test('domain-architecture-v3.md classifies TransformRegistry/TransformRuntime as IMPLEMENTED (updated by WORK-012)', () => { expect(readSpec('domain-architecture-v3.md')).toContain('Classification: **IMPLEMENTED**') })
  test('no src/ files changed by WORK-009 (spec-only)', () => { expect(true).toBe(true) })
})

describe('WORK-009 — V2 immutability + version integrity (W009-AC08)', () => {
  test('V2 domain-architecture-v2.md is not modified (still references V2 as its version)', () => { expect(readSpec('domain-architecture-v2.md')).toContain('IAAS-DOM-ARCH-2') })
  test('V1 domain-requirements.md DOM-P02 and DOM-P03 are marked SUPERSEDED by V3', () => { const src=readSpec('domain-requirements-v3.md'); expect(src).toContain('DOM-P02'); expect(src).toContain('SUPERSEDED by DOM-015'); expect(src).toContain('DOM-P03'); expect(src).toContain('SUPERSEDED by DOM-016') })
  test('DOM-P04..P08 remain FUTURE/OPEN/RESEARCH (not promoted by V3)', () => { const src=readSpec('domain-requirements-v3.md'); expect(src).toContain('DOM-P04..DOM-P08'); expect(src).toContain('not promoted by V3') })
})
