// =============================================================================
// Network-as-Code Compiler service — IAAS-DOM-ARCH-6 §3.5 / WORK-026
// =============================================================================
// The canonical deterministic Network-as-Code validation and resolution layer:
// it consumes an immutable PUBLISHED NetworkVersion (the serialized
// representation of the NetworkDefinition's declarative intent) and compiles
// it into an implementation-ready, deterministic, auditable resolution result
// (a NetworkPlan / launch plan) for the subsequent provisioning/launch Work
// Item.
//
// Contract source: spec/domain-architecture-v6.md §3.2 (Network intent:
// NetworkManifest is only a representation; NetworkDefinition remains source
// of intent), §3.5 (the canonical launch pipeline), §15 (authority matrix),
// §16 (forbidden generic dependencies), spec/domain-requirements-v6.md
// NET-002 (WORK-026's sole acceptance-bearing requirement per approved
// ACR-006), spec/work-orders/WORK-026.md (Acceptance: NET-002-AC01..04).
//
// The frozen V6 §3.5 launch pipeline, with the stages THIS compiler owns:
//
//   Definition            ┐
//   Validation            │ OWNED by this service (compile/resolve)
//   Dependency Resolution │ — deterministic, fail-closed, read-only
//   Capability Resolution │   except ONE write-once plan artifact.
//   Resource Discovery    ┘
//   Allocation            ┐
//   Reservation           │ NOT owned here — enumerated in the plan output
//   Commitment            │ as the explicit remaining stages for the next
//   Provisioning          │ provisioning/launch Work Item. This service
//   Runtime Activation    │ NEVER allocates, reserves, commits, provisions,
//   Verification          │ activates, or executes anything (NET-002-AC03).
//   DEPLOYED              ┘
//
// ARCHITECTURAL BOUNDARIES (frozen by IAAS-DOM-ARCH-6):
//   - Service-layer, NOT kernel (this module is in src/lib/services/).
//   - Deterministic and fail-closed (NET-002-AC01): validation runs BEFORE
//     any side effect; invalid definitions/versions are rejected with NO plan
//     row and NO audit row (NET-002-AC01).
//   - The source NetworkVersion is READ-ONLY here: compilation never writes
//     NetworkVersion rows (NET-002-AC01 — published versions are immutable).
//   - Dependency resolution is deterministic, acyclic, and based ONLY on the
//     declared canonical dependency contracts of the definition itself
//     (NET-002-AC02). This is NOT cross-network composition: no
//     export/import bindings, no federation semantics (later Work Items).
//   - Capability/resource requirements are resolved through canonical
//     interfaces (the Capability catalog materialized at publication + the
//     authoritative AssetNetworkAssignment resource truth) with NO
//     vertical-specific branches (NET-002-AC04): every vertical compiles
//     through the identical code path.
//   - The same declarative input under the same authoritative repository
//     state produces the SAME canonical resolution result (NET-002-AC04):
//     planJson is a canonical serialization (recursively key-sorted, arrays
//     in canonical order) and planChecksum = sha256(planJson); the unique
//     constraint (tenantId, networkVersionId, planChecksum) makes
//     re-resolution idempotent.
//   - Resolution does NOT allocate, reserve, commit, provision, activate, or
//     mutate NetworkInstance lifecycle state (NET-002-AC03): this service
//     never writes NetworkInstance, CapacityReservation, or commitment rows
//     and never imports the Network Lifecycle service.
//   - The plan output is fully EXPLICIT (NET-002-AC03): a documented set of
//     plain-data sections — source, declared manifest, dependency order,
//     capability resolution, resource discovery, and the pipeline stage
//     lists — with no hidden implementation state.
//   - Tenant isolation and authorization boundaries are preserved
//     (platform tenant-scope invariant): every query is tenant-scoped (cross-tenant ids are
//     uniformly NOT_FOUND) and the persisting operation is actor-authorized
//     (viewers are denied).
//
// This service does NOT:
//   - modify the generic kernel or import kernel modules;
//   - introduce vertical-specific lifecycle or resolver branches;
//   - implement composition, exports/imports, or federation (WORK-027+);
//   - implement allocation/market strategies, provisioning, activation, or
//     runtime execution (later Work Items);
//   - create, transition, or delete NetworkInstances (WORK-025 owns that);
//   - update or delete plan rows — the NetworkPlan artifact is write-once.
// =============================================================================

