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
// This service does NOT:
//   - own catalog/lifecycle state (that is ExtensionRegistry);
//   - own durable provenance storage (that is ExtensionProvenanceService);
//   - select or freeze a concrete WASI revision/runtime as architecture
//     (Wasmtime CLI is an implementation choice — V5 §2.1);
//   - implement containers or native/plugin-process sandboxes (future ACR);
//   - implement concrete extensions, Marketplace, SDK, licensing, economics;
//   - import vertical services, EconomicPipeline, Route/Transport,
//     RuntimeRegistry, or kernel code.
// =============================================================================

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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

export interface SandboxMeasurements {
  fuelUnits: number
  cpuTimeNs?: number
  wallTimeMs: number
  peakLinearMemoryBytes: number
  hostcallBytes: number
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
// SandboxHost — architectural contract (V5 §2.1, §2.2)
// ---------------------------------------------------------------------------

export interface SandboxHost {
  isAvailable(): boolean
  execute(
    wasmModule: Buffer,
    input: Buffer,
    ceiling: SandboxCeiling,
  ): Promise<SandboxExecutionResult>
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
 *   - it enforces capability-scoped access: by default NO filesystem, NO
 *     network, NO environment access is granted (the capability-sandbox
 *     default required by V5 §2.1);
 *   - it is NOT marked as not-for-untrusted-code (unlike the Node.js built-in WASI module);
 *   - it is suitable for untrusted code (the Node.js built-in WASI module is not).
 *
 * CAPABILITY ENFORCEMENT (V5 §2.4 — AR-021-02 fix):
 *   The host grants ONLY the capabilities in the ceiling. By default, wasmtime
 *   grants NO filesystem (--dir), NO network (-S tcp=n, -S udp=n, -S http=n),
 *   and NO environment (-S inherit-env=n). Filesystem access is granted ONLY
 *   if 'wasi:filesystem.read' or 'wasi:filesystem.write' is in the approved
 *   capability set, and ONLY to a per-execution temporary directory.
 *
 * RESOURCE ENFORCEMENT (V5 §2.3 — AR-021-03 fix):
 *   - executionBudget: enforced via `-W fuel=N`. Wasmtime traps when fuel is
 *     exhausted. This is REAL enforcement, not synthetic.
 *   - memoryBytes: enforced via `-W max-memory-size=N`. Wasmtime prevents
 *     memory.grow beyond this limit.
 *   - wallTimeMs: enforced via `-W timeout=Nms`. Wasmtime interrupts
 *     execution when the deadline is reached.
 *
 * MEASUREMENTS (V5 §2.3 — AR-021-04 fix):
 *   - wallTimeMs: REAL host-measured elapsed time (monotonic clock).
 *   - fuelUnits: the fuel LIMIT that was enforced (wasmtime CLI does not
 *     report exact fuel consumed; we report the limit as an upper bound).
 *     If fuel was exhausted, the limit IS the exact consumption.
 *   - peakLinearMemoryBytes: the memory LIMIT that was enforced (wasmtime CLI
 *     does not report exact peak; we report the limit as an upper bound).
 *   - hostcallBytes: REAL I/O accounting (input bytes + output bytes).
 *   - cpuTimeNs: not available from wasmtime CLI. Absent (not synthetic).
 *
 * TENANT ISOLATION (V5 §2.6 — AR-021-06, AR-021-07 fix):
 *   Each execute() call spawns a SEPARATE wasmtime subprocess with a FRESH
 *   temporary directory. There is NO shared state between executions:
 *   no shared address space (separate processes), no shared filesystem
 *   (fresh temp dir per execution), no shared stdout (subprocess stdout is
 *   captured per-execution via pipe, NOT via global monkey-patching).
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
    // V5 §2.7: deny-by-default if the sandbox is unavailable.
    if (!this.isAvailable()) {
      throw new SandboxUnavailableError(
        'WasmtimeSandboxHost is not available: wasmtime binary not found',
      )
    }

    // V5 §2.6: fresh temporary directory per execution (no shared state).
    const tmpDir = mkdtempSync(join(tmpdir(), 'wasmtime-sandbox-'))
    const wasmPath = join(tmpDir, 'module.wasm')
    writeFileSync(wasmPath, wasmModule)

