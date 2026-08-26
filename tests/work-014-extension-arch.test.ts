/// <reference types="bun-types" />
// WORK-014/015 — Extension Stack architecture freeze regression suite
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (file: string) => readFileSync(join(root, 'spec', file), 'utf8')

const arch = read('domain-architecture-v4.md')
const req = read('domain-requirements-v4.md')
const graph = read('domain-dependency-graph-v4.md')
const acr = read('architecture-change-requests/ACR-003.md')

describe('WORK-014/015 — ACR-003 and V4 freeze', () => {
  test('ACR-003 is approved', () => {
    expect(acr).toContain('ACR-003')
    expect(acr).toContain('Status: `APPROVED`')
    expect(acr).toContain('IAAS-DOM-ARCH-4` (FROZEN)')
  })
  test('V4 is current canonical frozen architecture', () => {
    expect(arch).toContain('Status: **FROZEN**')
    expect(arch).toContain('current canonical domain architecture')
    expect(arch).toContain('FROZEN-CONTRACT')
  })
  test('V3 remains immutable historical architecture', () => {
    const v3 = read('domain-architecture-v3.md')
    expect(v3).toContain('IAAS-DOM-ARCH-3')
    expect(v3).toContain('FROZEN')
    expect(arch).toContain('V3 is not modified in place')
  })
  test('Extension/Registry/Runtime contracts are frozen without implementation', () => {
    expect(arch).toContain('extensionType + extensionVersion')
    expect(arch).toContain('FROZEN-CONTRACT')
    expect(arch).toContain('Concrete extensions are future')
    expect(arch).toContain('catalog and lifecycle authority')
    expect(arch).toContain('execution and isolation authority')
    expect(arch).toContain('does not own catalog/lifecycle state')
  })
  test('Provenance ownership/fingerprint/order is frozen', () => {
    expect(arch).toContain('provenance boundary owns durable storage')
    expect(arch).toContain('executionIdempotencyKey')
    expect(arch).toContain('SHA-256')
    expect(arch).toContain("resultStatus='failed'")
    expect(arch).toContain('re-throws')
  })
  test('Capability/resource authority precedence is frozen', () => {
    expect(arch).toContain('Tenant/operator authorization')
    expect(arch).toContain('Runtime-enforced ceiling = min(declared, approved)')
    expect(arch).toContain('cannot self-authorize')
  })
  test('Lifecycle authority and revocation semantics are frozen', () => {
    expect(arch).toContain('registered → installed → activated')
    expect(arch).toContain('revoked (terminal)')
    expect(arch).toContain('ExtensionRegistry owns lifecycle transitions')
    expect(arch).toContain('in-flight execution')
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
  test('V4 requirements are frozen acceptance-bearing contracts', () => {
    for (const id of ['DOM-018', 'DOM-019', 'DOM-020', 'DOM-021', 'DOM-022']) expect(req).toContain(id)
    expect(req).not.toContain('candidate')
    expect(req).toContain('FROZEN-CONTRACT')
  })
  test('V4 dependency graph is frozen and acyclic', () => {
    expect(graph).toContain('IAAS-DOM-ARCH-4` (FROZEN)')
    expect(graph).toContain('ExtensionRuntime → TransformRuntime.executeTransform()')
    expect(graph).toContain('ExtensionProvenance')
    expect(graph).not.toContain('candidate')
  })
  test('Extension anti-dependencies remain explicit', () => {
    expect(graph).toContain('ExtensionRegistry  ✗-> Vertical services')
    expect(graph).toContain('ExtensionRuntime   ✗-> EconomicPipeline')
    expect(graph).toContain('ExtensionRegistry  ✗-> Kernel')
    expect(graph).toContain('Kernel             ✗-> ExtensionRegistry / ExtensionRuntime')
  })
})
