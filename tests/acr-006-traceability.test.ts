// =============================================================================
// ACR-006 — V6 NET Requirement-to-Work-Item Traceability Regression Suite
// =============================================================================
// Static, dependency-free consistency tests (node:* builtins only — the
// specification-consistency CI job runs with no node_modules, per the
// WORK-016/018/025 convention).
//
// Provenance: ACR-006 was issued by the Chief Architect as GitHub Issue #45
// after PR #44 (WORK-026 implementation) was blocked with REQUIRE CHANGES on
// a governance/traceability blocker: the frozen V6 package assigned
// NET-003/NET-004 to WORK-026 while the frozen requirements define
// NET-003 = Network Lifecycle Authority and NET-004 = Deterministic Network
// Launch — semantics the issued WORK-026 scope explicitly forbids
// implementing. This suite durably enforces the ACR-006 corrected mapping:
//
//   NET-001 → WORK-025 (unchanged)
//   NET-002 → WORK-026 (reallocated from WORK-025)
//   NET-003 → WORK-025 (reallocated from WORK-026)
//   NET-004 → WORK-040 (sole owner; was WORK-026 + WORK-040)
//
// and proves the correction touched ONLY the assignment layer:
// domain-requirements-v6.md and the other semantic documents are pinned
// byte-for-byte to their pre-correction git blob SHAs.
// =============================================================================

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const ROOT = process.cwd()
function read(path: string): string { return readFileSync(join(ROOT, path), 'utf8') }
function gitBlobSha(content: string): string { const body = Buffer.from(content, 'utf8'); const header = Buffer.from(`blob ${body.length}\0`, 'utf8'); return createHash('sha1').update(header).update(body).digest('hex') }

const workItems = read('spec/work-items-v6.md')
const requirements = read('spec/domain-requirements-v6.md')
const order25 = read('spec/work-orders/WORK-025.md')
const order26 = read('spec/work-orders/WORK-026.md')
const order40 = read('spec/work-orders/WORK-040.md')
const workGraph = read('spec/dependency-graph-v6.md')
const acr6 = read('spec/architecture-change-requests/ACR-006.md')

function workItemSection(id: string): string {
  const start = workItems.indexOf(`## ${id} —`)
  expect(start).toBeGreaterThanOrEqual(0)
  const next = workItems.indexOf('\n## WORK-', start + 4)
  return workItems.slice(start, next < 0 ? workItems.length : next)
}

const requirementsLines = [...workItems.matchAll(/^Requirements: (.+)$/gm)].map((m) => m[1])
const ownersOf = (id: string): string[] => requirementsLines.filter((line) => line.includes(id))

// The exact frozen edge set (byte-identical before and after ACR-006; the
// correction changes one diagram annotation only).
const FROZEN_EDGES: ReadonlyArray<readonly [string, string]> = [
  ['WORK-023', 'WORK-024'], ['WORK-024', 'WORK-025'], ['WORK-025', 'WORK-026'],
  ['WORK-026', 'WORK-027'], ['WORK-026', 'WORK-028'], ['WORK-027', 'WORK-029'],
  ['WORK-027', 'WORK-030'], ['WORK-030', 'WORK-031'], ['WORK-031', 'WORK-032'],
  ['WORK-032', 'WORK-033'], ['WORK-028', 'WORK-034'], ['WORK-030', 'WORK-034'],
  ['WORK-025', 'WORK-035'], ['WORK-030', 'WORK-035'], ['WORK-034', 'WORK-036'],
  ['WORK-035', 'WORK-036'], ['WORK-026', 'WORK-037'], ['WORK-027', 'WORK-037'],
  ['WORK-030', 'WORK-037'], ['WORK-035', 'WORK-037'], ['WORK-030', 'WORK-038'],
  ['WORK-034', 'WORK-038'], ['WORK-026', 'WORK-039'], ['WORK-027', 'WORK-039'],
  ['WORK-028', 'WORK-039'], ['WORK-029', 'WORK-039'], ['WORK-034', 'WORK-039'],
  ['WORK-035', 'WORK-039'], ['WORK-036', 'WORK-039'], ['WORK-029', 'WORK-040'],
  ['WORK-032', 'WORK-040'], ['WORK-034', 'WORK-040'], ['WORK-035', 'WORK-040'],
  ['WORK-036', 'WORK-040'], ['WORK-039', 'WORK-040'], ['WORK-040', 'WORK-041'],
  ['WORK-038', 'WORK-041'],
]

