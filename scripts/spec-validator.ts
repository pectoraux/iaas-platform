// =============================================================================
// WORK-001 — Executable Specification Consistency Validator
// =============================================================================
// Validates the persistent IAAS governance/specification layer under `spec/`
// against the frozen governance architecture `IAAS-GOV-ARCH-1`.
//
// Source of requirements: spec/work-orders/WORK-001.md, "Required
// Implementation" items 2–11. Each check below carries a stable check ID
// (SC-01 … SC-16) so failures are mechanically attributable.
//
// Architect Review corrections applied to this validator:
//   - AR-001: SC-06 enforces the COMPLETE Work Item schema declared in
//     spec/work-items.md ("Schema") for EVERY Work Item, not a subset.
//   - AR-002: the GitHub-state one-active-PR invariant (W001-AC09 /
//     GOV-005 / frozen rule 8) is established by the companion script
//     scripts/pr-invariant-check.ts, executed by the same CI job.
//
// Contract (WORK-001 Required Implementation item 13):
//   - exits 0 and prints a deterministic success message when the
//     specification is internally consistent;
//   - exits non-zero and prints deterministic failure diagnostics otherwise.
//
// Usage:
//   bun run spec:validate
//   bun scripts/spec-validator.ts [--spec-dir <path>]
//
// `--spec-dir` defaults to the `spec/` directory next to the repository root
// derived from this script's own path, so the validator works from any cwd.
// Negative tests use `--spec-dir` to validate mutated copies of the spec.
//
// The validator is intentionally dependency-free (node:* builtins only) so the
// governance gate never depends on the application dependency tree.
// =============================================================================

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  specDir: string
}

function parseArgs(argv: string[]): CliArgs {
  let specDir: string | null = null
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--spec-dir') {
      const value = argv[i + 1]
      if (!value) {
        failHard('usage: spec-validator.ts [--spec-dir <path>] — --spec-dir requires a value')
      }
      specDir = value
      i += 1
    } else if (arg.startsWith('--spec-dir=')) {
      specDir = arg.slice('--spec-dir='.length)
    } else {
      failHard(`usage: spec-validator.ts [--spec-dir <path>] — unknown argument: ${arg}`)
    }
  }
  const scriptDir = dirname(resolve(argv[1] ?? process.cwd()))
  return { specDir: resolve(specDir ?? join(scriptDir, '..', 'spec')) }
}

function failHard(message: string): never {
  process.stderr.write(`SPEC VALIDATOR ERROR: ${message}\n`)
  process.exit(2)
}

const { specDir } = parseArgs(process.argv)

// ---------------------------------------------------------------------------
// Constants (frozen governance facts, derived from spec/architecture-lock.md)
// ---------------------------------------------------------------------------

const REQUIRED_SPEC_FILES: ReadonlyArray<string> = [
  'README.md',
  'architecture.md',
  'architecture-lock.md',
  'requirements.md',
  'work-items.md',
  'dependency-graph.md',
  'work-order-template.md',
  'architecture-change-request.md',
  'verification.md',
  'work-orders/WORK-001.md',
]

// Files that spec/README.md must index in its Documents section
// (excluding the README itself and the work-order registry).
const README_INDEXED_FILES: ReadonlyArray<string> = REQUIRED_SPEC_FILES.filter(
  (f) => f !== 'README.md' && f !== 'work-orders/WORK-001.md',
)

const GOV_VERSION_PATTERN = /^IAAS-GOV-ARCH-\d+$/
const WORK_ITEM_PATTERN = /^WORK-\d+$/
const AC_PATTERN = /^W001-AC\d{2}$/
const EXPECTED_WORK001_ACS: readonly string[] = Array.from({ length: 13 }, (_, i) =>
  `W001-AC${String(i + 1).padStart(2, '0')}`,
)

