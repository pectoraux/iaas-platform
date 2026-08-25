/// <reference types="bun-types" />
// =============================================================================
// WORK-001 — One-Active-PR Invariant Check: Negative Tests (AR-002)
// =============================================================================
// These tests prove that scripts/pr-invariant-check.ts actually establishes
// the W001-AC09 / GOV-005 / frozen-rule-8 invariant ("a Work Item has at
// most one active implementation PR") instead of passing vacuously:
//
//   - it FAILS (exit 1) when two open PRs reference the same Work Item,
//     including branch-only references;
//   - it PASSES (exit 0) for zero, one-per-Work-Item, and unattributed PRs;
//   - it FAILS CLOSED (exit 2) when the invariant cannot be established:
//     missing fixture, malformed fixture, malformed entries, missing --repo,
//     or an unreachable GitHub API — an unestablishable invariant is a
//     failure, never a skip (Architect Review correction AR-002/AR-003
//     fail-closed discipline).
//
// Live GitHub state is replaced by JSON fixtures via `--fixture`, and the
// unreachable-API case uses a closed local port via `--api-base`, so the
// suite is deterministic and offline.
// =============================================================================

import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()
const CHECK = join(REPO_ROOT, 'scripts', 'pr-invariant-check.ts')

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

interface CheckResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

/** Run the invariant check as a subprocess with the given arguments. */
function runCheck(
  args: string[],
  env: Record<string, string> = {},
  options: { cwd?: string } = {},
): CheckResult {
  const result = spawnSync(process.execPath, [CHECK, ...args], {
    encoding: 'utf8',
    cwd: options.cwd,
    env: { ...process.env, ...env },
  })
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

interface FixturePr {
  number: number
  title: string
  head?: string | { ref: string } | null
}

/** Write a fixture file with the given pull-request entries. */
function writeFixture(entries: FixturePr[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'iaas-pr-invariant-'))
  tempDirs.push(dir)
  const path = join(dir, 'pulls.json')
  writeFileSync(path, JSON.stringify(entries, null, 2))
  return path
}

/** Write a fixture file with arbitrary (possibly invalid) content. */
function writeRawFixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'iaas-pr-invariant-'))
  tempDirs.push(dir)
  const path = join(dir, 'pulls.json')
  writeFileSync(path, content)
  return path
}

function expectFailClosed(result: CheckResult, fragment: string): void {
  expect(result.exitCode).toBe(2)
  expect(result.stderr).toContain('PR INVARIANT CHECK ERROR (fail-closed)')
  expect(result.stderr).toContain(fragment)
}

// ---------------------------------------------------------------------------
// Invariant violation cases (exit 1).
// ---------------------------------------------------------------------------

describe('one-active-PR invariant check — violation cases', () => {
  test('fails when two open PRs reference the same Work Item (W001-AC09)', () => {
    const fixture = writeFixture([
      { number: 3, title: 'WORK-001: establish governance foundation', head: 'work-001-governance-clean' },
      { number: 7, title: 'WORK-001: alternative governance approach', head: 'work-001-alternative' },
    ])
    const result = runCheck(['--fixture', fixture])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('PR INVARIANT FAILED')
    expect(result.stdout).toContain(
      'Work Item WORK-001 has 2 active implementation PRs (#3, #7); at most one is allowed',
    )
  })

  test('fails on branch-only references when titles carry no Work Item ID', () => {
    const fixture = writeFixture([
      { number: 3, title: 'Governance foundation', head: 'work-001-governance-clean' },
      { number: 8, title: 'Another governance change', head: 'work-001-cleanup' },
    ])
    const result = runCheck(['--fixture', fixture])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('PR INVARIANT FAILED')
    expect(result.stdout).toContain('Work Item WORK-001 has 2 active implementation PRs (#3, #8)')
  })

  test('fails when one PR is attributed via title and another via branch', () => {
    const fixture = writeFixture([
      { number: 4, title: 'WORK-001: governance', head: 'feature/misc' },
      { number: 5, title: 'Unrelated title', head: 'work-001-governance-fix' },
    ])
    const result = runCheck(['--fixture', fixture])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('Work Item WORK-001 has 2 active implementation PRs (#4, #5)')
  })

  test('does not misattribute non-work-item wording (e.g. “network-12”)', () => {
    const fixture = writeFixture([
      { number: 3, title: 'WORK-001: governance foundation', head: 'work-001-governance-clean' },
      { number: 9, title: 'Refactor network-12 transport pooling', head: 'refactor/network-12' },
    ])
    const result = runCheck(['--fixture', fixture])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('WORK-001: active-prs=1 (pr=#3)')
    expect(result.stdout).toContain('unattributed-open-prs=1')
  })
})

// ---------------------------------------------------------------------------
// Passing cases (exit 0) — the invariant holds.
// ---------------------------------------------------------------------------

