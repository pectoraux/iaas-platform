/// <reference types="bun-types" />
// =============================================================================
// WORK-001 — Specification Consistency Validator: Negative Tests
// =============================================================================
// These tests prove that the executable specification validator rejects
// representative specification inconsistencies and passes the current
// authoritative IAAS specification.
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
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

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

function runValidator(specDir: string): ValidatorResult {
  const result = spawnSync(process.execPath, [VALIDATOR, '--spec-dir', specDir], {
    encoding: 'utf8',
    env: process.env,
  })
  return { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
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

describe('spec consistency validator — positive case', () => {
  test('passes against the repository specification with a deterministic success message', () => {
    const first = runValidator(SPEC_DIR)
    expect(first.exitCode).toBe(0)
    expect(first.stdout).toContain('SPEC VALIDATION PASSED')
    expect(first.stdout).toContain('architecture=IAAS-GOV-ARCH-1')
    expect(first.stdout).toContain('domain-architecture=IAAS-DOM-ARCH-4')
    expect(first.stdout).toContain('required-files=13')
    expect(first.stdout).toContain('work-items=16')
    expect(first.stdout).toContain('work-item-schema-fields=11')
    expect(first.stdout).toContain('work001-acceptance-criteria=13')
    expect(first.stdout).toContain('dependency-edges=15')
    expect(first.stdout).toContain('checks=20')
    expect(first.stderr).toBe('')
    const second = runValidator(SPEC_DIR)
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toBe(first.stdout)
  })
})

describe('spec consistency validator — negative cases (WORK-001 Required Tests)', () => {
  test('fails when a required spec file is missing (SC-01)', () => {
    const specDir = makeTempSpecCopy()
    unlinkSync(join(specDir, 'requirements.md'))
    expectFailure(runValidator(specDir), 'SC-01', 'missing required specification file: spec/requirements.md')
  })

  test('fails when a Work Item dependency is unresolved (SC-09)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'work-items.md', c => c.replace('Dependencies: `WORK-001`', 'Dependencies: `WORK-099`'))
    expectFailure(runValidator(specDir), 'SC-09', 'WORK-002 declares unresolved dependency: WORK-099')
  })

  test('fails when a Work Item does not declare an architecture version (SC-05)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'work-items.md', c => c.replace('Architecture Version: `IAAS-GOV-ARCH-1`', 'Architecture Version: none'))
    expectFailure(runValidator(specDir), 'SC-05', 'Work Item WORK-001 declares a malformed architecture version')
  })

  test('fails when the frozen governance architecture version is inconsistent between documents (SC-03)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'architecture-lock.md', c => c.replace('`IAAS-GOV-ARCH-1`', '`IAAS-GOV-ARCH-2`'))
    expectFailure(runValidator(specDir), 'SC-03', 'governance architecture version inconsistent')
  })

  test('fails when the governance architecture version is malformed (SC-03)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'architecture-lock.md', c => c.replace('Governance Architecture Version: `IAAS-GOV-ARCH-1`', 'Governance Architecture Version: `governance-version-final`'))
    expectFailure(runValidator(specDir), 'SC-03', 'malformed governance architecture version')
  })

  test('fails when a required WORK-001 acceptance criterion is missing (SC-07)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'work-items.md', c => c.replace('- `W001-AC07` verification evidence maps to ACs.\n', ''))
    expectFailure(runValidator(specDir), 'SC-07', 'missing required WORK-001 acceptance criteria: W001-AC07')
  })

  test('fails on duplicate WORK-001 acceptance criterion IDs (SC-07)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'work-items.md', c => c.replace('- `W001-AC07` verification evidence maps to ACs.', '- `W001-AC07` verification evidence maps to ACs.\n- `W001-AC07` duplicated criterion.'))
    expectFailure(runValidator(specDir), 'SC-07', 'duplicate WORK-001 acceptance criterion ID: W001-AC07')
  })

  test('fails when WORK-001 declares forbidden production scope (SC-15)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'work-items.md', c => c.replace('Repository Scope: `spec/` governance documents and their executable consistency gate.', 'Repository Scope: `spec/`, `prisma/schema.prisma`, and production services.'))
    expectFailure(runValidator(specDir), 'SC-15', "WORK-001 'Repository Scope' declares forbidden production implementation scope")
  })

  test('fails when the WORK-001 production freeze is removed from requirements (SC-15)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'requirements.md', c => c.replace('No production IAAS feature is authorized by these requirements.', ''))
    expectFailure(runValidator(specDir), 'SC-15', 'no production IAAS feature is authorized')
  })

  test('fails when the dependency graph contains a cycle (SC-10)', () => {
    const specDir = makeTempSpecCopy()
    rewrite(specDir, 'work-items.md', c => c.replace('Dependencies: none', 'Dependencies: `WORK-002`'))
    expectFailure(runValidator(specDir), 'SC-10', 'cycle')
  })
})