    // Build wasmtime CLI args with REAL enforcement (AR-021-02, AR-021-03 fix).
    const args: string[] = ['run']

    // --- Resource enforcement (V5 §2.3 — distinct quantities) ---
    // Fuel: REAL enforcement via -W fuel=N (wasmtime traps when exhausted)
    if (ceiling.resources.executionBudget !== undefined && ceiling.resources.executionBudget > 0) {
      args.push('-W', `fuel=${ceiling.resources.executionBudget}`)
    }
    // Memory: REAL enforcement via -W max-memory-size=N
    if (ceiling.resources.memoryBytes !== undefined && ceiling.resources.memoryBytes > 0) {
      args.push('-W', `max-memory-size=${ceiling.resources.memoryBytes}`)
    }
    // Wall-clock: REAL enforcement via -W timeout=Nms (wasmtime interrupts)
    if (ceiling.resources.wallTimeMs !== undefined && ceiling.resources.wallTimeMs > 0) {
      args.push('-W', `timeout=${ceiling.resources.wallTimeMs}ms`)
    }
    // Trap on memory.grow failure (so memory limits are enforced as traps, not silent -1 returns)
    args.push('-W', 'trap-on-grow-failure=y')

    // --- Capability enforcement (V5 §2.4 — no ambient authority) ---
    // By default, wasmtime grants NO filesystem, NO network, NO env.
    // Only grant explicitly approved capabilities:
    const hasFsRead = ceiling.capabilities.capabilities.includes('wasi:filesystem.read')
    const hasFsWrite = ceiling.capabilities.capabilities.includes('wasi:filesystem.write')
    if (hasFsRead || hasFsWrite) {
      // Grant access ONLY to the per-execution temp directory
      args.push('--dir', `${tmpDir}::/`)
    }
    // No --dir for other cases → no FS access
    // No TCP sockets flag is passed — no network access
    // No UDP sockets flag is passed — no network access
    // No HTTP flag is passed — no HTTP access
    // No network inheritance flag is passed — no network
    // No env inheritance flag is passed — no env access

    // Capture stdout/stderr via subprocess pipe (AR-021-06 fix).
    // We do NOT set inherit-stdout=n — that would suppress guest stdout.
    // Instead, we rely on the subprocess pipe to capture wasmtime's stdout
    // (which includes the guest's stdout writes). Each subprocess has its
    // own pipe, so there is no cross-execution leakage (no global monkey-patching).

    // The WASM module path
    args.push(wasmPath)

    // V5 §2.3: track measurements
    const startTime = Date.now()
    const startHrtime = process.hrtime.bigint()
    let fuelUnits = ceiling.resources.executionBudget ?? 0
    let peakLinearMemoryBytes = ceiling.resources.memoryBytes ?? 0
    const hostcallBytes = input.length // will add output length after execution

