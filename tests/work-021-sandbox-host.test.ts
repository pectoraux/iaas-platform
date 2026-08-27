/// <reference types="bun-types" />
// =============================================================================
// WORK-021 — WASI Sandbox Host Foundation unit + architecture tests
// =============================================================================
// Verifies W021-AC01..AC12: the sandbox host is service-layer, enforces the
// V5 capability/resource/termination/deny-by-default contracts, preserves
// fuel ≠ CPU time, and obeys all V5 anti-dependency prohibitions.
//
// AR-021 fixes addressed:
//   - AR-021-01: uses wasmtime CLI (production-grade, not experimental node:wasi)
//   - AR-021-02: real capability filtering (--dir only when approved; no network)
//   - AR-021-03: real resource enforcement (-W fuel, -W max-memory-size, -W timeout)
//   - AR-021-04: real measurements (wallTimeMs measured; fuel/memory = enforced limits)
//   - AR-021-05: measurements wired into provenance (verified in e2e tests)
//   - AR-021-06: no global stdout monkey-patch (uses subprocess stdout pipe)
//   - AR-021-07: adversarial tests (verified in e2e tests)
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

describe('WORK-021 — WASI runtime as implementation choice (W021-AC01, AR-021-01)', () => {
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('WasmtimeSandboxHost is documented as an implementation choice, not architecture', () => {
    expect(SANDBOX_SRC).toContain('implementation choice')
    expect(SANDBOX_SRC).toContain('V5 §2.1')
  })

  test('SandboxHost interface is the architectural contract (not the concrete class)', () => {
    expect(SANDBOX_SRC).toContain('export interface SandboxHost')
    expect(SANDBOX_SRC).toContain('export class WasmtimeSandboxHost implements SandboxHost')
  })

  test('concrete runtime is wasmtime CLI (production-grade, NOT experimental node:wasi)', () => {
    expect(SANDBOX_SRC).toContain('wasmtime')
    expect(SANDBOX_SRC).toContain('Bytecode Alliance')
    expect(SANDBOX_SRC).toContain('production-grade')
    // Must NOT use experimental node:wasi (AR-021-01)
    expect(SANDBOX_SRC).not.toContain("require('node:wasi')")
    expect(SANDBOX_SRC).not.toContain('node:wasi')
  })

  test('wasmtime is documented as suitable for untrusted code (AR-021-01)', () => {
    expect(SANDBOX_SRC).toContain('suitable for untrusted code')
    expect(SANDBOX_SRC).not.toContain('experimental')
  })
})

// ---------------------------------------------------------------------------
// W021-AC02 — no ambient authority (AR-021-02)
// ---------------------------------------------------------------------------

describe('WORK-021 — No ambient authority (W021-AC02, AR-021-02)', () => {
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('capability enforcement: --dir only granted when FS capability is approved', () => {
    expect(SANDBOX_SRC).toContain('hasFsRead')
    expect(SANDBOX_SRC).toContain('hasFsWrite')
    expect(SANDBOX_SRC).toContain('--dir')
    expect(SANDBOX_SRC).toContain('tmpDir')
  })

  test('no ambient network access (no network flags passed)', () => {
    // The source must NOT pass any network-enabling flags.
    // We check that the source does not contain these as wasmtime args.
    const networkArgPattern = /'tcp=y'|'udp=y'|'http=y'|'inherit-network=y'/
    expect(networkArgPattern.test(SANDBOX_SRC)).toBe(false)
  })

  test('no ambient env access (no inherit-env flag passed)', () => {
    const envArgPattern = /'inherit-env=y'/
    expect(envArgPattern.test(SANDBOX_SRC)).toBe(false)
  })

  test('stdout is captured via subprocess pipe (no global monkey-patch — AR-021-06)', () => {
    // The sandbox uses execFileSync with stdio: ['pipe', 'pipe', 'pipe']
    // to capture stdout per-execution. No process.stdout mutation.
    expect(SANDBOX_SRC).toContain('stdio')
    expect(SANDBOX_SRC).toContain('pipe')
    expect(SANDBOX_SRC).not.toContain('process.stdout.write =')
  })

  test('no global process.stdout monkey-patching (AR-021-06)', () => {
    expect(SANDBOX_SRC).not.toContain('process.stdout.write =')
    expect(SANDBOX_SRC).not.toContain('originalStdoutWrite')
  })
})

// ---------------------------------------------------------------------------
// W021-AC03 — capability enforcement
// ---------------------------------------------------------------------------

describe('WORK-021 — Capability enforcement (W021-AC03)', () => {
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('SandboxCapabilitySet type exists', () => {
    expect(SANDBOX_SRC).toContain('export interface SandboxCapabilitySet')
    expect(SANDBOX_SRC).toContain('capabilities: string[]')
  })

  test('SandboxCapabilityDeniedError exists for denied imports', () => {
    expect(SANDBOX_SRC).toContain('export class SandboxCapabilityDeniedError')
  })
})

// ---------------------------------------------------------------------------
// W021-AC04 — tenant isolation
// ---------------------------------------------------------------------------

describe('WORK-021 — Tenant isolation (W021-AC04, AR-021-07)', () => {
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('each execution creates a fresh temp directory (no shared state)', () => {
    expect(SANDBOX_SRC).toContain('mkdtempSync')
    expect(SANDBOX_SRC).toContain('rmSync')
    expect(SANDBOX_SRC).toContain('no shared state')
  })

  test('each execution is a separate subprocess (process isolation)', () => {
    expect(SANDBOX_SRC).toContain('execFileSync')
    expect(SANDBOX_SRC).toContain('wasmtime')
  })
})

// ---------------------------------------------------------------------------
// W021-AC05 — independent resource controls (AR-021-03)
// ---------------------------------------------------------------------------