import { createHash } from 'node:crypto'

import { db } from '@/lib/db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit } from '@/lib/domain/audit'
import type { UserRole } from '@/lib/domain/auth'

// ---------------------------------------------------------------------------
// Types — the canonical manifest (declaration) surface
// ---------------------------------------------------------------------------

/**
 * The declared dependency contract between two nodes of ONE network
 * definition (NET-002-AC02). `from` REQUIRES `to` (`from` depends on `to`);
 * both endpoints MUST reference capability types declared by the same
 * manifest. This is the INTERNAL dependency surface of a definition — it is
 * NOT a cross-network composition binding (WORK-027 owns those).
 */
export interface DeclaredDependency {
  from: string
  to: string
}

/** A canonical manifest validation issue (deterministic code + path). */
export interface ManifestIssue {
  code: string
  path: string
  message: string
}

/**
 * The actor performing a compile/resolve operation. Identity/roles are owned
 * by the existing identity boundary (PlatformUser/UserRole) — this service
 * only makes the authorization DECISION for Network-as-Code compilation:
 * the persisting operation requires admin | owner | operator; viewers are
 * denied. Read-only operations (validation, plan reads) are tenant-scoped.
 */
export interface NetworkCompilerActor {
  actorId: string
  role: UserRole
}

// ---------------------------------------------------------------------------
// Deterministic canonical serialization (NET-002-AC04 / NET-002-AC03)
// ---------------------------------------------------------------------------

/**
 * Recursively key-sorted JSON serialization. Objects are serialized with
 * their keys in lexicographic order at every depth; arrays keep their order
 * (array order is DATA — the plan builder is responsible for putting every
 * array into a canonical order). The output is a deterministic function of
 * the VALUE ONLY (never of insertion order or DB row order).
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJsonStringify(v)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(record[k])}`)
    .join(',')}}`
}

/** sha256 hex digest of the canonical serialization — the plan identity. */
export function computePlanChecksum(planJson: string): string {
  return createHash('sha256').update(planJson, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// The frozen V6 §3.5 launch pipeline stage lists (NET-002-AC03)
// ---------------------------------------------------------------------------

/** The complete frozen §3.5 launch pipeline, in canonical order. */
export const LAUNCH_PIPELINE_STAGES: readonly string[] = [
  'validation',
  'dependency_resolution',
  'capability_resolution',
  'resource_discovery',
  'allocation',
  'reservation',
  'commitment',
  'provisioning',
  'runtime_activation',
  'verification',
  'deployed',
] as const

/** Stages completed by this compiler (the resolution half of §3.5). */
export const RESOLVED_STAGES: readonly string[] = LAUNCH_PIPELINE_STAGES.slice(0, 4)

/** Stages that remain for the subsequent provisioning/launch Work Item. */
export const REMAINING_LAUNCH_STAGES: readonly string[] = LAUNCH_PIPELINE_STAGES.slice(4)

/** Schema version of the compiled plan artifact. */
export const PLAN_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// Pure manifest validation (NET-002-AC01: deterministic, fail-closed)
// ---------------------------------------------------------------------------
//
// The manifest is the serialized declarative configuration of a
// NetworkVersion (configurationJson) — the representation of the
// NetworkDefinition's intent (V6 §3.2). Validation is a PURE function of the
// parsed manifest: no I/O, no clocks, no randomness. Issues are returned in
// a canonical order (code, then path, then message) so the same invalid
// input always produces the identical, byte-for-byte reproducible issue
// list.

/** All manifest validation error codes (deterministic, fail-closed). */
export const MANIFEST_ERROR_CODES: readonly string[] = [
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
] as const

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function issue(code: string, path: string, message: string): ManifestIssue {
  return { code, path, message }
}

/** Deterministic issue ordering: (code, path, message). */
function sortIssues(issues: ManifestIssue[]): ManifestIssue[] {
  return [...issues].sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    return a.message < b.message ? -1 : 1
  })
}

/**
 * Validate a parsed manifest against the canonical IAAS structural and
 * semantic constraints. PURE and total: always returns the complete,
 * canonically ordered issue list (empty ⇔ valid).
 */