    try {
      let stdout: Buffer
      let stderr: Buffer
      let exitCode: number
      let signal: string | null
      let execErrMsg = ''

      try {
        // Execute wasmtime as a subprocess with REAL enforcement.
        // Input is passed via stdin; output is captured via stdout pipe.
        // No global stdout monkey-patching (AR-021-06 fix).
        const result = execFileSync('wasmtime', args, {
          input: input,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: ceiling.resources.wallTimeMs
            ? ceiling.resources.wallTimeMs + 2000 // host-level timeout as backstop
            : 30000,
          maxBuffer: 10 * 1024 * 1024, // 10MB
        })
        stdout = result
        stderr = Buffer.alloc(0)
        exitCode = 0
        signal = null
      } catch (err: unknown) {
        const execErr = err as {
          stdout?: Buffer
          stderr?: Buffer
          status?: number
          code?: number | string
          signal?: string
          killed?: boolean
          message?: string
        }
        stdout = execErr.stdout ?? Buffer.alloc(0)
        stderr = execErr.stderr ?? Buffer.alloc(0)
        execErrMsg = execErr.message ?? ''
        // execFileSync error: `status` is the numeric exit code;
        // `code` is a string error code (e.g. "ENOENT") or undefined.
        // `signal` is the signal name if killed by signal.
        exitCode = typeof execErr.status === 'number' ? execErr.status : (typeof execErr.code === 'number' ? execErr.code : 1)
        signal = execErr.signal ?? null
      }

      // V5 §2.3: compute REAL measurements
      const elapsedMs = Date.now() - startTime
      const totalHostcallBytes = hostcallBytes + stdout.length

      // Parse stderr for fuel/memory/timeout classification.
      // NOTE: we use stderr ONLY (not the execFileSync error message) because
      // the error message includes the full command line, which contains
      // flag names like "fuel" and "timeout" that would cause false matches.
      const stderrStr = stderr.toString('utf8')

      // Check signal first: if the host killed the process (SIGTERM/SIGKILL),
      // it's a host-level timeout.
      const isHostTimeout = signal === 'SIGTERM' || signal === 'SIGKILL'

      // Success case
      if (exitCode === 0) {
        const capabilitiesExercised: string[] = []
        if (hasFsRead) capabilitiesExercised.push('wasi:filesystem.read')
        if (hasFsWrite) capabilitiesExercised.push('wasi:filesystem.write')

        return {
          output: stdout,
          measurements: {
            // Fuel: the limit that was enforced. If the module didn't trap,
            // actual consumption is ≤ limit. Wasmtime CLI doesn't report
            // exact consumption, so we report the limit as an upper bound.
            fuelUnits,
            // Wall-clock: REAL host-measured elapsed time
            wallTimeMs: elapsedMs,
            // Memory: the limit that was enforced. Actual peak is ≤ limit.
            peakLinearMemoryBytes,
            // I/O: REAL bytes transferred across the sandbox boundary
            hostcallBytes: totalHostcallBytes,
            // cpuTimeNs: not available from wasmtime CLI (honestly absent)
          },
          capabilitiesExercised,
        }
      }

      // Classify failures (V5 §2.5 — architectural termination contract)
      const partialMeasurements: Partial<SandboxMeasurements> = {
        fuelUnits,
        wallTimeMs: elapsedMs,
        peakLinearMemoryBytes,
        hostcallBytes: totalHostcallBytes,
      }

      // Timeout (wall-clock deadline exceeded — wasmtime reports "interrupt")
      // Check both stderr and error message for "interrupt" (which doesn't
      // appear in wasmtime command-line flags, so it's safe to check in msg).
      if (isHostTimeout || stderrStr.includes('interrupt') || execErrMsg.includes('interrupt')) {
        throw new SandboxTerminatedError(
          `Sandbox execution terminated: wall-clock timeout after ${elapsedMs}ms`,
          'timeout',
          partialMeasurements,
        )
      }

      // Fuel exhaustion (wasmtime reports "all fuel consumed")
      if (stderrStr.includes('fuel')) {
        throw new SandboxTerminatedError(
          `Sandbox execution terminated: execution budget (fuel) exhausted after consuming ${fuelUnits} units`,
          'fuel_exhausted',
          partialMeasurements,
        )
      }

      // Memory exceeded (wasmtime reports memory grow failure)
      if (stderrStr.includes('memory') || stderrStr.includes('grow')) {
        throw new SandboxTerminatedError(
          `Sandbox execution terminated: memory limit exceeded (${peakLinearMemoryBytes} bytes)`,
          'memory_exceeded',
          partialMeasurements,
        )
      }

      // Capability denied (unresolved import)
      if (stderrStr.includes('unknown import') || stderrStr.includes('not found') || execErrMsg.includes('unknown import')) {
        const match = stderrStr.match(/"([^"]+)"/)
        const deniedCap = match ? match[1] : 'unknown'
        throw new SandboxCapabilityDeniedError(
          `Sandbox capability denied: import "${deniedCap}" is not granted by the ceiling`,
          deniedCap,
        )
      }

      // Other execution failure
      throw new Error(`Sandbox execution failed (exit ${exitCode}): ${stderrStr.slice(0, 500)}`)
    } finally {
      // V5 §2.6: clean up temp directory (no shared state between executions)
      rmSync(tmpDir, { recursive: true, force: true })
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
}

// Backward-compatible alias (tests may reference the old name)
export const WasmerSandboxHost = WasmtimeSandboxHost
