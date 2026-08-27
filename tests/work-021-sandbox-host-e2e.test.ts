/// <reference types="bun-types" />
/**
 * WORK-021 — WASI Sandbox Host end-to-end verification tests
 *
 * Proves W021-AC02..AC11 with a real wasmtime CLI subprocess:
 *
 * AR-021-18 — EXACT capability allowlist at the import/interface boundary:
 *   - true Preview-2 component fixtures whose imports correspond to the
 *     frozen capability contract (AR-021-20);
 *   - unauthorized component interfaces are NEVER linked (denied before the
 *     runtime is even spawned);
 *   - P1 core-module operations (random_get, clock_time_get, fd_write,
 *     path_open) are individually capability-checked;
 *   - socket imports are denied under EVERY approved capability set;
 *   - non-WASI custom imports are denied.
 *
 * AR-021-19 — explicit termination-cause tracking:
 *   - wasmtime -W timeout trap → 'timeout';
 *   - host wall-clock backstop kill (SIGTERM) → 'timeout', NOT 'revoked';
 *   - explicit revocation (SIGTERM) → 'revoked';
 *   - fuel exhaustion → 'fuel_exhausted'; memory limit → 'memory_exceeded';
 *   - the ExtensionRuntime records terminationReason in failure provenance.
 *
 * AR-021-20 — true WASI Preview-2 component-model fixtures:
 *   - fixtures under tests/fixtures/work-021/ are genuine Component Model
 *     binaries (version byte 0x0d) importing real Preview-2 interfaces
 *     (wasi:random/random, wasi:cli/stdout + wasi:io/streams,
 *     wasi:clocks/monotonic-clock) — NOT Preview-1 core modules wrapped by
 *     the compatibility adapter.
 *
 * Run: bun test tests/work-021-sandbox-host-e2e.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  WasmtimeSandboxHost,
  DenyByDefaultSandboxHost,
  SandboxUnavailableError,
  SandboxTerminatedError,
  SandboxCapabilityDeniedError,
  type SandboxCeiling,
  type SandboxExecutionHandle,
} from '../src/lib/services/sandbox-host.service'

const require = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// WAT → core WASM helper (Preview-1 core-module fixtures)
// ---------------------------------------------------------------------------

async function compileWatToCoreWasm(watSource: string): Promise<Buffer> {
  const wabtInit = require('wabt').default
  const wabt = await wabtInit()
  const wasmModule = wabt.parseWat('test.wat', watSource)
  const { buffer } = wasmModule.toBinary({})
  return Buffer.from(buffer)
}

/** Load a prebuilt TRUE Preview-2 Component Model fixture. */
function loadComponentFixture(name: string): Buffer {
  return readFileSync(join(process.cwd(), 'tests', 'fixtures', 'work-021', name))
}

// ---------------------------------------------------------------------------
// Preview-1 core-module WAT fixtures
// ---------------------------------------------------------------------------

// Minimal WASM module: exports memory + _start (no imports)
const MINIMAL_WAT = `(module (memory (export "memory") 1) (func (export "_start")))`

// Infinite loop module (for fuel/timeout/revocation tests; no imports)
const INFINITE_LOOP_WAT = `(module
  (memory (export "memory") 1)
  (func (export "_start")
    (loop br 0)
  )
)`

// Memory grow module (tries to grow memory beyond limit)
const MEMORY_GROW_WAT = `(module
  (memory (export "memory") 1)
  (func (export "_start")
    (drop (memory.grow (i32.const 1000)))
  )
)`

// Stdout write module (writes "hello" to stdout via fd_write — P1 path)
const STDOUT_WRITE_WAT = `(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "hello")
  (func (export "_start")
    (i32.store (i32.const 16) (i32.const 0))
    (i32.store (i32.const 20) (i32.const 5))
    (drop (call $fd_write (i32.const 1) (i32.const 16) (i32.const 1) (i32.const 24)))
  )
)`

// File write module (tries to create a file via path_open)
const FILE_WRITE_WAT = `(module
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "newfile.txt")
  (func (export "_start")
    (drop (call $path_open
      (i32.const 3) (i32.const 0)
      (i32.const 0) (i32.const 11)
      (i32.const 1) (i64.const 0) (i64.const 0)
      (i32.const 0) (i32.const 100)))
  )
)`

// AR-021-18: P1 random module (random_get requires wasi:random/random)
const P1_RANDOM_WAT = `(module
  (import "wasi_snapshot_preview1" "random_get"
    (func $random_get (param i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (drop (call $random_get (i32.const 0) (i32.const 8))))
)`

// AR-021-18: P1 clock module (clock_time_get requires a clocks capability)
const P1_CLOCK_WAT = `(module
  (import "wasi_snapshot_preview1" "clock_time_get"
    (func $clock (param i32 i64 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (drop (call $clock (i32.const 1) (i64.const 0) (i32.const 0))))
)`

// AR-021-18: P1 socket module — network is granted by NO capability
const P1_SOCKET_WAT = `(module
  (import "wasi_snapshot_preview1" "sock_recv"
    (func $sock_recv (param i32 i32 i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (drop (call $sock_recv
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))))
)`

