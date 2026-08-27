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
// =============================================================================
// AR-021-18 fix — EXACT capability allowlist at the import/interface boundary
// =============================================================================
// Wasmtime's -S cli switch is documented as enabling the WASI CLI API family
// "including filesystems, sockets, clocks, and random". It has NO per-interface
// switches, so cli=y alone would expose a surface broader than the approved
// capability set. This host therefore enforces an EXACT interface allowlist:
//
//   approved capability set
//           ↓  (import verification — SandboxImportVerifier)
//   exact host interfaces the guest may import
//           ↓  (Component Model = statically-linked imports only)
//   all other interfaces unreachable
//
// Enforcement mechanism (deny-at-the-boundary, applied BEFORE execution):
//   1. The binary is classified as a Component Model binary (version bytes
//      0x0d 00 01 00) or a core WASM module (version bytes 01 00 00 00).
//   2. Component binaries: `wasm-tools component wit` extracts the world's
//      imported interfaces; every imported WASI interface must be authorized
//      by an approved capability (mapping table below). Non-WASI imports are
//      denied.
//   3. Core modules (WASI Preview 1): the binary's import section is parsed
//      directly; every imported wasi_snapshot_preview1 function must be
//      authorized by an approved capability (P1 function table below).
//   4. Because the WebAssembly Component Model and core WASM are BOTH
//      import-driven — a guest can only reach host functionality it statically
//      imports — a guest whose imports are all approved cannot reach any
//      unapproved interface, even though the runtime linker may hold more.
//   5. Defense in depth: when NO capability is approved the host runs with
//      cli=n so ALL WASI interfaces are unavailable at link time; network
//      flags are never passed; --dir is only passed for approved filesystem
//      capabilities; environment inheritance is never enabled.
//
// This is production enforcement, not a comment or test-only guarantee:
// SandboxCapabilityDeniedError is thrown before the runtime is ever spawned.
//
// Capability → interface mapping (WASI Preview 2, interface version stripped):
//   wasi:cli/stdout        → capability 'wasi:cli/stdout'
//   wasi:cli/stderr        → capability 'wasi:cli/stderr'
//   wasi:cli/stdin         → capability 'wasi:cli/stdin'
//   wasi:cli/terminal-*    → the corresponding stdio capability
//   wasi:cli/environment   → capability 'wasi:cli/environment'
//   wasi:cli/exit          → always allowed (self-termination; zero authority)
//   wasi:filesystem/*      → 'wasi:filesystem.read' and/or 'wasi:filesystem.write'
//   wasi:random/*          → capability 'wasi:random/random'
//   wasi:clocks/*          → the corresponding clocks capability
//   wasi:io/error|poll|streams → structural support interfaces (see
//                            STREAM_USING_CAPABILITIES below)
//   wasi:sockets/*         → NEVER authorized: no capability in the platform
//                            vocabulary grants network access. Socket imports
//                            are denied for every approved set.
//
// =============================================================================
// AR-021-19 fix — explicit termination-cause tracking
// =============================================================================
// The terminating host actor records its cause BEFORE killing the subprocess:
//   - revoke()          → hostCause = 'revoked'
//   - wall-clock backstop → hostCause = 'host-timeout'
// The close handler reports the recorded initiating cause and NEVER infers the
// cause from the termination signal (a SIGTERM may be sent by either actor).
// Guest-side traps (wasmtime -W timeout / fuel / memory) are classified from
// the runtime's own trap output when no host actor initiated termination.
// Node's spawn "timeout" option is intentionally NOT used: it kills with an
// ambiguous SIGTERM. The host owns an explicit backstop timer instead.
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
// AR-021-18 — SandboxImportVerifier: EXACT capability allowlist at the
// import/interface boundary. (Internal implementation detail of this host.)
// ---------------------------------------------------------------------------

/** Result of classifying a guest binary. */
type SandboxBinaryKind = 'component' | 'core-module'

interface SandboxBinaryImports {
  kind: SandboxBinaryKind
  /**
   * For components: imported interface names WITHOUT versions
   * (e.g. 'wasi:random/random'). For core modules: imported
   * (module, field) pairs (e.g. ('wasi_snapshot_preview1', 'random_get')).
   */
  componentInterfaces: string[]
  coreImports: { module: string; field: string }[]
}

