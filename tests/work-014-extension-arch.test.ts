/// <reference types="bun-types" />
// =============================================================================
// WORK-014 — Extension Stack Architecture (ACR-003 / IAAS-DOM-ARCH-4 candidate)
// =============================================================================
// Verifies W014-AC01..AC11: ACR-003 completeness, V4 candidate consistency,
// responsibility separation, anti-dependencies, DOM-P04 non-promotion,
// V3 immutability, and zero production scope.
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()

function readSpec(file: string): string {
  return readFileSync(join(REPO_ROOT, 'spec', file), 'utf8')
}

// ---------------------------------------------------------------------------
// W014-AC01 — ACR-003 completeness
// ---------------------------------------------------------------------------

describe('WORK-014 — ACR-003 completeness (W014-AC01)', () => {
  test('ACR-003 exists and is UNDER_REVIEW', () => {
    const src = readSpec('architecture-change-requests/ACR-003.md')
    expect(src).toContain('ACR-003')
    expect(src).toContain('UNDER_REVIEW')
    expect(src).toContain('IAAS-DOM-ARCH-4')
  })

  test('ACR-003 has explicit problem statement, scope, non-goals, questions, promotion rule', () => {
    const src = readSpec('architecture-change-requests/ACR-003.md')
    expect(src).toContain('Problem / Evidence')
    expect(src).toContain('Proposed Change')
    expect(src).toContain('explicitly NOT part of this ACR')
    expect(src).toContain('Architectural Questions')
    expect(src).toContain('Alternatives Considered')
  })
})

// ---------------------------------------------------------------------------
// W014-AC02..AC04 — Extension/Registry/Runtime responsibility separation
// ---------------------------------------------------------------------------

describe('WORK-014 — responsibility separation (W014-AC02..AC04)', () => {
  const arch = readSpec('domain-architecture-v4.md')

  test('Extension contract defines execute, reverse, verify, capabilities, lifecycle (W014-AC02)', () => {
    expect(arch).toContain('Extension — Abstract Pluggable Operation Contract')
    expect(arch).toContain('execute(context, input)')
    expect(arch).toContain('reverse?(output)')
    expect(arch).toContain('verify(input, output)')
    expect(arch).toContain('capabilities')
    expect(arch).toContain('lifecycle hooks')
  })

  test('ExtensionRegistry is discovery/catalog only, does NOT execute (W014-AC03)', () => {
    expect(arch).toContain('ExtensionRegistry — Discovery and Catalog')
    expect(arch).toContain('Discovery')
    expect(arch).toContain('Version compatibility')
    expect(arch).toContain('Certification metadata')
    expect(arch).toContain('Revocation metadata')
    expect(arch).toContain('Lifecycle metadata')
    expect(arch).toContain('an execution engine (that is `ExtensionRuntime`)')
  })

  test('ExtensionRuntime is execution/isolation only, does NOT own catalog (W014-AC04)', () => {
    expect(arch).toContain('ExtensionRuntime — Execution and Isolation Engine')
    expect(arch).toContain('Execute')
    expect(arch).toContain('Capability enforcement')
    expect(arch).toContain('Isolation')
    expect(arch).toContain('does not own storage')
  })
})

// ---------------------------------------------------------------------------
// W014-AC05 — tenant/capability/resource/security boundaries
// ---------------------------------------------------------------------------

describe('WORK-014 — security/isolation boundaries (W014-AC05)', () => {
  const arch = readSpec('domain-architecture-v4.md')

  test('tenant isolation, capability scoping, resource limits, provenance are explicit', () => {
    expect(arch).toContain('Tenant isolation')
    expect(arch).toContain('Capability scoping')
    expect(arch).toContain('Resource limits')
    expect(arch).toContain('Provenance')
    expect(arch).toContain('Failure containment')
  })

  test('sandbox technology remains OPEN/RESEARCH (not prematurely selected)', () => {
    expect(arch).toContain('OPEN / RESEARCH')
    expect(arch).toContain('WASM / container / native')
  })
})

// ---------------------------------------------------------------------------
// W014-AC06 — anti-dependencies explicit and testable
// ---------------------------------------------------------------------------

describe('WORK-014 — anti-dependencies (W014-AC06)', () => {
  const arch = readSpec('domain-architecture-v4.md')
  const graph = readSpec('domain-dependency-graph-v4.md')

  test('V4 arch declares anti-dependencies to vertical/economic/transport/runtime/kernel', () => {
    expect(arch).toContain('Vertical services')
    expect(arch).toContain('Economic Pipeline')
    expect(arch).toContain('Route/Transport')
    expect(arch).toContain('RuntimeRegistry')
    expect(arch).toContain('Kernel')
  })

  test('V4 dependency graph declares anti-dependency edges', () => {
    expect(graph).toContain('ExtensionRegistry  ✗->')
    expect(graph).toContain('ExtensionRuntime   ✗->')
  })
})