// Work Item schema (spec/work-items.md "Schema" / GOV-002). Every Work Item
// MUST define all of these. Value fields must carry a non-empty value on
// their field line; section fields must appear as their own heading line.
const SCHEMA_VALUE_FIELDS: ReadonlyArray<string> = [
  'Objective',
  'Requirements',
  'Dependencies',
  'Architecture Constraints',
  'Repository Scope',
  'Out of Scope',
]
const SCHEMA_SECTION_FIELDS: ReadonlyArray<string> = [
  'Acceptance Criteria',
  'Required Verification',
  'Definition of Done',
]
// Work ID (section heading) + Governing Architecture Version (SC-05) plus
// the value and section fields above.
const SCHEMA_FIELD_COUNT = 2 + SCHEMA_VALUE_FIELDS.length + SCHEMA_SECTION_FIELDS.length

// WORK-001 Required Verification activities and Definition of Done elements
// (GOV-002 traceability). Field PRESENCE for every Work Item is SC-06; this
// content is pinned by SC-08.
const WORK001_REQUIRED_VERIFICATION_ACTIVITIES: ReadonlyArray<string> = [
  'repository specification inspection',
  'automated specification consistency check',
  'negative tests',
  'CI execution',
  'PR diff inspection',
  'independent Architect Review',
]
const WORK001_DOD_ELEMENTS: ReadonlyArray<string> = [
  'production diff is empty',
  'architect approves',
  'PR merged',
  'VERIFIED',
]

// Lifecycle states from spec/architecture-lock.md "Workflow" plus `BLOCKED`,
// the dependency-derived state used by spec/work-items.md / dependency-graph.md.
const ALLOWED_STATUSES: ReadonlySet<string> = new Set([
  'DRAFT',
  'READY',
  'ASSIGNED',
  'IMPLEMENTING',
  'PR_OPEN',
  'VERIFYING',
  'VERIFICATION_FAILED',
  'ARCHITECT_REVIEW',
  'REQUEST_CHANGES',
  'ARCHITECTURE_CHANGE_REQUIRED',
  'ARCHITECTURE_CHANGE_REQUEST',
  'IMPLEMENTATION_BLOCKED',
  'APPROVED',
  'MERGED',
  'VERIFIED',
  'BLOCKED',
])

// States at or beyond READY. Only dependency-eligible Work Items may enter
// these states (architecture-lock.md frozen rules 9 / GOV-008).
const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'READY',
  'ASSIGNED',
  'IMPLEMENTING',
  'PR_OPEN',
  'VERIFYING',
  'VERIFICATION_FAILED',
  'ARCHITECT_REVIEW',
  'REQUEST_CHANGES',
  'ARCHITECTURE_CHANGE_REQUIRED',
  'ARCHITECTURE_CHANGE_REQUEST',
  'IMPLEMENTATION_BLOCKED',
  'APPROVED',
  'MERGED',
  'VERIFIED',
])

const TRUTH_CLASSIFICATIONS: ReadonlyArray<string> = [
  'OBSERVED',
  'INFERRED',
  'CONFIRMED',
  'PROPOSED',
]

const ACR_STATES: ReadonlyArray<string> = [
  'DRAFT',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'SUPERSEDED',
]

const VERIFICATION_EVIDENCE_FIELDS: ReadonlyArray<string> = [
  'criterion_id',
  'verification_method',
  'command_or_artifact',
  'observed_result',
  'verified_at',
  'verifier',
]

// Forbidden production-scope markers for WORK-001's positive Scope declaration.
// (The Out-of-Scope line is expected to *mention* these as exclusions.)
const PRODUCTION_SCOPE_MARKERS =
  /(prisma|migration|node[ -]?plane|data[ -]?plane|routing|transport|vertical network|production service|production code|production implementation|src\/|services\/)/i

// ---------------------------------------------------------------------------
// Spec file loading
// ---------------------------------------------------------------------------

type SpecContent = Record<string, string>