/** WASM magic bytes "\0asm" as read via readUInt32LE (little-endian). */
const WASM_MAGIC = 0x6d_73_61_00
const CORE_MODULE_VERSION = 0x01
const COMPONENT_VERSION = 0x0d

/**
 * Component-model interface (version stripped) → capabilities that authorize
 * importing it. Interfaces absent from this table are DENIED for every
 * approved capability set (notably all wasi:sockets/*).
 */
const COMPONENT_INTERFACE_REQUIREMENTS: Record<string, readonly string[]> = {
  'wasi:cli/stdout': ['wasi:cli/stdout'],
  'wasi:cli/stderr': ['wasi:cli/stderr'],
  'wasi:cli/stdin': ['wasi:cli/stdin'],
  'wasi:cli/terminal-stdin': ['wasi:cli/stdin'],
  'wasi:cli/terminal-stdout': ['wasi:cli/stdout'],
  'wasi:cli/terminal-stderr': ['wasi:cli/stderr'],
  'wasi:cli/environment': ['wasi:cli/environment'],
  // Self-termination of the guest process: zero ambient authority.
  'wasi:cli/exit': [],
  'wasi:filesystem/preopens': ['wasi:filesystem.read', 'wasi:filesystem.write'],
  'wasi:filesystem/types': ['wasi:filesystem.read', 'wasi:filesystem.write'],
  'wasi:random/random': ['wasi:random/random'],
  'wasi:random/insecure': ['wasi:random/random'],
  'wasi:random/insecure-seed': ['wasi:random/random'],
  'wasi:clocks/monotonic-clock': ['wasi:clocks/monotonic-clock'],
  'wasi:clocks/wall-clock': ['wasi:clocks/wall-clock'],
  // NOTE: wasi:io/error, wasi:io/poll, and wasi:io/streams are structural
  // support interfaces handled by isStructuralSupportInterface() below —
  // they are NOT in this table.
}

/**
 * Capabilities whose approved interfaces structurally require the
 * wasi:io support interfaces (streams/poll/error). When at least one of
 * these capabilities is approved, the wasi:io/* support interfaces may be
 * imported; otherwise they are denied.
 */
const STREAM_USING_CAPABILITIES: readonly string[] = [
  'wasi:cli/stdout',
  'wasi:cli/stderr',
  'wasi:cli/stdin',
  'wasi:filesystem.read',
  'wasi:filesystem.write',
]

const STRUCTURAL_SUPPORT_INTERFACES: readonly string[] = [
  'wasi:io/error',
  'wasi:io/poll',
  'wasi:io/streams',
]

function isStructuralSupportInterface(iface: string): boolean {
  return STRUCTURAL_SUPPORT_INTERFACES.includes(iface)
}

/**
 * WASI Preview 1 core-module function → capabilities that authorize calling
 * it. Functions absent from this table (notably every sock_* function) are
 * DENIED for every approved capability set.
 *
 * Preview 1 exposes coarser operations than Preview 2 interfaces; each entry
 * maps the P1 operation to the minimal set of platform capabilities that
 * authorize it. Without --dir, file descriptors cannot exist at all, so a
 * guest that only imports fd_write can only reach the piped stdio of its own
 * subprocess (never ambient host files).
 */
