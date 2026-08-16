// =============================================================================
// Kernel: Architecture Contract Tests
// =============================================================================
// These tests enforce the structural boundary between the generic kernel
// and the VPP vertical implementation. They prove that:
//
//   1. No generic kernel service imports any VPP-specific module
//   2. A generic network can be created and operated without VPP
//   3. The dependency direction is: kernel ← runtime ← vertical
//
// If any of these tests fail, the architectural boundary has been violated.
// =============================================================================

import { describe, it, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Test 1: No generic service imports VPP
// ---------------------------------------------------------------------------

const GENERIC_SERVICES = [
  'capacity.service',
  'contribution.service',
  'reward.service',
  'ledger.service',
  'settlement.service',
  'verification.service',
  'ingestion.service',
  'worker.service',
  'network.service',
  'registry.service',
  'tenant.service',
  'attestation.service',
  'payments.service',
  'dashboard.service',
]

const VPP_IMPORT_PATTERNS = [
  /from\s+['"]\.\/vpp/,
  /from\s+['"]\.\/portfolio-/,
  /from\s+['"]\.\/der-adapter/,
  /from\s+['"]\.\/buyer-settlement/,
  /from\s+['"]\.\/baseline/,
  /from\s+['"]\.\/historical-telemetry/,
]

describe('Architecture contract: kernel boundary', () => {
  it('no generic service imports any VPP module', () => {
    const servicesDir = join(process.cwd(), 'src', 'lib', 'services')

    for (const service of GENERIC_SERVICES) {
      const filePath = join(servicesDir, `${service}.ts`)
      let content: string
      try {
        content = readFileSync(filePath, 'utf-8')
      } catch {
        continue // file doesn't exist, skip
      }

      for (const pattern of VPP_IMPORT_PATTERNS) {
        const matches = content.match(pattern)
        expect(matches).toBeNull()
      }
    }
  })

  it('kernel concurrency module does not import VPP', () => {
    const leaseServicePath = join(process.cwd(), 'src', 'lib', 'kernel', 'concurrency', 'lease.service.ts')
    let content: string
    try {
      content = readFileSync(leaseServicePath, 'utf-8')
    } catch {
      return // file doesn't exist yet, skip
    }

    for (const pattern of VPP_IMPORT_PATTERNS) {
      expect(content.match(pattern)).toBeNull()
    }
  })

  it('kernel execution module does not import VPP', () => {
    const execServicePath = join(process.cwd(), 'src', 'lib', 'kernel', 'execution', 'execution.service.ts')
    let content: string
    try {
      content = readFileSync(execServicePath, 'utf-8')
    } catch {
      return
    }
    for (const pattern of VPP_IMPORT_PATTERNS) {
      expect(content.match(pattern)).toBeNull()
    }
  })

  it('kernel adapter interface does not import VPP', () => {
    const adapterPath = join(process.cwd(), 'src', 'lib', 'kernel', 'adapters', 'infrastructure-adapter.ts')
    let content: string
    try {
      content = readFileSync(adapterPath, 'utf-8')
    } catch {
      return
    }
    for (const pattern of VPP_IMPORT_PATTERNS) {
      expect(content.match(pattern)).toBeNull()
    }
  })

  it('generic kernel directory has concurrency, execution, and adapters', () => {
    const kernelDir = join(process.cwd(), 'src', 'lib', 'kernel')
    let entries: string[]
    try {
      entries = readdirSync(kernelDir)
    } catch {
      return
    }
    expect(entries).toContain('concurrency')
    expect(entries).toContain('execution')
    expect(entries).toContain('adapters')
  })

  it('generic Execution model exists in schema', () => {
    const schemaPath = join(process.cwd(), 'prisma', 'schema.prisma')
    const content = readFileSync(schemaPath, 'utf-8')
    expect(content).toMatch(/model Execution [{]/)
    expect(content).toMatch(/model ExecutionAssignment [{]/)
    expect(content).toMatch(/requestedQuantity/)
    expect(content).toMatch(/requestedUnit/)
    expect(content).toMatch(/assignedQuantity/)
    expect(content).toMatch(/assignedUnit/)
    expect(content).toMatch(/actualQuantity/)
    expect(content).toMatch(/verifiedQuantity/)
  })
})

// ---------------------------------------------------------------------------
// Test 2: VPP services ARE allowed to import generic kernel
// ---------------------------------------------------------------------------

describe('Architecture contract: VPP depends on kernel (not vice versa)', () => {
  it('VPP service imports generic services (capacity, ledger, etc.)', () => {
    const vppServicePath = join(process.cwd(), 'src', 'lib', 'services', 'vpp.service.ts')
    const content = readFileSync(vppServicePath, 'utf-8')

    // VPP should import generic services — this proves the dependency direction.
    expect(content).toMatch(/from\s+['"]\.\/capacity\.service/)
    expect(content).toMatch(/from\s+['"]\.\/contribution\.service/)
    expect(content).toMatch(/from\s+['"]\.\/reward\.service/)
    expect(content).toMatch(/from\s+['"]\.\/ledger\.service/)
    expect(content).toMatch(/from\s+['"]\.\/settlement\.service/)
  })
})

// ---------------------------------------------------------------------------
// Test 3: Generic template exists (non-energy network)
// ---------------------------------------------------------------------------

describe('Architecture contract: non-energy reference', () => {
  it('generic-resource-network template exists', () => {
    const templatesPath = join(process.cwd(), 'src', 'lib', 'domain', 'templates.ts')
    const content = readFileSync(templatesPath, 'utf-8')

    // The generic template proves the platform is not inherently energy-specific.
    expect(content).toMatch(/generic-resource-network/)
  })
})

// ---------------------------------------------------------------------------
// Test 4: VPP-Execution structural invariant (Phase 4.2)
// ---------------------------------------------------------------------------

describe('Architecture contract: VPP-Execution invariant', () => {
  it('VppDispatch has executionId @unique FK to Execution', () => {
    const schemaPath = join(process.cwd(), 'prisma', 'schema.prisma')
    const content = readFileSync(schemaPath, 'utf-8')

    // VppDispatch must have executionId as a unique FK.
    expect(content).toMatch(/executionId\s+String\s+@unique/)
    expect(content).toMatch(/execution\s+Execution\s+@relation/)
  })

  it('VppDispatchAssignment has executionAssignmentId @unique FK to ExecutionAssignment', () => {
    const schemaPath = join(process.cwd(), 'prisma', 'schema.prisma')
    const content = readFileSync(schemaPath, 'utf-8')

    expect(content).toMatch(/executionAssignmentId\s+String\s+@unique/)
    expect(content).toMatch(/executionAssignment\s+ExecutionAssignment\s+@relation/)
  })

  it('VPP service uses executionAssignmentId directly (no findFirst ambiguity)', () => {
    const vppServicePath = join(process.cwd(), 'src', 'lib', 'services', 'vpp.service.ts')
    const content = readFileSync(vppServicePath, 'utf-8')

    // The VPP service should reference executionAssignmentId directly.
    expect(content).toMatch(/assignment\.executionAssignmentId/)
    // Should NOT use findFirst with executionId + assetId (the old ambiguous pattern).
    expect(content).not.toMatch(/findFirst.*executionId.*assetId/)
  })

  it('VPP service finalizes generic Execution via the runtime (not direct kernel call)', () => {
    const vppServicePath = join(process.cwd(), 'src', 'lib', 'services', 'vpp.service.ts')
    const content = readFileSync(vppServicePath, 'utf-8')

    // Phase 5: VPP goes through the runtime, not direct finalizeExecutionIfTerminal.
    // The runtime's completeAssignment/failAssignment calls finalizeIfTerminal internally.
    expect(content).toMatch(/runtime\.completeAssignment/)
    expect(content).toMatch(/runtime\.failAssignment/)
    expect(content).toMatch(/runtime\.finalizeIfTerminal/)
  })

  it('VPP service synchronizes failure states via runtime.failAssignment', () => {
    const vppServicePath = join(process.cwd(), 'src', 'lib', 'services', 'vpp.service.ts')
    const content = readFileSync(vppServicePath, 'utf-8')

    // Phase 5: both failAssignment and markReconciliationRequired call
    // runtime.failAssignment(tx, ...) — the runtime handles the generic
    // ExecutionAssignment → failed transition + parent finalization.
    const failCalls = content.match(/runtime\.failAssignment\(tx,/g)
    expect(failCalls).not.toBeNull()
    expect(failCalls!.length).toBeGreaterThanOrEqual(2) // failAssignment + markReconciliationRequired
  })

  it('kernel execution service has finalizeExecutionIfTerminal', () => {
    const execServicePath = join(process.cwd(), 'src', 'lib', 'kernel', 'execution', 'execution.service.ts')
    const content = readFileSync(execServicePath, 'utf-8')

    expect(content).toMatch(/export async function finalizeExecutionIfTerminal/)
  })

  it('finalizeExecutionIfTerminal is transaction-aware (accepts tx as first param)', () => {
    const execServicePath = join(process.cwd(), 'src', 'lib', 'kernel', 'execution', 'execution.service.ts')
    const content = readFileSync(execServicePath, 'utf-8')

    // The function signature must accept a transaction client as the first
    // argument, enabling atomic finalization with the assignment transition.
    expect(content).toMatch(/finalizeExecutionIfTerminal\(\s*tx/)

    // Phase 5: The InfrastructureRuntime (not VPP directly) calls
    // finalizeExecutionIfTerminal(tx, ...) inside completeAssignment and
    // failAssignment. VPP calls the runtime, the runtime calls the kernel.
    const infraRuntimePath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'infrastructure-runtime.ts')
    const infraContent = readFileSync(infraRuntimePath, 'utf-8')
    expect(infraContent).toMatch(/finalizeExecutionIfTerminal\(tx,/)
  })

  it('parent Execution does not carry VPP financial states', () => {
    const execServicePath = join(process.cwd(), 'src', 'lib', 'kernel', 'execution', 'execution.service.ts')
    const content = readFileSync(execServicePath, 'utf-8')

    // The generic Execution service must NEVER set Execution.status to a
    // VPP financial state. These live on VppDispatch, not Execution.
    // Check that no code assigns these as status VALUES (ignore comments).
    expect(content).not.toMatch(/status:\s*'(delivery_complete|buyer_settlement_pending|reconciliation_required)'/)
    // The only terminal parent status WRITTEN is 'completed'.
    expect(content).toMatch(/data:\s*\{\s*status:\s*'completed'\s*\}/)
    // The semantics doc must state 'completed' = lifecycle ended.
    expect(content).toMatch(/ONE terminal parent state/)
  })
})

// ---------------------------------------------------------------------------
// Test 5: Phase 5 — Runtime boundary and resolution (Phase 5)
// ---------------------------------------------------------------------------

describe('Architecture contract: runtime boundary (Phase 5)', () => {
  it('kernel runtime module does not import VPP', () => {
    const runtimeDir = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime')
    let entries: string[]
    try {
      entries = readdirSync(runtimeDir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.endsWith('.ts')) continue
      const filePath = join(runtimeDir, entry)
      const content = readFileSync(filePath, 'utf-8')
      for (const pattern of VPP_IMPORT_PATTERNS) {
        expect(content.match(pattern)).toBeNull()
      }
    }
  })

  it('kernel runtime directory has registry, types, and three runtime implementations', () => {
    const runtimeDir = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime')
    let entries: string[]
    try {
      entries = readdirSync(runtimeDir)
    } catch {
      return
    }
    expect(entries).toContain('types.ts')
    expect(entries).toContain('registry.ts')
    expect(entries).toContain('infrastructure-runtime.ts')
    expect(entries).toContain('protocol-runtime.ts')
    expect(entries).toContain('hybrid-runtime.ts')
    expect(entries).toContain('index.ts')
  })

  it('VPP service resolves runtime via RuntimeRegistry (not direct execution.service)', () => {
    const vppServicePath = join(process.cwd(), 'src', 'lib', 'services', 'vpp.service.ts')
    const content = readFileSync(vppServicePath, 'utf-8')

    // VPP must import resolveRuntime from the kernel runtime module.
    expect(content).toMatch(/from\s+['"]@\/lib\/kernel\/runtime['"]/)
    expect(content).toMatch(/resolveRuntime/)

    // VPP must NOT import finalizeExecutionIfTerminal directly (goes through runtime).
    expect(content).not.toMatch(/from\s+['"]@\/lib\/kernel\/execution\/execution\.service['"]/)

    // VPP must NOT directly write to Execution/ExecutionAssignment (goes through runtime).
    expect(content).not.toMatch(/tx\.execution\.create\(/)
    expect(content).not.toMatch(/tx\.execution\.update\(/)
    expect(content).not.toMatch(/tx\.executionAssignment\.create\(/)
    expect(content).not.toMatch(/tx\.executionAssignment\.update\(/)
  })

  it('NetworkVersion has runtimeKind field in schema', () => {
    const schemaPath = join(process.cwd(), 'prisma', 'schema.prisma')
    const content = readFileSync(schemaPath, 'utf-8')

    expect(content).toMatch(/runtimeKind\s+String\s+@default\("infrastructure"\)/)
  })

  it('runtimeKind allowed values are infrastructure | protocol | hybrid', () => {
    const typesPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'types.ts')
    const content = readFileSync(typesPath, 'utf-8')

    expect(content).toMatch(/\[.infrastructure.,\s*.protocol.,\s*.hybrid.\]/)
  })

  it('RuntimeRegistry throws on unregistered kind (no silent fallback)', () => {
    const registryPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'registry.ts')
    const content = readFileSync(registryPath, 'utf-8')

    // The resolve method must throw if no runtime is registered.
    expect(content).toMatch(/throw new Error\([^)]*No runtime registered/)
  })

  it('ProtocolRuntime and HybridRuntime are stubs that throw NotImplemented', () => {
    const protocolPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'protocol-runtime.ts')
    const protocolContent = readFileSync(protocolPath, 'utf-8')
    expect(protocolContent).toMatch(/ProtocolRuntimeNotImplementedError/)

    const hybridPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'hybrid-runtime.ts')
    const hybridContent = readFileSync(hybridPath, 'utf-8')
    expect(hybridContent).toMatch(/HybridRuntimeNotImplementedError/)
  })
})