function loadSpec(dir: string): { content: SpecContent; errors: string[] } {
  const content: SpecContent = {}
  const errors: string[] = []
  for (const file of REQUIRED_SPEC_FILES) {
    try {
      content[file] = readFileSync(join(dir, file), 'utf8')
      if (content[file].trim().length === 0) {
        errors.push(`required specification file is empty: spec/${file}`)
      }
    } catch {
      content[file] = ''
      errors.push(`missing required specification file: spec/${file}`)
    }
  }
  return { content, errors }
}

const { content: spec, errors: fileErrors } = loadSpec(specDir)

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

interface WorkItem {
  id: string
  body: string
  status: string | null
  architectureVersion: string | null
  architectureVersionCount: number
  dependencies: string[]
  acceptanceCriteria: string[]
  repositoryScopeLine: string | null
}

function fieldValue(body: string, field: string): string | null {
  // Fields appear either as plain lines (`Status: ...`) or as list items
  // (`- Architecture Version: ...` in the Work Order files).
  const match = body.match(new RegExp(`^(?:[-*]\\s+)?${field}:[ \\t]*(.*)$`, 'm'))
  return match ? match[1].trim() : null
}

function firstBackticked(text: string | null): string | null {
  if (!text) return null
  const match = text.match(/`([^`]+)`/)
  return match ? match[1] : null
}

function allBackticked(text: string): string[] {
  const matches = text.matchAll(/`([^`]+)`/g)
  const out: string[] = []
  for (const match of matches) out.push(match[1])
  return out
}

/** Content of the `Acceptance Criteria:` section (list of AC IDs). */
function acceptanceCriteriaSection(body: string): string {
  const match = body.match(/^Acceptance Criteria:[ \t]*$/m)
  if (!match || match.index === undefined) return ''
  const rest = body.slice(match.index + match[0].length)
  // The section ends at the next field/section declaration line
  // (e.g. `Required Verification:`). List items do not match.
  const endMatch = rest.match(/^(?:[-*]\s+)?[A-Z][A-Za-z /]*:/m)
  return endMatch && endMatch.index !== undefined ? rest.slice(0, endMatch.index) : rest
}