const P1_FUNCTION_REQUIREMENTS: Record<string, readonly string[]> = {
  // Filesystem: path_* operations.
  'path_open': ['wasi:filesystem.read', 'wasi:filesystem.write'],
  'path_filestat_get': ['wasi:filesystem.read', 'wasi:filesystem.write'],
  'path_filestat_set_times': ['wasi:filesystem.write'],
  'path_readlink': ['wasi:filesystem.read'],
  'path_remove_directory': ['wasi:filesystem.write'],
  'path_rename': ['wasi:filesystem.write'],
  'path_symlink': ['wasi:filesystem.write'],
  'path_unlink_file': ['wasi:filesystem.write'],
  'path_create_directory': ['wasi:filesystem.write'],
  'fd_prestat_get': ['wasi:filesystem.read', 'wasi:filesystem.write'],
  'fd_prestat_dir_name': ['wasi:filesystem.read', 'wasi:filesystem.write'],
  'fd_readdir': ['wasi:filesystem.read'],
  // Filesystem: fd_* operations (fds can only be stdio or preopened files).
  'fd_read': ['wasi:filesystem.read', 'wasi:cli/stdin'],
  'fd_write': ['wasi:cli/stdout', 'wasi:cli/stderr', 'wasi:filesystem.write'],
  'fd_seek': ['wasi:filesystem.read', 'wasi:filesystem.write', 'wasi:cli/stdin', 'wasi:cli/stdout', 'wasi:cli/stderr'],
  'fd_tell': ['wasi:filesystem.read', 'wasi:filesystem.write', 'wasi:cli/stdin', 'wasi:cli/stdout', 'wasi:cli/stderr'],
  'fd_close': ['wasi:filesystem.read', 'wasi:filesystem.write', 'wasi:cli/stdin', 'wasi:cli/stdout', 'wasi:cli/stderr'],
  'fd_fdstat_get': ['wasi:filesystem.read', 'wasi:filesystem.write', 'wasi:cli/stdin', 'wasi:cli/stdout', 'wasi:cli/stderr'],
  'fd_fdstat_set_flags': ['wasi:filesystem.write', 'wasi:cli/stdout', 'wasi:cli/stderr'],
  'fd_filestat_get': ['wasi:filesystem.read', 'wasi:filesystem.write'],
  'fd_filestat_set_times': ['wasi:filesystem.write'],
  'fd_filestat_set_size': ['wasi:filesystem.write'],
  'fd_sync': ['wasi:filesystem.write'],
  'fd_datasync': ['wasi:filesystem.write'],
  'fd_allocate': ['wasi:filesystem.write'],
  'fd_advise': ['wasi:filesystem.read', 'wasi:filesystem.write'],
  // Random.
  'random_get': ['wasi:random/random'],
  // Clocks.
  'clock_time_get': ['wasi:clocks/monotonic-clock', 'wasi:clocks/wall-clock'],
  'clock_res_get': ['wasi:clocks/monotonic-clock', 'wasi:clocks/wall-clock'],
  // Poll (waits on clock timers or stdin).
  'poll_oneoff': ['wasi:clocks/monotonic-clock', 'wasi:clocks/wall-clock', 'wasi:cli/stdin'],
  // Environment/arguments (never granted unless explicitly approved).
  'environ_get': ['wasi:cli/environment'],
  'environ_sizes_get': ['wasi:cli/environment'],
  'args_get': ['wasi:cli/environment'],
  'args_sizes_get': ['wasi:cli/environment'],
  // Zero-authority operations: self-termination and scheduler yield.
  'proc_exit': [],
  'sched_yield': [],
  // NOTE: every sock_* function is intentionally absent — network access is
  // granted by NO capability in the platform vocabulary.
}

/**
 * AR-021-18: verify that a guest binary's statically declared imports are all
 * authorized by the approved capability set. Throws SandboxCapabilityDeniedError
 * BEFORE any execution when the guest declares an interface or operation
 * outside the approved set. Fail-closed: a binary whose imports cannot be
 * verified is denied.
 */
