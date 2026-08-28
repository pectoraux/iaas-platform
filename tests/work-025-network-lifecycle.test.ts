/// <reference types="bun-types" />
// =============================================================================
// WORK-025 — NetworkInstance + Network Lifecycle unit + architecture tests
// =============================================================================
// Verifies the architecture/static halves of NET-001-AC01..04 and
// NET-002-AC01..04 (IAAS-DOM-ARCH-6 §3.3–3.4, spec/work-orders/WORK-025.md):
//   - NetworkInstance identity is distinct from NetworkDefinition identity;
//     exactly one immutable PUBLISHED NetworkVersion source (NET-001-AC01)
//   - lifecycle state is authoritative in the network lifecycle subsystem and
//     is never sourced from definition/request/execution/resource lifecycles
//     (NET-001-AC02)
//   - tenant scope is explicit everywhere (NET-001-AC03)
//   - the frozen V6 §3.4 state machine: one lifecycle for the canonical
//     launch pipeline, no stage bypass (NET-002-AC01), explicit failure/
//     rollback transitions (NET-002-AC02)
//   - the same lifecycle model for every network type — no vertical-specific
//     lifecycle ownership (NET-002-AC03)
//   - no kernel modification: service-layer authority only, complete import
//     allowlist, anti-dependency prohibitions (NET-002-AC04)
//
// NOTE (CI contract): this suite runs in the Specification Consistency
// Validator job, which has NO node_modules by design — every check here is a
// source-level contract check (readFileSync), following the WORK-016/018
// unit-test convention. The state chart is PARSED from the service source and
// compared against the frozen chart below; runtime behavior (persistence,
// tenant isolation, invalid-transition negatives against real PostgreSQL,
// version immutability, evidence preservation, concurrency) is proven by
// tests/work-025-network-lifecycle-pg.test.ts in the PostgreSQL job.
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()