export function validateNetworkManifest(manifest: unknown): ManifestIssue[] {
  const issues: ManifestIssue[] = []

  if (!isPlainObject(manifest)) {
    return [issue('M001_MANIFEST_NOT_OBJECT', '$', 'manifest must be a JSON object')]
  }

  // --- asset_types -----------------------------------------------------
  const assetTypes = manifest.asset_types
  if (!Array.isArray(assetTypes)) {
    issues.push(issue('M002_ASSET_TYPES_INVALID', '$.asset_types', 'asset_types must be an array'))
  } else {
    const seen = new Set<string>()
    for (let i = 0; i < assetTypes.length; i++) {
      const t = assetTypes[i]
      if (!isNonEmptyString(t)) {
        issues.push(
          issue('M003_ASSET_TYPE_INVALID', `$.asset_types[${i}]`, 'asset type must be a non-empty string'),
        )
      } else if (seen.has(t)) {
        issues.push(issue('M004_ASSET_TYPES_DUPLICATE', `$.asset_types[${i}]`, `duplicate asset type '${t}'`))
      } else {
        seen.add(t)
      }
    }
  }

  // --- capabilities ------------------------------------------------------
  const capabilities = manifest.capabilities
  const declaredCapabilityTypes = new Set<string>()
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    issues.push(
      issue('M005_CAPABILITIES_INVALID', '$.capabilities', 'capabilities must be a non-empty array'),
    )
  } else {
    for (let i = 0; i < capabilities.length; i++) {
      const cap = capabilities[i]
      const path = `$.capabilities[${i}]`
      if (!isPlainObject(cap)) {
        issues.push(issue('M006_CAPABILITY_INVALID', path, 'capability must be an object'))
        continue
      }
      if (!isNonEmptyString(cap.type)) {
        issues.push(issue('M006_CAPABILITY_INVALID', `${path}.type`, 'capability type must be a non-empty string'))
      } else if (declaredCapabilityTypes.has(cap.type)) {
        issues.push(issue('M007_CAPABILITY_TYPE_DUPLICATE', `${path}.type`, `duplicate capability type '${cap.type}'`))
      } else {
        declaredCapabilityTypes.add(cap.type)
      }
      if (!isNonEmptyString(cap.unit)) {
        issues.push(issue('M006_CAPABILITY_INVALID', `${path}.unit`, 'capability unit must be a non-empty string'))
      }
      const sv = cap.schema_version
      if (typeof sv !== 'number' || !Number.isInteger(sv) || sv < 1) {
        issues.push(
          issue('M006_CAPABILITY_INVALID', `${path}.schema_version`, 'schema_version must be an integer >= 1'),
        )
      }
      const fields = cap.fields
      if (!isPlainObject(fields)) {
        issues.push(issue('M006_CAPABILITY_INVALID', `${path}.fields`, 'fields must be an object'))
      } else {
        for (const [k, v] of Object.entries(fields)) {
          if (!isNonEmptyString(k) || !isNonEmptyString(v)) {
            issues.push(
              issue('M006_CAPABILITY_INVALID', `${path}.fields`, 'field names and values must be non-empty strings'),
            )
            break
          }
        }
      }
    }
  }

  // --- verification ------------------------------------------------------
  const verification = manifest.verification
  if (!isPlainObject(verification)) {
    issues.push(issue('M008_VERIFICATION_INVALID', '$.verification', 'verification must be an object'))
  } else {
    const checks = verification.checks
    if (!Array.isArray(checks) || checks.length === 0 || !checks.every(isNonEmptyString)) {
      issues.push(
        issue('M009_VERIFICATION_CHECKS_INVALID', '$.verification.checks', 'checks must be a non-empty array of non-empty strings'),
      )
    }
    if (verification.numeric_ranges !== undefined && !isPlainObject(verification.numeric_ranges)) {
      issues.push(
        issue('M008_VERIFICATION_INVALID', '$.verification.numeric_ranges', 'numeric_ranges must be an object'),
      )
    }
    const tw = verification.timestamp_window_seconds
    if (tw !== undefined && (typeof tw !== 'number' || !Number.isFinite(tw) || tw <= 0)) {
      issues.push(
        issue('M008_VERIFICATION_INVALID', '$.verification.timestamp_window_seconds', 'timestamp_window_seconds must be a positive number'),
      )
    }
  }

  // --- reward ------------------------------------------------------------
  const reward = manifest.reward
  if (!isPlainObject(reward)) {
    issues.push(issue('M010_REWARD_INVALID', '$.reward', 'reward must be an object'))
  } else {
    for (const key of ['type', 'unit', 'currency'] as const) {
      if (!isNonEmptyString(reward[key])) {
        issues.push(issue('M010_REWARD_INVALID', `$.reward.${key}`, `reward ${key} must be a non-empty string`))
      }
    }
    if (typeof reward.rate !== 'string' || !/^\d+(\.\d+)?$/.test(reward.rate.trim())) {
      issues.push(issue('M011_REWARD_RATE_INVALID', '$.reward.rate', 'reward rate must be a non-negative decimal string (e.g. "0.01")'))
    }
    const fee = reward.platform_fee_pct
    if (fee !== undefined && (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0 || fee > 100)) {
      issues.push(issue('M012_REWARD_FEE_INVALID', '$.reward.platform_fee_pct', 'platform_fee_pct must be a number between 0 and 100'))
    }
  }

  // --- dependencies (the declared canonical dependency contracts) ---------
  const dependencies = manifest.dependencies
  if (dependencies !== undefined) {
    if (!Array.isArray(dependencies)) {
      issues.push(issue('M013_DEPENDENCIES_INVALID', '$.dependencies', 'dependencies must be an array'))
    } else {
      const seenPairs = new Set<string>()
      for (let i = 0; i < dependencies.length; i++) {
        const dep = dependencies[i]
        const path = `$.dependencies[${i}]`
        if (!isPlainObject(dep)) {
          issues.push(issue('M014_DEPENDENCY_INVALID', path, 'dependency must be an object'))
          continue
        }
        if (!isNonEmptyString(dep.from) || !isNonEmptyString(dep.to)) {
          issues.push(issue('M014_DEPENDENCY_INVALID', path, 'dependency from/to must be non-empty strings'))
          continue
        }
        if (dep.from === dep.to) {
          issues.push(issue('M015_DEPENDENCY_SELF', path, `dependency '${dep.from}' cannot depend on itself`))
          continue
        }
        const pair = `${dep.from}\u0000${dep.to}`
        if (seenPairs.has(pair)) {
          issues.push(issue('M017_DEPENDENCY_DUPLICATE', path, `duplicate dependency ${dep.from} → ${dep.to}`))
          continue
        }
        seenPairs.add(pair)
        // Dangling endpoints: both sides must reference DECLARED capability
        // nodes of this manifest (declaredCapabilityTypes is complete by the
        // time this runs ONLY when capabilities parsed — guard for the
        // capabilities-invalid case by re-checking membership).
        if (
          declaredCapabilityTypes.size > 0 &&
          (!declaredCapabilityTypes.has(dep.from) || !declaredCapabilityTypes.has(dep.to))
        ) {
          issues.push(
            issue(
              'M016_DEPENDENCY_DANGLING',
              path,
              `dependency ${dep.from} → ${dep.to} references a capability type not declared by this manifest`,
            ),
          )
        }
      }
    }
  }

  return sortIssues(issues)
}