export function verifySandboxImports(
  wasmModule: Buffer,
  approvedCapabilities: ReadonlySet<string>,
  wasmPath?: string,
): SandboxBinaryImports {
  const imports = extractBinaryImports(wasmModule, wasmPath)

  if (imports.kind === 'component') {
    for (const iface of imports.componentInterfaces) {
      if (isStructuralSupportInterface(iface)) {
        const hasStreamUsingCapability = STREAM_USING_CAPABILITIES.some((c) =>
          approvedCapabilities.has(c),
        )
        if (!hasStreamUsingCapability) {
          throw new SandboxCapabilityDeniedError(
            `Sandbox capability denied: component interface "${iface}" is a structural support interface ` +
              `that requires an approved stream-using capability (stdio or filesystem); none is approved`,
            iface,
          )
        }
        continue
      }
      const authorizedBy = COMPONENT_INTERFACE_REQUIREMENTS[iface]
      if (authorizedBy === undefined) {
        // Unknown or unauthorized interface (includes every wasi:sockets/*
        // interface and all non-WASI interfaces). Network access is granted
        // by NO capability; deny-by-default for everything unrecognized.
        throw new SandboxCapabilityDeniedError(
          `Sandbox capability denied: component interface "${iface}" is not granted by the approved capability set ` +
            `(network/sockets and non-WASI interfaces are never granted)`,
          iface,
        )
      }
      const authorized = authorizedBy.length === 0 || authorizedBy.some((c) => approvedCapabilities.has(c))
      if (!authorized) {
        throw new SandboxCapabilityDeniedError(
          `Sandbox capability denied: component interface "${iface}" requires one of [${authorizedBy.join(', ')}]`,
          iface,
        )
      }
    }
    return imports
  }

  // Core module (WASI Preview 1 path): every wasi_snapshot_preview1 import
  // must be an authorized P1 operation. Any other module namespace import is
  // an unknown host function → denied.
  for (const imp of imports.coreImports) {
    if (imp.module === 'wasi_snapshot_preview1') {
      const authorizedBy = P1_FUNCTION_REQUIREMENTS[imp.field]
      if (authorizedBy === undefined) {
        throw new SandboxCapabilityDeniedError(
          `Sandbox capability denied: wasi_snapshot_preview1 operation "${imp.field}" is not granted by the approved ` +
            `capability set (socket and unknown operations are never granted)`,
          `wasi_snapshot_preview1.${imp.field}`,
        )
      }
      const authorized = authorizedBy.length === 0 || authorizedBy.some((c) => approvedCapabilities.has(c))
      if (!authorized) {
        throw new SandboxCapabilityDeniedError(
          `Sandbox capability denied: wasi_snapshot_preview1 operation "${imp.field}" requires one of [${authorizedBy.join(', ')}]`,
          `wasi_snapshot_preview1.${imp.field}`,
        )
      }
    } else {
      throw new SandboxCapabilityDeniedError(
        `Sandbox capability denied: non-WASI import "${imp.module}::${imp.field}" is not granted ` +
          `(the sandbox provides no custom host functions)`,
        `${imp.module}::${imp.field}`,
      )
    }
  }
  return imports
}

// ---------------------------------------------------------------------------
// AR-021-18 — binary import extraction
// ---------------------------------------------------------------------------

/** Read a little-endian base-128 varint starting at `offset`. Fail-closed. */
function readVarUint(bytes: Buffer, offset: number): { value: number; next: number } {
  let result = 0
  let shift = 0
  let pos = offset
  for (let i = 0; i < 5; i++) {
    if (pos >= bytes.length) throw new Error('unexpected end of wasm binary reading varuint')
    const byte = bytes[pos]
    pos++
    result += (byte & 0x7f) * Math.pow(2, shift)
    if ((byte & 0x80) === 0) return { value: result, next: pos }
    shift += 7
  }
  throw new Error('varuint too long')
}

/** Read a length-prefixed UTF-8 name starting at `offset`. Fail-closed. */
function readName(bytes: Buffer, offset: number): { value: string; next: number } {
  const { value: len, next: afterLen } = readVarUint(bytes, offset)
  if (afterLen + len > bytes.length) throw new Error('unexpected end of wasm binary reading name')
  return {
    value: bytes.toString('utf8', afterLen, afterLen + len),
    next: afterLen + len,
  }
}

/** Skip a limits type (flag byte + optional min/max). Fail-closed. */
function skipLimits(bytes: Buffer, offset: number): number {
  if (offset >= bytes.length) throw new Error('unexpected end of wasm binary reading limits')
  const flags = bytes[offset]
  let pos = offset + 1
  const min = readVarUint(bytes, pos)
  pos = min.next
  if ((flags & 0x01) !== 0) {
    const max = readVarUint(bytes, pos)
    pos = max.next
  }
  return pos
}

/**
 * Parse the import section of a CORE wasm binary directly (no external
 * dependency; fail-closed on any parse anomaly).
 */
