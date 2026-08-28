// =============================================================================
// IAAS-DOM-ARCH-6 — Architecture Completion Validator
// =============================================================================
// Dependency-free validator for the candidate V6 architecture package.
// It validates the complete specification tree under test with the immutable
// V1-era legacy validator, then validates the V6 candidate package; it does
// not execute production code or authorize implementation.
// =============================================================================

import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()

const fail = (message: string): never => {
  process.stderr.write(`V6 ARCHITECTURE VALIDATOR FAILED: ${message}\n`)
  process.exit(1)
}

const read = (path: string): string => {
  const full = join(root, path)
  if (!existsSync(full)) fail(`missing required file: ${path}`)
  return readFileSync(full, 'utf8')
}

// WORK-024 repair: the legacy V1-era validator is the immutable specification
// regression gate and runs against the COMPLETE specification tree under test
// — on main this is main itself; on a PR branch it is exactly the tree the PR
// would land on main. The original implementation instead validated a
// snapshot of `origin/main`, which after the V6 candidate merge became
// self-referential and unsatisfiable: a repair PR could never prove its own
// specification tree green (the gate validated the already-regressed merged
// snapshot instead of the tree under review), while main's own push gate
// validated the same broken tree it had just accepted — PR #35 passed every
// check pre-merge, then push run 33142040478 on merge commit ea3268a failed
// SC-04/SC-15. Validating the tree under test restores the intended invariant
// (the tree that would land on main MUST satisfy the complete V1-era
// specification contract) and makes the gate self-consistent at every commit:
// green on a PR head is green on the resulting main, because it is the same
// tree. V1-V5 immutability remains independently enforced by the frozen
// git-blob SHA checks below and by the legacy validator's own checks.
function runLegacyBaselineValidation(): void {
  const validator = join(root, 'scripts', 'spec-validator.ts')
  const specDir = join(root, 'spec')
  const result = spawnSync(process.execPath, [validator, '--spec-dir', specDir], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.status !== 0) fail(`specification tree under test rejected by legacy validator (exit ${result.status ?? 1})`)
}

// The V1-era validator remains a historical regression gate; execute it over
// the complete specification tree under test. V6 is validated independently
// below against the candidate tree.
runLegacyBaselineValidation()

const required = [
  'spec/architecture.md',
  'spec/architecture-lock.md',
  'spec/architecture-change-requests/ACR-005.md',
  'spec/architecture-inventory-v6.md',
  'spec/domain-architecture-v5.md',
  'spec/domain-architecture-v6.md',
  'spec/domain-requirements-v6.md',
  'spec/domain-dependency-graph-v6.md',
  'spec/work-items-v6.md',
  'spec/dependency-graph-v6.md',
  'spec/work-orders/WORK-023.md',
  'spec/work-orders/WORK-024.md',
  'spec/work-state/V6-ARCHITECTURE-HOLD.md',
]
required.forEach(read)

const architecture = read('spec/architecture.md')
const lock = read('spec/architecture-lock.md')
const acr = read('spec/architecture-change-requests/ACR-005.md')
const inventory = read('spec/architecture-inventory-v6.md')
const v5 = read('spec/domain-architecture-v5.md')
const v6 = read('spec/domain-architecture-v6.md')
const req = read('spec/domain-requirements-v6.md')
const domainGraph = read('spec/domain-dependency-graph-v6.md')
const workItems = read('spec/work-items-v6.md')
const workGraph = read('spec/dependency-graph-v6.md')
const hold = read('spec/work-state/V6-ARCHITECTURE-HOLD.md')

if (!/IAAS-DOM-ARCH-5` \| FROZEN \/ CURRENT CANONICAL/.test(architecture)) fail('V5 is not current canonical in architecture.md')
if (!/IAAS-DOM-ARCH-6` \| CANDIDATE \/ UNDER REVIEW/.test(architecture)) fail('V6 candidate row missing')
if (!lock.includes('IAAS-DOM-ARCH-5` (FROZEN')) fail('architecture-lock does not identify V5 as frozen')
if (!lock.includes('IAAS-DOM-ARCH-6` (CANDIDATE / UNDER REVIEW — ACR-005)')) fail('architecture-lock does not identify V6 candidate')
if (!acr.includes('- ACR-ID: `ACR-005`')) fail('ACR-005 identity missing')
if (!acr.includes('- Status: `UNDER_REVIEW`')) fail('ACR-005 must remain under review')
if (!v6.includes('IAAS-DOM-ARCH-6') || !v6.includes('CANDIDATE / UNDER REVIEW')) fail('V6 architecture status invalid')
if (!v5.includes('IAAS-DOM-ARCH-5')) fail('V5 architecture missing')

const frozenBlobSha: Record<string, string> = {
  'spec/domain-architecture.md': '1868a11171b6007b167652466c970acdf7f948d5',
  'spec/domain-architecture-v2.md': '95d13509a180819c02e8b41fed8a781cb2be090a',
  'spec/domain-architecture-v3.md': '1fd340229a78efe6d13664ab72ac6c7d3c46ddcb',
  'spec/domain-architecture-v4.md': '03bdac8338d06ddaa9d1d9b037942ea9684f0567',
  'spec/domain-architecture-v5.md': 'f51b107e12f484026aa31e38ec1cf041a660d7fd',
}
for (const [path, expected] of Object.entries(frozenBlobSha)) {
  const body = read(path)
  const bytes = Buffer.from(body, 'utf8')
  const blob = Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])
  const actual = createHash('sha1').update(blob).digest('hex')
  if (actual !== expected) fail(`historical architecture changed: ${path}`)
}