function parseWorkItems(workItemsMd: string): WorkItem[] {
  const items: WorkItem[] = []
  const lines = workItemsMd.split('\n')
  let current: { id: string; lines: string[] } | null = null
  for (const line of lines) {
    const heading = line.match(/^## (WORK-\d+)\b/)
    if (heading) {
      if (current) items.push(finalizeWorkItem(current))
      current = { id: heading[1], lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) items.push(finalizeWorkItem(current))
  return items
}

function finalizeWorkItem(section: { id: string; lines: string[] }): WorkItem {
  const body = section.lines.join('\n')
  const versionLines = body.match(/^(?:[-*]\s+)?Architecture Version:.*$/gm) ?? []
  const dependenciesRaw = fieldValue(body, 'Dependencies')
  const dependencies =
    dependenciesRaw && !/^\s*none\s*$/i.test(dependenciesRaw)
      ? allBackticked(dependenciesRaw).filter((d) => WORK_ITEM_PATTERN.test(d))
      : []
  const statusRaw = fieldValue(body, 'Status')
  const status = firstBackticked(statusRaw) ?? (statusRaw ? statusRaw.split(/\s+/)[0] : null)
  return {
    id: section.id,
    body,
    status: status ?? null,
    architectureVersion: firstBackticked(fieldValue(body, 'Architecture Version')),
    architectureVersionCount: versionLines.length,
    dependencies,
    acceptanceCriteria: allBackticked(acceptanceCriteriaSection(body)).filter((t) => AC_PATTERN.test(t)),
    repositoryScopeLine: fieldValue(body, 'Repository Scope'),
  }
}

interface GraphEdge {
  from: string // dependency (must complete first)
  to: string // dependent
}

function parseGraphEdges(dependencyGraphMd: string): GraphEdge[] {
  const edges: GraphEdge[] = []
  const matches = dependencyGraphMd.matchAll(/^\s*(WORK-\d+)\s*->\s*(WORK-\d+)\s*$/gm)
  for (const match of matches) edges.push({ from: match[1], to: match[2] })
  return edges
}

// ---------------------------------------------------------------------------
// Validation checks
// ---------------------------------------------------------------------------

const errors: Array<{ check: string; message: string }> = []

function error(check: string, message: string): void {
  errors.push({ check, message })
}

// SC-01 — required specification files exist and are non-empty.
for (const fileError of fileErrors) error('SC-01', fileError)

const readme = spec['README.md'] ?? ''
const architecture = spec['architecture.md'] ?? ''
const lock = spec['architecture-lock.md'] ?? ''
const requirements = spec['requirements.md'] ?? ''
const workItemsMd = spec['work-items.md'] ?? ''
const dependencyGraphMd = spec['dependency-graph.md'] ?? ''
const workOrderTemplate = spec['work-order-template.md'] ?? ''
const acr = spec['architecture-change-request.md'] ?? ''
const verification = spec['verification.md'] ?? ''
const workOrder = spec['work-orders/WORK-001.md'] ?? ''

// SC-02 — README indexes every core specification document.
for (const file of README_INDEXED_FILES) {
  if (!readme.includes(file)) {
    error('SC-02', `spec/README.md does not index required document: spec/${file}`)
  }
}

// SC-03 — frozen governance architecture version present, well-formed,
// and consistent between architecture.md and architecture-lock.md.
const lockVersionMatch = lock.match(/Governance Architecture Version:\s*`([^`]+)`/)
const lockVersion = lockVersionMatch ? lockVersionMatch[1] : null
const archVersionMatch = architecture.match(
  /\|\s*Governance Architecture\s*\|\s*`([^`]+)`\s*\|\s*(\S+)\s*\|/,
)
const archVersion = archVersionMatch ? archVersionMatch[1] : null

if (!lockVersionMatch) {
  error('SC-03', 'spec/architecture-lock.md does not declare a Governance Architecture Version')
} else if (!GOV_VERSION_PATTERN.test(lockVersion ?? '')) {
  error('SC-03', `malformed governance architecture version in architecture-lock.md: ${lockVersion}`)
}
if (!archVersionMatch) {
  error('SC-03', 'spec/architecture.md does not register a Governance Architecture version row')
} else if (!GOV_VERSION_PATTERN.test(archVersion ?? '')) {
  error('SC-03', `malformed governance architecture version in architecture.md: ${archVersion}`)
}
if (lockVersion && archVersion && lockVersion !== archVersion) {
  error(
    'SC-03',
    `governance architecture version inconsistent: architecture-lock.md declares ${lockVersion} but architecture.md declares ${archVersion}`,
  )
}
if (!/Status:\s*\*\*FROZEN\*\*/.test(lock)) {
  error('SC-03', 'spec/architecture-lock.md does not mark the governance architecture FROZEN')
}
if (archVersionMatch && !/FROZEN/.test(archVersionMatch[2] ?? '')) {
  error('SC-03', 'spec/architecture.md does not mark the governance architecture FROZEN')
}

// SC-04 — domain architecture remains pending WORK-002 (version model parity).
const domVersionMatch = architecture.match(
  /\|\s*Domain Architecture\s*\|\s*`([^`]+)`\s*\|\s*([^\n|]+)\|/,
)
if (!domVersionMatch) {
  error('SC-04', 'spec/architecture.md does not register a Domain Architecture version row')
} else if (!/PENDING/i.test(domVersionMatch[2] ?? '')) {
  error(
    'SC-04',
    `spec/architecture.md must keep the domain architecture pending WORK-002 (found status: ${domVersionMatch[2]?.trim()})`,
  )
}
if (!lock.includes('Domain Architecture Version: pending WORK-002')) {
  error('SC-04', 'spec/architecture-lock.md must keep the domain architecture pending WORK-002')
}

const registeredVersions: ReadonlySet<string> = new Set(
  [archVersion, domVersionMatch ? domVersionMatch[1] : null].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  ),
)

const workItems = parseWorkItems(workItemsMd)
const workItemById = new Map<string, WorkItem>()
for (const item of workItems) {
  if (workItemById.has(item.id)) {
    error('SC-06', `duplicate Work Item declaration: ${item.id}`)
  } else {
    workItemById.set(item.id, item)
  }
}

// SC-05 — every Work Item declares exactly one architecture version,
// and that version is registered in spec/architecture.md.
for (const item of workItems) {
  if (item.architectureVersionCount === 0) {
    error('SC-05', `Work Item ${item.id} declares no architecture version`)
  } else if (item.architectureVersionCount > 1) {
    error(
      'SC-05',
      `Work Item ${item.id} declares ${item.architectureVersionCount} architecture versions; exactly one is required`,
    )
  } else if (!item.architectureVersion || !GOV_VERSION_PATTERN.test(item.architectureVersion)) {
    error(
      'SC-05',
      `Work Item ${item.id} declares a malformed architecture version: ${item.architectureVersion}`,
    )
  } else if (!registeredVersions.has(item.architectureVersion)) {
    error(
      'SC-05',
      `Work Item ${item.id} references unregistered architecture version ${item.architectureVersion}`,
    )
  }
}

// SC-06 — complete Work Item schema (spec/work-items.md "Schema" / GOV-002),
// enforced for EVERY Work Item: Work ID (section heading), Objective,
// Governing Architecture Version (exactly one — SC-05), Requirements,
// Acceptance Criteria, Dependencies, Architecture Constraints, Repository
// Scope, Out of Scope, Required Verification, Definition of Done.
// (Architect Review correction AR-001: the schema is no longer enforced for
// a subset of fields or a subset of Work Items.)
if (workItems.length === 0) {
  error('SC-06', 'spec/work-items.md declares no Work Items')
}
for (const item of workItems) {
  for (const field of SCHEMA_VALUE_FIELDS) {
    const value = fieldValue(item.body, field)
    if (value === null) {
      error('SC-06', `Work Item ${item.id} is missing required schema field: ${field}`)
    } else if (value.length === 0) {
      error('SC-06', `Work Item ${item.id} declares an empty value for required schema field: ${field}`)
    }
  }
  for (const field of SCHEMA_SECTION_FIELDS) {
    if (!new RegExp(`^${field}:`, 'm').test(item.body)) {
      error('SC-06', `Work Item ${item.id} is missing required schema section: ${field}`)
    }
  }
  const acPrefix = item.id.replace(/^WORK-/, 'W')
  if (!new RegExp('`' + acPrefix + '-AC\\d{2}`').test(item.body)) {
    error(
      'SC-06',
      `Work Item ${item.id} declares no acceptance criterion IDs (expected \`${acPrefix}-ACnn\`)`,
    )
  }
  if (item.status === null) {
    error('SC-06', `Work Item ${item.id} is missing required field: Status`)
  } else if (!ALLOWED_STATUSES.has(item.status)) {
    error('SC-06', `Work Item ${item.id} declares unknown Status: ${item.status}`)
  }
}

