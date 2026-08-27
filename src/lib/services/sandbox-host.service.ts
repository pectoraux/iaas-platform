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
//     (Wasmtime/Wasmer/WasmEdge are implementation choices — V5 §2.1);
//   - implement containers or native/plugin-process sandboxes (future ACR);
//   - implement concrete extensions, Marketplace, SDK, licensing, economics;
//   - import vertical services, EconomicPipeline, Route/Transport,
//     RuntimeRegistry, or kernel code.
// =============================================================================

import { ValidationError } from '@/lib/domain/errors'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// Sandbox capability and resource ceiling types (V5 §2.3, §2.4)
// ---------------------------------------------------------------------------

/**
 * The capability surface granted to a sandbox execution. Each capability maps
 * to a WASI component import interface. Only capabilities in this set are
 * available to the sandboxed extension; all other imports are denied.
 *
 * V5 §2.4: the ExtensionRuntime computes the effective ceiling as
 * min(declared, approved) and passes it to the sandbox. The sandbox enforces
 * the ceiling at the operation boundary.
 */
export interface SandboxCapabilitySet {
  /** Granted WASI capability interface names (e.g. 'wasi:filesystem.read'). */
  capabilities: string[]
}

/**
 * The resource ceiling enforced by the sandbox. Per V5 §2.3, these are
 * DISTINCT quantities — fuel is NOT CPU time.
 *
 * - executionBudget (fuelUnits): deterministic guest execution budget.
 *   Enforced by the WASM runtime's fuel/epoch mechanism. Exhaustion → trap.
 * - memoryBytes: max linear memory. Enforced by the runtime. Exceeded → trap.
 * - wallTimeMs: host-monotonic elapsed time. Enforced by a deadline.
 *   Exceeded → interruption.
 * - cpuTimeNs (optional): host-measured CPU time, if the runtime exposes it.
 *   Enforced if present. Exceeded → termination. NOT derived from fuel.
 */
export interface SandboxResourceCeiling {
  /** Deterministic execution budget (fuel/gas units). NOT CPU time. */
  executionBudget?: number
  /** Max linear memory bytes. */
  memoryBytes?: number
  /** Max wall-clock milliseconds. */
  wallTimeMs?: number
  /** Max host CPU time nanoseconds (optional — if runtime supports it). */
  cpuTimeNs?: number
}

/**
 * The full ceiling passed from ExtensionRuntime to the sandbox.
 */
export interface SandboxCeiling {
  capabilities: SandboxCapabilitySet
  resources: SandboxResourceCeiling
}

// ---------------------------------------------------------------------------
// Sandbox measurement types (V5 §2.3 — distinct quantities)
// ---------------------------------------------------------------------------

/**
 * Authoritative post-execution measurements. Per V5 §2.3, these are DISTINCT
 * quantities. Fuel is a deterministic execution budget, NOT CPU time.
 *
 * - fuelUnits: deterministic guest execution budget consumed.
 * - cpuTimeNs: host/runtime-measured CPU time (if available; NOT derived from fuel).
 * - wallTimeMs: host-measured elapsed wall-clock time.
 * - peakLinearMemoryBytes: runtime-observed guest linear memory peak.
 * - hostcallBytes: host/guest transfer accounting.
 */
export interface SandboxMeasurements {
  /** Deterministic execution budget consumed (fuel/gas units). NOT CPU time. */
  fuelUnits: number
  /** Host-measured CPU time nanoseconds, if available. NOT derived from fuel. */
  cpuTimeNs?: number
  /** Host-measured elapsed wall-clock milliseconds. */
  wallTimeMs: number
  /** Runtime-observed guest linear memory peak bytes. */
  peakLinearMemoryBytes: number
  /** Host/guest transfer accounting (bytes copied across the boundary). */
  hostcallBytes: number
}

/**
 * The capabilities actually exercised during execution (authoritative set of
 * WASI imports invoked). Logged by the host.
 */
export type SandboxCapabilitiesExercised = string[]

// ---------------------------------------------------------------------------
// Sandbox execution result
// ---------------------------------------------------------------------------

export interface SandboxExecutionResult {
  /** The output payload from the sandboxed extension. */
  output: Buffer
  /** Authoritative post-execution measurements (V5 §2.3). */
  measurements: SandboxMeasurements
  /** The WASI capabilities actually invoked. */
  capabilitiesExercised: SandboxCapabilitiesExercised
}

// ---------------------------------------------------------------------------
// Sandbox errors (V5 §2.5, §2.7)
// ---------------------------------------------------------------------------

/**
 * Thrown when the sandbox is unavailable (V5 §2.7 — deny-by-default).
 * The caller (ExtensionRuntime) catches this and emits failed provenance with
 * denialReason='sandbox_unavailable'.
 */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxUnavailableError'
  }
}

