/// <reference types="bun-types" />
// =============================================================================
// WORK-026 — Network-as-Code Validation and Resolution unit + architecture tests
// =============================================================================
// Verifies the architecture/static halves of NET-003-AC01..04 and
// NET-004-AC01..04 (IAAS-DOM-ARCH-6 §3.5, spec/work-orders/WORK-026.md):
//   - validation is deterministic, fail-closed, and never mutates published
//     NetworkVersion state (NET-003-AC01)
//   - invalid definitions/versions are rejected BEFORE resolution side
//     effects (NET-003-AC02)
//   - dependency resolution is deterministic, acyclic, and based only on the
//     declared canonical dependency contracts of the definition (NET-003-AC03)
//   - capability/resource requirements are resolved through canonical
//     interfaces without vertical-specific branches (NET-003-AC04)
//   - the same declarative input produces the same canonical resolution
//     result under the same authoritative repository state (NET-004-AC01)
//   - resolution does not allocate, reserve, commit, provision, activate, or
//     mutate NetworkInstance lifecycle state (NET-004-AC02)
//   - the resolution output is explicit for the next provisioning/launch
//     stage and contains no hidden implementation state (NET-004-AC03)
//   - tenant isolation and authorization boundaries are preserved
//     (NET-004-AC04)
//
// NOTE (CI contract): this suite runs in the Specification Consistency
// Validator job, which has NO node_modules by design — every check here is a
// source-level contract check (readFileSync), following the WORK-016/018/025
// unit-test convention. The stage lists, error codes, and pipeline contracts
// are PARSED from the service source and pinned against the frozen
// architecture document; runtime behavior (persistence, determinism across
// repository-state changes, tenant isolation, cycle rejection against real
// PostgreSQL, version immutability, concurrency) is proven by
// tests/work-026-network-compiler-pg.test.ts in the PostgreSQL job.
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()