function readSrc(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

const SERVICE_SRC = readSrc('src/lib/services/network-lifecycle.service.ts')

// ---------------------------------------------------------------------------
// Source parsing — the exported state chart, extracted from the service
// ---------------------------------------------------------------------------

/** Parse the LIFECYCLE_STATE constant block: { PLANNED: 'planned', ... } */
function parseLifecycleConstants(src: string): Record<string, string> {
  const block = src.match(/export const LIFECYCLE_STATE = \{([\s\S]*?)\} as const/)?.[1] ?? ''
  const map: Record<string, string> = {}
  for (const m of block.matchAll(/^\s*([A-Z_]+):\s*'([a-z]+)'\s*,?\s*$/gm)) {
    map[m[1]] = m[2]
  }
  return map
}

const LIFECYCLE_CONSTANTS = parseLifecycleConstants(SERVICE_SRC)

/** Parse the declared transition table: [LIFECYCLE_STATE.X]: [LIFECYCLE_STATE.Y, ...] */
function parseDeclaredTransitions(src: string): Array<[string, string]> {
  const block = src.match(/export const VALID_TRANSITIONS[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const out: Array<[string, string]> = []
  for (const m of block.matchAll(/\[LIFECYCLE_STATE\.([A-Z_]+)\]:\s*\[([^\]]*)\]/g)) {
    const from = LIFECYCLE_CONSTANTS[m[1]]
    expect(from).toBeDefined()
    for (const t of m[2].matchAll(/LIFECYCLE_STATE\.([A-Z_]+)/g)) {
      const to = LIFECYCLE_CONSTANTS[t[1]]
      expect(to).toBeDefined()
      out.push([from, to])
    }
  }
  return out
}

const DECLARED_TRANSITIONS = parseDeclaredTransitions(SERVICE_SRC)
const DECLARED_SET = new Set(DECLARED_TRANSITIONS.map(([f, t]) => `${f}→${t}`))

function declared(from: string, to: string): boolean {
  return DECLARED_SET.has(`${from}→${to}`)
}

/** Parse the ordered state list constant. */
function parseStateList(src: string): string[] {
  const block =
    src.match(/export const NETWORK_INSTANCE_LIFECYCLE_STATES[^=]*=\s*\[([\s\S]*?)\]/)?.[1] ?? ''
  return [...block.matchAll(/LIFECYCLE_STATE\.([A-Z_]+)/g)].map((m) => LIFECYCLE_CONSTANTS[m[1]])
}

const DECLARED_STATES = parseStateList(SERVICE_SRC)
const DECLARED_TERMINAL = SERVICE_SRC.match(
  /export const TERMINAL_LIFECYCLE_STATE = LIFECYCLE_STATE\.([A-Z_]+)/,
)?.[1]
const DECLARED_INITIAL = SERVICE_SRC.match(
  /export const INITIAL_LIFECYCLE_STATE = LIFECYCLE_STATE\.([A-Z_]+)/,
)?.[1]

// ---------------------------------------------------------------------------
// NET-002-AC04 — architecture + anti-dependency checks (service layer, no
// kernel modification, no cross-layer authority)
// ---------------------------------------------------------------------------

describe('WORK-025 — Network Lifecycle architecture (NET-002-AC04)', () => {
  test('Network Lifecycle service is in the service layer (NOT kernel)', () => {
    const path = join(REPO_ROOT, 'src', 'lib', 'services', 'network-lifecycle.service.ts')
    expect(path).toContain('src/lib/services/')
    expect(path).not.toContain('src/lib/kernel/')
  })

  test('the complete import allowlist is exactly: db, domain/errors, domain/audit, domain/auth (type-only)', () => {
    // The lifecycle authority owns instance state and nothing else. Its ONLY
    // dependencies are the durable store and the domain error/audit kernels.
    const importLines = SERVICE_SRC.match(/^import .*$/gm) ?? []
    expect(importLines.length).toBeGreaterThan(0)
    const allowed = ["@/lib/db", '@/lib/domain/errors', '@/lib/domain/audit', '@/lib/domain/auth']
    for (const line of importLines) {
      const specifiers = [...line.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
      for (const spec of specifiers) {
        expect(allowed).toContain(spec)
      }
    }
  })

  test('Network Lifecycle service imports NO vertical service (no vertical-specific lifecycle owner)', () => {
    const verticalPattern = /(?:vpp|compute|storage|wireless|manufacturing|der-adapter|der-simulator|energy)\.service/
    expect(verticalPattern.test(SERVICE_SRC)).toBe(false)
  })

  test('Network Lifecycle service imports NO EconomicPipeline', () => {
    expect(SERVICE_SRC).not.toContain('economic-pipeline')
  })

  test('Network Lifecycle service imports NO Route/Transport/data-plane service', () => {
    const dataPlanePattern = /(?:routing|transport|delivery-confirmation|data-plane)\.service/
    expect(dataPlanePattern.test(SERVICE_SRC)).toBe(false)
  })

  test('Network Lifecycle service imports NO kernel / RuntimeRegistry code', () => {
    expect(SERVICE_SRC).not.toMatch(/^import.*@\/lib\/kernel/m)
    expect(SERVICE_SRC).not.toMatch(/from\s+['"]@\/lib\/kernel\//m)
  })

  test('Network Lifecycle service imports NO control-plane (workflow engine / scheduler / request lifecycle)', () => {
    // V6 §15 authority matrix: the forbidden alternative owner for network
    // instance/lifecycle is "Workflow engine, Runtime". The control-plane
    // scheduler/service owns the NetworkRequest lifecycle — the instance
    // lifecycle must be a distinct authority.
    expect(SERVICE_SRC).not.toContain('@/lib/control-plane')
    expect(SERVICE_SRC).not.toContain('control-plane/service')
    expect(SERVICE_SRC).not.toContain('scheduler')
  })

  test('Network Lifecycle service imports NO execution/runtime/sandbox/extension services', () => {
    // Instance lifecycle is distinct from the Execution lifecycle and from
    // runtime/sandbox authorities (V6 §3.3: "lifecycle state independent of
    // NetworkDefinition/Version"; WORK-025 order: "lifecycle is distinct from
    // NetworkDefinition, request, execution, and resource lifecycles").
    const forbidden = /(?:active-execution-registry|sandbox-host|extension-runtime|extension-registry|extension-provenance|transform-runtime|transform-registry|transform-record|worker|execution-lease|execution-orchestrator|capacity)\.service/
    expect(forbidden.test(SERVICE_SRC)).toBe(false)
    expect(SERVICE_SRC).not.toContain('executeAssignment')
  })

  test('Network Lifecycle service NEVER mutates NetworkVersion (immutable published source)', () => {
    // Constraint: "no mutation of published NetworkVersion". The service may
    // only READ the version (findFirst) — no write paths to the version table.
    expect(SERVICE_SRC).toMatch(/networkVersion\.findFirst/)
    expect(SERVICE_SRC).not.toMatch(/networkVersion\.(update|create|upsert|delete|deleteMany|updateMany)\s*\(/)
    expect(SERVICE_SRC).not.toMatch(/\$executeRaw[\s\S]*UPDATE "NetworkVersion"/)
  })

  test('Network Lifecycle service exposes NO deletion path (evidence retention after terminal states)', () => {
    // V6 §3.3: the instance "retains audit/evidence after termination/archive".
    expect(SERVICE_SRC).not.toMatch(/networkInstance\.(delete|deleteMany)\s*\(/)
  })

  test('PostgreSQL is the durable source of instance identity + state', () => {
    expect(SERVICE_SRC).toContain("from '@/lib/db'")
    expect(SERVICE_SRC).toContain('db.networkInstance')
  })
})

// ---------------------------------------------------------------------------
// NET-001-AC01 / NET-001-AC03 — schema contract: distinct durable identity,
// exactly one immutable source version, tenant scope, no composition semantics
// ---------------------------------------------------------------------------

describe('WORK-025 — NetworkInstance schema contract (NET-001-AC01, NET-001-AC03)', () => {
  const SCHEMA = readSrc('prisma/schema.prisma')

  function modelSection(name: string): string {
    const start = SCHEMA.indexOf(`model ${name} {`)
    expect(start).toBeGreaterThanOrEqual(0)
    const end = SCHEMA.indexOf('\n}', start)
    return SCHEMA.slice(start, end)
  }

  test('NetworkInstance is its own durable model with its own primary key (distinct identity)', () => {
    const section = modelSection('NetworkInstance')
    expect(section).toMatch(/id\s+String\s+@id\s+@default\(cuid\(\)\)/)
  })

  test('NetworkInstance references exactly ONE NetworkVersion via a REQUIRED column', () => {
    const section = modelSection('NetworkInstance')
    expect(section).toMatch(/networkVersionId\s+String\s*$/m)
    expect(section).not.toMatch(/networkVersionId\s+String\?/)
    expect(section).toMatch(/networkVersion\s+NetworkVersion\s+@relation\(fields:\s*\[networkVersionId\]/)
  })

  test('NetworkInstance has NO unique constraint on the source version (many instances per version)', () => {
    // V6 §3.3: an instance "may be one of many instances derived from the
    // same version". The model must NOT constrain one-instance-per-version.
    const section = modelSection('NetworkInstance')
    expect(section).not.toContain('@@unique')
  })

  test('NetworkInstance lifecycle state defaults to planned and is owned by the lifecycle service', () => {
    const section = modelSection('NetworkInstance')
    expect(section).toMatch(/lifecycleState\s+String\s+@default\("planned"\)/)
    // The owning subsystem is named in the model's boundary comment.
    expect(SCHEMA).toContain('src/lib/services/network-lifecycle.service.ts')
  })

  test('NetworkInstance is tenant-scoped with a tenant cascade relation', () => {
    const section = modelSection('NetworkInstance')
    expect(section).toMatch(/tenantId\s+String\s*$/m)
    expect(section).toMatch(/tenant\s+Tenant\s+@relation\(fields:\s*\[tenantId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/)
    expect(section).toMatch(/@@index\(\[tenantId\]\)/)
    expect(section).toMatch(/@@index\(\[tenantId,\s*lifecycleState\]\)/)
  })

  test('NetworkInstance carries NO composition/federation semantics (WORK-025 out of scope)', () => {
    const section = modelSection('NetworkInstance')
    expect(section).not.toMatch(/parentInstanceId|childInstances|compositionId|NetworkComposition|federation/i)
    // No NetworkComposition model exists yet (WORK-027 owns it).
    expect(SCHEMA).not.toContain('model NetworkComposition {')
  })

  test('label is optional metadata — identity is the durable id', () => {
    const section = modelSection('NetworkInstance')
    expect(section).toMatch(/label\s+String\?/)
  })

  test('NetworkVersion gains only the read-only instances back-relation', () => {
    const section = modelSection('NetworkVersion')
    expect(section).toMatch(/instances\s+NetworkInstance\[\]/)
    // The version model itself remains the immutable published artifact.
    expect(section).toMatch(/publishedAt\s+DateTime\?/)
    expect(section).toContain('IMMUTABLE once publishedAt is set')
  })

  test('migration exists and is production-safe (idempotent, no destructive DDL)', () => {
    const path = 'prisma/migrations/20260828000000_add_network_instance/migration.sql'
    expect(existsSync(join(REPO_ROOT, path))).toBe(true)
    const sql = readSrc(path)
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "NetworkInstance"')
    expect(sql).toContain('NetworkInstance_tenantId_fkey')
    expect(sql).toContain('NetworkInstance_networkVersionId_fkey')
    expect(sql).toMatch(/ON DELETE RESTRICT/)
    // No destructive DDL statements (comments are exempt — anchored to line start).
    expect(sql).not.toMatch(/^\s*DROP TABLE/mi)
    expect(sql).not.toMatch(/^\s*TRUNCATE/mi)
    expect(sql).not.toMatch(/^\s*DELETE FROM/mi)
  })
})

// ---------------------------------------------------------------------------
// NET-002-AC01 / NET-002-AC02 — the frozen V6 §3.4 state machine, parsed from
// the service source and pinned against the frozen chart
// ---------------------------------------------------------------------------

describe('WORK-025 — NetworkInstance lifecycle state machine (NET-002-AC01, NET-002-AC02)', () => {
  // The exact frozen chart (V6 §3.4):
  //   PLANNED → PROVISIONING → VALIDATING → ACTIVE ⇌ PAUSED
  //           → DRAINING → TERMINATED → ARCHIVED
  // plus the explicit failure/rollback exits to TERMINATED.
  const FROZEN_STATES = [
    'planned', 'provisioning', 'validating', 'active',
    'paused', 'draining', 'terminated', 'archived',
  ]
  const FROZEN_TRANSITIONS: Array<[string, string]> = [
    ['planned', 'provisioning'],
    ['planned', 'terminated'],       // explicit abandon before provisioning
    ['provisioning', 'validating'],
    ['provisioning', 'terminated'],  // explicit provisioning failure
    ['validating', 'active'],
    ['validating', 'terminated'],    // explicit validation failure
    ['active', 'paused'],
    ['active', 'draining'],
    ['paused', 'active'],
    ['paused', 'draining'],
    ['draining', 'terminated'],
    ['terminated', 'archived'],
  ]

  test('the frozen V6 §3.4 states are all declared, in chart order', () => {
    expect(Object.keys(LIFECYCLE_CONSTANTS).sort()).toEqual(
      ['ACTIVE', 'ARCHIVED', 'DRAINING', 'PAUSED', 'PLANNED', 'PROVISIONING', 'TERMINATED', 'VALIDATING'],
    )
    expect(LIFECYCLE_CONSTANTS.PLANNED).toBe('planned')
    expect(LIFECYCLE_CONSTANTS.PROVISIONING).toBe('provisioning')
    expect(LIFECYCLE_CONSTANTS.VALIDATING).toBe('validating')
    expect(LIFECYCLE_CONSTANTS.ACTIVE).toBe('active')
    expect(LIFECYCLE_CONSTANTS.PAUSED).toBe('paused')
    expect(LIFECYCLE_CONSTANTS.DRAINING).toBe('draining')
    expect(LIFECYCLE_CONSTANTS.TERMINATED).toBe('terminated')
    expect(LIFECYCLE_CONSTANTS.ARCHIVED).toBe('archived')
    expect(DECLARED_STATES).toEqual(FROZEN_STATES)
    expect(DECLARED_TERMINAL).toBe('ARCHIVED')
    expect(DECLARED_INITIAL).toBe('PLANNED')
  })

  test('the declared transition table is EXACTLY the frozen chart — exhaustive 8×8 matrix', () => {
    // Every declared transition must be in the frozen set...
    expect(DECLARED_SET).toEqual(new Set(FROZEN_TRANSITIONS.map(([f, t]) => `${f}→${t}`)))
    // ...and the exhaustive matrix agrees on all 64 pairs.
    for (const from of FROZEN_STATES) {
      for (const to of FROZEN_STATES) {
        const expected = FROZEN_TRANSITIONS.some(([f, t]) => f === from && t === to)
        expect(declared(from, to)).toBe(expected)
      }
    }
  })

  test('the canonical launch pipeline is ONE lifecycle with NO stage bypass (NET-002-AC01)', () => {
    // Definition(PLANNED) → Provisioning → Verification(VALIDATING) →
    // Deployment(ACTIVE): each stage is reachable only through the previous.
    expect(declared('planned', 'provisioning')).toBe(true)
    expect(declared('provisioning', 'validating')).toBe(true)
    expect(declared('validating', 'active')).toBe(true)
    // Bypass negatives: no stage can skip a required earlier stage.
    expect(declared('planned', 'validating')).toBe(false)
    expect(declared('planned', 'active')).toBe(false)
    expect(declared('planned', 'paused')).toBe(false)
    expect(declared('planned', 'draining')).toBe(false)
    expect(declared('planned', 'archived')).toBe(false)
    expect(declared('provisioning', 'active')).toBe(false)
    expect(declared('provisioning', 'paused')).toBe(false)
    expect(declared('provisioning', 'draining')).toBe(false)
    expect(declared('validating', 'paused')).toBe(false)
    expect(declared('validating', 'draining')).toBe(false)
  })

  test('ACTIVE ⇌ PAUSED reversible suspension', () => {
    expect(declared('active', 'paused')).toBe(true)
    expect(declared('paused', 'active')).toBe(true)
  })

  test('teardown requires DRAINING before TERMINATED; TERMINATED precedes ARCHIVED', () => {
    expect(declared('active', 'draining')).toBe(true)
    expect(declared('paused', 'draining')).toBe(true)
    expect(declared('draining', 'terminated')).toBe(true)
    expect(declared('terminated', 'archived')).toBe(true)
    // Hard-terminate without draining is NOT part of the frozen chart.
    expect(declared('active', 'terminated')).toBe(false)
    expect(declared('paused', 'terminated')).toBe(false)
    expect(declared('draining', 'archived')).toBe(false)
  })

  test('explicit failure/rollback exits to TERMINATED (NET-002-AC02)', () => {
    expect(declared('planned', 'terminated')).toBe(true)
    expect(declared('provisioning', 'terminated')).toBe(true)
    expect(declared('validating', 'terminated')).toBe(true)
  })

  test('ARCHIVED is the absolute terminal state — nothing leaves it', () => {
    expect(DECLARED_STATES).toContain('archived')
    for (const to of FROZEN_STATES) {
      expect(declared('archived', to)).toBe(false)
    }
    // TERMINATED is deep-terminal: only archival remains.
    const terminatedTargets = DECLARED_TRANSITIONS.filter(([f]) => f === 'terminated').map(([, t]) => t)
    expect(terminatedTargets).toEqual(['archived'])
  })

  test('same-state transitions are invalid everywhere (no idempotent self-loops)', () => {
    for (const state of FROZEN_STATES) {
      expect(declared(state, state)).toBe(false)
    }
  })

  test('the transition predicate fails closed on unknown states (source contract)', () => {
    // isValidLifecycleTransition: an unknown from-state has no table entry —
    // the predicate must return false BEFORE any .includes() call.
    expect(SERVICE_SRC).toMatch(/const allowed = VALID_TRANSITIONS\[from\]\s*\n?\s*if \(!allowed\) return false/)
    expect(SERVICE_SRC).toMatch(/return allowed\.includes\(to\)/)
  })
})

// ---------------------------------------------------------------------------
// NET-001-AC02..AC04 / NET-002-AC03 — service contract presence:
// authority, authorization, audit, universality
// ---------------------------------------------------------------------------

describe('WORK-025 — Network Lifecycle service contract (NET-001-AC02..AC04, NET-002-AC03)', () => {
  test('createNetworkInstance exists (tenant-scoped, published-version gated)', () => {
    expect(SERVICE_SRC).toContain('export async function createNetworkInstance')
    expect(SERVICE_SRC).toMatch(/tenantId:\s*string/)
    expect(SERVICE_SRC).toContain('publishedAt')
    expect(SERVICE_SRC).toContain('immutable PUBLISHED version')
  })

  test('getNetworkInstance / listNetworkInstances exist (tenant-scoped reads)', () => {
    expect(SERVICE_SRC).toContain('export async function getNetworkInstance')
    expect(SERVICE_SRC).toContain('export async function listNetworkInstances')
  })

  test('transitionNetworkInstanceLifecycle exists — the single authoritative transition path', () => {
    expect(SERVICE_SRC).toContain('export async function transitionNetworkInstanceLifecycle')
    expect(SERVICE_SRC).toContain('VALID_TRANSITIONS')
  })

  test('transitions are concurrency-safe (FOR UPDATE lock + in-transaction re-validation)', () => {
    expect(SERVICE_SRC).toContain('FOR UPDATE')
    expect(SERVICE_SRC).toContain('{ timeout: 30000 }')
  })

  test('authorization is enforced on mutating operations (viewers denied)', () => {
    expect(SERVICE_SRC).toContain('export interface NetworkLifecycleActor')
    expect(SERVICE_SRC).toMatch(/MUTATING_ROLES/)
    expect(SERVICE_SRC).toMatch(/'admin',\s*'owner',\s*'operator'/)
    expect(SERVICE_SRC).toContain('ForbiddenError')
    expect(SERVICE_SRC).toMatch(/authorizeMutatingOperation\(actor,\s*'create'\)/)
    expect(SERVICE_SRC).toMatch(/authorizeMutatingOperation\(actor,\s*'transition the lifecycle of'\)/)
  })

  test('audit is atomic with the durable transition (tx passed to appendAudit)', () => {
    expect(SERVICE_SRC).toContain("'network_instance.created'")
    expect(SERVICE_SRC).toContain("'network_instance.lifecycle_transition'")
    expect(SERVICE_SRC).toContain("resourceType: 'network_instance'")
    expect(SERVICE_SRC.match(/tx,\s*\n\s*\}\)/g)?.length).toBeGreaterThanOrEqual(2)
  })

  test('historical evidence is readable after terminal states (audit-based trail)', () => {
    expect(SERVICE_SRC).toContain('export async function getNetworkInstanceLifecycleHistory')
    expect(SERVICE_SRC).toContain('auditLog.findMany')
    expect(SERVICE_SRC).toContain('retains audit/evidence after termination/archive')
  })

  test('the lifecycle model is universal — no vertical-conditional logic', () => {
    // NET-002-AC03: simple and complex networks use the same model. The
    // lifecycle authority must not branch on vertical/network type (contrast
    // with the definition-layer publication gate in network.service.ts).
    expect(SERVICE_SRC).not.toMatch(/switch\s*\(\s*(vertical|network\.vertical|networkType)\s*\)/)
    expect(SERVICE_SRC).not.toMatch(/case\s+'(energy_vpp|storage|wireless|compute|manufacturing)'/)
    expect(SERVICE_SRC).not.toMatch(/vertical\s*===/)
  })

  test('cross-tenant instance ids resolve uniformly to NOT_FOUND (no leakage)', () => {
    expect(SERVICE_SRC).toContain('locked.tenantId !== tenantId')
    expect(SERVICE_SRC).toContain('no cross-tenant leakage')
  })
})
