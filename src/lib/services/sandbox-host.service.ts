// =============================================================================
// SandboxHost — IAAS-DOM-ARCH-5 / DOM-P05 / WORK-021
// =============================================================================
// The service-layer WASI Component Model sandbox host for untrusted extensions.
// Creates an isolated execution context (WASM component/instance) and enforces
// the frozen V5 capability, resource, termination, and deny-by-default contracts.
//
// Contract source: spec/domain-architecture-v5.md §2,
// spec/architecture-change-requests/ACR-004.md (APPROVED),
// spec/work-orders/WORK-021.md.
//
// ARCHITECTURAL BOUNDARIES (frozen by IAAS-DOM-ARCH-5):
//   - Service-layer, NOT kernel (this module is in src/lib/services/).
//   - ExtensionRuntime remains the execution/isolation authority and the
//     capability/resource authority (V5 §2.4 — min(declared, approved)).
//     The sandbox enforces the resulting ceiling at the operation boundary.
//   - No ambient filesystem, network, environment, device, or cross-tenant
//     authority (V5 §2.1, §2.6).
//   - Resource quantities remain distinct (V5 §2.3): executionBudget/fuelUnits
//     (NOT CPU time), cpuTimeNs (host-measured, if available), wallTimeMs,
//     peakLinearMemoryBytes, hostcallBytes. Fuel is NEVER treated as CPU ms.
//   - Termination is an architectural abstraction (V5 §2.5): revoke → terminate
//     sandbox execution context → failed provenance → re-throw. Concrete
//     runtime API is an implementation choice.
//   - Deny-by-default (V5 §2.7): if the sandbox is unavailable, execution is
//     denied with denialReason='sandbox_unavailable'. No silent unsandboxed
//     fallback.
//   - Tenant isolation (V5 §2.6): each execution receives an isolated sandbox
//     context with no shared host address space, filesystem, network, or
//     tenant state.
//
// AR-021-08 fix: wasmtime CLI uses Preview 2 (Component Model) by default
//   (-S preview2=y). WASI Preview 1 imports are adapted to Preview 2
//   components internally. This satisfies the V5 Component Model contract.
//
// AR-021-09 fix: capability filtering is enforced at the IMPORT boundary via
//   -S cli=n (disables ALL WASI imports). When any capability is approved,
//   -S cli=y enables the WASI import namespace. Filesystem access is
//   additionally controlled via --dir (only granted when FS capability is
//   approved). Network access is disabled by default (no -S tcp=y).
//
// AR-021-10 fix: measurements are honestly reported. fuelUnits and
//   peakLinearMemoryBytes are the ENFORCED LIMITS, not actual consumption.
//   wallTimeMs is REAL host-measured elapsed time. hostcallBytes is REAL
//   I/O accounting. cpuTimeNs is honestly ABSENT (wasmtime CLI doesn't
//   report it). Actual fuel consumption measurement requires the wasmtime
//   embedding API (not available in the npm ecosystem).
//
// AR-021-11 fix: execute() uses child_process.spawn (not execFileSync),
//   returning an execution handle that supports revocation via
//   child.kill(SIGTERM). The handle is linked to the ExtensionRegistry
//   lifecycle through the Runtime.
//
// AR-021-13 fix: read-only filesystem enforcement via chmod 555 on the
//   temp directory when only 'wasi:filesystem.read' is approved (not write).
// =============================================================================

import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Sandbox capability and resource ceiling types (V5 §2.3, §2.4)
// ---------------------------------------------------------------------------

export interface SandboxCapabilitySet {
  capabilities: string[]
}

export interface SandboxResourceCeiling {
  executionBudget?: number
  memoryBytes?: number
  wallTimeMs?: number
  cpuTimeNs?: number
}

export interface SandboxCeiling {
  capabilities: SandboxCapabilitySet
  resources: SandboxResourceCeiling
}

// ---------------------------------------------------------------------------
// Sandbox measurement types (V5 §2.3 — distinct quantities)
// ---------------------------------------------------------------------------