const work001 = workItemById.get('WORK-001') ?? null

// SC-07 — the 13 WORK-001 acceptance criterion IDs: exact set, no duplicates.
if (work001) {
  const found = work001.acceptanceCriteria
  const unique = new Set(found)
  if (found.length !== unique.size) {
    const seen = new Set<string>()
    for (const id of found) {
      if (seen.has(id)) error('SC-07', `duplicate WORK-001 acceptance criterion ID: ${id}`)
      seen.add(id)
    }
  }
  const missing = EXPECTED_WORK001_ACS.filter((id) => !unique.has(id))
  if (missing.length > 0) {
    error('SC-07', `missing required WORK-001 acceptance criteria: ${missing.join(', ')}`)
  }
  const extra = [...unique].filter((id) => !EXPECTED_WORK001_ACS.includes(id))
  if (extra.length > 0) {
    error('SC-07', `unexpected WORK-001 acceptance criteria outside W001-AC01..W001-AC13: ${extra.join(', ')}`)
  }
} else {
  error('SC-07', 'Work Item WORK-001 is not declared in spec/work-items.md')
}

// SC-08 — WORK-001 Required Verification activities and Definition of Done
// elements (GOV-002 traceability). Schema PRESENCE for every Work Item is
// enforced by SC-06; SC-08 pins WORK-001's verification and completion
// CONTENT so the traceability requirement cannot be vacuously satisfied.
if (work001) {
  for (const activity of WORK001_REQUIRED_VERIFICATION_ACTIVITIES) {
    if (!work001.body.includes(activity)) {
      error('SC-08', `WORK-001 Required Verification is missing required activity: ${activity}`)
    }
  }
  for (const element of WORK001_DOD_ELEMENTS) {
    if (!work001.body.includes(element)) {
      error('SC-08', `WORK-001 Definition of Done is missing required element: ${element}`)
    }
  }
}

