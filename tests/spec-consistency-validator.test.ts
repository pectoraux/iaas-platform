/// <reference types="bun-types" />
// WORK-001 specification-consistency regression suite.
// Kept intentionally deterministic and dependency-free.
import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = process.cwd()
const VALIDATOR = join(ROOT, 'scripts', 'spec-validator.ts')
const SPEC = join(ROOT, 'spec')
const tempDirs: string[] = []

afterAll(() => tempDirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))

function copySpec(): string {
  const root = mkdtempSync(join(tmpdir(), 'iaas-spec-'))
  tempDirs.push(root)
  const out = join(root, 'spec')
  cpSync(SPEC, out, { recursive: true })
  return out
}

function run(specDir: string) {
  const result = spawnSync(process.execPath, [VALIDATOR, '--spec-dir', specDir], { encoding: 'utf8', env: process.env })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function rewrite(specDir: string, file: string, fn: (text: string) => string) {
  const path = join(specDir, file)
  writeFileSync(path, fn(readFileSync(path, 'utf8')))
}

function expectFailure(specDir: string, check: string) {
  const result = run(specDir)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain('SPEC VALIDATION FAILED')
  expect(result.stderr).toContain(`[${check}]`)
}

describe('spec validator — current repository', () => {
  test('passes deterministically with the V5 / 22-item specification', () => {
    const a = run(SPEC)
    const b = run(SPEC)
    expect(a.code).toBe(0)
    expect(b.code).toBe(0)
    expect(a.stderr).toBe('')
    expect(a.stdout).toContain('SPEC VALIDATION PASSED')
    expect(a.stdout).toContain('domain-architecture=IAAS-DOM-ARCH-4')
    expect(a.stdout).toContain('work-items=22')
    expect(a.stdout).toContain('dependency-edges=21')
    expect(a.stdout).toBe(b.stdout)
  })
})

describe('spec validator — mandatory negative cases', () => {
  test('missing required file is rejected', () => {
    const s = copySpec()
    unlinkSync(join(s, 'requirements.md'))
    expectFailure(s, 'SC-01')
  })

  test('unresolved dependency is rejected', () => {
    const s = copySpec()
    rewrite(s, 'work-items.md', x => x.replace('Dependencies: `WORK-017`', 'Dependencies: `WORK-999`'))
    expectFailure(s, 'SC-09')
  })

  test('malformed architecture version is rejected', () => {
    const s = copySpec()
    rewrite(s, 'work-items.md', x => x.replace('Architecture Version: `IAAS-GOV-ARCH-1`', 'Architecture Version: broken'))
    expectFailure(s, 'SC-05')
  })

  test('missing WORK-001 acceptance criterion is rejected', () => {
    const s = copySpec()
    rewrite(s, 'work-items.md', x => x.replace('- `W001-AC07` verification evidence maps to acceptance criteria.\n', ''))
    expectFailure(s, 'SC-07')
  })

  test('WORK-001 production scope is rejected', () => {
    const s = copySpec()
    rewrite(s, 'work-items.md', x => x.replace('Repository Scope: `spec/` governance documents and its executable consistency gate.', 'Repository Scope: `spec/` plus production services and prisma migrations.'))
    expectFailure(s, 'SC-15')
  })

  test('dependency cycle is rejected', () => {
    const s = copySpec()
    rewrite(s, 'work-items.md', x => x.replace('Dependencies: none', 'Dependencies: `WORK-017`'))
    expectFailure(s, 'SC-10')
  })

  test('WORK-022 cannot be READY when its dependency is not VERIFIED', () => {
    const s = copySpec()
    rewrite(s, 'work-items.md', x => x.replace('## WORK-021 — WASI Sandbox Host Foundation\nStatus: `VERIFIED`', '## WORK-021 — WASI Sandbox Host Foundation\nStatus: `READY`'))
    expectFailure(s, 'SC-11')
  })

  test('truth classification is required', () => {
    const s = copySpec()
    rewrite(s, 'requirements.md', x => x.replace(/OBSERVED/g, ''))
    expectFailure(s, 'SC-12')
  })
})

describe('V5 / WORK-021 and WORK-022 governance invariants', () => {
  test('V5 is frozen, WORK-021 is verified, and WORK-022 is released', () => {
    const items = readFileSync(join(SPEC, 'work-items.md'), 'utf8')
    const order = readFileSync(join(SPEC, 'work-orders', 'WORK-022.md'), 'utf8')
    expect(items).toContain('## WORK-021 — WASI Sandbox Host Foundation')
    expect(items).toContain('Status: `VERIFIED`')
    expect(items).toContain('Dependencies: `WORK-020`')
    expect(items).toContain('## WORK-022 — Sandbox Lifecycle Completion')
    expect(items).toContain('Status: `READY`')
    expect(items).toContain('Dependencies: `WORK-021`')
    expect(order).toContain('`READY`')
    expect(order).toContain('`IAAS-DOM-ARCH-5`')
    expect(order).toContain('`WORK-021`')
    expect(order).toContain('lifecycle')
  })
})