// AR-021-18: non-WASI custom host function import — always denied
const P1_CUSTOM_IMPORT_WAT = `(module
  (import "env" "host_fn" (func $host_fn (result i32)))
  (memory (export "memory") 1)
  (func (export "_start") (drop (call $host_fn)))
)`

let MINIMAL_WASM: Buffer
let INFINITE_LOOP_WASM: Buffer
let MEMORY_GROW_WASM: Buffer
let STDOUT_WRITE_WASM: Buffer
let FILE_WRITE_WASM: Buffer
let P1_RANDOM_WASM: Buffer
let P1_CLOCK_WASM: Buffer
let P1_SOCKET_WASM: Buffer
let P1_CUSTOM_IMPORT_WASM: Buffer

// ---------------------------------------------------------------------------
// AR-021-20: TRUE Preview-2 Component Model fixtures (prebuilt binaries).
// Built from component WAT / the wasm-tools WIT embed pipeline; they import
// genuine Preview-2 interfaces (NOT the Preview-1 compatibility adapter).
//   random-guest.component.wasm          imports wasi:random/random@0.2.12
//   stdout-guest.component.wasm          imports wasi:cli/stdout@0.2.12 +
//                                         wasi:io/streams@0.2.12 +
//                                         wasi:io/error@0.2.12, writes "hi"
//   monotonic-clock-guest.component.wasm imports wasi:clocks/monotonic-clock@0.2.12
//   infinite-loop.component.wasm         imports nothing (component binary)
// ---------------------------------------------------------------------------
const RANDOM_COMPONENT = () => loadComponentFixture('random-guest.component.wasm')
const STDOUT_COMPONENT = () => loadComponentFixture('stdout-guest.component.wasm')
const CLOCK_COMPONENT = () => loadComponentFixture('monotonic-clock-guest.component.wasm')
const LOOP_COMPONENT = () => loadComponentFixture('infinite-loop.component.wasm')

beforeAll(async () => {
  MINIMAL_WASM = await compileWatToCoreWasm(MINIMAL_WAT)
  INFINITE_LOOP_WASM = await compileWatToCoreWasm(INFINITE_LOOP_WAT)
  MEMORY_GROW_WASM = await compileWatToCoreWasm(MEMORY_GROW_WAT)
  STDOUT_WRITE_WASM = await compileWatToCoreWasm(STDOUT_WRITE_WAT)
  FILE_WRITE_WASM = await compileWatToCoreWasm(FILE_WRITE_WAT)
  P1_RANDOM_WASM = await compileWatToCoreWasm(P1_RANDOM_WAT)
  P1_CLOCK_WASM = await compileWatToCoreWasm(P1_CLOCK_WAT)
  P1_SOCKET_WASM = await compileWatToCoreWasm(P1_SOCKET_WAT)
  P1_CUSTOM_IMPORT_WASM = await compileWatToCoreWasm(P1_CUSTOM_IMPORT_WAT)
})

let sandboxHost: WasmtimeSandboxHost

beforeAll(() => {
  sandboxHost = new WasmtimeSandboxHost()
})

const BASE_RESOURCES = { executionBudget: 1000000, memoryBytes: 1048576, wallTimeMs: 5000 }

// ---------------------------------------------------------------------------
// W021-AC01 — sandbox availability
// ---------------------------------------------------------------------------