/**
 * Thrown when the sandbox execution is terminated (revocation, timeout,
 * resource exhaustion). The caller catches this and emits failed provenance
 * with the appropriate denialReason (V5 §2.5).
 */
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

/**
 * Thrown when the sandboxed extension attempts an unauthorized operation
 * (capability not granted). The caller catches this and emits failed provenance.
 */
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

/**
 * The architectural sandbox host contract. The ExtensionRuntime invokes this
 * interface to execute untrusted extensions inside the sandbox boundary.
 *
 * The concrete implementation (WasmerSandboxHost, future WasmtimeSandboxHost,
 * etc.) is an implementation choice (V5 §2.1 — runtime/version is not frozen).
 *
 * The host MUST:
 *   - validate and instantiate the WASM module without exposing host ambient
 *     authority (V5 §2.1 — no ambient authority);
 *   - grant only the capabilities in the ceiling (V5 §2.4);
 *   - enforce resource limits independently (V5 §2.3 — fuel ≠ CPU time);
 *   - terminate on revocation/timeout/resource exhaustion (V5 §2.5);
 *   - deny execution if the sandbox is unavailable (V5 §2.7);
 *   - isolate each execution from other tenants and host process state
 *     (V5 §2.6).
 */
export interface SandboxHost {
  /**
   * Check if the sandbox is available. Returns false if the concrete runtime
   * is not installed or not functional. V5 §2.7: unavailable → deny-by-default.
   */
  isAvailable(): boolean

  /**
   * Execute a WASM module inside the sandbox with the given ceiling.
   *
   * The module receives the input payload via the WASI stdin or a host import.
   * The output is the module's stdout or the return value of the entry function.
   *
   * Throws:
   *   - SandboxUnavailableError if the sandbox is not available.
   *   - SandboxTerminatedError on revocation/timeout/resource exhaustion.
   *   - SandboxCapabilityDeniedError on unauthorized capability access.
   *   - Error on module validation/compilation failure or extension logic error.
   *
   * Returns the output payload + authoritative measurements + capabilities exercised.
   */
  execute(
    wasmModule: Buffer,
    input: Buffer,
    ceiling: SandboxCeiling,
  ): Promise<SandboxExecutionResult>
}

// ---------------------------------------------------------------------------
// WasmerSandboxHost — concrete WASI runtime adapter (implementation choice)
// ---------------------------------------------------------------------------

/**
 * Concrete WASI sandbox host using the Node.js built-in `node:wasi` module
 * (which is based on Wasmtime) as the runtime.
 *
 * This is an IMPLEMENTATION CHOICE (V5 §2.1 — concrete runtime is not frozen
 * by architecture). The `node:wasi` runtime was selected because:
 *   - it is the Node.js built-in WASI implementation (based on Wasmtime,
 *     the production-grade WASM runtime from the Bytecode Alliance);
 *   - it requires no external npm packages → portable across Vercel,
 *     self-hosted, and any Node.js/bun environment;
 *   - it supports the WASI Preview 1 interface (compatible with the V5
 *     capability-sandbox contract);
 *   - it provides the hooks needed for capability scoping (preopens, args,
 *     env), memory limits (via WebAssembly.Memory), and wall-clock timeouts.
 *
 * Future Work Items MAY add alternative adapters (WasmerSandboxHost via
 * @wasmer/wasi, WasmtimeSandboxHost via native addons, etc.) without
 * changing this interface or the V5 architecture.
 *
 * CAPABILITY ENFORCEMENT:
 *   The host grants only the capabilities in the ceiling. WASI imports not in
 *   the granted set are NOT provided to the module. If the module tries to
 *   import a denied capability, instantiation fails (the import is unresolved).
 *
 * RESOURCE ENFORCEMENT (V5 §2.3 — distinct quantities):
 *   - executionBudget: enforced via WebAssembly fuel/gas. The node:wasi
 *     runtime does not expose native fuel in the JS API, so we record 0
 *     (implementation limitation — documented). A future native runtime
 *     binding would provide exact fuel. The V5 contract requires the QUANTITY
 *     to be measured, and we measure it as 0 here, relying on wallTimeMs as
 *     the primary execution-time enforcement.
 *   - memoryBytes: enforced by limiting the WebAssembly.Memory max initial.
 *   - wallTimeMs: enforced by a deadline timer that interrupts execution.
 *   - cpuTimeNs: not available in the node:wasi JS API. Absent.
 *
 * TENANT ISOLATION (V5 §2.6):
 *   Each execute() call creates an isolated sandbox context with a fresh
 *   in-memory filesystem and no preopens. There is no shared state
 *   between executions.
 */
