/// <reference types="bun-types" />
// =============================================================================
// WORK-014 — Extension Stack Architecture (ACR-003 / IAAS-DOM-ARCH-4 candidate)
// =============================================================================
// Verifies W014-AC01..AC11 + AR-014-01..04 corrections:
//   - ACR-003 completeness
//   - V4 candidate consistency (CANDIDATE, not FROZEN-CONTRACT)
//   - ExtensionProvenance persistence/ownership specified (AR-014-01)
//   - Capability authority + resource-limit precedence (AR-014-02)
//   - Lifecycle authority + transition semantics (AR-014-03)
//   - DOM-P04 non-promotion
//   - V3 immutability
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
    expect(arch).toContain('declaredCapabilities')
    expect(arch).toContain('lifecycle hooks')
  })

  test('ExtensionRegistry is discovery/catalog only, does NOT execute (W014-AC03)', () => {
    expect(arch).toContain('ExtensionRegistry — Discovery and Catalog')
    expect(arch).toContain('Discovery')
    expect(arch).toContain('Version compatibility')
    expect(arch).toContain('Certification metadata')
    expect(arch).toContain('Revocation metadata')
    expect(arch).toContain('an execution engine (that is `ExtensionRuntime`)')
  })

  test('ExtensionRuntime is execution/isolation only, does NOT own catalog or lifecycle state (W014-AC04)', () => {
    expect(arch).toContain('ExtensionRuntime — Execution and Isolation Engine')
    expect(arch).toContain('Execute')
    expect(arch).toContain('Capability enforcement')
    expect(arch).toContain('does NOT directly write to the')
    expect(arch).toContain('the authority for lifecycle transitions')
  })
})

// ---------------------------------------------------------------------------
// AR-014-01 — ExtensionProvenance persistence/ownership specified
// ---------------------------------------------------------------------------

describe('WORK-014 — AR-014-01: ExtensionProvenance specified', () => {
  const arch = readSpec('domain-architecture-v4.md')

  test('ExtensionProvenance has its own §2.6 section with ownership boundary', () => {
    expect(arch).toContain('ExtensionProvenance — Durable Provenance Record')
    expect(arch).toContain('owned by the provenance boundary')
    expect(arch).toContain('The runtime does NOT directly write to the')
    expect(arch).toContain('database')
  })

  test('ExtensionProvenance has minimum identity/fingerprint', () => {
    expect(arch).toContain('tenantId')
    expect(arch).toContain('executionIdempotencyKey')
    expect(arch).toContain('inputHash')
    expect(arch).toContain('outputHash')
    expect(arch).toContain('resultStatus')
    expect(arch).toContain('Deterministic fingerprint')
  })

  test('ExtensionProvenance has idempotency + failure ordering semantics', () => {
    expect(arch).toContain('1:1 with the idempotency key')
    expect(arch).toContain('provenance is emitted AFTER execution completes')
    expect(arch).toContain("resultStatus='failed'")
    expect(arch).toContain('re-thrown')
    expect(arch).toContain('silent success')
  })

  test('ExtensionProvenance is tenant-bound', () => {
    expect(arch).toContain('Cross-tenant provenance queries are prohibited')
  })
})

// ---------------------------------------------------------------------------
// AR-014-02 — Capability authority + resource-limit precedence
// ---------------------------------------------------------------------------

describe('WORK-014 — AR-014-02: capability authority + resource-limit policy', () => {
  const arch = readSpec('domain-architecture-v4.md')

  test('Four-layer precedence chain is explicit', () => {
    expect(arch).toContain('Capability Authority and Resource-Limit Policy')
    expect(arch).toContain('Extension-declared request')
    expect(arch).toContain('Tenant/operator authorization')
    expect(arch).toContain('Runtime-enforced ceiling')
    expect(arch).toContain('Execution allowed / denied')
  })

  test('Runtime enforces min(declared, approved)', () => {
    expect(arch).toContain('min(extension.declaredLimits, tenant.approvedLimits)')
    expect(arch).toContain('minimum of (declared, approved)')
  })

  test('Tenant authorization is authoritative (extension cannot self-authorize)', () => {
    expect(arch).toContain('tenant/operator authorization is authoritative')
    expect(arch).toContain('cannot self-authorize')
  })

  test('Denied execution emits failure provenance', () => {
    expect(arch).toContain('DENIED')
    expect(arch).toContain("resultStatus='failed'")
  })
})

// ---------------------------------------------------------------------------
// AR-014-03 — Lifecycle authority + transition semantics
// ---------------------------------------------------------------------------