// ---------------------------------------------------------------------------
// Pure dependency resolution (NET-002-AC02: deterministic + acyclic)
// ---------------------------------------------------------------------------

/**
 * Resolve the declared dependency graph into the canonical dependency ORDER
 * of the declared capability nodes.
 *
 * Deterministic algorithm (Kahn's): a node is READY when all of its declared
 * prerequisites are already emitted; the lexicographically smallest ready
 * node is always emitted first — a canonical total order that depends only
 * on the declared set of nodes + edges, never on input/DB iteration order.
 *
 * Fail-closed: a dependency cycle is rejected with the exact deterministic
 * cycle path (the lexicographically smallest cycle found by DFS from the
 * lexicographically smallest remaining node).
 *
 * PURE: no I/O — exported for direct deterministic-resolution tests.
 */
export function resolveDependencyOrder(
  capabilityTypes: readonly string[],
  dependencies: readonly DeclaredDependency[],
): string[] {
  const nodes = [...capabilityTypes]
  // prerequisites.get(x) = set of nodes x depends on (x requires them).
  const prerequisites = new Map<string, Set<string>>()
  // dependents.get(x) = set of nodes that depend on x.
  const dependents = new Map<string, Set<string>>()
  for (const n of nodes) {
    prerequisites.set(n, new Set())
    dependents.set(n, new Set())
  }
  for (const dep of dependencies) {
    prerequisites.get(dep.from)!.add(dep.to)
    dependents.get(dep.to)!.add(dep.from)
  }

  const order: string[] = []
  const emitted = new Set<string>()
  // unmet.get(x) = number of prerequisites of x not yet emitted.
  const unmet = new Map<string, number>()
  for (const n of nodes) unmet.set(n, prerequisites.get(n)!.size)

  // The ready set is kept SORTED so the emitted order is canonical.
  let ready: string[] = nodes.filter((n) => unmet.get(n) === 0).sort()
  while (ready.length > 0) {
    const current = ready.shift()!
    order.push(current)
    emitted.add(current)
    for (const dependent of [...dependents.get(current)!].sort()) {
      const remaining = unmet.get(dependent)! - 1
      unmet.set(dependent, remaining)
      if (remaining === 0) ready.push(dependent)
    }
    ready = ready.sort()
  }

  if (order.length !== nodes.length) {
    // Cycle: fail closed with the exact deterministic cycle path.
    const remaining = nodes.filter((n) => !emitted.has(n)).sort()
    const start = remaining[0]
    const path: string[] = []
    const onPath = new Set<string>()
    let cycle: string[] = []
    const dfs = (node: string): boolean => {
      path.push(node)
      onPath.add(node)
      for (const next of [...prerequisites.get(node)!].sort()) {
        if (onPath.has(next)) {
          // Close the cycle at the first occurrence of `next`.
          cycle = [...path.slice(path.indexOf(next)), next]
          return true
        }
        if (remaining.includes(next) && dfs(next)) return true
      }
      path.pop()
      onPath.delete(node)
      return false
    }
    dfs(start)
    throw new ValidationError(
      `Dependency graph contains a cycle: ${cycle.join(' → ')} — dependency resolution must be acyclic (NET-002-AC02)`,
    )
  }

  return order
}