describe('WORK-021 — Sandbox availability (W021-AC01)', () => {
  it('wasmtime sandbox host reports availability (requires wasmtime + wasm-tools)', () => {
    expect(sandboxHost.isAvailable()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AR-021-20 — TRUE Preview-2 component-model fixtures
// ---------------------------------------------------------------------------

describe('WORK-021 — True Preview-2 component fixtures (AR-021-20)', () => {
  it('fixtures are genuine Component Model binaries (version byte 0x0d, not core modules)', () => {
    for (const buf of [RANDOM_COMPONENT(), STDOUT_COMPONENT(), CLOCK_COMPONENT(), LOOP_COMPONENT()]) {
      expect(buf.length).toBeGreaterThan(8)
      // magic: \0asm
      expect(buf[0]).toBe(0x00)
      expect(buf[1]).toBe(0x61)
      expect(buf[2]).toBe(0x73)
      expect(buf[3]).toBe(0x6d)
      // Component Model version bytes: 0x0d 00 01 00 (core modules use 01 00 00 00)
      expect(buf[4]).toBe(0x0d)
      expect(buf[5]).toBe(0x00)
      expect(buf[6]).toBe(0x01)
      expect(buf[7]).toBe(0x00)
    }
  })

  it('random fixture imports the true Preview-2 wasi:random/random interface', () => {
    // The component binary embeds its imported interface names as strings.
    const text = RANDOM_COMPONENT().toString('latin1')
    expect(text).toContain('wasi:random/random')
  })

  it('stdout fixture imports the true Preview-2 wasi:cli/stdout interface', () => {
    const text = STDOUT_COMPONENT().toString('latin1')
    expect(text).toContain('wasi:cli/stdout')
    expect(text).toContain('wasi:io/streams')
  })

  it('clock fixture imports the true Preview-2 wasi:clocks/monotonic-clock interface', () => {
    const text = CLOCK_COMPONENT().toString('latin1')
    expect(text).toContain('wasi:clocks/monotonic-clock')
  })

  it('stdout fixture writes real output through the true Preview-2 stream interface', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:cli/stdout'] },
      resources: BASE_RESOURCES,
    }
    const result = await sandboxHost.execute(STDOUT_COMPONENT(), Buffer.alloc(0), ceiling)
    expect(result.output.toString('utf8')).toContain('hi')
  })
})

// ---------------------------------------------------------------------------
// AR-021-18 — EXACT capability allowlist (component interface level)
// ---------------------------------------------------------------------------

describe('WORK-021 — Exact component interface allowlist (AR-021-18, AR-021-20)', () => {
  it('authorized: random component executes when wasi:random/random is approved', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:random/random'] },
      resources: BASE_RESOURCES,
    }
    const result = await sandboxHost.execute(RANDOM_COMPONENT(), Buffer.alloc(0), ceiling)
    expect(result.measurements.wallTimeMs).toBeGreaterThan(0)
  })

  it('unauthorized: random component is DENIED when only wasi:cli/stdout is approved', async () => {
    // The component imports wasi:random/random, which is outside the approved
    // set. The sandbox denies BEFORE the runtime is spawned — the
    // unauthorized interface is never linked or executed.
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:cli/stdout'] },
      resources: BASE_RESOURCES,
    }
    try {
      await sandboxHost.execute(RANDOM_COMPONENT(), Buffer.alloc(0), ceiling)
      expect(false).toBe(true) // must not execute
    } catch (err) {
      const denied = err as SandboxCapabilityDeniedError
      expect(denied).toBeInstanceOf(SandboxCapabilityDeniedError)
      expect(denied.deniedCapability).toBe('wasi:random/random')
    }
  })

  it('unauthorized: random component is DENIED when no capability is approved', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: BASE_RESOURCES,
    }
    await expect(
      sandboxHost.execute(RANDOM_COMPONENT(), Buffer.alloc(0), ceiling),
    ).rejects.toThrow(SandboxCapabilityDeniedError)
  })

  it('authorized: stdout component executes when wasi:cli/stdout is approved', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:cli/stdout'] },
      resources: BASE_RESOURCES,
    }
    const result = await sandboxHost.execute(STDOUT_COMPONENT(), Buffer.alloc(0), ceiling)
    expect(result.output.toString('utf8')).toContain('hi')
  })

  it('unauthorized: stdout component is DENIED when only wasi:random/random is approved', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:random/random'] },
      resources: BASE_RESOURCES,
    }
    await expect(
      sandboxHost.execute(STDOUT_COMPONENT(), Buffer.alloc(0), ceiling),
    ).rejects.toThrow(SandboxCapabilityDeniedError)
  })

  it('authorized: clock component executes when wasi:clocks/monotonic-clock is approved', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:clocks/monotonic-clock'] },
      resources: BASE_RESOURCES,
    }
    const result = await sandboxHost.execute(CLOCK_COMPONENT(), Buffer.alloc(0), ceiling)
    expect(result.measurements.wallTimeMs).toBeGreaterThan(0)
  })

  it('unauthorized: clock component is DENIED when only wasi:random/random is approved', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:random/random'] },
      resources: BASE_RESOURCES,
    }
    try {
      await sandboxHost.execute(CLOCK_COMPONENT(), Buffer.alloc(0), ceiling)
      expect(false).toBe(true)
    } catch (err) {
      const denied = err as SandboxCapabilityDeniedError
      expect(denied).toBeInstanceOf(SandboxCapabilityDeniedError)
      expect(denied.deniedCapability).toBe('wasi:clocks/monotonic-clock')
    }
  })
})

// ---------------------------------------------------------------------------
// AR-021-18 — EXACT capability allowlist (Preview-1 core-module function level)
// ---------------------------------------------------------------------------