// SC-09 — every dependency reference (work items and graph nodes) resolves.
for (const item of workItems) {
  for (const dep of item.dependencies) {
    if (!workItemById.has(dep)) {
      error('SC-09', `Work Item ${item.id} declares unresolved dependency: ${dep}`)
    }
  }
}
const graphEdges = parseGraphEdges(dependencyGraphMd)
for (const edge of graphEdges) {
  if (!workItemById.has(edge.from)) {
    error('SC-09', `spec/dependency-graph.md references unknown Work Item: ${edge.from}`)
  }
  if (!workItemById.has(edge.to)) {
    error('SC-09', `spec/dependency-graph.md references unknown Work Item: ${edge.to}`)
  }
}

// SC-10 — declared dependencies and dependency-graph.md agree; graph is acyclic.
const declaredEdges: GraphEdge[] = []
for (const item of workItems) {
  for (const dep of item.dependencies) {
    declaredEdges.push({ from: dep, to: item.id })
  }
}
const edgeKey = (e: GraphEdge): string => `${e.from}->${e.to}`
const declaredKeySet = new Set(declaredEdges.map(edgeKey))
const graphKeySet = new Set(graphEdges.map(edgeKey))
if (graphEdges.length !== graphKeySet.size) {
  const counts = new Map<string, number>()
  for (const edge of graphEdges) counts.set(edgeKey(edge), (counts.get(edgeKey(edge)) ?? 0) + 1)
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort()
  error('SC-10', `duplicate dependency edge(s) in dependency-graph.md: ${duplicates.join(', ')}`)
}
for (const key of declaredKeySet) {
  if (!graphKeySet.has(key)) {
    error('SC-10', `dependency declared in work-items.md but missing from dependency-graph.md: ${key}`)
  }
}
for (const key of graphKeySet) {
  if (!declaredKeySet.has(key)) {
    error('SC-10', `dependency edge present in dependency-graph.md but not declared in work-items.md: ${key}`)
  }
}
// Kahn's algorithm over dependency -> dependent edges (reversed for traversal).
{
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const id of workItemById.keys()) {
    inDegree.set(id, 0)
    dependents.set(id, [])
  }
  for (const item of workItems) {
    for (const dep of item.dependencies) {
      if (!workItemById.has(dep) || !workItemById.has(item.id)) continue
      dependents.get(dep)?.push(item.id)
      inDegree.set(item.id, (inDegree.get(item.id) ?? 0) + 1)
    }
  }
  const queue: string[] = [...workItemById.keys()].filter((id) => (inDegree.get(id) ?? 0) === 0)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift() as string
    order.push(id)
    for (const next of dependents.get(id) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1
      inDegree.set(next, remaining)
      if (remaining === 0) queue.push(next)
    }
  }
  if (order.length !== workItemById.size) {
    const cyclic = [...workItemById.keys()].filter((id) => (inDegree.get(id) ?? 0) > 0).sort()
    error('SC-10', `dependency graph contains a cycle involving: ${cyclic.join(', ')}`)
  }
}