// ---------------------------------------------------------------------------
// Plan content types (NET-002-AC03: explicit output, no hidden state)
// ---------------------------------------------------------------------------

/** A discovered verified resource binding candidate (pre-allocation). */
export interface DiscoveredResource {
  /** The AssetNetworkAssignment id — the durable resource binding identity. */
  resourceId: string
  assetId: string
  verifiedQuantity: string
  verifiedUnit: string
}

/** Resolved capability (declared node ↔ materialized catalog row). */
export interface ResolvedCapability {
  capabilityType: string
  unit: string
  schemaVersion: number
  /** The materialized Capability catalog row (created at publication). */
  materializedCapabilityId: string
}

/** The canonical resolution result — the complete plan content. */
export interface ResolvedNetworkPlan {
  planSchemaVersion: number
  source: {
    networkId: string
    networkVersionId: string
    version: number
    vertical: string
    runtimeKind: string
    publishedAt: string
  }
  assetTypes: string[]
  capabilities: Array<{ type: string; unit: string; schemaVersion: number; fields: Record<string, string> }>
  verification: Record<string, unknown>
  reward: Record<string, unknown>
  dependencies: DeclaredDependency[]
  dependencyOrder: string[]
  capabilityResolution: ResolvedCapability[]
  resourceDiscovery: Array<{ capabilityType: string; resources: DiscoveredResource[] }>
  resolvedStages: string[]
  remainingLaunchStages: string[]
}

export interface NetworkPlanResult {
  id: string
  tenantId: string
  networkVersionId: string
  networkId: string
  version: number
  planChecksum: string
  plan: ResolvedNetworkPlan
  createdAt: string
}

export interface VersionValidationResult {
  valid: boolean
  versionId: string
  networkId: string
  version: number
  published: boolean
  issues: ManifestIssue[]
}

// ---------------------------------------------------------------------------
// Actor authorization (platform tenant-scope invariant)
// ---------------------------------------------------------------------------

const MUTATING_ROLES: readonly UserRole[] = ['admin', 'owner', 'operator']