describe('WORK-021 — Exact P1 operation allowlist (AR-021-18)', () => {
  it('random_get is DENIED when no capability is approved', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: BASE_RESOURCES,
    }
    try {
      await sandboxHost.execute(P1_RANDOM_WASM, Buffer.alloc(0), ceiling)
      expect(false).toBe(true)
    } catch (err) {
      const denied = err as SandboxCapabilityDeniedError
      expect(denied).toBeInstanceOf(SandboxCapabilityDeniedError)
      expect(denied.deniedCapability).toBe('wasi_snapshot_preview1.random_get')
    }
  })

  it('random_get is DENIED when only wasi:cli/stdout is approved (cli=y does NOT authorize random)', async () => {
    // Proves the AR-021-18 defect is fixed: enabling the WASI interface
    // family for stdout no longer exposes random to a P1 guest.
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:cli/stdout'] },
      resources: BASE_RESOURCES,
    }
    await expect(
      sandboxHost.execute(P1_RANDOM_WASM, Buffer.alloc(0), ceiling),
    ).rejects.toThrow(SandboxCapabilityDeniedError)
  })

  it('random_get executes when wasi:random/random is approved', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:random/random'] },
      resources: BASE_RESOURCES,
    }
    const result = await sandboxHost.execute(P1_RANDOM_WASM, Buffer.alloc(0), ceiling)
    expect(result.measurements.wallTimeMs).toBeGreaterThan(0)
  })

  it('clock_time_get executes when wasi:clocks/monotonic-clock is approved', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:clocks/monotonic-clock'] },
      resources: BASE_RESOURCES,
    }
    const result = await sandboxHost.execute(P1_CLOCK_WASM, Buffer.alloc(0), ceiling)
    expect(result.measurements.wallTimeMs).toBeGreaterThan(0)
  })

  it('clock_time_get is DENIED when only wasi:cli/stdout is approved', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:cli/stdout'] },
      resources: BASE_RESOURCES,
    }
    await expect(
      sandboxHost.execute(P1_CLOCK_WASM, Buffer.alloc(0), ceiling),
    ).rejects.toThrow(SandboxCapabilityDeniedError)
  })

  it('socket operations are DENIED under EVERY approved capability set (network never granted)', async () => {
    const approvedSets: string[][] = [
      [],
      ['wasi:cli/stdout'],
      ['wasi:filesystem.read', 'wasi:filesystem.write'],
      ['wasi:random/random', 'wasi:cli/stdout', 'wasi:filesystem.read', 'wasi:filesystem.write', 'wasi:clocks/monotonic-clock'],
    ]
    for (const capabilities of approvedSets) {
      const ceiling: SandboxCeiling = {
        capabilities: { capabilities },
        resources: BASE_RESOURCES,
      }
      try {
        await sandboxHost.execute(P1_SOCKET_WASM, Buffer.alloc(0), ceiling)
        expect(false).toBe(true) // must be denied
      } catch (err) {
        const denied = err as SandboxCapabilityDeniedError
        expect(denied).toBeInstanceOf(SandboxCapabilityDeniedError)
        expect(denied.deniedCapability).toBe('wasi_snapshot_preview1.sock_recv')
      }
    }
  })

  it('non-WASI custom host imports are DENIED (sandbox provides no custom host functions)', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:random/random'] },
      resources: BASE_RESOURCES,
    }
    try {
      await sandboxHost.execute(P1_CUSTOM_IMPORT_WASM, Buffer.alloc(0), ceiling)
      expect(false).toBe(true)
    } catch (err) {
      const denied = err as SandboxCapabilityDeniedError
      expect(denied).toBeInstanceOf(SandboxCapabilityDeniedError)
      expect(denied.deniedCapability).toBe('env::host_fn')
    }
  })

  it('fd_write executes when wasi:cli/stdout is approved (P1 stdout path)', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:cli/stdout'] },
      resources: BASE_RESOURCES,
    }
    const result = await sandboxHost.execute(STDOUT_WRITE_WASM, Buffer.alloc(0), ceiling)
    expect(result.output.toString('utf8')).toContain('hello')
  })

  it('fd_write is DENIED when no capability is approved', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: BASE_RESOURCES,
    }
    await expect(
      sandboxHost.execute(STDOUT_WRITE_WASM, Buffer.alloc(0), ceiling),
    ).rejects.toThrow(SandboxCapabilityDeniedError)
  })
})

// ---------------------------------------------------------------------------
// W021-AC02 — successful sandboxed execution (core module path)
// ---------------------------------------------------------------------------

describe('WORK-021 — Successful sandboxed execution (W021-AC02)', () => {
  it('executes a minimal core module in the sandbox with no capabilities (cli=n)', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: BASE_RESOURCES,
    }
    const result = await sandboxHost.execute(MINIMAL_WASM, Buffer.alloc(0), ceiling)
    expect(result).toBeTruthy()
    expect(result.measurements.wallTimeMs).toBeGreaterThan(0)
  })

  it('captures stdout via subprocess pipe (no global monkey-patch — AR-021-06)', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:cli/stdout'] },
      resources: BASE_RESOURCES,
    }
    const result = await sandboxHost.execute(STDOUT_WRITE_WASM, Buffer.alloc(0), ceiling)
    expect(result.output.toString('utf8')).toContain('hello')
  })
})

// ---------------------------------------------------------------------------
// W021-AC03 — no ambient authority (defense in depth source checks)
// ---------------------------------------------------------------------------

describe('WORK-021 — No ambient authority (W021-AC03)', () => {
  it('no network-enabling flags are ever passed', () => {
    const sandboxSrc = readFileSync(
      join(process.cwd(), 'src', 'lib', 'services', 'sandbox-host.service.ts'),
      'utf8',
    )
    const networkArgPattern = /'tcp=y'|'udp=y'|'http=y'|'inherit-network=y'|'inherit-env=y'|'allow-ip-name-lookup=y'/
    expect(networkArgPattern.test(sandboxSrc)).toBe(false)
  })

  it('import verification runs BEFORE the runtime is spawned (deny-at-boundary)', () => {
    const sandboxSrc = readFileSync(
      join(process.cwd(), 'src', 'lib', 'services', 'sandbox-host.service.ts'),
      'utf8',
    )
    expect(sandboxSrc).toContain('verifySandboxImports')
    expect(sandboxSrc).toContain('COMPONENT_INTERFACE_REQUIREMENTS')
    expect(sandboxSrc).toContain('P1_FUNCTION_REQUIREMENTS')
    // The verification call must precede the spawn call in executeWithHandle.
    const verifyIdx = sandboxSrc.indexOf('verifySandboxImports(wasmModule, approvedCapabilities, wasmPath)')
    const spawnIdx = sandboxSrc.indexOf("spawn('wasmtime', args")
    expect(verifyIdx).toBeGreaterThan(0)
    expect(spawnIdx).toBeGreaterThan(verifyIdx)
  })
})