// SC-11 — dependency eligibility gate: WORK-002 cannot be eligible before
// WORK-001 is VERIFIED (GOV-008 / frozen rule 9).
for (const item of workItems) {
  const depsResolved = item.dependencies.every((dep) => workItemById.has(dep))
  if (!depsResolved) continue // already reported by SC-09
  const eligible =
    item.dependencies.length === 0 ||
    item.dependencies.every((dep) => workItemById.get(dep)?.status === 'VERIFIED')
  if (!eligible && item.status !== null && ACTIVE_STATUSES.has(item.status)) {
    error(
      'SC-11',
      `Work Item ${item.id} is not dependency-eligible (dependencies not VERIFIED) but has active status ${item.status}`,
    )
  }
}
if (!dependencyGraphMd.toLowerCase().includes('work-002 is blocked until work-001 is verified')) {
  error(
    'SC-11',
    'spec/dependency-graph.md does not state that WORK-002 is blocked until WORK-001 is VERIFIED',
  )
}

// SC-12 — required truth classifications (GOV-006 / frozen rule 5).
for (const classification of TRUTH_CLASSIFICATIONS) {
  if (!lock.includes(classification)) {
    error('SC-12', `spec/architecture-lock.md is missing truth classification: ${classification}`)
  }
  if (!requirements.includes(classification)) {
    error('SC-12', `spec/requirements.md (GOV-006) is missing truth classification: ${classification}`)
  }
}

// SC-13 — Architecture Change Request protocol exists and is referenced.
if (!acr.includes('ACR-ID')) error('SC-13', 'spec/architecture-change-request.md is missing field: ACR-ID')
if (!acr.includes('NEW ARCHITECTURE VERSION')) {
  error('SC-13', 'spec/architecture-change-request.md is missing field: NEW ARCHITECTURE VERSION')
}
for (const state of ACR_STATES) {
  if (!acr.includes(state)) {
    error('SC-13', `spec/architecture-change-request.md is missing ACR state: ${state}`)
  }
}
if (!acr.includes('MUST stop and escalate')) {
  error('SC-13', 'spec/architecture-change-request.md is missing the implementer escalation rule')
}
if (!lock.includes('Architecture Change Request')) {
  error('SC-13', 'spec/architecture-lock.md does not reference the Architecture Change Request protocol')
}
if (!readme.includes('architecture-change-request.md')) {
  error('SC-13', 'spec/README.md does not reference the Architecture Change Request protocol')
}

// SC-14 — verification protocol distinguishes objective evidence from agent
// narrative (GOV-003 / frozen rule 6) and from Architect Review (rule 7).
if (!verification.includes('PASS | FAIL | BLOCKED')) {
  error('SC-14', 'spec/verification.md does not define the PASS | FAIL | BLOCKED result model')
}
for (const field of VERIFICATION_EVIDENCE_FIELDS) {
  if (!verification.includes(field)) {
    error('SC-14', `spec/verification.md is missing evidence field: ${field}`)
  }
}
if (!verification.includes('Agent narrative is contextual only and cannot establish PASS')) {
  error(
    'SC-14',
    'spec/verification.md does not state that agent narrative cannot establish PASS (GOV-003)',
  )
}
if (!verification.includes('Architect Review')) {
  error('SC-14', 'spec/verification.md does not distinguish Architect Review from Verification')
}
if (!lock.includes('Verification and Architect Review are separate decisions')) {
  error('SC-14', 'spec/architecture-lock.md does not state that Verification and Architect Review are separate decisions')
}