describe('one-active-PR invariant check — passing cases', () => {
  test('passes when a single PR references one Work Item', () => {
    const fixture = writeFixture([
      { number: 3, title: 'WORK-001: establish governance foundation', head: 'work-001-governance-clean' },
    ])
    const result = runCheck(['--fixture', fixture])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('PR INVARIANT PASSED')
    expect(result.stdout).toContain('open-prs=1 work-items-with-active-prs=1 unattributed-open-prs=0')
    expect(result.stdout).toContain('WORK-001: active-prs=1 (pr=#3)')
  })

  test('passes when different Work Items each have exactly one PR', () => {
    const fixture = writeFixture([
      { number: 3, title: 'WORK-001: governance foundation', head: 'work-001-governance-clean' },
      { number: 12, title: 'WORK-002: repository baseline', head: 'work-002-baseline' },
    ])
    const result = runCheck(['--fixture', fixture])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('WORK-001: active-prs=1 (pr=#3)')
    expect(result.stdout).toContain('WORK-002: active-prs=1 (pr=#12)')
  })

  test('passes with zero open PRs', () => {
    const fixture = writeFixture([])
    const result = runCheck(['--fixture', fixture])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('open-prs=0 work-items-with-active-prs=0 unattributed-open-prs=0')
  })

  test('reports unattributed open PRs without failing the invariant', () => {
    const fixture = writeFixture([
      { number: 3, title: 'WORK-001: establish governance foundation', head: 'work-001-governance-clean' },
      { number: 1, title: 'Phase 12B Slice 6: durable economic reconciliation hardening', head: 'phase-12b-slice-6-reconciliation-hardening' },
    ])
    const result = runCheck(['--fixture', fixture])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('open-prs=2 work-items-with-active-prs=1 unattributed-open-prs=1')
    expect(result.stdout).toContain('WORK-001: active-prs=1 (pr=#3)')
  })

  test('accepts GitHub API-shaped fixtures (head as {ref: ...} object)', () => {
    const fixture = writeFixture([
      { number: 3, title: 'WORK-001: establish governance foundation', head: { ref: 'work-001-governance-clean' } },
    ])
    const result = runCheck(['--fixture', fixture])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('WORK-001: active-prs=1 (pr=#3)')
  })

  test('accepts {"pulls": [...} object fixtures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iaas-pr-invariant-'))
    tempDirs.push(dir)
    const path = join(dir, 'pulls.json')
    writeFileSync(
      path,
      JSON.stringify({ pulls: [{ number: 3, title: 'WORK-001: governance', head: 'work-001-governance-clean' }] }),
    )
    const result = runCheck(['--fixture', path])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('WORK-001: active-prs=1 (pr=#3)')
  })
})

// ---------------------------------------------------------------------------
// Fail-closed cases (exit 2) — the invariant could not be established.
// ---------------------------------------------------------------------------

describe('one-active-PR invariant check — fail-closed cases', () => {
  test('fails closed when the fixture file is missing', () => {
    const result = runCheck(['--fixture', join(tmpdir(), 'iaas-pr-invariant-does-not-exist.json')])
    expectFailClosed(result, 'cannot read fixture')
  })

  test('fails closed when the fixture is not valid JSON', () => {
    const fixture = writeRawFixture('this is not json {{{')
    const result = runCheck(['--fixture', fixture])
    expectFailClosed(result, 'is not valid JSON')
  })

  test('fails closed when the fixture has an invalid shape', () => {
    const fixture = writeRawFixture(JSON.stringify({ something: 'else' }))
    const result = runCheck(['--fixture', fixture])
    expectFailClosed(result, 'must be a JSON array of pull requests')
  })

  test('fails closed when a fixture entry is malformed', () => {
    const fixture = writeRawFixture(JSON.stringify([{ number: 'three', title: 'WORK-001: x' }]))
    const result = runCheck(['--fixture', fixture])
    expectFailClosed(result, 'no integer "number" field')
  })

  test('fails closed when --repo is omitted for live verification', () => {
    const result = runCheck([])
    expectFailClosed(result, '--repo is required for live GitHub-state verification')
  })

  test('fails closed when --repo is not <owner>/<name>', () => {
    const result = runCheck(['--repo', 'not-a-repo-spec'])
    expectFailClosed(result, '--repo must be <owner>/<name>')
  })

  test('fails closed when the GitHub API is unreachable', () => {
    const result = runCheck(['--repo', 'pectoraux/iaas-platform', '--api-base', 'http://127.0.0.1:9'], {
      GITHUB_TOKEN: 'dummy-token-for-negative-test',
    })
    expectFailClosed(result, 'GitHub API request failed')
  })

  test('fails closed when no GitHub token is available', () => {
    // Run outside any git repository and with an empty GITHUB_TOKEN so no
    // credential can be resolved (neither env nor `origin` remote) before
    // any network attempt. This is deterministic in every environment.
    const outsideGit = mkdtempSync(join(tmpdir(), 'iaas-pr-invariant-nogit-'))
    tempDirs.push(outsideGit)
    const result = runCheck(['--repo', 'pectoraux/iaas-platform'], { GITHUB_TOKEN: '' }, {
      cwd: outsideGit,
    })
    expectFailClosed(result, 'no GitHub token available')
  })
})
