/// <reference types="bun-types" />
// =============================================================================
// WORK-004 — Runtime Registry Bootstrap Reliability tests
// =============================================================================
// Verifies BASE-001 (bootstrap resolution), BASE-002 (boundary preservation),
// BASE-003 (regression recovery), and W004-AC01…AC09.
//
// These tests are DB-free: they exercise the bootstrap/registry/runtime layer
// directly. The PostgreSQL integration tests (runtime-resolution-integration,
// phase-5-2, phase-8b, vpp-4-2) prove the same contract against persisted
// NetworkVersion rows in CI.
// =============================================================================

import { describe, expect, test, beforeAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { initializeBootstrap } from '../src/lib/bootstrap'
import { resolveRuntime, runtimeRegistry } from '../src/lib/kernel/runtime'
import { InfrastructureRuntime } from '../src/lib/kernel/runtime/infrastructure-runtime'
import { ProtocolRuntime } from '../src/lib/kernel/runtime/protocol-runtime'
import { HybridRuntime } from '../src/lib/kernel/runtime/hybrid-runtime'
import type { NetworkRuntime } from '../src/lib/kernel/runtime/types'

const REPO_ROOT = process.cwd()

beforeAll(() => {
  // WORK-004 (BASE-001): the test is its own composition root.
  initializeBootstrap()
})

// ---------------------------------------------------------------------------
// W004-AC01 / W004-AC02 — runtime resolution through the bootstrap path
// ---------------------------------------------------------------------------

describe('WORK-004 — runtime resolution through the bootstrap path (W004-AC01, W004-AC02)', () => {
  test('infrastructure runtime resolves through the intended bootstrap path (W004-AC01)', () => {
    const runtime = resolveRuntime('infrastructure')
    expect(runtime).toBeInstanceOf(InfrastructureRuntime)
  })

  test('protocol runtime resolves through the intended bootstrap path (W004-AC02)', () => {
    const runtime = resolveRuntime('protocol')
    expect(runtime).toBeInstanceOf(ProtocolRuntime)
  })

  test('hybrid runtime resolves through the intended bootstrap path', () => {
    const runtime = resolveRuntime('hybrid')
    expect(runtime).toBeInstanceOf(HybridRuntime)
  })

  test('resolveRuntime throws for an unregistered kind (no silent fallback)', () => {
    // The registry has exactly the 3 documented kinds. An unregistered kind
    // must throw — there is no silent fallback (BASE-001).
    expect(() => resolveRuntime('nonexistent' as never)).toThrow(/No runtime registered/)
  })

  test('the registry is non-empty after initializeBootstrap (BASE-001)', () => {
    // The pre-WORK-004 defect: the registry was empty because tests did not
    // call initializeBootstrap(). After WORK-004, the bootstrap path populates
    // all three runtimes.
    const infra = runtimeRegistry.resolve('infrastructure')
    const proto = runtimeRegistry.resolve('protocol')
    const hybrid = runtimeRegistry.resolve('hybrid')
    expect(infra).toBeDefined()
    expect(proto).toBeDefined()
    expect(hybrid).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// W004-AC03 — registry singleton/stability
// ---------------------------------------------------------------------------

describe('WORK-004 — registry singleton/stability (W004-AC03)', () => {
  test('repeated resolution of the same kind returns the same instance', () => {
    const first = resolveRuntime('infrastructure')
    const second = resolveRuntime('infrastructure')
    const third = resolveRuntime('infrastructure')
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  test('each kind resolves to a distinct instance', () => {
    const infra = resolveRuntime('infrastructure')
    const proto = resolveRuntime('protocol')
    const hybrid = resolveRuntime('hybrid')
    expect(infra).not.toBe(proto)
    expect(infra).not.toBe(hybrid)
    expect(proto).not.toBe(hybrid)
  })

  test('initializeBootstrap is idempotent (does not re-register or replace)', () => {
    const before = resolveRuntime('infrastructure')
    initializeBootstrap() // idempotent — no-op after first call
    const after = resolveRuntime('infrastructure')
    expect(after).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// W004-AC04 / W004-AC07 — frozen runtime architecture + isolation preserved
// ---------------------------------------------------------------------------

describe('WORK-004 — runtime isolation + vertical neutrality (W004-AC04, W004-AC07)', () => {
  const INFRA_SRC = readFileSync(
    join(REPO_ROOT, 'src', 'lib', 'kernel', 'runtime', 'infrastructure-runtime.ts'),
    'utf8',
  )
  const PROTO_SRC = readFileSync(
    join(REPO_ROOT, 'src', 'lib', 'kernel', 'runtime', 'protocol-runtime.ts'),
    'utf8',
  )
  const HYBRID_SRC = readFileSync(
    join(REPO_ROOT, 'src', 'lib', 'kernel', 'runtime', 'hybrid-runtime.ts'),
    'utf8',
  )
  const BOOTSTRAP_SRC = readFileSync(
    join(REPO_ROOT, 'src', 'lib', 'bootstrap', 'index.ts'),
    'utf8',
  )
  const REGISTRY_SRC = readFileSync(
    join(REPO_ROOT, 'src', 'lib', 'kernel', 'runtime', 'index.ts'),
    'utf8',
  )

  test('InfrastructureRuntime does NOT import ProtocolRuntime (isolation)', () => {
    expect(INFRA_SRC).not.toMatch(/from\s+['"][^'"]*protocol-runtime['"]/)
  })

  test('ProtocolRuntime does NOT import InfrastructureRuntime (isolation)', () => {
    expect(PROTO_SRC).not.toMatch(/from\s+['"][^'"]*infrastructure-runtime['"]/)
  })

  test('HybridRuntime is the ONLY runtime importing both (the bridge)', () => {
    expect(HYBRID_SRC).toMatch(/from\s+['"][^'"]*infrastructure-runtime['"]/)
    expect(HYBRID_SRC).toMatch(/from\s+['"][^'"]*protocol-runtime['"]/)
  })

  test('generic runtime code imports NO vertical service (W004-AC07)', () => {
    const verticalPattern = /(?:vpp|compute|storage|wireless|manufacturing)\.service/
    expect(verticalPattern.test(INFRA_SRC)).toBe(false)
    expect(verticalPattern.test(PROTO_SRC)).toBe(false)
    expect(verticalPattern.test(HYBRID_SRC)).toBe(false)
    expect(verticalPattern.test(REGISTRY_SRC)).toBe(false)
  })

  test('bootstrap registers all three runtime kinds (BASE-001)', () => {
    expect(BOOTSTRAP_SRC).toContain('runtimeRegistry.register(infrastructureRuntime)')
    expect(BOOTSTRAP_SRC).toContain('runtimeRegistry.register(protocolRuntime)')
    expect(BOOTSTRAP_SRC).toContain('runtimeRegistry.register(hybridRuntime)')
  })

  test('runtime/index.ts does NOT auto-register (no hidden side effects)', () => {
    // The registry is populated only by explicit initializeBootstrap() —
    // importing the runtime module is a pure import. This is the documented
    // Phase 7.3 boundary.
    expect(REGISTRY_SRC).not.toMatch(/runtimeRegistry\.register\(/)
  })
})

// ---------------------------------------------------------------------------
// W004-AC08 — no persistence/Data Plane/Economic Pipeline redesign
// ---------------------------------------------------------------------------

describe('WORK-004 — no scope violation (W004-AC08)', () => {
  test('bootstrap does not import Data Plane services', () => {
    const BOOTSTRAP_SRC = readFileSync(
      join(REPO_ROOT, 'src', 'lib', 'bootstrap', 'index.ts'),
      'utf8',
    )
    const dataPlanePattern = /(?:data-plane|routing|transport|delivery-confirmation|transform-record)\.service/
    expect(dataPlanePattern.test(BOOTSTRAP_SRC)).toBe(false)
  })

  test('bootstrap does not import the Economic Pipeline', () => {
    const BOOTSTRAP_SRC = readFileSync(
      join(REPO_ROOT, 'src', 'lib', 'bootstrap', 'index.ts'),
      'utf8',
    )
    expect(BOOTSTRAP_SRC).not.toContain('economic-pipeline')
  })

  test('bootstrap does not import Prisma/db (no persistence redesign)', () => {
    const BOOTSTRAP_SRC = readFileSync(
      join(REPO_ROOT, 'src', 'lib', 'bootstrap', 'index.ts'),
      'utf8',
    )
    expect(BOOTSTRAP_SRC).not.toContain('@/lib/db')
    expect(BOOTSTRAP_SRC).not.toContain('@prisma/client')
  })
})
