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
  test('passes deterministically with the V4 / 17-item specification', () => {
    const a = run(SPEC)
    const b = run(SPEC)
    expect(a.code).toBe(0)
    expect(b.code).toBe(0)
    expect(a.stderr).toBe('')
    expect(a.stdout).toContain('SPEC VALIDATION PASSED')
    expect(a.stdout).toContain('domain-architecture=IAAS-DOM-ARCH-4')
    expect(a.stdout).toContain('work-items=17')
    expect(a.stdout).toContain('dependency-edges=16')
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
    rewrite(s, 'work-items.md', x => x.replace('Dependencies: `WORK-015`', 'Dependencies: `WORK-999`'))
    expectFailure(s, 'SC-09')
  })

  test('malformed architecture version is rejected', () => {
    const s = copySpec()
    rewrite(s, 'work-items.md', x => x.replace('Architecture Version: `IAAS-GOV-ARCH-1`', 'Architecture Version: broken'))
    expectFailure(s, 'SC-05')
  })

  test('missing WORK-001 acceptance criterion is rejected', () => {
    const s = copySpec()
    rewrite(s, 'work-items.md', x => x.replace('- `W001-AC07` verification evidence maps to ACs.\n', ''))
    expectFailure(s, 'SC-07')
  })

  test('WORK-001 production scope is rejected', () => {
    const s = copySpec()
    rewrite(s, 'work-items.md', x => x.replace('Repository Scope: `spec/` governance documents and their executable consistency gate.', 'Repository Scope: `spec/` plus production services and prisma migrations.'))
    expectFailure(s, 'SC-15')
  })

  test('dependency cycle is rejected', () => {
    const s = copySpec()
    rewrite(s, 'work-items.md', x => x.replace('Dependencies: none', 'Dependencies: `WORK-017`'))
    expectFailure(s, 'SC-10')
  })

  test('WORK-017 cannot be READY when its dependency is not VERIFIED', () => {
    const s = copySpec()
    rewrite(s, 'work-items.md', x => x.replace('## WORK-016 — ExtensionRegistry Implementation\nStatus: `VERIFIED`', '## WORK-016 — ExtensionRegistry Implementation\nStatus: `READY`'))
    expectFailure(s, 'SC-11')
  })

  test('truth classification is required', () => {
    const s = copySpec()
    rewrite(s, 'requirements.md', x => x.replace(/OBSERVED/g, ''))
    expectFailure(s, 'SC-12')
  })
})

describe('V4 / WORK-017 governance invariants', () => {
  test('DOM-020 is frozen and WORK-017 is released', () => {
    const items = readFileSync(join(SPEC, 'work-items.md'), 'utf8')
    const order = readFileSync(join(SPEC, 'work-orders', 'WORK-017.md'), 'utf8')
    expect(items).toContain('## WORK-017 — ExtensionRuntime Implementation')
    expect(items).toContain('Status: `READY`')
    expect(items).toContain('Dependencies: `WORK-016`')
    expect(order).toContain('`RELEASED`')
    expect(order).toContain('`IAAS-DOM-ARCH-4` (FROZEN)')
    expect(order).toContain('`WORK-016` VERIFIED')
    expect(order).toContain('do not implement durable provenance storage')
    expect(order).toContain('sandbox technology')
  })
})