const v6Corpus = [architecture, lock, acr, inventory, v6, req, domainGraph, workItems, workGraph, hold]
if (v6Corpus.some((content) => /WorkflowOS/.test(content))) fail('WorkflowOS vocabulary detected in V6 architecture package')

const requirementIds = [...req.matchAll(/^## ([A-Z]+-\d+) —/gm)].map((m) => m[1])
const expectedRequirementIds = ['ARCH-001','NET-001','NET-002','NET-003','NET-004','COMP-001','COMP-002','COMP-003','ALLOC-001','ALLOC-002','ALLOC-003','DATA-001','DATA-002','TRUST-001','TRUST-002','TRUST-003','PKG-001','PKG-002','DIST-001','DIST-002','ECON-001','ECON-002','ECON-003','OPS-001','OBS-001','OBS-002','SDK-001','FED-001','REF-001','CONF-001']
if (requirementIds.length !== expectedRequirementIds.length) fail(`expected ${expectedRequirementIds.length} V6 requirements, found ${requirementIds.length}`)
for (const id of expectedRequirementIds) if (!requirementIds.includes(id)) fail(`missing V6 requirement ${id}`)
if (!req.includes('Architecture Version: `IAAS-DOM-ARCH-6`')) fail('V6 requirement document does not declare its architecture version')
if (!req.includes('Dependencies:')) fail('V6 requirements must declare dependencies')
if (!req.includes('Acceptance Criteria:')) fail('V6 requirements must declare acceptance criteria')
if (!req.includes('Verification:')) fail('V6 requirements must declare verification requirements')

const workItemIds = [...workItems.matchAll(/^## (WORK-\d+) —/gm)].map((m) => m[1])
const expectedWorkIds = Array.from({ length: 19 }, (_, i) => `WORK-${String(i + 23).padStart(3, '0')}`)
if (workItemIds.length !== expectedWorkIds.length) fail(`expected 19 V6 Work Items, found ${workItemIds.length}`)
for (const id of expectedWorkIds) {
  if (!workItemIds.includes(id)) fail(`missing V6 Work Item ${id}`)
  const start = workItems.indexOf(`## ${id} —`)
  const next = workItems.indexOf('\n## WORK-', start + 4)
  const section = workItems.slice(start, next < 0 ? workItems.length : next)
  if (!section.includes('Status: `DRAFT`')) fail(`${id} is not DRAFT during V6 review`)
  for (const field of ['Architecture Version:','Requirements:','Dependencies:','Architecture Constraints:','Repository Scope:','Out of Scope:','Acceptance Criteria:','Required Verification:','Definition of Done:']) if (!section.includes(field)) fail(`${id} missing required Work Item field ${field}`)
}

const edgeMatches = [...workGraph.matchAll(/^(WORK-\d+) → (WORK-\d+)$/gm)].map((m) => [m[1], m[2]] as const)
const graph = new Map<string, string[]>()
for (const [from, to] of edgeMatches) graph.set(from, [...(graph.get(from) ?? []), to])
const visiting = new Set<string>(); const visited = new Set<string>()
const visit = (node: string): void => { if (visiting.has(node)) fail(`cycle in V6 Work Item DAG at ${node}`); if (visited.has(node)) return; visiting.add(node); for (const child of graph.get(node) ?? []) visit(child); visiting.delete(node); visited.add(node) }
for (const id of expectedWorkIds) visit(id)

for (const forbidden of ['Kernel ✗-> vertical services','Kernel ✗-> Marketplace','Kernel ✗-> EconomicPipeline','Kernel ✗-> DataPlane services','EconomicPipeline ✗-> DataPlane','DataPlane ✗-> EconomicPipeline','InfrastructureRuntime ✗-> ProtocolRuntime','ProtocolRuntime ✗-> InfrastructureRuntime','Marketplace ✗-> Extension execution','SDK ✗-> private persistence semantics','Telemetry ✗-> automatic attestation']) if (!domainGraph.includes(forbidden) && !v6.includes(forbidden)) fail(`missing forbidden dependency invariant: ${forbidden}`)

if (!hold.includes('no production Work Order may be assigned, implemented, or opened as an active PR')) fail('implementation hold is missing')
if (!workItems.includes('Status: `DRAFT`')) fail('V6 Work Item program is not draft-gated')
if (!inventory.includes('Federation') || !inventory.includes('OPEN / RESEARCH')) fail('federation research classification missing')
if (!inventory.includes('NodeAgent') || !inventory.includes('reject mandatory')) fail('NodeAgent rejection decision missing')
if (!v6.includes('No component may silently acquire a second ownership role for a listed responsibility') && !acr.includes("No component may own another component's authoritative state merely because it consumes it.")) fail('V6 authority ownership rule missing')

process.stdout.write('V6 ARCHITECTURE VALIDATOR: PASS — immutable main baseline and candidate package are internally consistent and implementation-gated.\n')