function parseCoreModuleImports(bytes: Buffer): { module: string; field: string }[] {
  const imports: { module: string; field: string }[] = []
  let pos = 8 // magic (4) + version (4)
  while (pos < bytes.length) {
    const sectionId = bytes[pos]
    const size = readVarUint(bytes, pos + 1)
    const bodyStart = size.next
    const bodyEnd = bodyStart + size.value
    if (bodyEnd > bytes.length) throw new Error('wasm section extends past end of binary')
    if (sectionId === 2) {
      // Import section.
      const count = readVarUint(bytes, bodyStart)
      let ipos = count.next
      for (let i = 0; i < count.value; i++) {
        const moduleName = readName(bytes, ipos)
        ipos = moduleName.next
        const fieldName = readName(bytes, ipos)
        ipos = fieldName.next
        if (ipos >= bytes.length) throw new Error('unexpected end of wasm binary reading import kind')
        const kind = bytes[ipos]
        ipos++
        if (kind === 0x00) {
          // function import: type index
          const typeIdx = readVarUint(bytes, ipos)
          ipos = typeIdx.next
        } else if (kind === 0x01) {
          // table import: elemtype byte + limits
          if (ipos >= bytes.length) throw new Error('unexpected end of wasm binary reading table type')
          ipos++ // element type (single byte for MVP/P1-era modules)
          ipos = skipLimits(bytes, ipos)
        } else if (kind === 0x02) {
          // memory import: limits
          ipos = skipLimits(bytes, ipos)
        } else if (kind === 0x03) {
          // global import: value type byte + mutability byte
          if (ipos + 1 >= bytes.length) throw new Error('unexpected end of wasm binary reading global type')
          ipos += 2
        } else if (kind === 0x04) {
          // tag import (exception handling proposal): attribute + type index
          const attr = readVarUint(bytes, ipos)
          ipos = attr.next
          const typeIdx = readVarUint(bytes, ipos)
          ipos = typeIdx.next
        } else {
          throw new Error(`unknown import kind 0x${kind.toString(16)}`)
        }
        imports.push({ module: moduleName.value, field: fieldName.value })
      }
    }
    pos = bodyEnd
  }
  return imports
}

/**
 * Extract a component's imported interface names (version-stripped) via
 * `wasm-tools component wit`. Fail-closed.
 */
function parseComponentInterfaces(wasmPath: string): string[] {
  let witText: string
  try {
    witText = execFileSync('wasm-tools', ['component', 'wit', wasmPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    }).toString('utf8')
  } catch {
    throw new SandboxCapabilityDeniedError(
      'Sandbox capability denied: component imports could not be verified (wasm-tools unavailable or binary invalid)',
      'unverifiable-component-imports',
    )
  }
  const interfaces: string[] = []
  const interfaceImport = /^[ \t]*import[ \t]+([a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9-]+(?:-[a-z0-9]+)*\/[a-z0-9-]+(?:-[a-z0-9]+)*)@[0-9][0-9a-z.\-]*;[ \t]*$/
  const anyImport = /^[ \t]*import[ \t]+/
  for (const line of witText.split('\n')) {
    if (!anyImport.test(line)) continue
    const match = line.match(interfaceImport)
    if (match) {
      interfaces.push(match[1])
    } else {
      // World-level import that is NOT a namespaced-versioned interface
      // (bare function, plain name, or unversioned import): treat as an
      // unauthorized custom import. Fail-closed.
      const bare = line.match(/^[ \t]*import[ \t]+([^;:]+);[ \t]*$/)
      throw new SandboxCapabilityDeniedError(
        `Sandbox capability denied: non-interface component import "${bare ? bare[1].trim() : line.trim()}" is not granted`,
        bare ? bare[1].trim() : 'unknown-import',
      )
    }
  }
  return interfaces
}