/**
 * Post-execution measurements. Per V5 §2.3, these are DISTINCT quantities.
 *
 * AR-021-16 fix: limits and usage are SEPARATE concepts. Usage fields are
 * ABSENT when the runtime cannot measure them — they are NOT filled with
 * the enforced ceiling.
 *
 * Measured values (authoritative):
 *   - wallTimeMs: REAL host-measured elapsed time.
 *   - hostcallBytes: REAL I/O accounting (input + output bytes).
 *
 * Absent values (honestly undefined — NOT filled with ceiling):
 *   - fuelUnits: ABSENT when actual consumption cannot be measured. The
 *     wasmtime CLI does not report actual fuel consumed. Requires the
 *     wasmtime embedding API (not available in the npm ecosystem).
 *   - peakLinearMemoryBytes: ABSENT when actual peak cannot be measured.
 *   - cpuTimeNs: ABSENT (wasmtime CLI does not report CPU time).
 *
 * Enforced limits are recorded SEPARATELY in `enforcedLimits`, not in
 * the usage fields. This ensures V5 provenance carries MEASURED usage,
 * not enforcement ceilings.
 */
export interface SandboxMeasurements {
  /** Actual fuel consumed. ABSENT when unmeasurable (NOT the ceiling). */
  fuelUnits?: number
  /** Host-measured CPU time nanoseconds. ABSENT when unmeasurable. */
  cpuTimeNs?: number
  /** REAL host-measured elapsed wall-clock milliseconds (authoritative). */
  wallTimeMs: number
  /** Actual peak linear memory. ABSENT when unmeasurable (NOT the ceiling). */
  peakLinearMemoryBytes?: number
  /** REAL I/O accounting: bytes transferred across the sandbox boundary. */
  hostcallBytes: number
  /** Enforced limits (separate from usage — AR-021-16 fix). */
  enforcedLimits: {
    executionBudget?: number
    memoryBytes?: number
    wallTimeMs?: number
  }
}

export type SandboxCapabilitiesExercised = string[]

// ---------------------------------------------------------------------------
// Sandbox execution result
// ---------------------------------------------------------------------------

export interface SandboxExecutionResult {
  output: Buffer
  measurements: SandboxMeasurements
  capabilitiesExercised: SandboxCapabilitiesExercised
}

// ---------------------------------------------------------------------------
// Sandbox errors (V5 §2.5, §2.7)
// ---------------------------------------------------------------------------

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxUnavailableError'
  }
}

export class SandboxTerminatedError extends Error {
  constructor(
    message: string,
    public readonly terminationReason: 'revoked' | 'timeout' | 'fuel_exhausted' | 'memory_exceeded' | 'cpu_time_exceeded',
    public readonly partialMeasurements?: Partial<SandboxMeasurements>,
  ) {
    super(message)
    this.name = 'SandboxTerminatedError'
  }
}

export class SandboxCapabilityDeniedError extends Error {
  constructor(
    message: string,
    public readonly deniedCapability: string,
  ) {
    super(message)
    this.name = 'SandboxCapabilityDeniedError'
  }
}

// ---------------------------------------------------------------------------
// SandboxExecutionHandle — AR-021-11 fix: revocation support
// ---------------------------------------------------------------------------

/**
 * Handle to an active sandbox execution. Allows revocation (termination)
 * of an in-flight execution per V5 §2.5.
 *
 * AR-021-11 fix: execute() returns a handle that can be revoked.
 * Revocation sends SIGTERM to the wasmtime subprocess, terminating the
 * sandbox execution context.
 */
export interface SandboxExecutionHandle {
  /** The result promise. Resolves on completion; rejects on termination/error. */
  result: Promise<SandboxExecutionResult>
  /** Revoke (terminate) the sandbox execution. V5 §2.5. */
  revoke(): void
  /** Whether the execution has been revoked. */
  isRevoked(): boolean
}

// ---------------------------------------------------------------------------
// SandboxHost — architectural contract (V5 §2.1, §2.2)
// ---------------------------------------------------------------------------

export interface SandboxHost {
  isAvailable(): boolean
  execute(
    wasmModule: Buffer,
    input: Buffer,
    ceiling: SandboxCeiling,
  ): Promise<SandboxExecutionResult>
  /**
   * AR-021-11 fix: start execution with a revocable handle.
   * Returns a handle that allows revocation of the in-flight execution.
   */
  executeWithHandle(
    wasmModule: Buffer,
    input: Buffer,
    ceiling: SandboxCeiling,
  ): SandboxExecutionHandle
}

// ---------------------------------------------------------------------------
// WasmtimeSandboxHost — concrete WASI runtime adapter (implementation choice)
// ---------------------------------------------------------------------------