function readSrc(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

const SERVICE_SRC = readSrc('src/lib/services/network-compiler.service.ts')
const SCHEMA = readSrc('prisma/schema.prisma')
const ARCH_SRC = readSrc('spec/domain-architecture-v6.md')

// ---------------------------------------------------------------------------
// Source parsing — exported contracts, extracted from the service source
// ---------------------------------------------------------------------------

/** Parse the LAUNCH_PIPELINE_STAGES array literal from the service source. */
function parsePipelineStages(src: string): string[] {
  const block =
    src.match(/export const LAUNCH_PIPELINE_STAGES: readonly string\[\] = \[([\s\S]*?)\] as const/)?.[1] ?? ''
  return [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
}

const DECLARED_PIPELINE = parsePipelineStages(SERVICE_SRC)

/** Parse the MANIFEST_ERROR_CODES array literal from the service source. */
function parseErrorCodes(src: string): string[] {
  const block =
    src.match(/export const MANIFEST_ERROR_CODES: readonly string\[\] = \[([\s\S]*?)\] as const/)?.[1] ?? ''
  return [...block.matchAll(/'(M\d{3}_[A-Z_]+)'/g)].map((m) => m[1])
}

const DECLARED_ERROR_CODES = parseErrorCodes(SERVICE_SRC)

/** The frozen §3.5 launch pipeline, extracted from the architecture doc. */
function parseFrozenPipeline(arch: string): string[] {
  const section = arch.slice(
    arch.indexOf('### 3.5 Network-as-Code'),
    arch.indexOf('## 4. Network Composition'),
  )
  const stages = [...section.matchAll(/^([A-Z][A-Za-z /]+)$/gm)].map((m) => m[1].trim())
  return stages.filter((s) => s !== '')
}

// ---------------------------------------------------------------------------
// NET-003-AC01 — architecture + fail-closed validation authority
// ---------------------------------------------------------------------------

describe('WORK-026 — Network-as-Code Compiler architecture (NET-003-AC01)', () => {
  test('Network-as-Code Compiler service is in the service layer (NOT kernel)', () => {
    const path = join(REPO_ROOT, 'src', 'lib', 'services', 'network-compiler.service.ts')
    expect(path).toContain('src/lib/services/')
    expect(path).not.toContain('src/lib/kernel/')
    // V6 §3.5/work order constraint: "no kernel modification".
    expect(SERVICE_SRC).not.toMatch(/from\s+['"]@\/lib\/kernel\//m)
  })

  test('the complete import allowlist is exactly: db, domain/errors, domain/audit, domain/auth (type-only), node:crypto', () => {
    // The compiler owns validation/resolution and nothing else. Its ONLY
    // dependencies are the durable store, the domain error/audit kernels,
    // the role type, and the platform hash primitive for the checksum.
    const importLines = SERVICE_SRC.match(/^import .*$/gm) ?? []
    expect(importLines.length).toBeGreaterThan(0)
    const allowed = [
      'node:crypto',
      '@/lib/db',
      '@/lib/domain/errors',
      '@/lib/domain/audit',
      '@/lib/domain/auth',
    ]
    for (const line of importLines) {
      const specifiers = [...line.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
      for (const spec of specifiers) {
        expect(allowed).toContain(spec)
      }
    }
    // domain/auth is imported TYPE-ONLY (roles are owned by the identity
    // boundary — the compiler only makes the authorization decision).
    expect(SERVICE_SRC).toMatch(/import type \{ UserRole \} from '@\/lib\/domain\/auth'/)
  })

  test('Network-as-Code Compiler imports NO vertical service (no vertical-specific resolver/compiler branch)', () => {
    const verticalPattern = /(?:vpp|compute|storage|wireless|manufacturing|der-adapter|der-simulator|energy)\.service/
    expect(verticalPattern.test(SERVICE_SRC)).toBe(false)
    // NET-003-AC04: no vertical-specific branches — the compiler never
    // switches behavior on the vertical.
    expect(SERVICE_SRC).not.toMatch(/vertical\s*===/)
    expect(SERVICE_SRC).not.toMatch(/vertical\s*==/)
    expect(SERVICE_SRC).not.toMatch(/switch\s*\(\s*[a-zA-Z.]*vertical/)
    expect(SERVICE_SRC).not.toMatch(/\bvertical\?\s*=/)
  })

  test('Network-as-Code Compiler imports NO EconomicPipeline / economics', () => {
    expect(SERVICE_SRC).not.toContain('economic-pipeline')
    expect(SERVICE_SRC).not.toContain('payments.service')
    expect(SERVICE_SRC).not.toContain('settlement.service')
    expect(SERVICE_SRC).not.toContain('reward.service')
    expect(SERVICE_SRC).not.toContain('ledger.service')
  })

  test('Network-as-Code Compiler imports NO Data Plane / runtime / execution / sandbox services', () => {
    const forbidden =
      /(?:routing|transport|delivery-confirmation|data-plane|active-execution-registry|sandbox-host|extension-runtime|extension-registry|extension-provenance|transform-runtime|transform-registry|transform-record|worker)\.service/
    expect(forbidden.test(SERVICE_SRC)).toBe(false)
    // No concrete runtime imports (work order: "no direct concrete-runtime
    // imports"; V6 §16: runtime resolution belongs to RuntimeRegistry).
    expect(SERVICE_SRC).not.toContain('runtime-resolution')
    expect(SERVICE_SRC).not.toMatch(/from\s+['"]@\/lib\/runtime/)
  })

  test('Network-as-Code Compiler imports NO control-plane (scheduler / workflow engine)', () => {
    expect(SERVICE_SRC).not.toContain('@/lib/control-plane')
    expect(SERVICE_SRC).not.toContain('control-plane/service')
    expect(SERVICE_SRC).not.toContain('scheduler')
  })

  test('Network-as-Code Compiler imports NO Network Lifecycle service and NEVER mutates NetworkInstance (NET-004-AC02 static half)', () => {
    // The compiler is a resolution authority, NOT a lifecycle authority:
    // resolution must never create, transition, or delete instances.
    expect(SERVICE_SRC).not.toContain('network-lifecycle.service')
    expect(SERVICE_SRC).not.toMatch(/networkInstance\.(create|update|upsert|delete|deleteMany|updateMany|createMany)\s*\(/)
    expect(SERVICE_SRC).not.toContain('db.networkInstance')
  })

  test('Network-as-Code Compiler NEVER mutates NetworkVersion (immutable published source)', () => {
    // NET-003-AC01: "does not mutate published NetworkVersion state". The
    // compiler may only READ the version (findFirst) — no write paths.
    expect(SERVICE_SRC).toMatch(/networkVersion\.findFirst/)
    expect(SERVICE_SRC).not.toMatch(/networkVersion\.(update|create|upsert|delete|deleteMany|updateMany)\s*\(/)
    expect(SERVICE_SRC).not.toMatch(/\$executeRaw[\s\S]*UPDATE "NetworkVersion"/)
  })

  test('Network-as-Code Compiler NEVER writes capabilities or resource assignments (read-only canonical interfaces)', () => {
    // Capability truth = the registry catalog (materialized at publication);
    // resource truth = Resource/Capacity (AssetNetworkAssignment). The
    // compiler READS both through the canonical interfaces and never writes.
    expect(SERVICE_SRC).toMatch(/db\.capability\.findMany/)
    expect(SERVICE_SRC).not.toMatch(/capability\.(create|update|upsert|delete|deleteMany|updateMany)\s*\(/)
    expect(SERVICE_SRC).toMatch(/db\.assetNetworkAssignment\.findMany/)
    expect(SERVICE_SRC).not.toMatch(
      /assetNetworkAssignment\.(create|update|upsert|delete|deleteMany|updateMany)\s*\(/,
    )
  })

  test('Network-as-Code Compiler performs NO allocation / reservation / commitment / provisioning / activation', () => {
    // NET-004-AC02 static half: the §3.5 stages after Resource Discovery are
    // owned by later Work Items — the compiler must not touch their state.
    expect(SERVICE_SRC).not.toContain('capacityReservation')
    expect(SERVICE_SRC).not.toContain('portfolioReservation')
    expect(SERVICE_SRC).not.toContain('portfolioCommitment')
    expect(SERVICE_SRC).not.toContain('capacity.service')
    expect(SERVICE_SRC).not.toContain('createCapacityReservation')
    expect(SERVICE_SRC).not.toContain('createCommitment')
    expect(SERVICE_SRC).not.toContain('ensureCapacityResource')
    expect(SERVICE_SRC).not.toMatch(/networkRequest\.(create|update)/)
    // No provisioning/activation verbs in executable code paths.
    expect(SERVICE_SRC).not.toMatch(/\bprovisionNetwork|\bactivateNetwork|\blaunchInstance/)
  })

  test('manifest validation is PURE: no db / await / transaction inside validateNetworkManifest', () => {
    const body = extractFunctionBody(SERVICE_SRC, 'export function validateNetworkManifest')
    expect(body).toBeTruthy()
    expect(body).not.toContain('await ')
    expect(body).not.toContain('db.')
    expect(body).not.toContain('new Date')
    expect(body).not.toContain('Math.random')
  })

  test('validation is deterministic: issues are canonically ordered before return/throw', () => {
    // sortIssues orders by (code, path, message) — the same invalid input
    // always yields the identical issue list.
    expect(SERVICE_SRC).toMatch(/function sortIssues/)
    const validateBody = extractFunctionBody(SERVICE_SRC, 'export function validateNetworkManifest')
    expect(validateBody).toContain('return sortIssues(')
  })

  test('validation is fail-closed: any issue aborts resolution BEFORE persistence', () => {
    // The resolve path throws ValidationError on issues.length > 0 and the
    // throw appears BEFORE the first plan write.
    const resolveBody = extractFunctionBody(SERVICE_SRC, 'export async function resolveNetworkPlan')
    const throwIdx = resolveBody.indexOf('issues.length > 0')
    const firstWriteIdx = resolveBody.indexOf('networkPlan.create')
    expect(throwIdx).toBeGreaterThan(-1)
    expect(firstWriteIdx).toBeGreaterThan(-1)
    expect(throwIdx).toBeLessThan(firstWriteIdx)
    // The rejection names the AC it enforces.
    expect(resolveBody).toContain('rejected before resolution side effects (NET-003-AC02)')
  })

  test('the publication gate rejects unpublished versions before resolution', () => {
    const resolveBody = extractFunctionBody(SERVICE_SRC, 'export async function resolveNetworkPlan')
    const gateIdx = resolveBody.indexOf('!version.publishedAt')
    const validationIdx = resolveBody.indexOf('validateNetworkManifest')
    const firstWriteIdx = resolveBody.indexOf('networkPlan.create')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeLessThan(validationIdx)
    expect(gateIdx).toBeLessThan(firstWriteIdx)
  })
})

// ---------------------------------------------------------------------------
// NET-003-AC02 — fail-closed negative ordering (static half)
// ---------------------------------------------------------------------------

describe('WORK-026 — fail-closed rejection ordering (NET-003-AC02)', () => {
  test('resolveNetworkPlan stage order: authorize → load → publication gate → validate → resolve → persist', () => {
    const body = extractFunctionBody(SERVICE_SRC, 'export async function resolveNetworkPlan')
    const order = [
      body.indexOf('authorizeMutatingOperation(actor'),
      body.indexOf('loadTenantVersion(tenantId, versionId)'),
      body.indexOf('!version.publishedAt'),
      body.indexOf('validateNetworkManifest(manifest)'),
      body.indexOf('resolveDependencyOrder('),
      body.indexOf('db.capability.findMany'),
      body.indexOf('db.assetNetworkAssignment.findMany'),
      body.indexOf('computePlanChecksum(planJson)'),
      body.indexOf('networkPlan.create'),
    ]
    for (const idx of order) expect(idx).toBeGreaterThan(-1)
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1])
    }
  })

  test('the ONLY writes in the compiler are the plan artifact insert and its atomic audit', () => {
    // Every db write in the service is inside the resolveNetworkPlan
    // persistence stage: networkPlan.create (once, inside the transaction)
    // plus appendAudit (inside the same transaction).
    expect(SERVICE_SRC).toMatch(/tx\.networkPlan\.create/)
    const writeMatches = SERVICE_SRC.match(
      /\.(create|update|upsert|delete|deleteMany|updateMany|createMany)\s*\(/g,
    ) ?? []
    // One insert of the plan row + auditLog.create inside appendAudit is
    // invoked via the audit helper (not inline) — assert no other write model
    // call sites exist in this file.
    const inlineWrites = [...SERVICE_SRC.matchAll(/\b(?:tx|db)\.(\w+)\.(create|update|upsert|delete|deleteMany|updateMany|createMany)\s*\(/g)]
    const writtenModels = new Set(inlineWrites.map((m) => `${m[1]}.${m[2]}`))
    expect([...writtenModels].sort()).toEqual(['networkPlan.create'])
  })

  test('plan artifact rows are never updated or deleted (write-once evidence)', () => {
    expect(SERVICE_SRC).not.toMatch(/networkPlan\.(update|upsert|delete|deleteMany|updateMany)\s*\(/)
  })

  test('re-resolution is idempotent: existing checksum returns the existing artifact', () => {
    const body = extractFunctionBody(SERVICE_SRC, 'export async function resolveNetworkPlan')
    expect(body).toContain('tenantId_networkVersionId_planChecksum')
    expect(body).toContain('if (existing)')
    // Racing resolutions converge through the unique-constraint handler.
    expect(SERVICE_SRC).toContain('isUniqueConstraintViolation')
  })
})

// ---------------------------------------------------------------------------
// NET-003-AC03 — declared canonical dependency contracts (static half)
// ---------------------------------------------------------------------------

describe('WORK-026 — dependency resolution contract (NET-003-AC03)', () => {
  test('the declared dependency contract is intra-definition (NOT composition)', () => {
    // Dependencies bind declared capability nodes of ONE manifest. No
    // cross-network / export / import / composition semantics — the check
    // runs against CODE (comments may legitimately say "no composition").
    expect(SERVICE_SRC).toMatch(/export interface DeclaredDependency/)
    const forbidden = /NetworkExport|NetworkImport|NetworkComposition|compositionId|federat/i
    expect(forbidden.test(codeOnly(SERVICE_SRC))).toBe(false)
    expect(codeOnly(SCHEMA)).not.toContain('model NetworkComposition {')
  })

  test('dependency validation rejects dangling endpoints, self-dependencies, and duplicates', () => {
    expect(DECLARED_ERROR_CODES).toContain('M015_DEPENDENCY_SELF')
    expect(DECLARED_ERROR_CODES).toContain('M016_DEPENDENCY_DANGLING')
    expect(DECLARED_ERROR_CODES).toContain('M017_DEPENDENCY_DUPLICATE')
    const validateBody = extractFunctionBody(SERVICE_SRC, 'export function validateNetworkManifest')
    expect(validateBody).toContain('cannot depend on itself')
    expect(validateBody).toContain('not declared by this manifest')
    expect(validateBody).toContain('duplicate dependency')
  })

  test('dependency resolution is acyclic and fails closed with the exact cycle', () => {
    const body = extractFunctionBody(SERVICE_SRC, 'export function resolveDependencyOrder')
    expect(body).toBeTruthy()
    expect(body).toContain('order.length !== nodes.length')
    expect(body).toContain('Dependency graph contains a cycle')
    expect(body).toContain('must be acyclic (NET-003-AC03)')
    // The cycle path is deterministic: DFS starts from the lexicographically
    // smallest remaining node with sorted adjacency.
    expect(body).toContain('.sort()')
  })

  test('the dependency order algorithm is deterministic (Kahn with sorted ready set)', () => {
    const body = extractFunctionBody(SERVICE_SRC, 'export function resolveDependencyOrder')
    // ready set is kept sorted; the lexicographically smallest ready node is
    // emitted first — a canonical total order.
    expect(body).toMatch(/ready\.shift\(\)/)
    expect(body).toMatch(/ready = ready\.sort\(\)/)
    expect(body).toMatch(/\.filter\(\(n\) => unmet\.get\(n\) === 0\)\.sort\(\)/)
  })

  test('dependency resolution is PURE: no db / await inside resolveDependencyOrder', () => {
    const body = extractFunctionBody(SERVICE_SRC, 'export function resolveDependencyOrder')
    expect(body).not.toContain('await ')
    expect(body).not.toContain('db.')
  })
})

// ---------------------------------------------------------------------------
// NET-003-AC04 — canonical capability/resource resolution (static half)
// ---------------------------------------------------------------------------

describe('WORK-026 — canonical capability/resource resolution (NET-003-AC04)', () => {
  test('capability requirements resolve against the materialized Capability catalog', () => {
    // The canonical interface for capability truth is the Capability
    // catalog materialized at publication (V6 §15) — scoped to the tenant
    // AND the source version.
    const body = extractFunctionBody(SERVICE_SRC, 'export async function resolveNetworkPlan')
    expect(body).toMatch(
      /db\.capability\.findMany\(\{\s*\n\s*where: \{ tenantId, networkVersionId: version\.id \}/,
    )
    // Mismatch between the declared manifest and the materialized catalog is
    // a fail-closed integrity rejection.
    expect(body).toContain('fail-closed, NET-003-AC04')
  })

  test('resource requirements resolve against the authoritative AssetNetworkAssignment truth', () => {
    const body = extractFunctionBody(SERVICE_SRC, 'export async function resolveNetworkPlan')
    expect(body).toMatch(
      /db\.assetNetworkAssignment\.findMany\(\{\s*\n\s*where: \{ tenantId, networkId: version\.networkId, status: 'active' \}/,
    )
    // Discovery is an inventory, not an allocation (NET-004-AC02).
    expect(SERVICE_SRC).toContain('Discovery is an INVENTORY')
    expect(SERVICE_SRC).toContain('not an allocation (NET-004-AC02)')
  })

  test('capability catalog and resource discovery are the ONLY cross-subsystem reads', () => {
    // The compiler reads exactly: NetworkVersion (+network), Capability,
    // AssetNetworkAssignment, and (on re-resolution) NetworkPlan.
    const readModels = [...SERVICE_SRC.matchAll(/\bdb\.(\w+)\.(findFirst|findMany|findUnique)\(/g)]
    const models = new Set(readModels.map((m) => m[1]))
    expect([...models].sort()).toEqual(['assetNetworkAssignment', 'capability', 'networkPlan', 'networkVersion'])
  })
})

// ---------------------------------------------------------------------------
// NET-004-AC01 — deterministic canonical resolution (static half)
// ---------------------------------------------------------------------------

describe('WORK-026 — deterministic canonical resolution (NET-004-AC01)', () => {
  test('the canonical serialization is recursively key-sorted', () => {
    const body = extractFunctionBody(SERVICE_SRC, 'export function canonicalJsonStringify')
    expect(body).toBeTruthy()
    expect(body).toContain('Object.keys(')
    expect(body).toContain('.sort()')
  })

  test('the plan checksum is sha256 over the canonical serialization', () => {
    const body = extractFunctionBody(SERVICE_SRC, 'export function computePlanChecksum')
    expect(body).toContain("createHash('sha256')")
    expect(body).toContain("digest('hex')")
    // The checksum is computed over the stored planJson itself.
    const resolveBody = extractFunctionBody(SERVICE_SRC, 'export async function resolveNetworkPlan')
    expect(resolveBody).toContain('computePlanChecksum(planJson)')
  })

  test('every plan array is built in a canonical order (no DB-iteration leakage)', () => {
    const resolveBody = extractFunctionBody(SERVICE_SRC, 'export async function resolveNetworkPlan')
    expect(resolveBody).toContain('assetTypes: (manifest.asset_types as string[]).slice().sort()')
    expect(resolveBody).toMatch(/capabilities: declaredCapabilities[\s\S]*?\.sort\(\(a, b\) => \(a\.type < b\.type/)
    expect(resolveBody).toMatch(/dependencies: declaredDependencies\s*\n\s*\.slice\(\)\s*\n\s*\.sort\(/)
    expect(resolveBody).toMatch(/capabilityResolution\.sort\(\(a, b\) => \(a\.capabilityType < b\.capabilityType/)
    expect(resolveBody).toMatch(/\.sort\(\(a, b\) => \(a\.resourceId < b\.resourceId/)
    expect(resolveBody).toMatch(/\[\.\.\.declaredCapabilities\]\.sort\(\(a, b\) => \(a\.type < b\.type/)
  })

  test('the plan contains NO nondeterministic content (no timestamps of resolution, no row iteration order)', () => {
    const resolveBody = extractFunctionBody(SERVICE_SRC, 'export async function resolveNetworkPlan')
    const planStart = resolveBody.indexOf('const plan: ResolvedNetworkPlan = {')
    const planEnd = resolveBody.indexOf('const planJson = canonicalJsonStringify(plan)')
    expect(planStart).toBeGreaterThan(-1)
    expect(planEnd).toBeGreaterThan(planStart)
    const planLiteral = resolveBody.slice(planStart, planEnd)
    // Only the SOURCE version's immutable publication timestamp may appear.
    expect(planLiteral).toContain('publishedAt: version.publishedAt!.toISOString()')
    expect(planLiteral).not.toContain('new Date')
    expect(planLiteral).not.toContain('Date.now')
    expect(planLiteral).not.toContain('Math.random')
    // The artifact row's createdAt lives on the ROW, never in the content.
    expect(planLiteral).not.toContain('createdAt')
  })
})

// ---------------------------------------------------------------------------
// NET-004-AC03 — explicit output, no hidden implementation state (static half)
// ---------------------------------------------------------------------------

describe('WORK-026 — explicit resolution output (NET-004-AC03)', () => {
  test('the plan content interface enumerates EXACTLY the documented sections', () => {
    const iface = extractInterfaceBody(SERVICE_SRC, 'export interface ResolvedNetworkPlan')
    const fields = [
      'planSchemaVersion',
      'source',
      'assetTypes',
      'capabilities',
      'verification',
      'reward',
      'dependencies',
      'dependencyOrder',
      'capabilityResolution',
      'resourceDiscovery',
      'resolvedStages',
      'remainingLaunchStages',
    ]
    for (const f of fields) expect(iface).toContain(`${f}:`)
    // Count interface members — no hidden sections beyond the documented set.
    const memberCount = (iface.match(/^\s{2}\w+:/gm) ?? []).length
    expect(memberCount).toBe(fields.length)
  })

  test('the plan is built field-by-field (no spread of opaque objects into the plan)', () => {
    const resolveBody = extractFunctionBody(SERVICE_SRC, 'export async function resolveNetworkPlan')
    const planStart = resolveBody.indexOf('const plan: ResolvedNetworkPlan = {')
    const planEnd = resolveBody.indexOf('const planJson = canonicalJsonStringify(plan)')
    const planLiteral = resolveBody.slice(planStart, planEnd)
    expect(planLiteral).not.toContain('...version')
    expect(planLiteral).not.toContain('...manifest')
    expect(planLiteral).not.toContain('...assignment')
    expect(planLiteral).not.toContain('...row')
  })

  test('the frozen §3.5 launch pipeline is pinned 1:1 from the architecture document', () => {
    // The compiler's stage list must equal the frozen V6 §3.5 pipeline
    // (excluding Definition — the pipeline INPUT) with a deterministic
    // slug transform (lowercase, spaces → underscores).
    const frozen = parseFrozenPipeline(ARCH_SRC)
    expect(frozen.length).toBeGreaterThanOrEqual(11)
    const slug = (s: string) => s.toLowerCase().replace(/ /g, '_').replace(/\//g, '_')
    const expected = frozen.filter((s) => s !== 'Definition').map(slug)
    expect(DECLARED_PIPELINE).toEqual(expected)
    // Resolution owns exactly the first four post-Definition stages.
    const resolved = parseExportedArraySlice(SERVICE_SRC, 'RESOLVED_STAGES', 'LAUNCH_PIPELINE_STAGES.slice(0, 4)')
    expect(resolved).toBe(true)
    const remaining = parseExportedArraySlice(SERVICE_SRC, 'REMAINING_LAUNCH_STAGES', 'LAUNCH_PIPELINE_STAGES.slice(4)')
    expect(remaining).toBe(true)
    // The plan carries both halves explicitly.
    const resolveBody = extractFunctionBody(SERVICE_SRC, 'export async function resolveNetworkPlan')
    expect(resolveBody).toContain('resolvedStages: [...RESOLVED_STAGES]')
    expect(resolveBody).toContain('remainingLaunchStages: [...REMAINING_LAUNCH_STAGES]')
  })
})

// ---------------------------------------------------------------------------
// NET-004-AC04 — tenant isolation + authorization (static half)
// ---------------------------------------------------------------------------

describe('WORK-026 — tenant isolation + authorization (NET-004-AC04)', () => {
  test('every cross-subsystem read is tenant-scoped', () => {
    expect(SERVICE_SRC).toMatch(/where: \{ id: versionId, network: \{ tenantId \} \}/)
    expect(SERVICE_SRC).toMatch(/where: \{ tenantId, networkVersionId: version\.id \}/)
    expect(SERVICE_SRC).toMatch(/where: \{ tenantId, networkId: version\.networkId, status: 'active' \}/)
    expect(SERVICE_SRC).toMatch(/where: \{ id: planId, tenantId \}/)
  })

  test('cross-tenant ids are uniformly NOT_FOUND (no leakage)', () => {
    const loadBody = extractFunctionBody(SERVICE_SRC, 'async function loadTenantVersion')
    expect(loadBody).toContain("throw new NotFoundError('network_version', versionId)")
    const getBody = extractFunctionBody(SERVICE_SRC, 'export async function getNetworkPlan')
    expect(getBody).toContain("throw new NotFoundError('network_plan', planId)")
  })

  test('the persisting operation is actor-authorized; viewers are denied', () => {
    const body = extractFunctionBody(SERVICE_SRC, 'export async function resolveNetworkPlan')
    expect(body.indexOf('authorizeMutatingOperation(actor')).toBeGreaterThan(-1)
    expect(body.indexOf('authorizeMutatingOperation(actor')).toBeLessThan(
      body.indexOf('networkPlan.create'),
    )
    expect(SERVICE_SRC).toMatch(/const MUTATING_ROLES: readonly UserRole\[\] = \['admin', 'owner', 'operator'\]/)
    expect(SERVICE_SRC).toContain('ForbiddenError')
  })

  test('plan reads (validation, get, list) perform NO writes and require NO mutating role', () => {
    const validateBody = extractFunctionBody(SERVICE_SRC, 'export async function validateNetworkVersion')
    expect(validateBody).not.toContain('networkPlan.create')
    expect(validateBody).not.toContain('appendAudit')
    expect(validateBody).not.toContain('authorizeMutatingOperation')
    for (const fn of ['export async function getNetworkPlan', 'export async function listNetworkPlans']) {
      const body = extractFunctionBody(SERVICE_SRC, fn)
      expect(body).not.toContain('appendAudit')
      expect(body).not.toContain('authorizeMutatingOperation')
    }
  })

  test('successful resolution is audited atomically with the artifact', () => {
    const body = extractFunctionBody(SERVICE_SRC, 'export async function resolveNetworkPlan')
    const auditIdx = body.indexOf("eventType: 'network_plan.resolved'")
    const createIdx = body.indexOf('tx.networkPlan.create')
    expect(auditIdx).toBeGreaterThan(-1)
    expect(createIdx).toBeGreaterThan(-1)
    // Both are inside the SAME transaction.
    const txStart = body.indexOf('db.$transaction(')
    expect(txStart).toBeGreaterThan(-1)
    expect(txStart).toBeLessThan(createIdx)
    expect(txStart).toBeLessThan(auditIdx)
    expect(body).toContain('tx,\n      })')
  })
})

// ---------------------------------------------------------------------------
// Schema contract — the NetworkPlan artifact (NET-004-AC01/AC02/AC04)
// ---------------------------------------------------------------------------

describe('WORK-026 — NetworkPlan schema contract', () => {
  function modelSection(name: string): string {
    const start = SCHEMA.indexOf(`model ${name} {`)
    expect(start).toBeGreaterThanOrEqual(0)
    const end = SCHEMA.indexOf('\n}', start)
    return SCHEMA.slice(start, end)
  }

  test('NetworkPlan is its own durable model with its own primary key (distinct artifact identity)', () => {
    const section = modelSection('NetworkPlan')
    expect(section).toMatch(/id\s+String\s+@id\s+@default\(cuid\(\)\)/)
  })

  test('NetworkPlan references exactly ONE NetworkVersion via a REQUIRED column (RESTRICT)', () => {
    const section = modelSection('NetworkPlan')
    expect(section).toMatch(/networkVersionId\s+String\s*$/m)
    expect(section).not.toMatch(/networkVersionId\s+String\?/)
    expect(section).toMatch(
      /networkVersion\s+NetworkVersion\s+@relation\(fields:\s*\[networkVersionId\],\s*references:\s*\[id\],\s*onDelete:\s*Restrict\)/,
    )
  })

  test('NetworkPlan is write-once: createdAt only, NO updatedAt, NO lifecycle/status column', () => {
    // The plan is a compiled projection, NOT a lifecycle authority — it must
    // not carry a state machine that could compete with NetworkInstance
    // lifecycle (NET-004-AC02 / V6 §15). Field-position patterns (2-space
    // indent) so boundary COMMENTS do not collide with the check.
    const section = modelSection('NetworkPlan')
    expect(section).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\)/)
    expect(section).not.toMatch(/^\s{2}updatedAt/m)
    expect(section).not.toMatch(/^\s{2}status\s+String/m)
    expect(section).not.toMatch(/^\s{2}lifecycleState/m)
  })

  test('NetworkPlan stores the canonical content + checksum and is idempotent per (tenant, version, checksum)', () => {
    const section = modelSection('NetworkPlan')
    expect(section).toMatch(/planJson\s+String/)
    expect(section).toMatch(/planChecksum\s+String/)
    expect(section).toMatch(/@@unique\(\[tenantId,\s*networkVersionId,\s*planChecksum\]\)/)
  })

  test('NetworkPlan is tenant-scoped with a tenant cascade relation', () => {
    const section = modelSection('NetworkPlan')
    expect(section).toMatch(/tenantId\s+String\s*$/m)
    expect(section).toMatch(
      /tenant\s+Tenant\s+@relation\(fields:\s*\[tenantId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/,
    )
    expect(section).toMatch(/@@index\(\[tenantId\]\)/)
  })

  test('NetworkPlan carries NO composition/federation semantics (WORK-027+ out of scope)', () => {
    const section = modelSection('NetworkPlan')
    expect(section).not.toMatch(/parentPlanId|childPlans|compositionId|NetworkComposition|federat|exportId|importId/i)
  })

  test('NetworkVersion gains only the read-only plans back-relation', () => {
    const section = modelSection('NetworkVersion')
    expect(section).toMatch(/plans\s+NetworkPlan\[\]/)
    expect(section).toMatch(/publishedAt\s+DateTime\?/)
    expect(section).toContain('IMMUTABLE once publishedAt is set')
  })

  test('migration exists and is production-safe (idempotent, no destructive DDL)', () => {
    const migrationPath = 'prisma/migrations/20260829000000_add_network_plan/migration.sql'
    expect(existsSync(join(REPO_ROOT, migrationPath))).toBe(true)
    const migration = readSrc(migrationPath)
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "NetworkPlan"')
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "NetworkPlan_tenantId_networkVersionId_planChecksum_key"',
    )
    expect(migration).toContain('ON DELETE CASCADE')
    expect(migration).toContain('ON DELETE RESTRICT')
    // Destructive-DDL check runs against SQL (boundary COMMENTS may
    // legitimately document the guarantee).
    expect(sqlOnly(migration)).not.toMatch(/DROP TABLE|TRUNCATE|ALTER TABLE .* DROP/)
    // Guarded FK creation (idempotent).
    expect(migration.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g)?.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Manifest validation contract completeness (NET-003-AC01 static half)
// ---------------------------------------------------------------------------

describe('WORK-026 — manifest validation contract (NET-003-AC01)', () => {
  test('every canonical constraint has a deterministic error code', () => {
    expect(DECLARED_ERROR_CODES).toEqual([
      'M001_MANIFEST_NOT_OBJECT',
      'M002_ASSET_TYPES_INVALID',
      'M003_ASSET_TYPE_INVALID',
      'M004_ASSET_TYPES_DUPLICATE',
      'M005_CAPABILITIES_INVALID',
      'M006_CAPABILITY_INVALID',
      'M007_CAPABILITY_TYPE_DUPLICATE',
      'M008_VERIFICATION_INVALID',
      'M009_VERIFICATION_CHECKS_INVALID',
      'M010_REWARD_INVALID',
      'M011_REWARD_RATE_INVALID',
      'M012_REWARD_FEE_INVALID',
      'M013_DEPENDENCIES_INVALID',
      'M014_DEPENDENCY_INVALID',
      'M015_DEPENDENCY_SELF',
      'M016_DEPENDENCY_DANGLING',
      'M017_DEPENDENCY_DUPLICATE',
    ])
  })

  test('validation covers every canonical structural surface', () => {
    const body = extractFunctionBody(SERVICE_SRC, 'export function validateNetworkManifest')
    for (const surface of [
      'asset_types',
      'capabilities',
      'verification',
      'reward',
      'dependencies',
      'schema_version',
      'numeric_ranges',
      'timestamp_window_seconds',
      'platform_fee_pct',
    ]) {
      expect(body).toContain(surface)
    }
    // Required capabilities: at least one declared capability node.
    expect(body).toMatch(/capabilities\.length === 0/)
    // Required verification checks: non-empty.
    expect(body).toMatch(/checks\.length === 0/)
  })

  test('the manifest is a REPRESENTATION: the NetworkDefinition remains source of intent (V6 §3.2)', () => {
    // The compiler consumes the version's serialized configuration as the
    // manifest representation — it never becomes a second source of truth.
    expect(SERVICE_SRC).toContain('JSON.parse(version.configurationJson)')
    expect(ARCH_SRC).toContain('NetworkManifest is not a second source of truth')
  })
})

// ---------------------------------------------------------------------------
// Helpers — source extraction utilities
// ---------------------------------------------------------------------------

/** Extract a function body by its declaration line (brace-matched). */
function extractFunctionBody(src: string, decl: string): string {
  const start = src.indexOf(decl)
  if (start === -1) return ''
  const openBrace = src.indexOf('{', start)
  let depth = 0
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(openBrace + 1, i)
    }
  }
  return ''
}

/** Extract an interface body by its declaration line (brace-matched). */
function extractInterfaceBody(src: string, decl: string): string {
  return extractFunctionBody(src, decl)
}

/** Assert an exported const is defined as `NAME = SOURCE.slice(a, b)`. */
function parseExportedArraySlice(src: string, name: string, sliceExpr: string): boolean {
  const re = new RegExp(`export const ${name}: readonly string\\[\\] = ${sliceExpr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  return re.test(src)
}

/** Source with block + full-line comments removed — CODE ONLY. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/** SQL with `--` comment lines removed — SQL ONLY. */
function sqlOnly(src: string): string {
  return src.replace(/^[ \t]*--.*$/gm, '')
}