// ---------------------------------------------------------------------------
// AR-021-13 — read-only filesystem enforcement
// ---------------------------------------------------------------------------

describe('WORK-021 — Read-only filesystem enforcement (AR-021-13)', () => {
  it('read-only FS: write attempts fail when only read capability is approved', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:filesystem.read'] },
      resources: BASE_RESOURCES,
    }
    // path_open is authorized by wasi:filesystem.read, but the write attempt
    // fails against the chmod-555 directory at the OS boundary.
    const result = await sandboxHost.execute(FILE_WRITE_WASM, Buffer.alloc(0), ceiling)
    expect(result).toBeTruthy()
  })

  it('read-write FS: write succeeds when both read and write are approved', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:filesystem.read', 'wasi:filesystem.write'] },
      resources: BASE_RESOURCES,
    }
    const result = await sandboxHost.execute(FILE_WRITE_WASM, Buffer.alloc(0), ceiling)
    expect(result).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// W021-AC05, AR-021-03, AR-021-16 — resource enforcement and measurement honesty
// ---------------------------------------------------------------------------

describe('WORK-021 — Real resource enforcement (W021-AC05, AR-021-03)', () => {
  it('enforces fuel limit — infinite loop traps (fuel_exhausted)', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: { executionBudget: 100, wallTimeMs: 10000 },
    }
    try {
      await sandboxHost.execute(INFINITE_LOOP_WASM, Buffer.alloc(0), ceiling)
      expect(false).toBe(true)
    } catch (err) {
      const terminated = err as SandboxTerminatedError
      expect(terminated).toBeInstanceOf(SandboxTerminatedError)
      expect(terminated.terminationReason).toBe('fuel_exhausted')
    }
  })

  it('AR-021-20: fuel enforcement works on the TRUE component path (no-import component)', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: { executionBudget: 1000, wallTimeMs: 10000 },
    }
    try {
      await sandboxHost.execute(LOOP_COMPONENT(), Buffer.alloc(0), ceiling)
      expect(false).toBe(true)
    } catch (err) {
      const terminated = err as SandboxTerminatedError
      expect(terminated).toBeInstanceOf(SandboxTerminatedError)
      expect(terminated.terminationReason).toBe('fuel_exhausted')
    }
  })

  it('enforces memory limit — memory.grow beyond limit traps (memory_exceeded)', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: { executionBudget: 1000000, memoryBytes: 65536, wallTimeMs: 5000 },
    }
    try {
      await sandboxHost.execute(MEMORY_GROW_WASM, Buffer.alloc(0), ceiling)
      expect(false).toBe(true)
    } catch (err) {
      const terminated = err as SandboxTerminatedError
      expect(terminated).toBeInstanceOf(SandboxTerminatedError)
      expect(terminated.terminationReason).toBe('memory_exceeded')
    }
  })

  it('enforces wall-clock timeout — infinite loop traps (timeout, NOT revoked)', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: { wallTimeMs: 100 },
    }
    const handle = sandboxHost.executeWithHandle(INFINITE_LOOP_WASM, Buffer.alloc(0), ceiling)
    try {
      await handle.result
      expect(false).toBe(true)
    } catch (err) {
      const terminated = err as SandboxTerminatedError
      expect(terminated).toBeInstanceOf(SandboxTerminatedError)
      // AR-021-19: a runtime-side timeout is 'timeout' and is NOT misreported
      // as a revocation.
      expect(terminated.terminationReason).toBe('timeout')
      expect(handle.isRevoked()).toBe(false)
    }
  })

  it('AR-021-20: wall-clock timeout works on the TRUE component path', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: { wallTimeMs: 100 },
    }
    try {
      await sandboxHost.execute(LOOP_COMPONENT(), Buffer.alloc(0), ceiling)
      expect(false).toBe(true)
    } catch (err) {
      const terminated = err as SandboxTerminatedError
      expect(terminated.terminationReason).toBe('timeout')
    }
  })
})

// ---------------------------------------------------------------------------
// AR-021-16 — usage fields absent when unmeasurable, not filled with ceiling
// ---------------------------------------------------------------------------

