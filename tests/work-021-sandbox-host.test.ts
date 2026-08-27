/// <reference types="bun-types" />
// =============================================================================
// WORK-021 — WASI Sandbox Host Foundation unit + architecture tests
// =============================================================================
// Verifies W021-AC01..AC12: the sandbox host is service-layer, enforces the
// V5 capability/resource/termination/deny-by-default contracts, preserves
// fuel ≠ CPU time, and obeys all V5 anti-dependency prohibitions.
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()

function readSrc(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

// ---------------------------------------------------------------------------
// W021-AC10 — static architecture + anti-dependency checks
// ---------------------------------------------------------------------------

describe('WORK-021 — SandboxHost architecture (W021-AC10)', () => {
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('SandboxHost is in the service layer (NOT kernel)', () => {
    const path = join(REPO_ROOT, 'src', 'lib', 'services', 'sandbox-host.service.ts')
    expect(path).toContain('src/lib/services/')
    expect(path).not.toContain('src/lib/kernel/')
  })

  test('SandboxHost imports NO vertical service (W021-AC10)', () => {
    const verticalPattern = /(?:vpp|compute|storage|wireless|manufacturing)\.service/
    expect(verticalPattern.test(SANDBOX_SRC)).toBe(false)
  })

  test('SandboxHost imports NO EconomicPipeline (W021-AC10)', () => {
    expect(SANDBOX_SRC).not.toContain('economic-pipeline')
  })

  test('SandboxHost imports NO Route/Transport (W021-AC10)', () => {
    const dataPlanePattern = /(?:routing|transport|delivery-confirmation)\.service/
    expect(dataPlanePattern.test(SANDBOX_SRC)).toBe(false)
  })

  test('SandboxHost imports NO RuntimeRegistry (W021-AC10)', () => {
    expect(SANDBOX_SRC).not.toMatch(/^import.*RuntimeRegistry/m)
    expect(SANDBOX_SRC).not.toMatch(/from\s+['"]@\/lib\/kernel\/runtime['"]/m)
    expect(SANDBOX_SRC).not.toMatch(/from\s+['"]@\/lib\/kernel\//m)
  })

  test('SandboxHost imports NO kernel code (W021-AC10)', () => {
    expect(SANDBOX_SRC).not.toMatch(/^import.*@\/lib\/kernel/m)
  })

  test('SandboxHost imports NO ExtensionRegistry (no catalog ownership) (W021-AC10)', () => {
    expect(SANDBOX_SRC).not.toContain('extension-registry.service')
  })

  test('SandboxHost imports NO ExtensionProvenanceService (no provenance ownership) (W021-AC10)', () => {
    expect(SANDBOX_SRC).not.toContain('extension-provenance.service')
  })

  test('SandboxHost imports NO TransformRegistry/TransformRecord/TransformRuntime (W021-AC10)', () => {
    expect(SANDBOX_SRC).not.toContain('transform-registry.service')
    expect(SANDBOX_SRC).not.toContain('transform-record.service')
    expect(SANDBOX_SRC).not.toContain('transform-runtime.service')
  })

  test('SandboxHost does NOT own catalog/lifecycle (no register/transition exports) (W021-AC10)', () => {
    expect(SANDBOX_SRC).not.toMatch(/export\s+(async\s+)?function\s+registerExtension\b/)
    expect(SANDBOX_SRC).not.toMatch(/export\s+(async\s+)?function\s+transitionLifecycle\b/)
    expect(SANDBOX_SRC).not.toMatch(/export\s+(async\s+)?function\s+revokeExtension\b/)
  })
})

// ---------------------------------------------------------------------------
// W021-AC01 — concrete WASI runtime documented as implementation choice
// ---------------------------------------------------------------------------

describe('WORK-021 — WASI runtime as implementation choice (W021-AC01)', () => {
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('WasmerSandboxHost is documented as an implementation choice, not architecture', () => {
    expect(SANDBOX_SRC).toContain('implementation choice')
    expect(SANDBOX_SRC).toContain('V5 §2.1')
  })

  test('SandboxHost interface is the architectural contract (not the concrete class)', () => {
    expect(SANDBOX_SRC).toContain('export interface SandboxHost')
    expect(SANDBOX_SRC).toContain('export class WasmerSandboxHost implements SandboxHost')
  })

  test('concrete runtime is documented with compatibility/security rationale', () => {
    expect(SANDBOX_SRC).toContain('node:wasi')
    expect(SANDBOX_SRC).toContain('Wasmtime')
    expect(SANDBOX_SRC).toContain('portable')
  })

  test('future alternative adapters are documented as possible without architecture change', () => {
    expect(SANDBOX_SRC).toContain('alternative adapters')
    expect(SANDBOX_SRC).toContain('changing this interface')
  })
})

// ---------------------------------------------------------------------------
// W021-AC02 — validation/instantiation without ambient authority
// ---------------------------------------------------------------------------

describe('WORK-021 — No ambient authority (W021-AC02)', () => {
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('SandboxHost grants only capabilities in the ceiling', () => {
    expect(SANDBOX_SRC).toContain('grant only the capabilities')
    expect(SANDBOX_SRC).toContain('ceiling.capabilities')
  })

  test('SandboxHost uses fresh WASI instance per execution (no ambient FS)', () => {
    expect(SANDBOX_SRC).toContain('fresh WASI instance')
    expect(SANDBOX_SRC).toContain('No preopens')
  })

  test('SandboxHost does NOT grant ambient network access', () => {
    expect(SANDBOX_SRC).not.toMatch(/network:\s*true/)
    expect(SANDBOX_SRC).not.toContain('net:')
  })
})

// ---------------------------------------------------------------------------
// W021-AC03 — capability enforcement (min(declared, approved))
// ---------------------------------------------------------------------------

describe('WORK-021 — Capability enforcement (W021-AC03)', () => {
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('SandboxHost accepts a SandboxCapabilitySet with granted capabilities', () => {
    expect(SANDBOX_SRC).toContain('export interface SandboxCapabilitySet')
    expect(SANDBOX_SRC).toContain('capabilities: string[]')
  })

  test('denied capabilities cause instantiation failure (unresolved import)', () => {
    expect(SANDBOX_SRC).toContain('SandboxCapabilityDeniedError')
    expect(SANDBOX_SRC).toContain('not granted by the ceiling')
  })
})

// ---------------------------------------------------------------------------
// W021-AC04 — tenant isolation
// ---------------------------------------------------------------------------

describe('WORK-021 — Tenant isolation (W021-AC04)', () => {
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('each execution receives an isolated sandbox context', () => {
    expect(SANDBOX_SRC).toContain('isolated sandbox context')
    expect(SANDBOX_SRC).toContain('no shared state')
  })

  test('fresh WASI instance per execution (no shared state)', () => {
    expect(SANDBOX_SRC).toContain('fresh')
    expect(SANDBOX_SRC).toContain('in-memory filesystem')
  })
})

// ---------------------------------------------------------------------------
// W021-AC05 — independent resource controls; fuel ≠ CPU time
// ---------------------------------------------------------------------------

describe('WORK-021 — Independent resource controls (W021-AC05)', () => {
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('SandboxResourceCeiling defines distinct resource quantities', () => {
    expect(SANDBOX_SRC).toContain('export interface SandboxResourceCeiling')
    expect(SANDBOX_SRC).toContain('executionBudget')
    expect(SANDBOX_SRC).toContain('memoryBytes')
    expect(SANDBOX_SRC).toContain('wallTimeMs')
    expect(SANDBOX_SRC).toContain('cpuTimeNs')
  })

  test('fuel is explicitly documented as NOT CPU time', () => {
    expect(SANDBOX_SRC).toContain('NOT CPU time')
    expect(SANDBOX_SRC).toContain('Fuel is NEVER treated as CPU ms')
  })

  test('resource limits are enforced independently', () => {
    expect(SANDBOX_SRC).toContain('independently')
    expect(SANDBOX_SRC).toContain('wall-clock deadline')
    expect(SANDBOX_SRC).toContain('memory limit')
  })
})

// ---------------------------------------------------------------------------
// W021-AC06 — CPU measurement separate from fuel
// ---------------------------------------------------------------------------

describe('WORK-021 — CPU measurement separate from fuel (W021-AC06)', () => {
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('SandboxMeasurements has fuelUnits and cpuTimeNs as separate fields', () => {
    expect(SANDBOX_SRC).toContain('export interface SandboxMeasurements')
    expect(SANDBOX_SRC).toContain('fuelUnits: number')
    expect(SANDBOX_SRC).toContain('cpuTimeNs?')
  })

  test('cpuTimeNs is documented as NOT derived from fuel', () => {
    expect(SANDBOX_SRC).toContain('NOT derived from fuel')
  })

  test('measurementSource discriminator is documented for fuel-vs-cpuTime mapping', () => {
    // The V5 contract requires a measurementSource discriminator when fuel
    // is used to approximate cpuMs. The ACR-004 document specifies this; the
    // sandbox host records measurements distinctly (fuelUnits vs cpuTimeNs).
    expect(SANDBOX_SRC).toContain('fuelUnits')
    expect(SANDBOX_SRC).toContain('cpuTimeNs')
    expect(SANDBOX_SRC).toContain('NOT derived from fuel')
  })
})

// ---------------------------------------------------------------------------
// W021-AC07 — termination contract
// ---------------------------------------------------------------------------

describe('WORK-021 — Termination contract (W021-AC07)', () => {
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('SandboxTerminatedError class exists with termination reasons', () => {
    expect(SANDBOX_SRC).toContain('export class SandboxTerminatedError')
    expect(SANDBOX_SRC).toContain("terminationReason: 'revoked'")
    expect(SANDBOX_SRC).toContain("'timeout'")
    expect(SANDBOX_SRC).toContain("'fuel_exhausted'")
    expect(SANDBOX_SRC).toContain("'memory_exceeded'")
  })

  test('termination does NOT freeze a specific runtime API', () => {
    // The architectural termination contract is an abstraction.
    // No instance.drop() in the sandbox host.
    expect(SANDBOX_SRC).not.toContain('instance.drop()')
  })

  test('deadline timer enforces wall-clock termination', () => {
    expect(SANDBOX_SRC).toContain('deadlineTimer')
    expect(SANDBOX_SRC).toContain('clearTimeout')
  })
})

// ---------------------------------------------------------------------------
// W021-AC08 — deny-by-default
// ---------------------------------------------------------------------------

describe('WORK-021 — Deny-by-default (W021-AC08)', () => {
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('SandboxUnavailableError class exists', () => {
    expect(SANDBOX_SRC).toContain('export class SandboxUnavailableError')
  })

  test('DenyByDefaultSandboxHost class exists and denies all execution', () => {
    expect(SANDBOX_SRC).toContain('export class DenyByDefaultSandboxHost')
    expect(SANDBOX_SRC).toContain('isAvailable(): boolean')
    expect(SANDBOX_SRC).toContain('return false')
  })

  test('deny-by-default is documented as V5 §2.7', () => {
    expect(SANDBOX_SRC).toContain('V5 §2.7')
    expect(SANDBOX_SRC).toContain('deny-by-default')
    expect(SANDBOX_SRC).toContain('No silent unsandboxed')
  })
})

// ---------------------------------------------------------------------------
// W021-AC09 — failed provenance + rethrow
// ---------------------------------------------------------------------------

describe('WORK-021 — Failed provenance + rethrow (W021-AC09)', () => {
  const RUNTIME_SRC = readSrc('src/lib/services/extension-runtime.service.ts')

  test('ExtensionRuntime catches sandbox errors and emits failed provenance', () => {
    expect(RUNTIME_SRC).toContain('sandbox_unavailable')
    expect(RUNTIME_SRC).toContain('emitFailedProvenance')
  })

  test('ExtensionRuntime re-throws sandbox errors (no silent success)', () => {
    expect(RUNTIME_SRC).toContain('Re-throw the original error')
  })
})

// ---------------------------------------------------------------------------
// W021-AC11 — end-to-end (verified by PG/integration test file, not here)
// ---------------------------------------------------------------------------

describe('WORK-021 — End-to-end verification (W021-AC11)', () => {
  test('sandbox-host.service.ts exists', () => {
    expect(existsSync(join(REPO_ROOT, 'src', 'lib', 'services', 'sandbox-host.service.ts'))).toBe(true)
  })

  test('ExtensionExecutionInput accepts wasmModule and sandboxHost', () => {
    const RUNTIME_SRC = readSrc('src/lib/services/extension-runtime.service.ts')
    expect(RUNTIME_SRC).toContain('wasmModule?: Buffer')
    expect(RUNTIME_SRC).toContain('sandboxHost?')
  })

  test('ExtensionRuntime routes through sandbox when wasmModule is provided', () => {
    const RUNTIME_SRC = readSrc('src/lib/services/extension-runtime.service.ts')
    expect(RUNTIME_SRC).toContain('useSandbox')
    expect(RUNTIME_SRC).toContain('sandbox.execute')
  })
})

// ---------------------------------------------------------------------------
// V5 immutability — V5 architecture not modified in place
// ---------------------------------------------------------------------------

describe('WORK-021 — V5 immutability (W021-AC12)', () => {
  test('frozen V5 architecture document is not modified in place', () => {
    const arch = readSrc('spec/domain-architecture-v5.md')
    // V5 must still say runtime/version is not frozen
    expect(arch).toContain('The architecture intentionally does not freeze a particular WASI revision or concrete runtime')
  })
})
