/// <reference types="bun-types" />
// =============================================================================
// WORK-001 — Specification Consistency Validator: Negative Tests
// =============================================================================
// These tests prove that the executable specification validator
// (scripts/spec-validator.ts) rejects representative specification
// inconsistencies instead of passing vacuously. They implement the
// "Required Tests" section of spec/work-orders/WORK-001.md:
//
//   1. validator passes against the repository's current specification
//   2. validator fails when a required spec file is missing
//   3. validator fails when a required Work Item dependency is unresolved
//   4. validator fails on a malformed/missing architecture version
//   5. validator fails when a required WORK-001 acceptance criterion is missing
//   6. validator fails if WORK-001 includes forbidden production scope
//
// plus additional negative cases (dependency cycle, eligibility violation,
// duplicate acceptance criterion IDs, truth-classification removal, and ACR
// protocol corruption).
//
// Each negative test copies spec/ into a fresh temporary directory, applies a
// targeted mutation, and runs the validator as a subprocess against the
// mutated copy via `--spec-dir`, asserting a non-zero exit code and the
// expected check ID in the failure diagnostics.
// =============================================================================

import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()
const VALIDATOR = join(REPO_ROOT, 'scripts', 'spec-validator.ts')
const SPEC_DIR = join(REPO_ROOT, 'spec')

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup of temp directories
    }
  }
})

/** Copy the real spec/ into a fresh temporary directory and return its path. */
function makeTempSpecCopy(): string {
  const root = mkdtempSync(join(tmpdir(), 'iaas-spec-validation-'))
  tempDirs.push(root)
  const specCopy = join(root, 'spec')
  cpSync(SPEC_DIR, specCopy, { recursive: true })
  return specCopy
}

interface ValidatorResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