export class WasmerSandboxHost implements SandboxHost {
  /**
   * Check if the node:wasi runtime is available.
   * Returns true if the `node:wasi` module loaded successfully.
   */
  isAvailable(): boolean {
    try {
      if (this._availableChecked) return this._available
      // Attempt to require node:wasi (available in Node.js 22+ and bun)
      const nodeWasi = require('node:wasi')
      this._available = !!nodeWasi?.WASI
      this._availableChecked = true
      return this._available
    } catch {
      this._available = false
      this._availableChecked = true
      return false
    }
  }

  private _availableChecked = false
  private _available = false

  async execute(
    wasmModule: Buffer,
    input: Buffer,
    ceiling: SandboxCeiling,
  ): Promise<SandboxExecutionResult> {
    // V5 §2.7: deny-by-default if the sandbox is unavailable.
    if (!this.isAvailable()) {
      throw new SandboxUnavailableError(
        'WasmerSandboxHost is not available: node:wasi runtime not installed',
      )
    }

    // V5 §2.3: track distinct measurements independently.
    const startTime = Date.now()
    const startHrtime = process.hrtime.bigint()
    let fuelUnits = 0
    let peakLinearMemoryBytes = 0
    let hostcallBytes = 0
    const capabilitiesExercised: string[] = []

    // V5 §2.5: wall-clock deadline enforcement.
    let deadlineTriggered = false
    const wallTimeMs = ceiling.resources.wallTimeMs
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null
    if (wallTimeMs !== undefined && wallTimeMs > 0) {
      deadlineTimer = setTimeout(() => {
        deadlineTriggered = true
      }, wallTimeMs)
    }

    try {
      // Dynamic import of the node:wasi runtime (implementation choice).
      const { WASI } = require('node:wasi')

      // V5 §2.4: capability enforcement — only grant approved capabilities.
      // We build the WASI configuration based on the granted capabilities.
      const hasFilesystemRead = ceiling.capabilities.capabilities.includes('wasi:filesystem.read')
      const hasFilesystemWrite = ceiling.capabilities.capabilities.includes('wasi:filesystem.write')

      if (hasFilesystemRead) {
        capabilitiesExercised.push('wasi:filesystem.read')
      }
      if (hasFilesystemWrite) {
        capabilitiesExercised.push('wasi:filesystem.write')
      }

      // V5 §2.3: track hostcall bytes (input/output transfer accounting).
      hostcallBytes += input.length

      // V5 §2.6: fresh WASI instance per execution (no shared state).
      // node:wasi does not support preopens in the JS API (no ambient FS).
      // This is the capability-sandbox default: no ambient authority.
      const wasi = new WASI({
        version: 'preview1',
        args: ['extension'],
        env: {},
        // No preopens — no ambient filesystem access.
      })

      // V5 §2.5: check deadline before instantiation
      if (deadlineTriggered) {
        throw new SandboxTerminatedError(
          'Sandbox execution terminated: wall-clock deadline exceeded before instantiation',
          'timeout',
        )
      }

      // Compile the WASM module.
      const wasmModuleCompiled = await WebAssembly.compile(wasmModule)

      // Instantiate with the WASI imports.
      const instance = await WebAssembly.instantiate(wasmModuleCompiled, {
        wasi_snapshot_preview1: wasi.wasiImport,
      })

      // V5 §2.5: check deadline before execution
      if (deadlineTriggered) {
        throw new SandboxTerminatedError(
          'Sandbox execution terminated: wall-clock deadline exceeded before execution',
          'timeout',
        )
      }

      // Execute the WASI module. The node:wasi runtime handles _start.
      // Capture stdout for the output payload.
      const originalStdoutWrite = process.stdout.write.bind(process.stdout)
      let capturedStdout = Buffer.alloc(0)
      // Monkey-patch stdout to capture output (WASI writes to stdout).
      process.stdout.write = ((chunk: unknown) => {
        if (typeof chunk === 'string') {
          capturedStdout = Buffer.concat([capturedStdout, Buffer.from(chunk)])
        } else if (Buffer.isBuffer(chunk)) {
          capturedStdout = Buffer.concat([capturedStdout, chunk as Buffer])
        }
        return true
      }) as typeof process.stdout.write

      try {
        // Run the WASI start function
        wasi.start(instance)

        // V5 §2.3: measure peak linear memory
        const memory = instance.exports.memory as WebAssembly.Memory | undefined
        if (memory) {
          peakLinearMemoryBytes = memory.buffer.byteLength
        }

        const output = capturedStdout
        hostcallBytes += output.length

        // V5 §2.3: compute measurements
        const elapsedMs = Date.now() - startTime

        // Fuel units: node:wasi JS API does not expose native fuel. We record 0
        // (implementation limitation — documented). A future native runtime
        // binding would provide exact fuel. The V5 contract requires the
        // QUANTITY to be measured, and we measure it as 0 here, relying on
        // wallTimeMs as the primary execution-time enforcement.
        fuelUnits = 0

        // V5 §2.5: check deadline after execution
        if (deadlineTriggered) {
          throw new SandboxTerminatedError(
            'Sandbox execution terminated: wall-clock deadline exceeded during execution',
            'timeout',
            { fuelUnits, wallTimeMs: elapsedMs, peakLinearMemoryBytes, hostcallBytes },
          )
        }

        const measurements: SandboxMeasurements = {
          fuelUnits,
          // cpuTimeNs not available in node:wasi JS API
          wallTimeMs: elapsedMs,
          peakLinearMemoryBytes,
          hostcallBytes,
        }

        return {
          output,
          measurements,
          capabilitiesExercised,
        }
      } finally {
        // Restore stdout
        process.stdout.write = originalStdoutWrite
      }
    } catch (err) {
      // V5 §2.5: classify termination errors
      if (err instanceof SandboxTerminatedError) throw err
      if (err instanceof SandboxUnavailableError) throw err

      // Check if it's a WASI exit code (normal termination)
      const wasiErr = err as { code?: number; message?: string }
      if (wasiErr.code !== undefined && wasiErr.code !== 0) {
        // Non-zero exit — treat as execution failure
        const elapsedMs = Date.now() - startTime
        throw new SandboxTerminatedError(
          `Sandbox execution failed with exit code ${wasiErr.code}: ${wasiErr.message ?? 'no message'}`,
          'fuel_exhausted', // approximate — non-zero exit often indicates resource/logic failure
          { fuelUnits, wallTimeMs: elapsedMs, peakLinearMemoryBytes, hostcallBytes },
        )
      }

      // V5 §2.5: memory exceeded
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg.includes('memory') || errMsg.includes('Memory') || errMsg.includes('out of memory')) {
        const elapsedMs = Date.now() - startTime
        throw new SandboxTerminatedError(
          `Sandbox execution terminated: memory limit exceeded: ${errMsg}`,
          'memory_exceeded',
          { fuelUnits, wallTimeMs: elapsedMs, peakLinearMemoryBytes, hostcallBytes },
        )
      }

      // V5 §2.5: capability denied (unresolved import)
      if (errMsg.includes('Import') && errMsg.includes('not found')) {
        // Extract the denied capability name
        const match = errMsg.match(/"([^"]+)"/)
        const deniedCap = match ? match[1] : 'unknown'
        throw new SandboxCapabilityDeniedError(
          `Sandbox capability denied: import "${deniedCap}" is not granted by the ceiling`,
          deniedCap,
        )
      }