/** Classify a wasm binary and extract its declared imports. Fail-closed. */
function extractBinaryImports(wasmModule: Buffer, wasmPath?: string): SandboxBinaryImports {
  if (wasmModule.length < 8) {
    throw new SandboxCapabilityDeniedError(
      'Sandbox capability denied: binary too small to be a valid wasm module',
      'unverifiable-binary',
    )
  }
  const magic = wasmModule.readUInt32LE(0)
  if (magic !== WASM_MAGIC) {
    throw new SandboxCapabilityDeniedError(
      'Sandbox capability denied: not a WebAssembly binary',
      'unverifiable-binary',
    )
  }
  const versionByte = wasmModule[4]
  if (versionByte === COMPONENT_VERSION && wasmModule[5] === 0 && wasmModule[6] === 1 && wasmModule[7] === 0) {
    if (!wasmPath) {
      throw new SandboxCapabilityDeniedError(
        'Sandbox capability denied: component imports could not be verified (no path provided)',
        'unverifiable-component-imports',
      )
    }
    return {
      kind: 'component',
      componentInterfaces: parseComponentInterfaces(wasmPath),
      coreImports: [],
    }
  }
  if (versionByte === CORE_MODULE_VERSION && wasmModule[5] === 0 && wasmModule[6] === 0 && wasmModule[7] === 0) {
    return {
      kind: 'core-module',
      componentInterfaces: [],
      coreImports: parseCoreModuleImports(wasmModule),
    }
  }
  throw new SandboxCapabilityDeniedError(
    `Sandbox capability denied: unsupported wasm binary version byte 0x${versionByte.toString(16)}`,
    'unverifiable-binary',
  )
}

// ---------------------------------------------------------------------------
// SandboxExecutionHandle — AR-021-11 fix: revocation support
// ---------------------------------------------------------------------------

/**
 * Handle to an active sandbox execution. Allows revocation (termination)
 * of an in-flight execution per V5 §2.5.
 *
 * AR-021-11 fix: execute() returns a handle that can be revoked.
 * Revocation records its explicit cause ('revoked') and then sends SIGTERM
 * to the wasmtime subprocess, terminating the sandbox execution context.
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
 * AR-021-19: the host actor that initiated termination of the subprocess.
 * Set BEFORE the kill signal is sent; the close handler reports this cause
 * instead of inferring from the signal (SIGTERM alone is ambiguous).
 */
type HostTerminationCause = 'revoked' | 'host-timeout'