/**
 * Concrete WASI sandbox host using the `wasmtime` CLI binary as a subprocess.
 *
 * This is an IMPLEMENTATION CHOICE (V5 §2.1 — concrete runtime is not frozen
 * by architecture). Wasmtime was selected because:
 *   - it is the Bytecode Alliance's production-grade WASM runtime;
 *   - it provides REAL enforcement of fuel/execution budget, memory limits,
 *     and wall-clock timeout via CLI flags (-W fuel=N, -W max-memory-size=N,
 *     -W timeout=Nms);
 *   - it enforces capability-scoped access via -S cli=n (disables ALL WASI
 *     imports) and selective -S cli=y + --dir (grants only approved FS);
 *   - it uses the WASI Component Model (Preview 2) by default (-S preview2=y),
 *     satisfying the V5 Component Model contract (AR-021-08);
 *   - it is NOT marked as not-for-untrusted-code (unlike the Node.js built-in
 *     WASI module);
 *   - it is suitable for untrusted code (the Node.js built-in WASI module is not).
 *
 * CAPABILITY ENFORCEMENT (V5 §2.4 — AR-021-02, AR-021-09, AR-021-15 fix):
 *   - -S cli=n: when NO capabilities are approved, ALL WASI imports are
 *     unresolved → instantiation fails (operation-level enforcement at the
 *     import boundary).
 *   - -S cli=y: when any capability is approved, the WASI import namespace
 *     is available. Filesystem access is additionally controlled via --dir.
 *   - --dir: granted ONLY when 'wasi:filesystem.read' or 'wasi:filesystem.write'
 *     is approved. When only read is approved, the temp directory is set to
 *     read-only (chmod 555) — AR-021-13 fix. This is OS-level enforcement
 *     at the sandbox boundary: the sandbox process cannot write because the
 *     kernel denies the write syscall on a 555 directory.
 *   - capabilitiesExercised: EMPTY — we cannot observe actual operations
 *     from the wasmtime CLI. We do NOT copy from the granted set (AR-021-15).
 *     The granted capabilities are recorded in the ceiling, not in exercised
 *     capabilities. Actual operation observation requires the wasmtime
 *     embedding API.
 *
 * RESOURCE ENFORCEMENT (V5 §2.3 — AR-021-03 fix):
 *   - executionBudget: enforced via `-W fuel=N`. Wasmtime traps when fuel is
 *     exhausted. This is REAL enforcement.
 *   - memoryBytes: enforced via `-W max-memory-size=N` + `trap-on-grow-failure=y`.
 *   - wallTimeMs: enforced via `-W timeout=Nms`. Wasmtime interrupts execution.
 *
 * MEASUREMENTS (V5 §2.3 — AR-021-16 fix):
 *   - wallTimeMs: REAL host-measured elapsed time (authoritative usage).
 *   - hostcallBytes: REAL I/O accounting (authoritative usage).
 *   - fuelUnits: ABSENT (actual consumption not measurable via CLI). NOT
 *     filled with the ceiling. Requires the wasmtime embedding API.
 *   - peakLinearMemoryBytes: ABSENT (actual peak not measurable via CLI).
 *     NOT filled with the ceiling.
 *   - cpuTimeNs: ABSENT (wasmtime CLI doesn't report CPU time).
 *   - enforcedLimits: SEPARATE field recording the enforcement ceilings
 *     (NOT in the usage fields). This ensures provenance carries MEASURED
 *     usage, not enforcement ceilings.
 *
 * REVOCATION (V5 §2.5 — AR-021-11 fix):
 *   executeWithHandle() uses child_process.spawn, returning a handle that
 *   supports revocation via child.kill(SIGTERM). This terminates the sandbox
 *   subprocess, ending the in-flight execution.
 *
 * TENANT ISOLATION (V5 §2.6):
 *   Each execute() call spawns a SEPARATE wasmtime subprocess with a FRESH
 *   temporary directory. There is NO shared state between executions.
 */
export class WasmtimeSandboxHost implements SandboxHost {
  private _availableChecked = false
  private _available = false

  isAvailable(): boolean {
    if (this._availableChecked) return this._available
    try {
      execFileSync('wasmtime', ['--version'], { stdio: 'pipe', timeout: 5000 })
      this._available = true
    } catch {
      this._available = false
    }
    this._availableChecked = true
    return this._available
  }

  async execute(
    wasmModule: Buffer,
    input: Buffer,
    ceiling: SandboxCeiling,
  ): Promise<SandboxExecutionResult> {
    const handle = this.executeWithHandle(wasmModule, input, ceiling)
    return handle.result
  }