// Pre-correction blob SHAs on main @ 39ce662: ACR-006 must not touch these.
const UNCHANGED_BY_ACR_006: Record<string, string> = {
  'spec/domain-requirements-v6.md': 'afb2af31483d3fefca6ea7bb2e1dea2ee7d36e7b',
  'spec/domain-architecture-v6.md': '7e1ed8b8a0affa17b456a0dea6eca2376f1cfae9',
  'spec/architecture-lock.md': '78b970c77d01dc894b877ebcf18bd99a7fa335f4',
  'spec/architecture.md': '0964dacd259f3dd2d3c59aba2a6a1d0eea8723d4',
  'spec/work-orders/WORK-040.md': 'a8cf6042f67e34ae4fd95e73319e4a09a6418929',
  'spec/architecture-change-requests/ACR-005.md': '6ecff3074329559e6aa6c99e2a6aae1273b1c69d',
  'spec/work-state/V6-FROZEN-WORK-025-READY.md': 'a2fd100298a485ae409154ac594aae1b53fa0a93',
}

const ALL_REQUIREMENT_IDS = ['ARCH-001','NET-001','NET-002','NET-003','NET-004','COMP-001','COMP-002','COMP-003','ALLOC-001','ALLOC-002','ALLOC-003','DATA-001','DATA-002','TRUST-001','TRUST-002','TRUST-003','PKG-001','PKG-002','DIST-001','DIST-002','ECON-001','ECON-002','ECON-003','OPS-001','OBS-001','OBS-002','SDK-001','FED-001','REF-001','CONF-001']
// The only requirement IDs referenced by more than one Work Item after the
// ACR-006 correction — all four are pre-existing gate/proof/shared-contract
// exceptions, none introduced or altered by ACR-006 (ACR-006 §10).
const JUSTIFIED_MULTI_REFERENCE = ['ARCH-001', 'CONF-001', 'DIST-001', 'REF-001']