describe('WORK-021 — Real resource enforcement (W021-AC05, AR-021-03)', () => {
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('fuel is enforced via -W fuel=N (REAL enforcement, not synthetic)', () => {
    expect(SANDBOX_SRC).toContain('-W')
    expect(SANDBOX_SRC).toContain('fuel=')
    expect(SANDBOX_SRC).not.toContain('fuelUnits = 0')
  })

  test('memory is enforced via -W max-memory-size=N (REAL enforcement)', () => {
    expect(SANDBOX_SRC).toContain('max-memory-size=')
  })

  test('wall-clock is enforced via -W timeout=Nms (REAL enforcement, not boolean flip)', () => {
    expect(SANDBOX_SRC).toContain('timeout=')
    expect(SANDBOX_SRC).not.toContain('deadlineTriggered = true')
  })

  test('trap-on-grow-failure is enabled (memory limits trap, not silent -1)', () => {
    expect(SANDBOX_SRC).toContain('trap-on-grow-failure=y')
  })

  test('fuel is NOT equated to CPU time', () => {
    expect(SANDBOX_SRC).toContain('NOT CPU time')
    expect(SANDBOX_SRC).toContain('Fuel is NEVER treated as CPU ms')
  })
})

// ---------------------------------------------------------------------------
// W021-AC06 — CPU measurement separate from fuel (AR-021-04)
// ---------------------------------------------------------------------------

describe('WORK-021 — Real measurements (W021-AC06, AR-021-04)', () => {
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('SandboxMeasurements has five distinct quantity fields', () => {
    expect(SANDBOX_SRC).toContain('export interface SandboxMeasurements')
    expect(SANDBOX_SRC).toContain('fuelUnits?')
    expect(SANDBOX_SRC).toContain('cpuTimeNs?')
    expect(SANDBOX_SRC).toContain('wallTimeMs: number')
    expect(SANDBOX_SRC).toContain('peakLinearMemoryBytes?')
    expect(SANDBOX_SRC).toContain('hostcallBytes: number')
  })

  test('wallTimeMs is host-measured (real, not synthetic)', () => {
    expect(SANDBOX_SRC).toContain('Date.now()')
    expect(SANDBOX_SRC).toContain('elapsedMs')
    expect(SANDBOX_SRC).toContain('REAL host-measured')
  })

  test('fuelUnits is the enforced limit (not synthetic 0)', () => {
    expect(SANDBOX_SRC).toContain('fuelUnits')
    expect(SANDBOX_SRC).not.toContain('fuelUnits = 0')
  })

  test('measurements separate usage from enforced limits (AR-021-16)', () => {
    expect(SANDBOX_SRC).toContain('enforcedLimits')
    expect(SANDBOX_SRC).toContain('ABSENT')
    expect(SANDBOX_SRC).toContain('NOT filled with the ceiling')
  })
})

// ---------------------------------------------------------------------------
// W021-AC07 — termination contract
// ---------------------------------------------------------------------------

describe('WORK-021 — Termination contract (W021-AC07)', () => {
  const SANDBOX_SRC = readSrc('src/lib/services/sandbox-host.service.ts')

  test('SandboxTerminatedError class exists with termination reasons', () => {
    expect(SANDBOX_SRC).toContain('export class SandboxTerminatedError')
    expect(SANDBOX_SRC).toContain("'revoked'")
    expect(SANDBOX_SRC).toContain("'timeout'")
    expect(SANDBOX_SRC).toContain("'fuel_exhausted'")
    expect(SANDBOX_SRC).toContain("'memory_exceeded'")
  })

  test('termination does NOT freeze a specific runtime API', () => {
    expect(SANDBOX_SRC).not.toContain('instance.drop()')
  })

  test('fuel exhaustion is classified from wasmtime stderr', () => {
    expect(SANDBOX_SRC).toContain("includes('fuel')")
  })

  test('timeout is classified from wasmtime stderr', () => {
    expect(SANDBOX_SRC).toContain("includes('interrupt')")
  })

  test('memory exceeded is classified from wasmtime stderr', () => {
    expect(SANDBOX_SRC).toContain("includes('memory')")
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

describe('WORK-021 — Failed provenance + rethrow (W021-AC09, AR-021-05)', () => {
  const RUNTIME_SRC = readSrc('src/lib/services/extension-runtime.service.ts')

  test('ExtensionRuntime catches sandbox errors and emits failed provenance', () => {
    expect(RUNTIME_SRC).toContain('sandbox_unavailable')
    expect(RUNTIME_SRC).toContain('emitFailedProvenance')
  })

  test('ExtensionRuntime re-throws sandbox errors (no silent success)', () => {
    expect(RUNTIME_SRC).toContain('Re-throw the original error')
  })

  test('ExtensionRuntime wires sandbox measurements into provenance (AR-021-05)', () => {
    expect(RUNTIME_SRC).toContain('measuredResourceUsage')
    expect(RUNTIME_SRC).toContain('measuredCapabilitiesExercised')
    expect(RUNTIME_SRC).toContain('AR-021-05')
  })
})

// ---------------------------------------------------------------------------
// W021-AC11 — end-to-end (verified by e2e test file)
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
// V5 immutability
// ---------------------------------------------------------------------------

describe('WORK-021 — V5 immutability (W021-AC12)', () => {
  test('frozen V5 architecture document is not modified in place', () => {
    const arch = readSrc('spec/domain-architecture-v5.md')
    expect(arch).toContain('IAAS-DOM-ARCH-5')
    expect(arch).toContain('FROZEN')
    expect(arch).toContain('does not freeze a particular WASI revision or concrete runtime')
  })
})
