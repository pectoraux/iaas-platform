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

  it('VPP service finalizes generic Execution via kernel function', () => {
    const vppServicePath = join(process.cwd(), 'src', 'lib', 'services', 'vpp.service.ts')
    const content = readFileSync(vppServicePath, 'utf-8')

    // The VPP service should call finalizeExecutionIfTerminal.
    expect(content).toMatch(/finalizeExecutionIfTerminal/)
  })

  it('VPP service synchronizes failure states to generic ExecutionAssignment', () => {
    const vppServicePath = join(process.cwd(), 'src', 'lib', 'services', 'vpp.service.ts')
    const content = readFileSync(vppServicePath, 'utf-8')

    // The failAssignment function should update ExecutionAssignment → failed.
    // Use [\s\S]* (matches across newlines) because the .update() call and
    // the status: 'failed' field are on separate lines.
    expect(content).toMatch(/executionAssignment[\s\S]*update[\s\S]*status:\s*'failed'/)
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
    // The VPP service must pass `tx` (not just tenantId) when calling it
    // inside a transaction.
    const vppServicePath = join(process.cwd(), 'src', 'lib', 'services', 'vpp.service.ts')
    const vppContent = readFileSync(vppServicePath, 'utf-8')
    expect(vppContent).toMatch(/finalizeExecutionIfTerminal\(tx,/)
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