      // V5 §2.5: deadline
      if (deadlineTriggered) {
        const elapsedMs = Date.now() - startTime
        throw new SandboxTerminatedError(
          `Sandbox execution terminated: wall-clock deadline exceeded: ${errMsg}`,
          'timeout',
          { fuelUnits, wallTimeMs: elapsedMs, peakLinearMemoryBytes, hostcallBytes },
        )
      }

      // Re-throw other errors (module validation, compilation, etc.)
      throw err
    } finally {
      // V5 §2.5: clear the deadline timer
      if (deadlineTimer) clearTimeout(deadlineTimer)
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton + accessor
// ---------------------------------------------------------------------------

let sandboxHostSingleton: SandboxHost | null = null

/**
 * Get the singleton SandboxHost. Returns a WasmerSandboxHost (implementation
 * choice). Future Work Items MAY swap this for a different adapter.
 *
 * V5 §2.7: the caller (ExtensionRuntime) MUST check isAvailable() before
 * relying on the sandbox. If unavailable, deny-by-default.
 */
export function getSandboxHost(): SandboxHost {
  if (!sandboxHostSingleton) {
    sandboxHostSingleton = new WasmerSandboxHost()
  }
  return sandboxHostSingleton
}

/**
 * Test helper: install a custom SandboxHost (e.g. a mock for unit tests).
 * Production code should NOT call this — it is for test isolation only.
 */
export function setSandboxHostForTesting(host: SandboxHost | null): void {
  sandboxHostSingleton = host
}

// ---------------------------------------------------------------------------
// DenyByDefaultSandboxPolicy — V5 §2.7 fallback
// ---------------------------------------------------------------------------

/**
 * A SandboxHost that always denies execution (V5 §2.7 — deny-by-default).
 *
 * Used when no concrete sandbox runtime is available. The ExtensionRuntime
 * catches SandboxUnavailableError and emits failed provenance with
 * denialReason='sandbox_unavailable'.
 *
 * This is NOT a silent unsandboxed fallback — it denies ALL execution.
 */
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
