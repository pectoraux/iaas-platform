/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, 'spec', p), 'utf8')

const arch = read('domain-architecture-v4.md')
const req = read('domain-requirements-v4.md')
const graph = read('domain-dependency-graph-v4.md')
const items = read('work-items.md')
const deps = read('dependency-graph.md')
const acr = read('architecture-change-requests/ACR-003.md')
const v3 = read('domain-architecture-v3.md')

describe('WORK-015 — V4 freeze and DOM-P04 truth promotion', () => {
  test('ACR-003 is approved and authoritative', () => {
    expect(acr).toContain('Status: `APPROVED`')
    expect(acr).toContain('New Architecture Version: `IAAS-DOM-ARCH-4` (FROZEN)')
    expect(acr).toContain('DOM-P04')
  })

  test('V4 is frozen and canonical', () => {
    expect(arch).toContain('Status: **FROZEN**')
    expect(arch).toContain('current canonical domain architecture')
    expect(req).toContain('Domain Architecture: `IAAS-DOM-ARCH-4` (FROZEN)')
    expect(graph).toContain('Domain Architecture: `IAAS-DOM-ARCH-4` (FROZEN)')
  })

  test('V3 remains untouched and historical', () => {
    expect(v3).toContain('IAAS-DOM-ARCH-3')
    expect(v3).toContain('FROZEN')
    expect(arch).toContain('V3 is not modified in place')
  })

  test('DOM-018..DOM-022 are frozen acceptance-bearing contracts', () => {
    for (const id of ['DOM-018', 'DOM-019', 'DOM-020', 'DOM-021', 'DOM-022']) {
      expect(req).toContain(id)
    }
    expect(req).toContain('FROZEN-CONTRACT')
    expect(req).not.toContain('candidate')
  })

  test('DOM-P04 is superseded only in the current V4 requirements', () => {
    expect(req).toContain('DOM-P04 (V1): **SUPERSEDED by DOM-018..DOM-022 under approved ACR-003**')
    expect(arch).toContain('`DOM-P04` is **SUPERSEDED**')
    expect(deps).toContain('WORK-014 -> WORK-015')
  })

  test('historical V1 requirements are preserved', () => {
    const v1req = read('domain-requirements.md')
    expect(v1req).toContain('DOM-P04 — TransformRegistry')
    expect(v1req).toContain('FUTURE')
  })

  test('WORK-014 is VERIFIED and WORK-015 is READY', () => {
    expect(items).toContain('## WORK-015 — IAAS-DOM-ARCH-4 Freeze and DOM-P04 Truth Promotion')
    expect(items).toContain('Status: `READY`')
    expect(deps).toContain('WORK-001 through WORK-014 are VERIFIED')
    expect(deps).toContain('WORK-015 is READY')
  })

  test('no later implementation Work Item is released', () => {
    expect(items).not.toContain('WORK-016')
  })
})