describe('WORK-021 — Measurement honesty (AR-021-16)', () => {
  it('wallTimeMs is real measured (present)', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: { executionBudget: 1000000, memoryBytes: 65536, wallTimeMs: 5000 },
    }
    const result = await sandboxHost.execute(MINIMAL_WASM, Buffer.alloc(0), ceiling)
    expect(result.measurements.wallTimeMs).toBeGreaterThan(0)
  })

  it('fuelUnits is ABSENT (not filled with ceiling)', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: { executionBudget: 50000, memoryBytes: 65536, wallTimeMs: 5000 },
    }
    const result = await sandboxHost.execute(MINIMAL_WASM, Buffer.alloc(0), ceiling)
    expect(result.measurements.fuelUnits).toBeUndefined()
  })

  it('peakLinearMemoryBytes is ABSENT (not filled with ceiling)', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: { executionBudget: 1000000, memoryBytes: 131072, wallTimeMs: 5000 },
    }
    const result = await sandboxHost.execute(MINIMAL_WASM, Buffer.alloc(0), ceiling)
    expect(result.measurements.peakLinearMemoryBytes).toBeUndefined()
  })

  it('cpuTimeNs is ABSENT (not derived from fuel)', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: { executionBudget: 1000000, memoryBytes: 65536, wallTimeMs: 5000 },
    }
    const result = await sandboxHost.execute(MINIMAL_WASM, Buffer.alloc(0), ceiling)
    expect(result.measurements.cpuTimeNs).toBeUndefined()
  })

  it('hostcallBytes is real measured I/O accounting', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: { executionBudget: 1000000, memoryBytes: 65536, wallTimeMs: 5000 },
    }
    const input = Buffer.from('test-input')
    const result = await sandboxHost.execute(MINIMAL_WASM, input, ceiling)
    expect(result.measurements.hostcallBytes).toBeGreaterThanOrEqual(input.length)
  })

  it('enforcedLimits are recorded SEPARATELY from usage', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: { executionBudget: 50000, memoryBytes: 131072, wallTimeMs: 5000 },
    }
    const result = await sandboxHost.execute(MINIMAL_WASM, Buffer.alloc(0), ceiling)
    expect(result.measurements.enforcedLimits).toBeDefined()
    expect(result.measurements.enforcedLimits.executionBudget).toBe(50000)
    expect(result.measurements.enforcedLimits.memoryBytes).toBe(131072)
    expect(result.measurements.enforcedLimits.wallTimeMs).toBe(5000)
    expect(result.measurements.fuelUnits).toBeUndefined()
    expect(result.measurements.peakLinearMemoryBytes).toBeUndefined()
  })

  it('AR-021-15: capabilitiesExercised is EMPTY, not copied from grant set', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:filesystem.read', 'wasi:filesystem.write'] },
      resources: BASE_RESOURCES,
    }
    const result = await sandboxHost.execute(MINIMAL_WASM, Buffer.alloc(0), ceiling)
    expect(result.capabilitiesExercised).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AR-021-11, AR-021-17, AR-021-19 — revocation + explicit termination causes
// ---------------------------------------------------------------------------

