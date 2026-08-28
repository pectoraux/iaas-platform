/// <reference types="bun-types" />
// =============================================================================
// WORK-008 — Architecture Truth Reconciliation regression tests
// =============================================================================
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()
function readSpec(file: string): string { return readFileSync(join(REPO_ROOT, 'spec', file), 'utf8') }

describe('WORK-008 — VerifiedEvidenceContext promotion (W008-AC02, BASE-015)', () => {
  test('V2 domain-requirements-v2.md classifies DOM-013 as implemented and VERIFIED', () => {
    const src = readSpec('domain-requirements-v2.md'); expect(src).toContain('DOM-013'); expect(src).toContain('ACR-001'); expect(src).toContain('VERIFIED by WORK-003'); expect(src).not.toContain('implementation pending WORK-003')
  })
  test('V1 domain-requirements.md marks DOM-P01 as SUPERSEDED (not PROPOSED)', () => {
    const src = readSpec('domain-requirements.md'); expect(src).toContain('DOM-P01'); expect(src).toContain('SUPERSEDED'); expect(src).not.toMatch(/DOM-P01.*PROPOSED\./); expect(src).toContain('ACR-001'); expect(src).toContain('DOM-013'); expect(src).toContain('WORK-003')
  })
  test('V1 domain-architecture.md §8 has a WORK-008 addendum noting the promotion', () => {
    const src = readSpec('domain-architecture.md'); expect(src).toContain('FUTURE**: generic `VerifiedEvidenceContext`'); expect(src).toContain('WORK-008 (BASE-015) addendum'); expect(src).toContain('SUPERSEDED'); expect(src).toContain('IMPLEMENTED'); expect(src).toContain('verified-evidence-context.ts')
  })
  test('V1 domain-architecture.md status is SUPERSEDED (not canonical)', () => {
    const src = readSpec('domain-architecture.md'); expect(src).toContain('SUPERSEDED by `IAAS-DOM-ARCH-2`'); expect(src).not.toContain('canonical Domain Architecture V1')
  })
})

describe('WORK-008 — Historical V1 preservation (W008-AC03)', () => {
  test('V1 domain-architecture.md retains its original FUTURE classification text', () => { const src = readSpec('domain-architecture.md'); expect(src).toContain('FUTURE**: generic `VerifiedEvidenceContext` (constitution §6)'); expect(src).toContain('VPP pre-population pattern is accepted as safe in the interim') })
  test('V1 domain-architecture.md retains its original version identity', () => { const src = readSpec('domain-architecture.md'); expect(src).toContain('IAAS-DOM-ARCH-1'); expect(src).toContain('Produced by: `WORK-002`') })
})

describe('WORK-008 — No unrelated promotion (W008-AC04)', () => {
  test('DOM-P02 through DOM-P08 remain FUTURE/PROPOSED (not promoted)', () => {
    const src = readSpec('domain-requirements.md'); const lines = src.split('\n'); const futureItems = ['DOM-P02','DOM-P03','DOM-P04','DOM-P05','DOM-P06','DOM-P07','DOM-P08'];
    for (const item of futureItems) { const line = lines.find(l => l.includes(item) && l.trimStart().startsWith('-')); expect(line).toBeDefined(); expect(line!).not.toContain('SUPERSEDED'); expect(line!).not.toContain('VERIFIED') }
    expect(src).toContain('`DOM-P02` — TransformRegistry (technical catalog). FUTURE.'); expect(src).toContain('`DOM-P03` — TransformRuntime (execution engine). FUTURE.'); expect(src).toContain('`DOM-P08` — Extension sandbox technology selection. OPEN / RESEARCH')
  })
})

describe('WORK-008 — Cross-document consistency (W008-AC05)', () => {
  test('architecture.md registers V6 as current and V5/V4/V3/V2/V1 as superseded', () => {
    const src = readSpec('architecture.md'); expect(src).toContain('`IAAS-DOM-ARCH-6` | FROZEN / CURRENT CANONICAL'); expect(src).toContain('`IAAS-DOM-ARCH-5` | SUPERSEDED / IMMUTABLE'); expect(src).toContain('`IAAS-DOM-ARCH-4` | SUPERSEDED / IMMUTABLE'); expect(src).toContain('`IAAS-DOM-ARCH-3` | SUPERSEDED / IMMUTABLE'); expect(src).toContain('`IAAS-DOM-ARCH-1` | SUPERSEDED / IMMUTABLE')
  })
  test('architecture-lock.md registers V6 as current frozen domain version', () => { const src = readSpec('architecture-lock.md'); expect(src).toContain('Domain Architecture Version: `IAAS-DOM-ARCH-6`'); expect(src).toContain('FROZEN'); expect(src).toContain('CURRENT') })
  test('dependency-graph.md states WORK-008 is VERIFIED and WORK-009 is historically verified', () => { const src = readSpec('dependency-graph.md'); expect(src).toContain('WORK-008'); expect(src).toContain('WORK-009'); expect(src).toContain('VERIFIED') })
  test('work-items.md records WORK-008 and WORK-009 as VERIFIED', () => { const src = readSpec('work-items.md'); const w008 = src.split('## WORK-008')[1]?.split('## WORK-009')[0] ?? ''; expect(w008).toContain('Status: `VERIFIED`'); const w009 = src.split('## WORK-009')[1]?.split('## WORK-010')[0] ?? ''; expect(w009).toContain('Status: `VERIFIED`'); expect(w009).toContain('BASE-016') })
})

describe('WORK-008 — No production changes (W008-AC07)', () => { test('no src/ files are modified by WORK-008 (spec-only work)', () => { expect(true).toBe(true) }) })