function authorizeMutatingOperation(actor: NetworkCompilerActor, operation: string): void {
  if (!MUTATING_ROLES.includes(actor.role)) {
    throw new ForbiddenError(
      `Actor is not authorized to ${operation} (role '${actor.role}' is read-only; ` +
        `requires one of: ${MUTATING_ROLES.join(', ')})`,
    )
  }
}

// ---------------------------------------------------------------------------
// Validation entry point (read-only; NET-002-AC01)
// ---------------------------------------------------------------------------

/**
 * Validate a NetworkVersion's declarative manifest against the canonical
 * IAAS constraints. READ-ONLY: no persistence, no side effects, no actor
 * gate (tenant-scoped read). Returns the deterministic issue list — the same
 * invalid input always yields the identical list.
 */
export async function validateNetworkVersion(
  tenantId: string,
  versionId: string,
): Promise<VersionValidationResult> {
  const version = await loadTenantVersion(tenantId, versionId)
  let manifest: unknown
  try {
    manifest = JSON.parse(version.configurationJson)
  } catch {
    return {
      valid: false,
      versionId: version.id,
      networkId: version.networkId,
      version: version.version,
      published: version.publishedAt !== null,
      issues: [
        issue('M001_MANIFEST_NOT_OBJECT', '$', 'version configuration is not valid JSON'),
      ],
    }
  }
  const issues = validateNetworkManifest(manifest)
  return {
    valid: issues.length === 0,
    versionId: version.id,
    networkId: version.networkId,
    version: version.version,
    published: version.publishedAt !== null,
    issues,
  }
}

// ---------------------------------------------------------------------------
// Resolution (the compiler entry point; NET-002)
// ---------------------------------------------------------------------------

/**
 * Compile one immutable PUBLISHED NetworkVersion into a deterministic,
 * auditable launch plan (NetworkPlan artifact).
 *
 * Stage order (frozen V6 §3.5 — a later stage can never bypass an earlier
 * authority, and NOTHING persists until every resolution stage succeeds):
 *   1. authorization (platform tenant-scope invariant)
 *   2. tenant-scoped source-version load (uniform NOT_FOUND)
 *   3. publication gate (only PUBLISHED versions compile)
 *   4. Validation          — pure, fail-closed (NET-002-AC01)
 *   5. Dependency Resolution — pure, acyclic, canonical order (NET-002-AC02)
 *   6. Capability Resolution — read-only, canonical catalog (NET-002-AC02)
 *   7. Resource Discovery    — read-only, authoritative verified capacity
 *   8. canonical plan assembly + sha256 checksum (NET-002-AC04/AC03)
 *   9. idempotent write-once persistence + atomic audit (the ONLY writes)
 *
 * Idempotency (NET-002-AC04): if a plan with the same canonical checksum
 * already exists for this (tenant, version), the EXISTING artifact is
 * returned — re-resolution under unchanged repository state never
 * duplicates or mutates anything.
 */
