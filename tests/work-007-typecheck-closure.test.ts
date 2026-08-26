/// <reference types="bun-types" />
// =============================================================================
// WORK-007 — Typecheck Residual Closure regression tests
// =============================================================================
// Verifies BASE-011 (baselineEngine type safety), BASE-012 (explicit TS
// project boundaries), BASE-013 (no silent exclusion), and BASE-014 (clean
// IAAS application typecheck).
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = process.cwd()

// ---------------------------------------------------------------------------
// W007-AC02 — baselineEngine type safety (BASE-011)
// ---------------------------------------------------------------------------

describe('WORK-007 — baselineEngine type safety (W007-AC02, BASE-011)', () => {
  test('vpp.service.ts uses a static import type for BaselineContext (no runtime namespace)', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'src', 'lib', 'services', 'vpp.service.ts'),
      'utf8',
    )
    // The fix: a static `import type { BaselineContext }` at module scope.
    expect(src).toMatch(/import type \{ BaselineContext \} from '\.\/baseline-engine\.service'/)
    // The broken pattern (using a runtime const as a type namespace) must be gone.
    expect(src).not.toMatch(/type BaselineContext = baselineEngine\.BaselineContext/)
    // The dynamic import is still present (runtime behavior preserved).
    expect(src).toMatch(/const baselineEngine = await import\('\.\/baseline-engine\.service'\)/)
    expect(src).toMatch(/const getStrategy = baselineEngine\.getStrategy/)
    // BaselineContext is used as a type annotation (not erased).
    expect(src).toMatch(/const baselineContext: BaselineContext/)
  })

  test('baseline-engine.service.ts exports the BaselineContext interface', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'src', 'lib', 'services', 'baseline-engine.service.ts'),
      'utf8',
    )
    expect(src).toMatch(/export interface BaselineContext/)
  })

  test('no @ts-ignore, @ts-expect-error, or any suppression near the baselineEngine import', () => {
    const src = readFileSync(
      join(REPO_ROOT, 'src', 'lib', 'services', 'vpp.service.ts'),
      'utf8',
    )
    // No suppression in the entire file.
    expect(src).not.toMatch(/@ts-ignore/)
    expect(src).not.toMatch(/@ts-expect-error/)
    // No `any` cast on the baselineEngine import.
    expect(src).not.toMatch(/baselineEngine as any/)
    expect(src).not.toMatch(/baselineEngine as unknown/)
  })
})

// ---------------------------------------------------------------------------
// W007-AC03/AC04 — explicit TypeScript project boundaries (BASE-012, BASE-013)
// ---------------------------------------------------------------------------

describe('WORK-007 — TypeScript project boundaries (W007-AC03, W007-AC04, BASE-012, BASE-013)', () => {
  test('root tsconfig.json explicitly excludes examples/ and skills/', () => {
    const src = readFileSync(join(REPO_ROOT, 'tsconfig.json'), 'utf8')
    expect(src).toContain('"examples"')
    expect(src).toContain('"skills"')
  })

  test('examples/ has its own tsconfig.json (explicit project boundary)', () => {
    expect(existsSync(join(REPO_ROOT, 'examples', 'tsconfig.json'))).toBe(true)
    const src = readFileSync(join(REPO_ROOT, 'examples', 'tsconfig.json'), 'utf8')
    // Must declare itself as a standalone project, not part of the IAAS app.
    expect(src).toContain('compilerOptions')
    expect(src).toContain('include')
  })

  test('skills/ has its own tsconfig.json (explicit project boundary)', () => {
    expect(existsSync(join(REPO_ROOT, 'skills', 'tsconfig.json'))).toBe(true)
    const src = readFileSync(join(REPO_ROOT, 'skills', 'tsconfig.json'), 'utf8')
    expect(src).toContain('compilerOptions')
    // stock-analysis-skill has its own project; excluded from the skills-level config.
    expect(src).toContain('stock-analysis-skill')
  })

  test('skills/stock-analysis-skill has its own standalone tsconfig + package.json', () => {
    expect(existsSync(join(REPO_ROOT, 'skills', 'stock-analysis-skill', 'tsconfig.json'))).toBe(true)
    expect(existsSync(join(REPO_ROOT, 'skills', 'stock-analysis-skill', 'package.json'))).toBe(true)
  })

  test('the exclusion is explained, not a silent broad exclude', () => {
    // BASE-013: any exclusion must correspond to an explicit project-boundary
    // decision. The examples/tsconfig.json and skills/tsconfig.json serve as
    // the explicit documentation of the boundary.
    const examplesConfig = readFileSync(join(REPO_ROOT, 'examples', 'tsconfig.json'), 'utf8')
    const skillsConfig = readFileSync(join(REPO_ROOT, 'skills', 'tsconfig.json'), 'utf8')
    // Both must contain a "//" field documenting the boundary decision.
    expect(examplesConfig).toContain('WORK-007')
    expect(examplesConfig).toContain('Explicit TypeScript project boundary')
    expect(skillsConfig).toContain('WORK-007')
    expect(skillsConfig).toContain('Explicit TypeScript project boundary')
  })
})

// ---------------------------------------------------------------------------
// W007-AC05 — IAAS application typecheck is clean (BASE-014)
// ---------------------------------------------------------------------------

describe('WORK-007 — clean IAAS application typecheck (W007-AC05, BASE-014)', () => {
  test('bunx tsc --noEmit exits 0 with no errors', () => {
    const result = spawnSync('bunx', ['tsc', '--noEmit'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60000,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('error TS')
    expect(result.stderr).not.toContain('error TS')
  })
})