/**
 * Concrete WASI sandbox host using the `wasmtime` CLI binary as a subprocess.
 *
 * This is an IMPLEMENTATION CHOICE (V5 §2.1 — concrete runtime is not frozen
 * by architecture). Wasmtime was selected because:
 *   - it is the Bytecode Alliance's production-grade WASM runtime;
 *   - it provides REAL enforcement of fuel/execution budget, memory limits,
 *     and wall-clock timeout via CLI flags (-W fuel=N, -W max-memory-size=N,
 *     -W timeout=Nms);
 *   - it executes the WASI Component Model (Preview 2) natively;
 *   - it enforces capability-scoped access via -S cli=n (disables ALL WASI
 *     imports) combined with this host's exact interface allowlist (see the
 *     AR-021-18 section above);
 *   - it is suitable for untrusted code.
 *
 * CAPABILITY ENFORCEMENT (V5 §2.4 — AR-021-02/09/15/18 fixes):
 *   - AR-021-18: SandboxImportVerifier denies any binary whose statically
 *     declared imports fall outside the approved capability set BEFORE the
 *     runtime is spawned. Because WASM guests can only reach imported
 *     host functionality, the effective exposed surface is EXACTLY the
 *     approved set.
 *   - No capabilities approved → -S cli=n: ALL WASI interfaces are
 *     unavailable at link time (any WASI import fails instantiation).
 *   - Capabilities approved → -S cli=y provides the WASI interface family,
 *     but only the verified approved interfaces are reachable by the guest.
 *   - --dir: granted ONLY when 'wasi:filesystem.read' or
 *     'wasi:filesystem.write' is approved. When only read is approved, the
 *     temp directory is set to read-only (chmod 555) — AR-021-13 fix. This is
 *     OS-level enforcement at the sandbox boundary: the kernel denies writes.
 *   - Network flags (tcp, udp, http, inherit-network, allow-ip-name-lookup)
 *     and environment inheritance are NEVER passed. No capability in the
 *     platform vocabulary grants network or ambient environment access.
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
 *   - cpuTimeNs: ABSENT (wasmtime CLI does not report CPU time).
 *   - enforcedLimits: SEPARATE field recording the enforcement ceilings
 *     (NOT in the usage fields).
 *
 * REVOCATION & TERMINATION CAUSES (V5 §2.5 — AR-021-11/19 fixes):
 *   executeWithHandle() uses child_process.spawn and returns a handle whose
 *   revoke() records the explicit cause 'revoked' before sending SIGTERM.
 *   The wall-clock backstop timer records 'host-timeout' before killing.
 *   The close handler reports the recorded initiating cause — it never
 *   infers revocation from a signal. Guest-side traps (fuel/memory/wasmtime
 *   timeout) are classified from the runtime's trap output.
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
      // AR-021-18: import verification requires wasm-tools for component
      // binaries. If it is missing, components cannot be verified, so the
      // sandbox declares itself unavailable (deny-by-default, V5 §2.7).
      execFileSync('wasm-tools', ['--version'], { stdio: 'pipe', timeout: 5000 })
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
        'WasmtimeSandboxHost is not available: wasmtime/wasm-tools binary not found',
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

    // --- AR-021-18: EXACT capability allowlist at the import boundary ---
    // Denies (SandboxCapabilityDeniedError) BEFORE the runtime is spawned if
    // the guest declares any import outside the approved capability set.
    const approvedCapabilities = new Set(ceiling.capabilities.capabilities)
    try {
      verifySandboxImports(wasmModule, approvedCapabilities, wasmPath)
    } catch (err) {
      // Deny-at-the-boundary: clean up the fresh temp dir and deny.
      rmSync(tmpDir, { recursive: true, force: true })
      return {
        result: Promise.reject(err instanceof Error ? err : new Error(String(err))),
        revoke: () => {},
        isRevoked: () => false,
      }
    }

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

    // --- Capability enforcement (V5 §2.4 — AR-021-09/18 fixes) ---
    const hasFsRead = ceiling.capabilities.capabilities.includes('wasi:filesystem.read')
    const hasFsWrite = ceiling.capabilities.capabilities.includes('wasi:filesystem.write')
    const hasAnyCapability = ceiling.capabilities.capabilities.length > 0

    if (hasAnyCapability) {
      // Provide the WASI interface family so the APPROVED interfaces can
      // link. The AR-021-18 import verification above guarantees the guest
      // cannot reach any interface outside the approved set: WASM guests
      // only reach host functionality through their statically declared
      // imports, which have all been verified as approved.
      args.push('-S', 'cli=y')
    } else {
      // NO capabilities approved: ALL WASI interfaces are unavailable at
      // link time — operation-level enforcement at the import boundary.
      args.push('-S', 'cli=n')
    }

    // Filesystem access: granted ONLY when an FS capability is approved.
    // AR-021-13: read-only enforcement (chmod 555) when only read is approved.
    const needsRestorePerms = hasFsRead && !hasFsWrite
    if (hasFsRead || hasFsWrite) {
      args.push('--dir', `${tmpDir}::/`)
      if (needsRestorePerms) {
        chmodSync(tmpDir, 0o555) // read + execute, no write
      }
    }

    // No TCP/UDP/HTTP/inherit-network/allow-ip-name-lookup/inherit-env flags
    // are passed, ever. Network and ambient environment access are NEVER
    // granted by any capability in the platform vocabulary, and wasmtime's
    // own socket feature flags remain disabled (their defaults).

    args.push(wasmPath)

    // V5 §2.3: track measurements
    const startTime = Date.now()
    const fuelLimit = ceiling.resources.executionBudget ?? 0
    const memoryLimit = ceiling.resources.memoryBytes ?? 0
    const hostcallBytes = input.length

    // --- AR-021-19: explicit termination-cause tracking ---
    // The terminating host actor records its cause BEFORE killing. The close
    // handler reports this cause; it never infers the cause from a signal.
    let revoked = false
    let closed = false
    let hostCause: HostTerminationCause | null = null
    let childProcess: ChildProcess | null = null
    let backstopTimer: ReturnType<typeof setTimeout> | null = null
    let killTimer: ReturnType<typeof setTimeout> | null = null

    const clearTimers = () => {
      if (backstopTimer) clearTimeout(backstopTimer)
      if (killTimer) clearTimeout(killTimer)
      backstopTimer = null
      killTimer = null
    }

    const resultPromise = new Promise<SandboxExecutionResult>((resolve, reject) => {
      // AR-021-19: the spawn "timeout" option is intentionally NOT used —
      // it kills with an ambiguous SIGTERM indistinguishable from
      // revocation. The host owns the backstop timer explicitly below.
      childProcess = spawn('wasmtime', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
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

      // AR-021-19: host-level wall-clock backstop. This is an operational
      // guard around the runtime's own -W timeout enforcement: if the
      // subprocess fails to die from the runtime-side timeout (or no
      // wallTimeMs ceiling was configured), the backstop terminates it and
      // records the explicit initiating cause 'host-timeout'.
      const graceMs = Number(process.env.IAAS_SANDBOX_BACKSTOP_GRACE_MS ?? '5000')
      const backstopMs = ceiling.resources.wallTimeMs
        ? ceiling.resources.wallTimeMs + (Number.isFinite(graceMs) ? graceMs : 5000)
        : 60000
      backstopTimer = setTimeout(() => {
        if (closed || !childProcess) return
        hostCause = hostCause ?? 'host-timeout'
        childProcess.kill('SIGTERM')
        killTimer = setTimeout(() => {
          if (!closed && childProcess) childProcess.kill('SIGKILL')
        }, 2000)
      }, backstopMs)
      backstopTimer.unref?.()

      childProcess.on('error', (err: Error) => {
        closed = true
        clearTimers()
        if (needsRestorePerms) chmodSync(tmpDir, 0o755)
        rmSync(tmpDir, { recursive: true, force: true })
        reject(err)
      })

      childProcess.on('close', (exitCode: number | null, signal: string | null) => {
        closed = true
        clearTimers()
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

        // --- AR-021-19: classify by EXPLICIT initiating cause first. ---
        // A SIGTERM alone is ambiguous (revocation and the host backstop
        // both send SIGTERM); only the recorded cause is authoritative.
        if (hostCause === 'revoked') {
          reject(new SandboxTerminatedError(
            `Sandbox execution terminated: revoked via explicit host revocation after ${elapsedMs}ms` +
              (signal ? ` (process signal: ${signal})` : ''),
            'revoked',
            partialMeasurements,
          ))
          return
        }
        if (hostCause === 'host-timeout') {
          reject(new SandboxTerminatedError(
            `Sandbox execution terminated: host wall-clock backstop after ${elapsedMs}ms` +
              (signal ? ` (process signal: ${signal})` : ''),
            'timeout',
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

        // Guest-side / runtime-side termination classification (no host
        // actor initiated termination; classify from the runtime's trap
        // output and exit status).
        if (stderrStr.includes('all fuel consumed') || stderrStr.includes('fuel')) {
          reject(new SandboxTerminatedError(
            `Sandbox execution terminated: execution budget (fuel) exhausted (limit: ${fuelLimit})`,
            'fuel_exhausted',
            partialMeasurements,
          ))
          return
        }

        if (stderrStr.includes('interrupt')) {
          // wasmtime's own -W timeout interrupts execution with
          // "wasm trap: interrupt".
          reject(new SandboxTerminatedError(
            `Sandbox execution terminated: wall-clock timeout after ${elapsedMs}ms (wasmtime -W timeout trap)`,
            'timeout',
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

        if (
          stderrStr.includes('unknown import') ||
          stderrStr.includes('not been defined') ||
          stderrStr.includes('has not been defined') ||
          stderrStr.includes('not found in the linker') ||
          stderrStr.includes('matching implementation was not found')
        ) {
          const match = stderrStr.match(/`([^`]+)`/)
          const deniedCap = match ? match[1] : 'unknown'
          reject(new SandboxCapabilityDeniedError(
            `Sandbox capability denied: import "${deniedCap}" is not granted by the ceiling`,
            deniedCap,
          ))
          return
        }

        reject(new Error(`Sandbox execution failed (exit ${exitCode}${signal ? `, signal ${signal}` : ''}): ${stderrStr.slice(0, 500)}`))
      })
    })

    return {
      result: resultPromise,
      revoke: () => {
        if (revoked || closed) {
          revoked = true
          return
        }
        // AR-021-19: record the EXPLICIT initiating cause BEFORE sending the
        // termination signal. The close handler reports this cause; it never
        // guesses from the signal.
        revoked = true
        hostCause = hostCause ?? 'revoked'
        if (childProcess && !childProcess.killed) {
          childProcess.kill('SIGTERM')
          killTimer = setTimeout(() => {
            if (!closed && childProcess) childProcess.kill('SIGKILL')
          }, 2000)
          killTimer.unref?.()
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