describe('ACR-006 — the correction touches only the assignment layer (byte-identity pins)', () => {
  test('every semantic/architectural document pinned to its pre-correction blob is unchanged', () => {
    for (const [path, expectedSha] of Object.entries(UNCHANGED_BY_ACR_006)) expect(gitBlobSha(read(path))).toBe(expectedSha)
  })
  test('the frozen NET requirement definitions are byte-identical (no text, AC, verification, or dependency rewrite)', () => {
    for (const header of ['## NET-001 — Network Instance Identity and Ownership','## NET-002 — Declarative Network-as-Code','## NET-003 — Network Lifecycle Authority','## NET-004 — Deterministic Network Launch']) expect(requirements).toContain(header)
    expect(requirements).toContain('Network-as-Code MUST represent networks declaratively through a versioned definition that can be validated and resolved deterministically without kernel modification')
    expect(requirements).toContain('Verification: launch integration tests; failure-atomicity tests; universal-launch proof')
    expect(requirements).toContain('Dependencies: `NET-002`, `NET-003`')
    const netSections = [...requirements.matchAll(/^## (NET-\d+) —/gm)].map((m) => m[1])
    expect(netSections).toEqual(['NET-001', 'NET-002', 'NET-003', 'NET-004'])
  })
})

describe('ACR-006 — corrected Work Item ledger mapping', () => {
  test('WORK-025 owns NET-001 and NET-003 (identity + lifecycle authority — matches the merged PR #42 implementation)', () => {
    const section = workItemSection('WORK-025')
    expect(section.match(/^Requirements: (.+)$/m)?.[1]).toBe('`NET-001`, `NET-003`')
    expect(section).toContain('Acceptance Criteria: NET-001-AC01..04 and NET-003-AC01..04.')
  })
  test('WORK-026 owns NET-002 only (deterministic validation/resolution — matches the issued Issue #43 scope)', () => {
    const section = workItemSection('WORK-026')
    expect(section.match(/^Requirements: (.+)$/m)?.[1]).toBe('`NET-002`')
    expect(section).toContain('Acceptance Criteria: NET-002-AC01..04.')
  })
  test('WORK-040 owns NET-004 alongside REF-001 and CONF-001 (sole NET-004 authority)', () => {
    const section = workItemSection('WORK-040')
    expect(section.match(/^Requirements: (.+)$/m)?.[1]).toBe('`NET-004`, `REF-001`, `CONF-001`')
  })
  test('the ledger records the ACR-006 correction provenance', () => {
    expect(workItems).toContain('requirement-to-Work-Item traceability corrected by `ACR-006`')
  })
})

describe('ACR-006 — the pre-correction contradiction signatures are absent', () => {
  test('the WORK-026 ledger section references neither NET-003 nor NET-004', () => {
    const section = workItemSection('WORK-026')
    expect(section).not.toContain('NET-003')
    expect(section).not.toContain('NET-004')
  })
  test('the WORK-025 ledger section does not reference NET-002', () => {
    expect(workItemSection('WORK-025')).not.toContain('NET-002')
  })
  test('no Requirements line co-assigns NET-003 and NET-004 (the exact blocked-PR signature)', () => {
    expect(requirementsLines.some((line) => line.includes('NET-003') && line.includes('NET-004'))).toBe(false)
  })
  test('the WORK-026 work order references neither NET-003 nor NET-004', () => {
    expect(order26).not.toContain('NET-003')
    expect(order26).not.toContain('NET-004')
  })
  test('the WORK-025 work order does not reference NET-002', () => {
    expect(order25).not.toContain('NET-002')
  })
})

describe('ACR-006 — coverage: no orphaned requirements, justified multi-reference exceptions only', () => {
  test('every V6 requirement ID is owned by at least one Work Item (no orphans)', () => {
    for (const id of ALL_REQUIREMENT_IDS) expect(ownersOf(id).length).toBeGreaterThan(0)
  })
  test('the multi-referenced set is exactly the four pre-existing justified exceptions', () => {
    const multi = ALL_REQUIREMENT_IDS.filter((id) => ownersOf(id).length > 1)
    expect(multi.sort()).toEqual([...JUSTIFIED_MULTI_REFERENCE].sort())
  })
  test('NET-001..NET-004 each have exactly one authoritative owner', () => {
    for (const id of ['NET-001', 'NET-002', 'NET-003', 'NET-004']) expect(ownersOf(id)).toHaveLength(1)
  })
  test('the corrected owners are exactly WORK-025/WORK-026/WORK-040', () => {
    expect(ownersOf('NET-001')[0]).toContain('NET-001')
    expect(ownersOf('NET-002')[0]).toBe('`NET-002`')
    expect(ownersOf('NET-003')[0]).toBe('`NET-001`, `NET-003`')
    expect(ownersOf('NET-004')[0]).toBe('`NET-004`, `REF-001`, `CONF-001`')
  })
})

describe('ACR-006 — released work orders are consistent with the corrected mapping', () => {
  test('WORK-025 order acceptance cites NET-001 and NET-003', () => {
    expect(order25).toContain('Acceptance: NET-001-AC01..04; NET-003-AC01..04.')
  })
  test('WORK-026 order acceptance cites NET-002 only', () => {
    expect(order26).toContain('Acceptance: NET-002-AC01..04.')
  })
  test('WORK-040 order still cites NET-004 (unchanged consistency anchor)', () => {
    expect(order40).toContain('Acceptance: NET-004, REF-001, CONF-001 applicable criteria.')
  })
})

describe('ACR-006 — dependency graph: edges unchanged, DAG acyclic, annotation corrected', () => {
  const parsedEdges = [...workGraph.matchAll(/^(WORK-\d+) → (WORK-\d+)$/gm)].map((m) => `${m[1]} → ${m[2]}`)

  test('the Exact Dependency Edges list is byte-identical to the frozen 37-edge set (zero edge changes)', () => {
    const expected = FROZEN_EDGES.map(([from, to]) => `${from} → ${to}`).sort()
    expect([...parsedEdges].sort()).toEqual(expected)
    expect(parsedEdges).toHaveLength(37)
  })
  test('the DAG is acyclic (independent Kahn proof over the parsed edges)', () => {
    const nodes = new Set<string>()
    for (const [from, to] of FROZEN_EDGES) { nodes.add(from); nodes.add(to) }
    const indegree = new Map<string, number>([...nodes].map((n) => [n, 0]))
    const adjacency = new Map<string, string[]>([...nodes].map((n) => [n, []]))
    for (const [from, to] of FROZEN_EDGES) { adjacency.get(from)!.push(to); indegree.set(to, (indegree.get(to) ?? 0) + 1) }
    const queue = [...nodes].filter((n) => (indegree.get(n) ?? 0) === 0)
    const order: string[] = []
    while (queue.length > 0) { const node = queue.shift()!; order.push(node); for (const child of adjacency.get(node)!) { indegree.set(child, (indegree.get(child) ?? 0) - 1); if (indegree.get(child) === 0) queue.push(child) } }
    expect(order.length).toBe(nodes.size)
  })
  test('the WORK-026 node annotation no longer claims launch execution; WORK-040 retains the launch proof', () => {
    expect(workGraph).toContain('WORK-026 Network-as-Code validation/resolution')
    expect(workGraph).not.toContain('Network-as-Code + launch')
    expect(workGraph).toContain('WORK-040 Universal launch proof')
  })
  test('the mapping-relevant spine edges are intact (mechanism items precede the NET-004 proof)', () => {
    for (const edge of ['WORK-025 → WORK-026', 'WORK-026 → WORK-027', 'WORK-026 → WORK-028', 'WORK-025 → WORK-035', 'WORK-039 → WORK-040', 'WORK-040 → WORK-041']) expect(parsedEdges).toContain(edge)
  })
})

describe('ACR-006 — the ACR document satisfies the Issue #45 evidence contract', () => {
  test('declares the full ACR template fields and the UNDER_REVIEW decision state', () => {
    for (const field of ['- ACR-ID: `ACR-006`','- Status: `UNDER_REVIEW`','## Decision','- Affected Architecture Version: `IAAS-DOM-ARCH-6` (FROZEN)','- Affected Requirements: `NET-002`, `NET-003`, `NET-004`','- Affected Work Items: `WORK-025`, `WORK-026`, `WORK-040`']) expect(acr6).toContain(field)
    for (const field of ['REQUESTED BY','PROBLEM / EVIDENCE','PROPOSED CHANGE','ALTERNATIVES','COMPATIBILITY / MIGRATION IMPACT','VERIFICATION IMPACT','DECISION','DECIDED BY','DECISION DATE','NEW ARCHITECTURE VERSION']) expect(acr6.toUpperCase()).toContain(field)
  })
  test('cites its issuing work order and records the blocked PR relationship', () => {
    expect(acr6).toContain('GitHub Issue #45')
    expect(acr6).toContain('PR #44')
    expect(acr6).toContain('REQUIRE CHANGES')
  })
  test('reproduces the frozen contradiction evidence verbatim', () => {
    expect(acr6).toContain('## NET-003 — Network Lifecycle Authority')
    expect(acr6).toContain('## NET-004 — Deterministic Network Launch')
    expect(acr6).toContain('Requirements: `NET-003`, `NET-004`')
    expect(acr6).toContain('Requirements: `NET-001`, `NET-002`')
  })
  test('records the three-bucket decision and the no-new-version outcome', () => {
    expect(acr6).toContain('WORK-026 deterministic validation/resolution')
    expect(acr6).toContain('The universal launch proof')
    expect(acr6).toContain('IAAS-DOM-ARCH-6` remains FROZEN / CURRENT CANONICAL')
  })
  test('documents WORK-026 boundary preservation (no forced launch/activation semantics)', () => {
    expect(acr6).toContain('not forced to implement launch/activation semantics')
    expect(acr6).toContain('never executed by WORK-026')
  })
})
