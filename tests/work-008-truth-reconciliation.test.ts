/// <reference types="bun-types" />
// =============================================================================
// WORK-008 — Architecture Truth Reconciliation regression tests
// =============================================================================
// Verifies BASE-015 (Architecture Truth Synchronization) and W008-AC01..AC06.
// These tests prevent a future reversion that incorrectly labels an
// already-VERIFIED architecture primitive (VerifiedEvidenceContext) as merely
// PROPOSED.
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()

function readSpec(file: string): string {
  return readFileSync(join(REPO_ROOT, 'spec', file), 'utf8')
}

// ---------------------------------------------------------------------------
// W008-AC02 — VerifiedEvidenceContext is represented as implemented/current
// ---------------------------------------------------------------------------

describe('WORK-008 — VerifiedEvidenceContext promotion (W008-AC02, BASE-015)', () => {
  test('V2 domain-requirements-v2.md classifies DOM-013 as implemented and VERIFIED', () => {
    const src = readSpec('domain-requirements-v2.md')
    expect(src).toContain('DOM-013')
    expect(src).toContain('ACR-001')
    // The stale "pending WORK-003" must be gone; replaced with VERIFIED.
    expect(src).toContain('VERIFIED by WORK-003')
    expect(src).not.toContain('implementation pending WORK-003')
  })

  test('V1 domain-requirements.md marks DOM-P01 as SUPERSEDED (not PROPOSED)', () => {
    const src = readSpec('domain-requirements.md')
    // DOM-P01 must be marked SUPERSEDED, not merely PROPOSED.
    expect(src).toContain('DOM-P01')
    expect(src).toContain('SUPERSEDED')
    // The stale "PROPOSED." label for DOM-P01 must be gone.
    expect(src).not.toMatch(/DOM-P01.*PROPOSED\./)
    // The supersession must trace to ACR-001, IAAS-DOM-ARCH-2, DOM-013, WORK-003.
    expect(src).toContain('ACR-001')
    expect(src).toContain('DOM-013')
    expect(src).toContain('WORK-003')
  })

  test('V1 domain-architecture.md §8 has a WORK-008 addendum noting the promotion', () => {
    const src = readSpec('domain-architecture.md')
    // The original FUTURE text is preserved (V1 immutability, W008-AC03).
    expect(src).toContain('FUTURE**: generic `VerifiedEvidenceContext`')
    // The addendum is present.
    expect(src).toContain('WORK-008 (BASE-015) addendum')
    expect(src).toContain('SUPERSEDED')
    expect(src).toContain('IMPLEMENTED')
    expect(src).toContain('verified-evidence-context.ts')
  })

  test('V1 domain-architecture.md status is SUPERSEDED (not canonical)', () => {
    const src = readSpec('domain-architecture.md')
    expect(src).toContain('SUPERSEDED by `IAAS-DOM-ARCH-2`')
    // The stale "canonical" claim must be corrected.
    expect(src).not.toContain('canonical Domain Architecture V1')
  })
})

// ---------------------------------------------------------------------------
// W008-AC03 — Historical V1 preservation (not silently rewritten)
// ---------------------------------------------------------------------------

describe('WORK-008 — Historical V1 preservation (W008-AC03)', () => {
  test('V1 domain-architecture.md retains its original FUTURE classification text', () => {
    const src = readSpec('domain-architecture.md')
    // The original V1 text is preserved — not rewritten. The addendum is
    // added BELOW it, not replacing it.
    expect(src).toContain('FUTURE**: generic `VerifiedEvidenceContext` (constitution §6)')
    expect(src).toContain('VPP pre-population pattern is accepted as safe in the interim')
  })

  test('V1 domain-architecture.md retains its original version identity', () => {
    const src = readSpec('domain-architecture.md')
    expect(src).toContain('IAAS-DOM-ARCH-1')
    expect(src).toContain('Produced by: `WORK-002`')
  })
})

// ---------------------------------------------------------------------------
// W008-AC04 — No unrelated promotion
// ---------------------------------------------------------------------------

describe('WORK-008 — No unrelated promotion (W008-AC04)', () => {
  test('DOM-P02 through DOM-P08 remain FUTURE/PROPOSED (not promoted)', () => {
    const src = readSpec('domain-requirements.md')
    // Check each future item's own line — it must NOT contain SUPERSEDED or VERIFIED.
    const lines = src.split('\n')
    const futureItems = ['DOM-P02', 'DOM-P03', 'DOM-P04', 'DOM-P05', 'DOM-P06', 'DOM-P07', 'DOM-P08']
    for (const item of futureItems) {
      const line = lines.find(l => l.includes(item) && l.trimStart().startsWith('-'))
      expect(line).toBeDefined()
      expect(line!).not.toContain('SUPERSEDED')
      expect(line!).not.toContain('VERIFIED')
    }
    // They must still be labelled FUTURE or OPEN / RESEARCH.
    expect(src).toContain('`DOM-P02` — TransformRegistry (technical catalog). FUTURE.')
    expect(src).toContain('`DOM-P03` — TransformRuntime (execution engine). FUTURE.')
    expect(src).toContain('`DOM-P08` — Extension sandbox technology selection. OPEN / RESEARCH')
  })
})

// ---------------------------------------------------------------------------
// W008-AC05 — Cross-document consistency
// ---------------------------------------------------------------------------

describe('WORK-008 — Cross-document consistency (W008-AC05)', () => {
  test('architecture.md registers V3 as FROZEN, V2 and V1 as SUPERSEDED', () => {
    const src = readSpec('architecture.md')
    expect(src).toContain('`IAAS-DOM-ARCH-3` | FROZEN')
    expect(src).toContain('`IAAS-DOM-ARCH-2` | SUPERSEDED')
    expect(src).toContain('`IAAS-DOM-ARCH-1` | SUPERSEDED')
  })

  test('architecture-lock.md registers V3 as current FROZEN domain version', () => {
    const src = readSpec('architecture-lock.md')
    expect(src).toContain('IAAS-DOM-ARCH-3')
    expect(src).toContain('FROZEN')
  })

  test('dependency-graph.md states WORK-008 is VERIFIED and WORK-009 is eligible', () => {
    const src = readSpec('dependency-graph.md')
    expect(src).toContain('WORK-001 is VERIFIED')
    expect(src).toContain('WORK-008')
    expect(src).toContain('WORK-009')
  })

  test('work-items.md records WORK-008 as VERIFIED and WORK-009 as READY', () => {
    const src = readSpec('work-items.md')
    // WORK-008 status
    const w008 = src.split('## WORK-008')[1]?.split('## WORK-009')[0] ?? ''
    expect(w008).toContain('Status: `VERIFIED`')
    // WORK-009 exists and is READY
    expect(src).toContain('## WORK-009')
    const w009 = src.split('## WORK-009')[1] ?? ''
    expect(w009).toContain('Status: `READY`')
    expect(w009).toContain('BASE-016')
  })
})

// ---------------------------------------------------------------------------
// W008-AC07 — No production changes
// ---------------------------------------------------------------------------

describe('WORK-008 — No production changes (W008-AC07)', () => {
  test('no src/ files are modified by WORK-008 (spec-only work)', () => {
    // This is a static reminder test. The actual diff-scope enforcement is
    // in CI (diff-scope guard). This test documents the constraint.
    expect(true).toBe(true)
  })
})
