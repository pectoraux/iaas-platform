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

describe('WORK-015/016/017/018 — frozen V4 state and next-work release', () => {
  test('ACR-003 is approved and authoritative', () => {
    expect(acr).toContain('Status: `APPROVED`')
    expect(acr).toContain('IAAS-DOM-ARCH-4` (FROZEN)')
  })
  test('V4 is frozen and canonical', () => {
    expect(arch).toContain('Status: **FROZEN**')
    expect(arch).toContain('current canonical domain architecture')
    expect(req).toContain('Domain Architecture: `IAAS-DOM-ARCH-4` (FROZEN)')
    expect(graph).toContain('Domain Architecture: `IAAS-DOM-ARCH-4` (FROZEN)')
  })
  test('V3 remains immutable historical architecture', () => {
    expect(v3).toContain('IAAS-DOM-ARCH-3')
    expect(v3).toContain('FROZEN')
    expect(arch).toContain('V3 is not modified in place')
  })
  test('DOM-018..DOM-022 are frozen acceptance-bearing contracts', () => {
    for (const id of ['DOM-018', 'DOM-019', 'DOM-020', 'DOM-021', 'DOM-022']) expect(req).toContain(id)
    expect(req).toContain('FROZEN-CONTRACT')
    expect(req).not.toContain('candidate')
  })
  test('DOM-P04 is promoted only in current frozen V4', () => {
    expect(req).toContain('DOM-P04 (V1): **SUPERSEDED by DOM-018..DOM-022 under approved ACR-003**')
    const v1 = read('domain-requirements.md')
    expect(v1).toContain('DOM-P04')
    expect(v1).not.toContain('DOM-P04 (V1): **SUPERSEDED')
  })
  test('DOM-P05..P08 remain future/open/research', () => {
    expect(req).toContain('DOM-P05..DOM-P08: remain FUTURE/OPEN/RESEARCH')
  })
  test('WORK-015/016/017/018/019/020/021 are VERIFIED and WORK-022 is READY', () => {
    for (const id of [
      '## WORK-015 — IAAS-DOM-ARCH-4 Freeze and DOM-P04 Truth Promotion',
      '## WORK-016 — ExtensionRegistry Implementation',
      '## WORK-017 — ExtensionRuntime Implementation',
      '## WORK-018 — ExtensionProvenance Durable Persistence',
      '## WORK-019 — Sandbox Architecture and ACR-004',
      '## WORK-020 — IAAS-DOM-ARCH-5 Freeze and DOM-P05 Promotion',
      '## WORK-021 — WASI Sandbox Host Foundation',
      '## WORK-022 — Sandbox Lifecycle Completion',
    ]) expect(items).toContain(id)
    expect(items).toContain('Status: `VERIFIED`')
    expect(items).toContain('Status: `READY`')
    expect(deps).toContain('WORK-014 -> WORK-015')
    expect(deps).toContain('WORK-015 -> WORK-016')
    expect(deps).toContain('WORK-016 -> WORK-017')
    expect(deps).toContain('WORK-017 -> WORK-018')
    expect(deps).toContain('WORK-018 -> WORK-019')
    expect(deps).toContain('WORK-019 -> WORK-020')
    expect(deps).toContain('WORK-020 -> WORK-021')
    expect(deps).toContain('WORK-021 -> WORK-022')
    expect(deps).toContain('WORK-022 is READY')
  })
  test('WORK-016 is released only against frozen V4', () => {
    const order = read('work-orders/WORK-016.md')
    expect(order).toContain('Status\n`RELEASED`')
    expect(order).toContain('`IAAS-DOM-ARCH-4` (FROZEN)')
    expect(order).toContain('`WORK-015` VERIFIED')
    expect(order).toContain('Do not start WORK-017')
  })
  test('WORK-017 is released only against frozen V4 and WORK-016 VERIFIED', () => {
    const order = read('work-orders/WORK-017.md')
    expect(order).toContain('`RELEASED`')
    expect(order).toContain('`IAAS-DOM-ARCH-4` (FROZEN)')
    expect(order).toContain('`WORK-016` VERIFIED')
    expect(order).toContain('DOM-020')
  })
  test('WORK-018 is released only against frozen V4 and WORK-017 VERIFIED', () => {
    const order = read('work-orders/WORK-018.md')
    expect(order).toContain('`RELEASED`')
    expect(order).toContain('`IAAS-DOM-ARCH-4` (FROZEN)')
    expect(order).toContain('`WORK-017` VERIFIED')
    expect(order).toContain('DOM-022')
    expect(order).toContain('sandbox technology')
  })
})