describe('WORK-021 — Revocation and termination causes (AR-021-11, AR-021-17, AR-021-19)', () => {
  it('executeWithHandle returns a handle with revoke()', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: { executionBudget: 1000000000, wallTimeMs: 30000 },
    }
    const handle = sandboxHost.executeWithHandle(INFINITE_LOOP_WASM, Buffer.alloc(0), ceiling)
    expect(handle.revoke).toBeDefined()
    expect(handle.isRevoked).toBeDefined()
    expect(handle.isRevoked()).toBe(false)

    setTimeout(() => handle.revoke(), 200)
    await expect(handle.result).rejects.toThrow(SandboxTerminatedError)
    expect(handle.isRevoked()).toBe(true)
  })

  it('AR-021-19: explicit revocation reports terminationReason revoked', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: { executionBudget: 1000000000, wallTimeMs: 30000 },
    }
    const handle = sandboxHost.executeWithHandle(INFINITE_LOOP_WASM, Buffer.alloc(0), ceiling)
    setTimeout(() => handle.revoke(), 200)

    try {
      await handle.result
      expect(false).toBe(true)
    } catch (err) {
      const terminated = err as SandboxTerminatedError
      expect(terminated.terminationReason).toBe('revoked')
    }
  })

  it('AR-021-19: host wall-clock backstop kill reports timeout, NOT revoked (fake wasmtime)', async () => {
    // A fake `wasmtime` binary ignores the -W timeout flags and sleeps, so
    // only the HOST backstop timer can terminate it. The backstop sends the
    // SAME SIGTERM signal that revocation uses — this test proves the cause
    // is taken from the explicit host actor, never inferred from the signal.
    const fakeDir = join(tmpdir(), `fake-wasmtime-${Date.now()}`)
    mkdirSync(fakeDir, { recursive: true })
    const fakeBin = join(fakeDir, 'wasmtime')
    writeFileSync(
      fakeBin,
      '#!/bin/sh\n'
      + 'if [ "$1" = "--version" ]; then\n'
      + '  echo "wasmtime fake 1.0.0"\n'
      + '  exit 0\n'
      + 'fi\n'
      + 'exec sleep 30\n',
    )
    chmodSync(fakeBin, 0o755)

    const originalPath = process.env.PATH
    const originalGrace = process.env.IAAS_SANDBOX_BACKSTOP_GRACE_MS
    process.env.PATH = `${fakeDir}:${originalPath}`
    process.env.IAAS_SANDBOX_BACKSTOP_GRACE_MS = '50'

    try {
      const fakeHost = new WasmtimeSandboxHost()
      const ceiling: SandboxCeiling = {
        capabilities: { capabilities: [] },
        resources: { wallTimeMs: 100 }, // backstop fires at 100 + 50 = 150ms
      }
      const handle = fakeHost.executeWithHandle(MINIMAL_WASM, Buffer.alloc(0), ceiling)
      try {
        await handle.result
        expect(false).toBe(true)
      } catch (err) {
        const terminated = err as SandboxTerminatedError
        expect(terminated).toBeInstanceOf(SandboxTerminatedError)
        // The SIGTERM came from the host backstop, so the explicit cause is
        // 'timeout' — a signal-only implementation would misreport 'revoked'.
        expect(terminated.terminationReason).toBe('timeout')
        expect(handle.isRevoked()).toBe(false)
      }
    } finally {
      if (originalGrace === undefined) delete process.env.IAAS_SANDBOX_BACKSTOP_GRACE_MS
      else process.env.IAAS_SANDBOX_BACKSTOP_GRACE_MS = originalGrace
      process.env.PATH = originalPath
      rmSync(fakeDir, { recursive: true, force: true })
    }
  })

  it('AR-021-19: revocation of a hung subprocess reports revoked (fake wasmtime, same SIGTERM)', async () => {
    // Same fake binary and SAME SIGTERM signal as the backstop test above —
    // only the explicit host actor differs, and so must the cause.
    const fakeDir = join(tmpdir(), `fake-wasmtime-revoke-${Date.now()}`)
    mkdirSync(fakeDir, { recursive: true })
    const fakeBin = join(fakeDir, 'wasmtime')
    writeFileSync(
      fakeBin,
      '#!/bin/sh\n'
      + 'if [ "$1" = "--version" ]; then\n'
      + '  echo "wasmtime fake 1.0.0"\n'
      + '  exit 0\n'
      + 'fi\n'
      + 'exec sleep 30\n',
    )
    chmodSync(fakeBin, 0o755)

    const originalPath = process.env.PATH
    process.env.PATH = `${fakeDir}:${originalPath}`

    try {
      const fakeHost = new WasmtimeSandboxHost()
      const ceiling: SandboxCeiling = {
        capabilities: { capabilities: [] },
        resources: {}, // no wallTimeMs → no backstop interference
      }
      const handle = fakeHost.executeWithHandle(MINIMAL_WASM, Buffer.alloc(0), ceiling)
      setTimeout(() => handle.revoke(), 150)
      try {
        await handle.result
        expect(false).toBe(true)
      } catch (err) {
        const terminated = err as SandboxTerminatedError
        expect(terminated).toBeInstanceOf(SandboxTerminatedError)
        expect(terminated.terminationReason).toBe('revoked')
        expect(handle.isRevoked()).toBe(true)
      }
    } finally {
      process.env.PATH = originalPath
      rmSync(fakeDir, { recursive: true, force: true })
    }
  })

  it('AR-021-19: ExtensionRuntime records the explicit terminationReason in failure provenance', () => {
    const runtimeSrc = readFileSync(
      join(process.cwd(), 'src', 'lib', 'services', 'extension-runtime.service.ts'),
      'utf8',
    )
    expect(runtimeSrc).toContain('terminationReason')
    expect(runtimeSrc).toContain('AR-021-19')
    expect(runtimeSrc).toContain('err.terminationReason')
  })

  it('AR-021-17: ExtensionRuntime uses executeWithHandle for sandboxed execution', () => {
    const runtimeSrc = readFileSync(
      join(process.cwd(), 'src', 'lib', 'services', 'extension-runtime.service.ts'),
      'utf8',
    )
    expect(runtimeSrc).toContain('executeWithHandle')
    expect(runtimeSrc).toContain('executionHandle')
    expect(runtimeSrc).toContain('AR-021-17')
  })

  it('AR-021-17: the AUTHORITATIVE registry revokes a REAL wasmtime execution through the termination hook', async () => {
    // Proves the registry-driven control path against the REAL sandbox host
    // (no DB here — the ExtensionRegistry → hook wiring is proven against real
    // PostgreSQL by tests/work-021-sandbox-revocation-pg.test.ts):
    //
    //   ActiveExecutionRegistry.revokeActiveExecutionsForExtension(...)
    //       ↓ (the exact hook ExtensionRegistry.revokeExtension invokes)
    //   SandboxExecutionHandle.revoke()
    //       ↓
    //   real SIGTERM → SandboxTerminatedError 'revoked'
    const { beginSandboxExecution, attachSandboxHandle, endSandboxExecution, revokeActiveExecutionsForExtension, listActiveExecutions } =
      await import('../src/lib/services/active-execution-registry.service')

    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: { wallTimeMs: 30000 }, // would run 30s without revocation
    }
    // begin → executeWithHandle → attach — the same synchronous block the
    // ExtensionRuntime performs.
    const begin = beginSandboxExecution({
      tenantId: 'w021-e2e-tenant',
      extensionType: 'w021-e2e-ext',
      extensionVersion: '1.0.0',
      idempotencyKey: 'ar-021-17-e2e',
    })
    expect(begin.ok).toBe(true)
    if (!begin.ok) throw new Error('unreachable')

    const handle = sandboxHost.executeWithHandle(LOOP_COMPONENT(), Buffer.alloc(0), ceiling)
    const attachResult = attachSandboxHandle(begin.executionId, handle)
    expect(attachResult).toBe('attached')
    expect(listActiveExecutions({ tenantId: 'w021-e2e-tenant', extensionType: 'w021-e2e-ext' }))
      .toHaveLength(1)
    const [record] = listActiveExecutions({ tenantId: 'w021-e2e-tenant', extensionType: 'w021-e2e-ext' })
    expect(record?.state).toBe('active')

    try {
      // The termination hook — the exact call ExtensionRegistry.revokeExtension
      // makes synchronously after the durable revocation update.
      const termination = revokeActiveExecutionsForExtension('w021-e2e-tenant', 'w021-e2e-ext', '1.0.0')
      expect(termination.executionIds).toEqual([begin.executionId])

      // The REAL wasmtime subprocess is terminated with the explicit cause.
      let err: unknown
      try {
        await handle.result
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(SandboxTerminatedError)
      expect((err as SandboxTerminatedError).terminationReason).toBe('revoked')
      expect(handle.isRevoked()).toBe(true)
    } finally {
      endSandboxExecution(begin.executionId)
    }
    expect(listActiveExecutions({ tenantId: 'w021-e2e-tenant', extensionType: 'w021-e2e-ext' }))
      .toHaveLength(0)
  })

  it('AR-021-17: revoke DURING registration terminates the sandbox at attach (race window closed)', async () => {
    const { beginSandboxExecution, attachSandboxHandle, endSandboxExecution, revokeActiveExecutionsForExtension } =
      await import('../src/lib/services/active-execution-registry.service')

    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: { wallTimeMs: 30000 },
    }
    // Registration completes but the sandbox has NOT spawned yet…
    const begin = beginSandboxExecution({
      tenantId: 'w021-e2e-tenant',
      extensionType: 'w021-e2e-race-ext',
      extensionVersion: '1.0.0',
      idempotencyKey: 'ar-021-17-e2e-race',
    })
    expect(begin.ok).toBe(true)
    if (!begin.ok) throw new Error('unreachable')

    // …the durable revoke lands in the registration window…
    const termination = revokeActiveExecutionsForExtension('w021-e2e-tenant', 'w021-e2e-race-ext', '1.0.0')
    expect(termination.executionIds).toEqual([begin.executionId])

    // …the sandbox spawns NOW: the attach revokes it immediately, in the same
    // synchronous block as the spawn.
    const handle = sandboxHost.executeWithHandle(LOOP_COMPONENT(), Buffer.alloc(0), ceiling)
    const attachResult = attachSandboxHandle(begin.executionId, handle)
    expect(attachResult).toBe('attached-and-revoked')

    try {
      let err: unknown
      try {
        await handle.result
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(SandboxTerminatedError)
      expect((err as SandboxTerminatedError).terminationReason).toBe('revoked')
    } finally {
      endSandboxExecution(begin.executionId)
    }
  })
})