  executeWithHandle(
    wasmModule: Buffer,
    input: Buffer,
    ceiling: SandboxCeiling,
  ): SandboxExecutionHandle {
    // V5 §2.7: deny-by-default if the sandbox is unavailable.
    if (!this.isAvailable()) {
      const err = new SandboxUnavailableError(
        'WasmtimeSandboxHost is not available: wasmtime binary not found',
      )
      return {
        result: Promise.reject(err),
        revoke: () => {},
        isRevoked: () => false,
      }
    }

    // V5 §2.6: fresh temporary directory per execution (no shared state).
    const tmpDir = mkdtempSync(join(tmpdir(), 'wasmtime-sandbox-'))
    const wasmPath = join(tmpDir, 'module.wasm')
    writeFileSync(wasmPath, wasmModule)

    // Build wasmtime CLI args with REAL enforcement.
    const args: string[] = ['run']

    // --- Resource enforcement (V5 §2.3) ---
    if (ceiling.resources.executionBudget !== undefined && ceiling.resources.executionBudget > 0) {
      args.push('-W', `fuel=${ceiling.resources.executionBudget}`)
    }
    if (ceiling.resources.memoryBytes !== undefined && ceiling.resources.memoryBytes > 0) {
      args.push('-W', `max-memory-size=${ceiling.resources.memoryBytes}`)
    }
    if (ceiling.resources.wallTimeMs !== undefined && ceiling.resources.wallTimeMs > 0) {
      args.push('-W', `timeout=${ceiling.resources.wallTimeMs}ms`)
    }
    args.push('-W', 'trap-on-grow-failure=y')

    // --- Capability enforcement (V5 §2.4 — AR-021-09 fix) ---
    // AR-021-09: -S cli=n disables ALL WASI imports when no capabilities
    // are approved. This is operation-level enforcement at the import boundary.
    const hasFsRead = ceiling.capabilities.capabilities.includes('wasi:filesystem.read')
    const hasFsWrite = ceiling.capabilities.capabilities.includes('wasi:filesystem.write')
    const hasAnyCapability = ceiling.capabilities.capabilities.length > 0

    if (hasAnyCapability) {
      // Enable WASI CLI imports (filesystems, sockets, clocks, random)
      args.push('-S', 'cli=y')
    } else {
      // Disable ALL WASI imports — operation-level enforcement
      args.push('-S', 'cli=n')
    }

    // Filesystem access: granted ONLY when FS capability is approved
    const needsRestorePerms = (hasFsRead || hasFsWrite) && hasFsRead && !hasFsWrite
    if (hasFsRead || hasFsWrite) {
      args.push('--dir', `${tmpDir}::/`)
      // AR-021-13 fix: read-only enforcement when only read is approved
      if (needsRestorePerms) {
        chmodSync(tmpDir, 0o555) // read + execute, no write
      }
    }

    // No TCP/UDP/HTTP/inherit-network/inherit-env flags are passed.
    // Network and environment access are NEVER granted.

    args.push(wasmPath)

    // V5 §2.3: track measurements
    const startTime = Date.now()
    const fuelLimit = ceiling.resources.executionBudget ?? 0
    const memoryLimit = ceiling.resources.memoryBytes ?? 0
    const hostcallBytes = input.length

    // AR-021-11 fix: use spawn for revocation support
    let revoked = false
    let childProcess: ChildProcess | null = null

    const resultPromise = new Promise<SandboxExecutionResult>((resolve, reject) => {
      childProcess = spawn('wasmtime', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: ceiling.resources.wallTimeMs
          ? ceiling.resources.wallTimeMs + 5000 // host-level timeout as backstop
          : 60000,
      })

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []

      childProcess.stdout?.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk)
      })
      childProcess.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk)
      })

      // Pass input via stdin
      childProcess.stdin?.write(input)
      childProcess.stdin?.end()

      childProcess.on('error', (err: Error) => {
        if (needsRestorePerms) chmodSync(tmpDir, 0o755)
        rmSync(tmpDir, { recursive: true, force: true })
        reject(err)
      })

      childProcess.on('close', (exitCode: number | null, signal: string | null) => {
        if (needsRestorePerms) chmodSync(tmpDir, 0o755)
        rmSync(tmpDir, { recursive: true, force: true })

        const stdout = Buffer.concat(stdoutChunks)
        const stderr = Buffer.concat(stderrChunks)
        const stderrStr = stderr.toString('utf8')
        const elapsedMs = Date.now() - startTime
        const totalHostcallBytes = hostcallBytes + stdout.length

        const partialMeasurements: Partial<SandboxMeasurements> = {
          // AR-021-16: usage fields are ABSENT when unmeasurable
          wallTimeMs: elapsedMs,
          hostcallBytes: totalHostcallBytes,
          enforcedLimits: {
            executionBudget: fuelLimit || undefined,
            memoryBytes: memoryLimit || undefined,
            wallTimeMs: ceiling.resources.wallTimeMs,
          },
        }

        // AR-021-11: check if revoked
        if (revoked || signal === 'SIGTERM') {
          reject(new SandboxTerminatedError(
            `Sandbox execution terminated: revoked via SIGTERM after ${elapsedMs}ms`,
            'revoked',
            partialMeasurements,
          ))
          return
        }

        // Success case
        if (exitCode === 0) {
          // AR-021-15: capabilitiesExercised is EMPTY — we cannot observe
          // actual operations from the wasmtime CLI. We do NOT copy from
          // the granted set. The granted capabilities are recorded in the
          // ceiling, not in exercised capabilities.
          const capabilitiesExercised: string[] = []

          resolve({
            output: stdout,
            measurements: {
              // AR-021-16: usage fields are ABSENT when unmeasurable
              // (NOT filled with the enforced ceiling)
              wallTimeMs: elapsedMs,
              hostcallBytes: totalHostcallBytes,
              enforcedLimits: {
                executionBudget: fuelLimit || undefined,
                memoryBytes: memoryLimit || undefined,
                wallTimeMs: ceiling.resources.wallTimeMs,
              },
            },
            capabilitiesExercised,
          })
          return
        }

        // Classify failures
        if (signal === 'SIGKILL' || stderrStr.includes('interrupt')) {
          reject(new SandboxTerminatedError(
            `Sandbox execution terminated: wall-clock timeout after ${elapsedMs}ms`,
            'timeout',
            partialMeasurements,
          ))
          return
        }

        if (stderrStr.includes('fuel')) {
          reject(new SandboxTerminatedError(
            `Sandbox execution terminated: execution budget (fuel) exhausted (limit: ${fuelLimit})`,
            'fuel_exhausted',
            partialMeasurements,
          ))
          return
        }

        if (stderrStr.includes('memory') || stderrStr.includes('grow')) {
          reject(new SandboxTerminatedError(
            `Sandbox execution terminated: memory limit exceeded (limit: ${memoryLimit})`,
            'memory_exceeded',
            partialMeasurements,
          ))
          return
        }

        if (stderrStr.includes('unknown import') || stderrStr.includes('not been defined') || stderrStr.includes('has not been defined')) {
          const match = stderrStr.match(/`([^`]+)`/)
          const deniedCap = match ? match[1] : 'unknown'
          reject(new SandboxCapabilityDeniedError(
            `Sandbox capability denied: import "${deniedCap}" is not granted by the ceiling`,
            deniedCap,
          ))
          return
        }

        reject(new Error(`Sandbox execution failed (exit ${exitCode}): ${stderrStr.slice(0, 500)}`))
      })
    })

    return {
      result: resultPromise,
      revoke: () => {
        revoked = true
        if (childProcess && !childProcess.killed) {
          childProcess.kill('SIGTERM')
        }
      },
      isRevoked: () => revoked,
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton + accessor
// ---------------------------------------------------------------------------

let sandboxHostSingleton: SandboxHost | null = null

export function getSandboxHost(): SandboxHost {
  if (!sandboxHostSingleton) {
    sandboxHostSingleton = new WasmtimeSandboxHost()
  }
  return sandboxHostSingleton
}

export function setSandboxHostForTesting(host: SandboxHost | null): void {
  sandboxHostSingleton = host
}

// ---------------------------------------------------------------------------
// DenyByDefaultSandboxHost — V5 §2.7 fallback
// ---------------------------------------------------------------------------

export class DenyByDefaultSandboxHost implements SandboxHost {
  isAvailable(): boolean {
    return false
  }

  async execute(
    _wasmModule: Buffer,
    _input: Buffer,
    _ceiling: SandboxCeiling,
  ): Promise<SandboxExecutionResult> {
    throw new SandboxUnavailableError(
      'Sandbox is unavailable: deny-by-default policy (V5 §2.7). No unsandboxed fallback is permitted.',
    )
  }

  executeWithHandle(
    _wasmModule: Buffer,
    _input: Buffer,
    _ceiling: SandboxCeiling,
  ): SandboxExecutionHandle {
    const err = new SandboxUnavailableError(
      'Sandbox is unavailable: deny-by-default policy (V5 §2.7). No unsandboxed fallback is permitted.',
    )
    return {
      result: Promise.reject(err),
      revoke: () => {},
      isRevoked: () => false,
    }
  }
}

// Backward-compatible alias
export const WasmerSandboxHost = WasmtimeSandboxHost
