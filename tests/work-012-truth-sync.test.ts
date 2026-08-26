/// <reference types="bun-types" />
// =============================================================================
// WORK-012 — Transform Stack Truth Synchronization regression tests
// =============================================================================
// Verifies W012-AC01..AC06: V3 spec accurately reflects WORK-010/011 VERIFIED,
// historical V1/V2 preserved, no unrelated promotion, cross-document consistency.
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()

function readSpec(file: string): string {
  return readFileSync(join(REPO_ROOT, 'spec', file), 'utf8')
}

// ---------------------------------------------------------------------------
// W012-AC01 — V3 classifications reflect implemented/verified state
// ---------------------------------------------------------------------------

describe('WORK-012 — V3 truth synchronization (W012-AC01)', () => {
  test('DOM-014 (Transform contract) is classified as implemented via WORK-011', () => {
    const src = readSpec('domain-requirements-v3.md')
    expect(src).toContain('DOM-014')
    expect(src).toContain('WORK-011 VERIFIED')
    expect(src).not.toContain('implementation pending a future\nWork Item after WORK-009 is VERIFIED')
  })

  test('DOM-015 (TransformRegistry) is classified as implemented via WORK-010', () => {
    const src = readSpec('domain-requirements-v3.md')
    expect(src).toContain('DOM-015')
    expect(src).toContain('WORK-010 VERIFIED')
  })

  test('DOM-016 (TransformRuntime) is classified as implemented via WORK-011', () => {
    const src = readSpec('domain-requirements-v3.md')
    expect(src).toContain('DOM-016')
    expect(src).toContain('WORK-011 VERIFIED')
  })

  test('V3 domain-architecture-v3.md classifies Transform/Registry/Runtime as IMPLEMENTED', () => {
    const src = readSpec('domain-architecture-v3.md')
    expect(src).toContain('Classification: **IMPLEMENTED**')
    expect(src).not.toContain('production implementation is future')
  })
})

// ---------------------------------------------------------------------------
// W012-AC02 — DOM-017 remains implemented/confirmed
// ---------------------------------------------------------------------------

describe('WORK-012 — DOM-017 preserved (W012-AC02)', () => {
  test('DOM-017 classification is CONFIRMED / IMPLEMENTED', () => {
    const src = readSpec('domain-requirements-v3.md')
    expect(src).toContain('DOM-017')
    expect(src).toContain('CONFIRMED')
  })
})

// ---------------------------------------------------------------------------
// W012-AC03 — Historical V1/V2 preserved
// ---------------------------------------------------------------------------

describe('WORK-012 — Historical V1/V2 preserved (W012-AC03)', () => {
  test('V1 domain-architecture.md retains original FUTURE text (not rewritten)', () => {
    const src = readSpec('domain-architecture.md')
    expect(src).toContain('FUTURE**: generic `VerifiedEvidenceContext`')
  })

  test('V2 domain-architecture-v2.md retains its version identity', () => {
    const src = readSpec('domain-architecture-v2.md')
    expect(src).toContain('IAAS-DOM-ARCH-2')
  })
})

// ---------------------------------------------------------------------------
// W012-AC04 — Cross-document consistency
// ---------------------------------------------------------------------------

describe('WORK-012 — Cross-document consistency (W012-AC04)', () => {
  test('architecture.md registers V3 as FROZEN', () => {
    const src = readSpec('architecture.md')
    expect(src).toContain('`IAAS-DOM-ARCH-3` | FROZEN')
  })

  test('architecture-lock.md registers V3 as current', () => {
    const src = readSpec('architecture-lock.md')
    expect(src).toContain('IAAS-DOM-ARCH-3')
  })

  test('dependency-graph.md states WORK-011 is VERIFIED and WORK-012 is eligible', () => {
    const src = readSpec('dependency-graph.md')
    expect(src).toContain('WORK-011')
    expect(src).toContain('WORK-012')
    expect(src).toContain('VERIFIED')
  })

  test('work-items.md records WORK-010 and WORK-011 as VERIFIED', () => {
    const src = readSpec('work-items.md')
    const w010 = src.split('## WORK-010')[1]?.split('## WORK-011')[0] ?? ''
    expect(w010).toContain('Status: `VERIFIED`')
    const w011 = src.split('## WORK-011')[1]?.split('## WORK-012')[0] ?? ''
    expect(w011).toContain('Status: `VERIFIED`')
  })
})

// ---------------------------------------------------------------------------
// W012-AC06 — DOM-P04..P08 remain FUTURE (not promoted)
// ---------------------------------------------------------------------------

describe('WORK-012 — No unrelated promotion (W012-AC06)', () => {
  test('DOM-P04..P08 remain FUTURE/OPEN/RESEARCH in V3 requirements', () => {
    const src = readSpec('domain-requirements-v3.md')
    expect(src).toContain('DOM-P04..DOM-P08')
    expect(src).toContain('not promoted by V3')
  })

  test('DOM-P02/P03 are marked SUPERSEDED (promoted by V3, not by V4)', () => {
    const src = readSpec('domain-requirements-v3.md')
    expect(src).toContain('DOM-P02')
    expect(src).toContain('SUPERSEDED by DOM-015')
    expect(src).toContain('DOM-P03')
    expect(src).toContain('SUPERSEDED by DOM-016')
  })
})

// ---------------------------------------------------------------------------
// AR-012-01 — no stale implementation-authorization language contradicting IMPLEMENTED
// ---------------------------------------------------------------------------

describe('WORK-012 — AR-012-01: no stale authorization language (AR-012-01)', () => {
  test('V3 domain-architecture-v3.md does NOT say TransformRegistry/Runtime implementation is unauthorized', () => {
    const src = readSpec('domain-architecture-v3.md')
    // The opening note must NOT contain the stale "No production implementation
    // ... is authorized" language that contradicts the IMPLEMENTED classifications.
    expect(src).not.toContain('No production implementation of\n> TransformRegistry or TransformRuntime is authorized')
    expect(src).not.toContain('only the contract is frozen. Implementation requires a separate Work Item')
  })

  test('V3 domain-architecture-v3.md §5 does NOT call TransformRegistry/Runtime "future Work Items"', () => {
    const src = readSpec('domain-architecture-v3.md')
    // §5 must NOT describe the implementation as "future Work Items" — they
    // are now VERIFIED (WORK-010/011).
    expect(src).not.toContain('TransformRegistry/TransformRuntime (future Work Items)')
  })

  test('V3 domain-architecture-v3.md opening note explicitly states TransformRegistry/Runtime are implemented and VERIFIED', () => {
    const src = readSpec('domain-architecture-v3.md')
    expect(src).toContain('TransformRegistry and TransformRuntime have been implemented')
    expect(src).toContain('VERIFIED (WORK-010 and WORK-011')
  })

  test('V3 domain-architecture-v3.md §5 references WORK-010 and WORK-011 as VERIFIED', () => {
    const src = readSpec('domain-architecture-v3.md')
    expect(src).toContain('WORK-010, VERIFIED')
    expect(src).toContain('WORK-011, VERIFIED')
  })

  test('V3 domain-architecture-v3.md still correctly states concrete Transform implementations remain future', () => {
    const src = readSpec('domain-architecture-v3.md')
    // Concrete transforms (compression, encryption, etc.) are still future —
    // only the registry/runtime/contract are implemented.
    expect(src).toContain('Concrete Transform implementations remain future')
  })
})