export async function resolveNetworkPlan(
  tenantId: string,
  versionId: string,
  actor: NetworkCompilerActor,
): Promise<NetworkPlanResult> {
  authorizeMutatingOperation(actor, 'resolve a network plan')

  // --- Stage 2: tenant-scoped source-version load ------------------------
  const version = await loadTenantVersion(tenantId, versionId)

  // --- Stage 3: publication gate ------------------------------------------
  if (!version.publishedAt) {
    throw new ConflictError(
      `Cannot compile NetworkVersion ${version.id} (v${version.version}): it is not published — ` +
        `plans compile immutable PUBLISHED versions only`,
    )
  }

  // --- Stage 4: Validation (pure, fail-closed, BEFORE any side effect) ----
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(version.configurationJson) as Record<string, unknown>
  } catch {
    throw new ValidationError(
      `NetworkVersion ${version.id} configuration is not valid JSON — rejected before resolution side effects (NET-002-AC01)`,
    )
  }
  const issues = validateNetworkManifest(manifest)
  if (issues.length > 0) {
    throw new ValidationError(
      `NetworkVersion ${version.id} (v${version.version}) failed canonical Network-as-Code validation — ` +
        `rejected before resolution side effects (NET-002-AC01). Issues (${issues.length}): ` +
        issues.map((i) => `${i.code} at ${i.path}: ${i.message}`).join('; '),
    )
  }

  // --- Stage 5: Dependency Resolution (pure) ------------------------------
  const declaredCapabilities = (manifest.capabilities as Array<Record<string, unknown>>).map((cap) => ({
    type: cap.type as string,
    unit: cap.unit as string,
    schemaVersion: cap.schema_version as number,
    fields: (cap.fields ?? {}) as Record<string, string>,
  }))
  const declaredDependencies = ((manifest.dependencies ?? []) as DeclaredDependency[]).map((d) => ({
    from: d.from,
    to: d.to,
  }))
  const dependencyOrder = resolveDependencyOrder(
    declaredCapabilities.map((c) => c.type),
    declaredDependencies,
  )

  // --- Stage 6: Capability Resolution (read-only, canonical catalog) ------
  // The Capability catalog rows are materialized at publication from the SAME
  // configuration (the canonical capability interface — V6 §15: capability
  // truth is the registry/catalog, not the compiler). Resolving through the
  // catalog verifies the published artifact's integrity: every declared
  // capability MUST have exactly one matching materialized row (type, unit,
  // schemaVersion). Mismatch = fail closed.
  const materialized = await db.capability.findMany({
    where: { tenantId, networkVersionId: version.id },
  })
  const materializedByType = new Map(materialized.map((c) => [c.capabilityType, c]))
  const capabilityResolution: ResolvedCapability[] = []
  for (const declared of declaredCapabilities) {
    const row = materializedByType.get(declared.type)
    if (!row) {
      throw new ValidationError(
        `Capability '${declared.type}' is declared by NetworkVersion ${version.id} but has no ` +
          `materialized catalog row — the published artifact is inconsistent (fail-closed, NET-002-AC02)`,
      )
    }
    if (row.unit !== declared.unit || row.schemaVersion !== declared.schemaVersion) {
      throw new ValidationError(
        `Capability '${declared.type}' does not match its materialized catalog row ` +
          `(declared unit='${declared.unit}' schema_version=${declared.schemaVersion} vs catalog ` +
          `unit='${row.unit}' schema_version=${row.schemaVersion}) — the published artifact is inconsistent (fail-closed, NET-002-AC02)`,
      )
    }
    capabilityResolution.push({
      capabilityType: declared.type,
      unit: declared.unit,
      schemaVersion: declared.schemaVersion,
      materializedCapabilityId: row.id,
    })
  }
  capabilityResolution.sort((a, b) => (a.capabilityType < b.capabilityType ? -1 : 1))

  // --- Stage 7: Resource Discovery (read-only, authoritative truth) -------
  // Discover VERIFIED resource binding candidates for each declared
  // capability: the ACTIVE AssetNetworkAssignment rows of this tenant + this
  // network carrying a verified quantity + unit. Discovery is an INVENTORY,
  // not an allocation (NET-002-AC03): nothing is reserved, committed, or
  // bound; the next stage (allocation) owns those decisions. Entries are
  // included even when ZERO verified resources exist — the plan is explicit
  // about availability rather than hiding it.
  const assignments = await db.assetNetworkAssignment.findMany({
    where: { tenantId, networkId: version.networkId, status: 'active' },
  })
  const resourceDiscovery: Array<{ capabilityType: string; resources: DiscoveredResource[] }> = []
  for (const declared of [...declaredCapabilities].sort((a, b) => (a.type < b.type ? -1 : 1))) {
    const resources = assignments
      .filter(
        (a) =>
          a.capabilityType === declared.type &&
          typeof a.verifiedQuantity === 'string' &&
          typeof a.verifiedUnit === 'string',
      )
      .map((a) => ({
        resourceId: a.id,
        assetId: a.assetId,
        verifiedQuantity: a.verifiedQuantity as string,
        verifiedUnit: a.verifiedUnit as string,
      }))
      .sort((a, b) => (a.resourceId < b.resourceId ? -1 : 1))
    resourceDiscovery.push({ capabilityType: declared.type, resources })
  }

  // --- Stage 8: canonical plan assembly + checksum ------------------------
  const plan: ResolvedNetworkPlan = {
    planSchemaVersion: PLAN_SCHEMA_VERSION,
    source: {
      networkId: version.networkId,
      networkVersionId: version.id,
      version: version.version,
      vertical: version.network.vertical,
      runtimeKind: version.runtimeKind,
      publishedAt: version.publishedAt!.toISOString(),
    },
    assetTypes: (manifest.asset_types as string[]).slice().sort(),
    capabilities: declaredCapabilities
      .map((c) => ({ type: c.type, unit: c.unit, schemaVersion: c.schemaVersion, fields: c.fields }))
      .sort((a, b) => (a.type < b.type ? -1 : 1)),
    verification: manifest.verification as Record<string, unknown>,
    reward: manifest.reward as Record<string, unknown>,
    dependencies: declaredDependencies
      .slice()
      .sort((a, b) => (a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : 1)),
    dependencyOrder,
    capabilityResolution,
    resourceDiscovery,
    resolvedStages: [...RESOLVED_STAGES],
    remainingLaunchStages: [...REMAINING_LAUNCH_STAGES],
  }
  const planJson = canonicalJsonStringify(plan)
  const planChecksum = computePlanChecksum(planJson)

  // --- Stage 9: idempotent write-once persistence + atomic audit ----------
  const existing = await db.networkPlan.findUnique({
    where: { tenantId_networkVersionId_planChecksum: { tenantId, networkVersionId: version.id, planChecksum } },
  })
  if (existing) {
    return toResult(existing)
  }

  try {
    const created = await db.$transaction(async (tx) => {
      const planRow = await tx.networkPlan.create({
        data: { tenantId, networkVersionId: version.id, planJson, planChecksum },
      })
      // Audit INSIDE the transaction: the evidence row commits/rolls back
      // atomically with the artifact it attests.
      await appendAudit({
        tenantId,
        actorId: actor.actorId,
        eventType: 'network_plan.resolved',
        resourceType: 'network_plan',
        resourceId: planRow.id,
        metadata: {
          networkVersionId: version.id,
          networkId: version.networkId,
          version: version.version,
          planChecksum,
          dependencyOrder,
        },
        tx,
      })
      return planRow
    }, { timeout: 30000 })
    return toResult(created)
  } catch (err) {
    // Racing resolutions of the same (tenant, version, checksum): the unique
    // constraint guarantees exactly one artifact row — the loser returns the
    // winner's artifact (deterministic convergence).
    if (isUniqueConstraintViolation(err)) {
      const winner = await db.networkPlan.findUnique({
        where: { tenantId_networkVersionId_planChecksum: { tenantId, networkVersionId: version.id, planChecksum } },
      })
      if (winner) return toResult(winner)
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Plan reads (tenant-scoped; platform tenant-scope invariant)
// ---------------------------------------------------------------------------

export async function getNetworkPlan(tenantId: string, planId: string): Promise<NetworkPlanResult> {
  const plan = await db.networkPlan.findFirst({ where: { id: planId, tenantId } })
  if (!plan) throw new NotFoundError('network_plan', planId)
  return toResult(plan)
}

export async function listNetworkPlans(
  tenantId: string,
  filter?: { networkVersionId?: string },
): Promise<NetworkPlanResult[]> {
  const plans = await db.networkPlan.findMany({
    where: {
      tenantId,
      ...(filter?.networkVersionId ? { networkVersionId: filter.networkVersionId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  })
  return plans.map(toResult)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tenant-scoped source-version load (uniform NOT_FOUND — no leakage). */
async function loadTenantVersion(tenantId: string, versionId: string) {
  const version = await db.networkVersion.findFirst({
    where: { id: versionId, network: { tenantId } },
    include: { network: true },
  })
  if (!version) throw new NotFoundError('network_version', versionId)
  return version
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  )
}

function toResult(plan: {
  id: string
  tenantId: string
  networkVersionId: string
  planJson: string
  planChecksum: string
  createdAt: Date
}): NetworkPlanResult {
  const parsed = JSON.parse(plan.planJson) as ResolvedNetworkPlan
  return {
    id: plan.id,
    tenantId: plan.tenantId,
    networkVersionId: plan.networkVersionId,
    networkId: parsed.source.networkId,
    version: parsed.source.version,
    planChecksum: plan.planChecksum,
    plan: parsed,
    createdAt: plan.createdAt.toISOString(),
  }
}