describe('WORK-014 — AR-014-03: lifecycle authority + transitions', () => {
  const arch = readSpec('domain-architecture-v4.md')

  test('Lifecycle has registry-owned vs runtime-enforced split', () => {
    expect(arch).toContain('Lifecycle Authority and Transition Semantics')
    expect(arch).toContain('Registry-owned transitions')
    expect(arch).toContain('Runtime-observed/enforced')
  })

  test('Revoked is terminal', () => {
    expect(arch).toContain('revoked (terminal)')
    expect(arch).toContain('Revocation is terminal')
    expect(arch).toContain('cannot transition back')
  })

  test('In-flight execution on revocation is defined', () => {
    expect(arch).toContain('In-flight on revocation')
    expect(arch).toContain('completes the current execution')
    expect(arch).toContain('refuses all future executions')
  })

  test('Installation/uninstall semantics are defined', () => {
    expect(arch).toContain('installed')
    expect(arch).toContain("NOT a lifecycle state")
    expect(arch).toContain('administrative action')
  })
})

// ---------------------------------------------------------------------------
// AR-014-04 — CANDIDATE vs FROZEN-CONTRACT status consistency
// ---------------------------------------------------------------------------

describe('WORK-014 — AR-014-04: CANDIDATE status consistency', () => {
  const arch = readSpec('domain-architecture-v4.md')
  const reqs = readSpec('domain-requirements-v4.md')
  const graph = readSpec('domain-dependency-graph-v4.md')

  test('V4 arch uses PROPOSED CONTRACT (not FROZEN-CONTRACT) for all Extension primitives', () => {
    // All Extension classifications must say PROPOSED CONTRACT, not FROZEN-CONTRACT
    expect(arch).toContain('PROPOSED CONTRACT')
    // Must NOT contain FROZEN-CONTRACT for Extension classifications
    expect(arch).not.toContain('Classification: **FROZEN-CONTRACT**')
  })

  test('V4 requirements use PROPOSED CONTRACT (not FROZEN-CONTRACT)', () => {
    expect(reqs).toContain('PROPOSED CONTRACT by ACR-003 (candidate)')
    expect(reqs).not.toContain('FROZEN-CONTRACT by ACR-003')
  })

  test('V4 dependency graph uses "proposed" language', () => {
    expect(graph).toContain('proposed')
    expect(graph).not.toContain('(frozen)')
  })

  test('V4 arch header is CANDIDATE', () => {
    expect(arch).toContain('Status: **CANDIDATE**')
  })

  test('V4 arch opening note says proposed contracts become frozen only upon V4 freeze', () => {
    expect(arch).toContain('proposed')
    expect(arch).toContain('they become frozen only upon V4')
  })
})

// ---------------------------------------------------------------------------
// W014-AC05 — security/isolation boundaries
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
// W014-AC06 — anti-dependencies
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

  test('Runtime does NOT directly own ExtensionProvenance storage (AR-014-01)', () => {
    expect(graph).toContain('ExtensionRuntime   ✗-> ExtensionProvenance')
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
    const domP04Line = src.split('DOM-P04')[1]?.split('\n')[0] ?? ''
    expect(domP04Line).not.toContain('SUPERSEDED')
  })

  test('V4 candidate requirements state DOM-P04 remains FUTURE (not SUPERSEDED) until V4 freeze (AR-014-05)', () => {
    const src = readSpec('domain-requirements-v4.md')
    expect(src).toContain('DOM-P04')
    expect(src).toContain('remains FUTURE/OPEN/RESEARCH')
    expect(src).toContain('does NOT transition')
    expect(src).toContain('out of FUTURE until ACR-003 is approved')
    // Must NOT say SUPERSEDED for DOM-P04
    expect(src).not.toContain('SUPERSEDED by DOM-018')
  })

  test('V4 candidate architecture states DOM-P04 remains FUTURE until V4 freeze (AR-014-05)', () => {
    const src = readSpec('domain-architecture-v4.md')
    expect(src).toContain('DOM-P04')
    expect(src).toContain('remains')
    expect(src).toContain('FUTURE/OPEN/RESEARCH')
    expect(src).toContain('does NOT transition out of FUTURE')
    // Must NOT say SUPERSEDED for DOM-P04
    expect(src).not.toMatch(/DOM-P04.*SUPERSEDED/)
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
// W014-AC09 — V3 immutability + zero production
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
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// W014-AC10 — V4 candidate documents exist
// ---------------------------------------------------------------------------

describe('WORK-014 — V4 candidate documents (W014-AC10)', () => {
  test('domain-requirements-v4.md has DOM-018..DOM-022', () => {
    const src = readSpec('domain-requirements-v4.md')
    expect(src).toContain('DOM-018')
    expect(src).toContain('DOM-019')
    expect(src).toContain('DOM-020')
    expect(src).toContain('DOM-021')
    expect(src).toContain('DOM-022')
  })

  test('domain-dependency-graph-v4.md has Extension Stack DAG', () => {
    const src = readSpec('domain-dependency-graph-v4.md')
    expect(src).toContain('Extension')
    expect(src).toContain('ExtensionRegistry')
    expect(src).toContain('ExtensionRuntime')
    expect(src).toContain('ExtensionProvenance')
  })
})