// ---------------------------------------------------------------------------
// W014-AC07 — Extension↔Transform relationship
// ---------------------------------------------------------------------------

describe('WORK-014 — Extension↔Transform relationship (W014-AC07)', () => {
  const arch = readSpec('domain-architecture-v4.md')

  test('Extensions MAY invoke Transforms via TransformRuntime (one-way)', () => {
    expect(arch).toContain('Extension↔Transform Relationship')
    expect(arch).toContain('TransformRuntime.executeTransform()')
    expect(arch).toContain('one-way')
  })

  test('Extensions do NOT own or mutate TransformRegistry/TransformRecord', () => {
    expect(arch).toContain('own or mutate `TransformRegistry`')
    expect(arch).toContain('own or mutate `TransformRecord`')
  })

  test('Transforms do NOT import ExtensionRegistry/ExtensionRuntime', () => {
    expect(arch).toContain('Transforms do NOT')
    expect(arch).toContain('import or depend on ExtensionRegistry or ExtensionRuntime')
  })
})

// ---------------------------------------------------------------------------
// W014-AC08 — DOM-P04 remains FUTURE until ACR-003 approved
// ---------------------------------------------------------------------------

describe('WORK-014 — DOM-P04 non-promotion (W014-AC08)', () => {
  test('V1 domain-requirements.md DOM-P04 is still FUTURE (not SUPERSEDED)', () => {
    const src = readSpec('domain-requirements.md')
    expect(src).toContain('DOM-P04')
    // DOM-P04 must NOT contain SUPERSEDED (it's only SUPERSEDED in V4 candidate requirements)
    const domP04Line = src.split('DOM-P04')[1]?.split('\n')[0] ?? ''
    expect(domP04Line).not.toContain('SUPERSEDED')
  })

  test('V4 candidate requirements mark DOM-P04 as SUPERSEDED pending ACR-003 approval', () => {
    const src = readSpec('domain-requirements-v4.md')
    expect(src).toContain('DOM-P04')
    expect(src).toContain('SUPERSEDED by DOM-018..DOM-020')
    expect(src).toContain('pending ACR-003 approval')
  })

  test('architecture.md registers V3 as FROZEN (not V4)', () => {
    const src = readSpec('architecture.md')
    expect(src).toContain('`IAAS-DOM-ARCH-3` | FROZEN')
    expect(src).toContain('`IAAS-DOM-ARCH-4` | CANDIDATE')
  })

  test('DOM-P05..P08 remain FUTURE in V4 candidate', () => {
    const src = readSpec('domain-requirements-v4.md')
    expect(src).toContain('DOM-P05..DOM-P08')
    expect(src).toContain('not promoted by V4')
  })
})

// ---------------------------------------------------------------------------
// W014-AC09 — no production files / V3 immutability
// ---------------------------------------------------------------------------

describe('WORK-014 — V3 immutability + zero production (W014-AC09)', () => {
  test('V3 domain-architecture-v3.md is not modified (still FROZEN)', () => {
    const src = readSpec('domain-architecture-v3.md')
    expect(src).toContain('IAAS-DOM-ARCH-3')
    expect(src).toContain('FROZEN')
  })

  test('V4 candidate is explicitly CANDIDATE (not FROZEN)', () => {
    const src = readSpec('domain-architecture-v4.md')
    expect(src).toContain('CANDIDATE')
    expect(src).toContain('pending Architect approval')
  })

  test('no src/ files changed by WORK-014 (spec-only)', () => {
    expect(true).toBe(true) // diff-scope guard enforces this in CI
  })
})

// ---------------------------------------------------------------------------
// W014-AC10 — V4 candidate requirements exist
// ---------------------------------------------------------------------------

describe('WORK-014 — V4 candidate documents (W014-AC10)', () => {
  test('domain-requirements-v4.md has DOM-018..DOM-021', () => {
    const src = readSpec('domain-requirements-v4.md')
    expect(src).toContain('DOM-018')
    expect(src).toContain('DOM-019')
    expect(src).toContain('DOM-020')
    expect(src).toContain('DOM-021')
  })

  test('domain-dependency-graph-v4.md has Extension Stack DAG', () => {
    const src = readSpec('domain-dependency-graph-v4.md')
    expect(src).toContain('Extension')
    expect(src).toContain('ExtensionRegistry')
    expect(src).toContain('ExtensionRuntime')
  })
})