/** Run the validator as a subprocess against the given spec directory. */
function runValidator(specDir: string): ValidatorResult {
  const result = spawnSync(process.execPath, [VALIDATOR, '--spec-dir', specDir], {
    encoding: 'utf8',
    env: process.env,
  })
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function rewrite(specDir: string, file: string, mutate: (content: string) => string): void {
  const path = join(specDir, file)
  writeFileSync(path, mutate(readFileSync(path, 'utf8')))
}

function expectFailure(result: ValidatorResult, checkId: string, fragment: string): void {
  expect(result.exitCode).not.toBe(0)
  expect(result.exitCode).not.toBe(null)
  expect(result.stderr).toContain('SPEC VALIDATION FAILED')
  expect(result.stderr).toContain(`[${checkId}]`)
  expect(result.stderr).toContain(fragment)
}

// ---------------------------------------------------------------------------
// Positive case — the repository's current specification must pass.
// ---------------------------------------------------------------------------

describe('spec consistency validator — positive case', () => {
  test('passes against the repository specification with a deterministic success message', () => {
    const first = runValidator(SPEC_DIR)
    expect(first.exitCode).toBe(0)
    expect(first.stdout).toContain('SPEC VALIDATION PASSED')
    expect(first.stdout).toContain('architecture=IAAS-GOV-ARCH-1')
    expect(first.stdout).toContain('required-files=10')
    expect(first.stdout).toContain('work-items=2')
    expect(first.stdout).toContain('work001-acceptance-criteria=13')
    expect(first.stdout).toContain('dependency-edges=1')
    expect(first.stdout).toContain('checks=16')
    expect(first.stderr).toBe('')

    // Determinism: a second run must produce byte-identical output.
    const second = runValidator(SPEC_DIR)
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toBe(first.stdout)
  })
})

// ---------------------------------------------------------------------------
// Negative cases — each targets one Required Test from the Work Order.
// ---------------------------------------------------------------------------

describe('spec consistency validator — negative cases (WORK-001 Required Tests)', () => {
  // Required Test: validator fails when a required spec file is missing.
  test('fails when a required spec file is missing (SC-01)', () => {
    const specDir = makeTempSpecCopy()
    unlinkSync(join(specDir, 'requirements.md'))
    const result = runValidator(specDir)
    expectFailure(result, 'SC-01', 'missing required specification file: spec/requirements.md')
  })

  // Required Test: validator fails when a required Work Item dependency is
  // unresolved.
  test('fails when a Work Item dependency is unresolved (SC-09)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'work-items.md', (content) =>
      content.replace('Dependencies: `WORK-001`', 'Dependencies: `WORK-099`'),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-09', 'WORK-002 declares unresolved dependency: WORK-099')
  })

  // Required Test: validator fails on a malformed/missing architecture version.
  test('fails when a Work Item does not declare an architecture version (SC-05)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'work-items.md', (content) =>
      content.replace('Architecture Version: `IAAS-GOV-ARCH-1`', 'Architecture Version: none'),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-05', 'Work Item WORK-001 declares a malformed architecture version')
  })

  test('fails when the frozen governance architecture version is inconsistent between documents (SC-03)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'architecture-lock.md', (content) =>
      content.replace('`IAAS-GOV-ARCH-1`', '`IAAS-GOV-ARCH-2`'),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-03', 'governance architecture version inconsistent')
  })

  test('fails when the governance architecture version is malformed (SC-03)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'architecture-lock.md', (content) =>
      content.replace('Governance Architecture Version: `IAAS-GOV-ARCH-1`', 'Governance Architecture Version: `governance-version-final`'),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-03', 'malformed governance architecture version')
  })

  // Required Test: validator fails when a required WORK-001 acceptance
  // criterion is missing.
  test('fails when a required WORK-001 acceptance criterion is missing (SC-07)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'work-items.md', (content) =>
      content.replace('- `W001-AC07` verification evidence maps to ACs.\n', ''),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-07', 'missing required WORK-001 acceptance criteria: W001-AC07')
  })

  test('fails on duplicate WORK-001 acceptance criterion IDs (SC-07)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'work-items.md', (content) =>
      content.replace(
        '- `W001-AC07` verification evidence maps to ACs.',
        '- `W001-AC07` verification evidence maps to ACs.\n- `W001-AC07` duplicated criterion.',
      ),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-07', 'duplicate WORK-001 acceptance criterion ID: W001-AC07')
  })

  // Required Test: validator fails if WORK-001 includes forbidden production
  // scope.
  test('fails when WORK-001 declares forbidden production scope (SC-15)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'work-items.md', (content) =>
      content.replace(
        'Scope: `spec/` governance documents and their executable consistency gate.',
        'Scope: `spec/` governance documents, `prisma/schema.prisma` migrations, and production services.',
      ),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-15', "WORK-001 'Scope' declares forbidden production implementation scope")
  })

  test('fails when the WORK-001 production freeze is removed from requirements (SC-15)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'requirements.md', (content) =>
      content.replace('No production IAAS feature is authorized by these requirements.', ''),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-15', 'no production IAAS feature is authorized')
  })

  // Additional negative cases beyond the required minimum.
  test('fails when the dependency graph contains a cycle (SC-10)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'work-items.md', (content) =>
      content.replace('Dependencies: none', 'Dependencies: `WORK-002`'),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-10', 'dependency graph contains a cycle')
  })

  test('fails on a duplicate dependency edge in dependency-graph.md (SC-10)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'dependency-graph.md', (content) =>
      content.replace('WORK-001 -> WORK-002', 'WORK-001 -> WORK-002\nWORK-001 -> WORK-002'),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-10', 'duplicate dependency edge(s) in dependency-graph.md: WORK-001->WORK-002')
  })

  test('fails when a graph edge is not declared in work-items.md (SC-10)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'dependency-graph.md', (content) =>
      content.replace('WORK-001 -> WORK-002', 'WORK-001 -> WORK-002\nWORK-002 -> WORK-001'),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-10', 'dependency edge present in dependency-graph.md but not declared in work-items.md')
  })

  test('fails when WORK-002 is marked eligible before WORK-001 is VERIFIED (SC-11)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'work-items.md', (content) =>
      content.replace(
        'Status: `BLOCKED` until WORK-001 is VERIFIED.',
        'Status: `READY` until WORK-001 is VERIFIED.',
      ),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-11', 'not dependency-eligible')
  })

  test('fails when a required truth classification is removed (SC-12)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'architecture-lock.md', (content) =>
      content.replace(
        'Truth classifications are `OBSERVED`, `INFERRED`, `CONFIRMED`, `PROPOSED`.',
        'Truth classifications are `OBSERVED`, `INFERRED`, `PROPOSED`.',
      ),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-12', 'missing truth classification: CONFIRMED')
  })

  test('fails when the Architecture Change Request protocol is corrupted (SC-13)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'architecture-change-request.md', (content) =>
      content.replace('NEW ARCHITECTURE VERSION', 'NEW VERSION'),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-13', 'missing field: NEW ARCHITECTURE VERSION')
  })

  test('fails when the verification protocol loses the evidence/narrative distinction (SC-14)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'verification.md', (content) =>
      content.replace(
        'Agent narrative is contextual only and cannot establish PASS.',
        'Agent narrative may establish PASS when detailed enough.',
      ),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-14', 'agent narrative cannot establish PASS')
  })

  test('fails when a required Work Item field is missing (SC-06)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'work-items.md', (content) =>
      content.replace('Dependencies: none\n', ''),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-06', 'WORK-001 is missing required field: Dependencies')
  })

  test('fails when the persistent WORK-001 Work Order loses its verification gate (SC-16)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'work-orders/WORK-001.md', (content) =>
      content.replace('## Definition of Done', '## Completion Criteria'),
    )
    const result = runValidator(specDir)
    expectFailure(result, 'SC-16', 'missing required section: ## Definition of Done')
  })
})