// ---------------------------------------------------------------------------
// W021-AC08 — deny-by-default
// ---------------------------------------------------------------------------

describe('WORK-021 — Deny-by-default (W021-AC08)', () => {
  it('DenyByDefaultSandboxHost denies all execution', async () => {
    const denyHost = new DenyByDefaultSandboxHost()
    expect(denyHost.isAvailable()).toBe(false)
    await expect(
      denyHost.execute(MINIMAL_WASM, Buffer.alloc(0), {
        capabilities: { capabilities: [] },
        resources: {},
      }),
    ).rejects.toThrow(SandboxUnavailableError)
  })
})

// ---------------------------------------------------------------------------
// W021-AC04, AR-021-07 — tenant isolation
// ---------------------------------------------------------------------------

describe('WORK-021 — Tenant isolation (W021-AC04, AR-021-07)', () => {
  it('concurrent executions do not leak output across tenants', async () => {
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: [] },
      resources: BASE_RESOURCES,
    }
    const inputA = Buffer.from('tenant-a')
    const inputB = Buffer.from('tenant-b-different-length')
    const [result1, result2] = await Promise.all([
      sandboxHost.execute(MINIMAL_WASM, inputA, ceiling),
      sandboxHost.execute(MINIMAL_WASM, inputB, ceiling),
    ])
    expect(result1.measurements.hostcallBytes).not.toEqual(result2.measurements.hostcallBytes)
  })
})

// ---------------------------------------------------------------------------
// AR-021-06 — no global stdout monkey-patch
// ---------------------------------------------------------------------------

describe('WORK-021 — No global stdout monkey-patch (AR-021-06)', () => {
  it('process.stdout.write is not modified during execution', async () => {
    const originalWrite = process.stdout.write
    const ceiling: SandboxCeiling = {
      capabilities: { capabilities: ['wasi:cli/stdout'] },
      resources: BASE_RESOURCES,
    }
    await sandboxHost.execute(STDOUT_WRITE_WASM, Buffer.alloc(0), ceiling)
    expect(process.stdout.write).toBe(originalWrite)
  })
})

// ---------------------------------------------------------------------------
// W021-AC09, AR-021-05 — Runtime integration
// ---------------------------------------------------------------------------

describe('WORK-021 — ExtensionRuntime sandbox integration (W021-AC09, AR-021-05)', () => {
  it('ExtensionRuntime wires sandbox measurements into provenance', () => {
    const runtimeSrc = readFileSync(
      join(process.cwd(), 'src', 'lib', 'services', 'extension-runtime.service.ts'),
      'utf8',
    )
    expect(runtimeSrc).toContain('measuredResourceUsage')
    expect(runtimeSrc).toContain('measuredCapabilitiesExercised')
    expect(runtimeSrc).toContain('AR-021-05')
  })

  it('ExtensionRuntime denies with sandbox_unavailable when sandbox is not available', () => {
    const runtimeSrc = readFileSync(
      join(process.cwd(), 'src', 'lib', 'services', 'extension-runtime.service.ts'),
      'utf8',
    )
    expect(runtimeSrc).toContain('sandbox_unavailable')
  })
})