// SC-15 — WORK-001 contains no production implementation scope (frozen rule 13).
if (work001) {
  if (!work001.body.includes('no IAAS production code changes in WORK-001')) {
    error('SC-15', 'WORK-001 is missing acceptance criterion text: no IAAS production code changes in WORK-001 (W001-AC13)')
  }
  const outOfScope = fieldValue(work001.body, 'Out of Scope') ?? ''
  if (!/domain feature implementation/i.test(outOfScope) || !/migration/i.test(outOfScope)) {
    error('SC-15', "WORK-001 'Out of Scope' must exclude domain feature implementation and migrations")
  }
  const scopeLine = work001.repositoryScopeLine ?? ''
  if (!scopeLine.includes('spec/')) {
    error('SC-15', "WORK-001 'Repository Scope' must be limited to the spec/ governance layer and its consistency gate")
  }
  const forbidden = scopeLine.match(PRODUCTION_SCOPE_MARKERS)
  if (forbidden) {
    error(
      'SC-15',
      `WORK-001 'Repository Scope' declares forbidden production implementation scope (matched: ${forbidden[0]})`,
    )
  }
}
if (!requirements.includes('No production IAAS feature is authorized')) {
  error('SC-15', 'spec/requirements.md is missing the WORK-001 freeze: no production IAAS feature is authorized')
}
if (!lock.includes('WORK-001 authorizes no production feature implementation')) {
  error('SC-15', 'spec/architecture-lock.md is missing frozen rule 13: WORK-001 authorizes no production feature implementation')
}

// SC-16 — the persistent WORK-001 Work Order conforms to the Work Order
// template's required handoff fields (spec/work-order-template.md).
const orderVersion = firstBackticked(fieldValue(workOrder, 'Architecture Version'))
if (!workOrder.includes('Work Item: `WORK-001`')) {
  error('SC-16', 'spec/work-orders/WORK-001.md does not identify Work Item WORK-001')
}
if (!workOrder.includes('Implementer:')) {
  error('SC-16', 'spec/work-orders/WORK-001.md is missing field: Implementer')
}
if (!workOrder.includes('Architect / Reviewer:')) {
  error('SC-16', 'spec/work-orders/WORK-001.md is missing field: Architect / Reviewer')
}
for (const section of [
  '## Objective',
  '## Requirements',
  '## Repository Scope',
  '## Out of Scope',
  '## Required Tests',
  '## Required Verification Evidence',
  '## Stop Conditions',
  '## Definition of Done',
]) {
  if (!workOrder.includes(section)) {
    error('SC-16', `spec/work-orders/WORK-001.md is missing required section: ${section}`)
  }
}
if (!orderVersion) {
  error('SC-16', 'spec/work-orders/WORK-001.md is missing field: Architecture Version')
} else if (work001?.architectureVersion && orderVersion !== work001.architectureVersion) {
  error(
    'SC-16',
    `spec/work-orders/WORK-001.md declares architecture version ${orderVersion} but WORK-001 declares ${work001.architectureVersion}`,
  )
}
if (!workOrderTemplate.includes('STOP CONDITIONS') || !workOrderTemplate.includes('DEFINITION OF DONE')) {
  error('SC-16', 'spec/work-order-template.md is missing STOP CONDITIONS / DEFINITION OF DONE fields')
}

// ---------------------------------------------------------------------------
// Output (deterministic) and exit code contract
// ---------------------------------------------------------------------------

if (errors.length > 0) {
  process.stderr.write('SPEC VALIDATION FAILED\n')
  for (const { check, message } of errors) {
    process.stderr.write(`[${check}] ${message}\n`)
  }
  process.stderr.write(`spec validation failed with ${errors.length} error(s)\n`)
  process.exit(1)
}

process.stdout.write('SPEC VALIDATION PASSED\n')
process.stdout.write(
  `architecture=${archVersion ?? 'unknown'} ` +
    `required-files=${REQUIRED_SPEC_FILES.length} ` +
    `work-items=${workItems.length} ` +
    `work-item-schema-fields=${SCHEMA_FIELD_COUNT} ` +
    `work001-acceptance-criteria=${EXPECTED_WORK001_ACS.length} ` +
    `dependency-edges=${declaredKeySet.size} ` +
    `checks=16\n`,
)
process.exit(0)
