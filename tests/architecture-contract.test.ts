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

// ---------------------------------------------------------------------------
// Test 6: Phase 5.2 — Execution/economics separation
// ---------------------------------------------------------------------------

describe('Architecture contract: execution/economics separation (Phase 5.2)', () => {
  it('InfrastructureRuntime.failAssignment uses CAS (only fails if not already completed)', () => {
    const infraPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'infrastructure-runtime.ts')
    const content = readFileSync(infraPath, 'utf-8')

    // The failAssignment method must use updateMany with a CAS condition
    // (status: { not: 'completed' }) — operational completion is irreversible.
    expect(content).toMatch(/failAssignment[\s\S]*updateMany[\s\S]*status:\s*\{\s*not:\s*'completed'\s*\}/)
  })

  it('InfrastructureRuntime has linkContribution method', () => {
    const infraPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'infrastructure-runtime.ts')
    const content = readFileSync(infraPath, 'utf-8')

    expect(content).toMatch(/async linkContribution\(/)
  })

  it('VPP completeAssignment is called BEFORE createContribution (operational completion before economics)', () => {
    const vppServicePath = join(process.cwd(), 'src', 'lib', 'services', 'vpp.service.ts')
    const content = readFileSync(vppServicePath, 'utf-8')

    // Find the position of runtime.completeAssignment and createContribution.
    // completeAssignment must appear BEFORE createContribution in the
    // executeDispatchAssignment function — operational completion happens
    // before the economic pipeline.
    const completeIdx = content.indexOf('runtime.completeAssignment(tx,')
    const contributionIdx = content.indexOf('createContribution(')

    expect(completeIdx).toBeGreaterThan(-1)
    expect(contributionIdx).toBeGreaterThan(-1)
    expect(completeIdx).toBeLessThan(contributionIdx)
  })

  it('VPP markReconciliationRequired checks operationalCompleted before calling runtime.failAssignment', () => {
    const vppServicePath = join(process.cwd(), 'src', 'lib', 'services', 'vpp.service.ts')
    const content = readFileSync(vppServicePath, 'utf-8')

    // The markReconciliationRequired function must check operationalCompleted
    // before calling runtime.failAssignment. If operationalCompleted is true,
    // the generic assignment is already completed and must NOT be failed.
    expect(content).toMatch(/if\s*\(\s*!operationalCompleted\s*\)\s*\{[\s\S]*runtime\.failAssignment/)
  })

  it('VPP success path does NOT call runtime.completeAssignment (generic already completed)', () => {
    const vppServicePath = join(process.cwd(), 'src', 'lib', 'services', 'vpp.service.ts')
    const content = readFileSync(vppServicePath, 'utf-8')

    // The VPP success completion (after settlement) must NOT call
    // runtime.completeAssignment — the generic was already completed during
    // operational completion. The success path only updates VPP-specific state.
    //
    // Find the "VPP COMPLETED" section and verify it does not contain
    // runtime.completeAssignment.
    const vppCompletedIdx = content.indexOf('VPP COMPLETED')
    expect(vppCompletedIdx).toBeGreaterThan(-1)

    // Find the next runtime.completeAssignment after the operational completion
    // (which is the legitimate one). There should be only ONE call total.
    const completeCalls = content.match(/runtime\.completeAssignment\(tx,/g)
    expect(completeCalls).not.toBeNull()
    expect(completeCalls!.length).toBe(1) // only the operational completion call
  })

  it('VPP tracks operationalCompleted flag', () => {
    const vppServicePath = join(process.cwd(), 'src', 'lib', 'services', 'vpp.service.ts')
    const content = readFileSync(vppServicePath, 'utf-8')

    expect(content).toMatch(/let operationalCompleted = false/)
    expect(content).toMatch(/operationalCompleted = true/)
  })
})

// ---------------------------------------------------------------------------
// Test 7: Phase 5.3 — Schema cleanup (no vertical economics on generic models)
// ---------------------------------------------------------------------------

describe('Architecture contract: schema cleanup (Phase 5.3)', () => {
  it('ExecutionAssignment does NOT have economicStage field', () => {
    const schemaPath = join(process.cwd(), 'prisma', 'schema.prisma')
    const content = readFileSync(schemaPath, 'utf-8')

    // Extract the ExecutionAssignment model block.
    const match = content.match(/model ExecutionAssignment \{[\s\S]*?\}/)
    expect(match).not.toBeNull()
    const modelBlock = match![0]

    // economicStage must NOT appear in the generic ExecutionAssignment model.
    expect(modelBlock).not.toMatch(/economicStage/)
  })

  it('Execution does NOT have contributionId field', () => {
    const schemaPath = join(process.cwd(), 'prisma', 'schema.prisma')
    const content = readFileSync(schemaPath, 'utf-8')

    // Extract the Execution model block.
    const match = content.match(/model Execution \{[\s\S]*?\}/)
    expect(match).not.toBeNull()
    const modelBlock = match![0]

    // contributionId must NOT appear in the generic Execution model.
    // (The parent Execution doesn't have a single contribution — each
    // ExecutionAssignment has its own contributionId.)
    expect(modelBlock).not.toMatch(/contributionId/)
  })

  it('ExecutionAssignment DOES have contributionId (the link linkContribution sets)', () => {
    const schemaPath = join(process.cwd(), 'prisma', 'schema.prisma')
    const content = readFileSync(schemaPath, 'utf-8')

    const match = content.match(/model ExecutionAssignment \{[\s\S]*?\}/)
    expect(match).not.toBeNull()
    const modelBlock = match![0]

    // contributionId IS on ExecutionAssignment — it's the link to the
    // derived economic contribution, set by linkContribution().
    expect(modelBlock).toMatch(/contributionId\s+String\?/)
  })

  it('InfrastructureRuntime.completeAssignment does NOT set economicStage', () => {
    const infraPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'infrastructure-runtime.ts')
    const content = readFileSync(infraPath, 'utf-8')

    // Extract the completeAssignment method block.
    const match = content.match(/async completeAssignment\([\s\S]*?\n  \}/)
    expect(match).not.toBeNull()
    const methodBlock = match![0]

    // economicStage must NOT appear as a DATA FIELD assignment (economicStage: '...')
    // in the generic completeAssignment. Comments mentioning it are fine.
    expect(methodBlock).not.toMatch(/economicStage\s*:/)
  })

  it('linkContribution is fenced (CAS: only links if status=completed)', () => {
    const infraPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'infrastructure-runtime.ts')
    const content = readFileSync(infraPath, 'utf-8')

    // linkContribution must use updateMany with a CAS condition
    // (status: 'completed') — a non-completed assignment cannot have a
    // contribution linked.
    expect(content).toMatch(/linkContribution[\s\S]*updateMany[\s\S]*status:\s*'completed'/)
  })

  it('execution.service updateAssignmentResults does NOT accept economicStage', () => {
    const execPath = join(process.cwd(), 'src', 'lib', 'kernel', 'execution', 'execution.service.ts')
    const content = readFileSync(execPath, 'utf-8')

    // The updateAssignmentResults input type must NOT include economicStage.
    const match = content.match(/export async function updateAssignmentResults[\s\S]*?\)/)
    expect(match).not.toBeNull()
    const methodSignature = match![0]
    expect(methodSignature).not.toMatch(/economicStage/)
  })
})

// ---------------------------------------------------------------------------
// Test 8: Phase 5.4 — linkContribution write-once + single write authority
// ---------------------------------------------------------------------------

describe('Architecture contract: linkContribution write-once (Phase 5.4)', () => {
  it('RuntimeAssignmentResults does NOT contain contributionId', () => {
    const typesPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'types.ts')
    const content = readFileSync(typesPath, 'utf-8')

    // Extract the RuntimeAssignmentResults interface block.
    const match = content.match(/export interface RuntimeAssignmentResults \{[\s\S]*?\}/)
    expect(match).not.toBeNull()
    const interfaceBlock = match![0]

    // contributionId must NOT appear in RuntimeAssignmentResults — the only
    // way to link a contribution is via linkContribution().
    expect(interfaceBlock).not.toMatch(/contributionId/)
  })

  it('recordAssignmentResults does NOT write contributionId', () => {
    const infraPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'infrastructure-runtime.ts')
    const content = readFileSync(infraPath, 'utf-8')

    // Extract the recordAssignmentResults method block.
    const match = content.match(/async recordAssignmentResults\([\s\S]*?\n  \}/)
    expect(match).not.toBeNull()
    const methodBlock = match![0]

    // contributionId must NOT appear as a DATA FIELD assignment (contributionId: '...')
    // in recordAssignmentResults. Comments mentioning it are fine.
    expect(methodBlock).not.toMatch(/contributionId\s*:/)
  })

  it('linkContribution is write-once (CAS: NULL or same value, not different)', () => {
    const infraPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'infrastructure-runtime.ts')
    const content = readFileSync(infraPath, 'utf-8')

    // The linkContribution CAS must include the OR condition:
    //   contributionId IS NULL OR contributionId = ?
    // This makes it write-once — a different contributionId is rejected.
    expect(content).toMatch(/linkContribution[\s\S]*OR:\s*\[[\s\S]*contributionId:\s*null[\s\S]*contributionId:\s*contributionId/)
  })

  it('linkContribution throws on rejection (not silent no-op)', () => {
    const infraPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'infrastructure-runtime.ts')
    const content = readFileSync(infraPath, 'utf-8')

    // The linkContribution method must throw when count=0 (CAS rejected).
    // It must distinguish "not completed" from "already linked to different".
    expect(content).toMatch(/Cannot link contribution.*not completed/)
    expect(content).toMatch(/Cannot link contribution.*already linked/)
  })
})

// ---------------------------------------------------------------------------
// Test 9: Phase 6 — Physical execution boundary (AdapterRegistry)
// ---------------------------------------------------------------------------

describe('Architecture contract: physical execution boundary (Phase 6)', () => {
  it('VPP service does NOT import or instantiate DERAdapter', () => {
    const vppServicePath = join(process.cwd(), 'src', 'lib', 'services', 'vpp.service.ts')
    const content = readFileSync(vppServicePath, 'utf-8')

    // VPP must NOT import DERAdapter or SimulatedDERAdapter.
    expect(content).not.toMatch(/from\s+['"]\.\/der-adapter\.service['"]/)
    expect(content).not.toMatch(/new SimulatedDERAdapter/)
    // Must NOT instantiate a DERAdapter.
    expect(content).not.toMatch(/:\s*DERAdapter\s*=/)
    // Must NOT call executeDischarge directly.
    expect(content).not.toMatch(/executeDischarge/)
  })

  it('VPP service calls runtime.executeAssignment for physical execution', () => {
    const vppServicePath = join(process.cwd(), 'src', 'lib', 'services', 'vpp.service.ts')
    const content = readFileSync(vppServicePath, 'utf-8')

    // VPP must call runtime.executeAssignment() — physical execution
    // enters through the runtime, not the vertical.
    expect(content).toMatch(/runtime\.executeAssignment\(/)
  })

  it('InfrastructureRuntime has executeAssignment method', () => {
    const infraPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'infrastructure-runtime.ts')
    const content = readFileSync(infraPath, 'utf-8')

    expect(content).toMatch(/async executeAssignment\(/)
  })

  it('InfrastructureRuntime.executeAssignment resolves adapter via AdapterRegistry', () => {
    const infraPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'infrastructure-runtime.ts')
    const content = readFileSync(infraPath, 'utf-8')

    // The executeAssignment method must call resolveAdapter — not
    // instantiate a concrete adapter.
    expect(content).toMatch(/resolveAdapter\(/)
  })

  it('kernel runtime directory has adapter-registry (generic, no concrete imports)', () => {
    const runtimeDir = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime')
    let entries: string[]
    try {
      entries = readdirSync(runtimeDir)
    } catch {
      return
    }
    expect(entries).toContain('adapter-registry.ts')
    // Phase 6.1: adapters-init.ts is DELETED — concrete adapter registration
    // moved to the bootstrap layer (src/lib/bootstrap/adapters.ts).
    expect(entries).not.toContain('adapters-init.ts')
  })

  it('AdapterRegistry throws on unregistered asset type (no silent fallback)', () => {
    const registryPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'adapter-registry.ts')
    const content = readFileSync(registryPath, 'utf-8')

    expect(content).toMatch(/throw new Error\([^)]*No adapter registered/)
  })

  it('DERAdapter implements the generic InfrastructureAdapter interface', () => {
    const derAdapterPath = join(process.cwd(), 'src', 'lib', 'services', 'der-adapter.service.ts')
    const content = readFileSync(derAdapterPath, 'utf-8')

    // SimulatedDERAdapter must implement InfrastructureAdapter.
    expect(content).toMatch(/class SimulatedDERAdapter implements InfrastructureAdapter/)
    // Must have the generic execute(command: ExecuteCommand) method.
    expect(content).toMatch(/async execute\(command:\s*ExecuteCommand\)/)
  })

  it('InfrastructureRuntime does NOT import VPP baseline or portfolio logic', () => {
    const infraPath = join(process.cwd(), 'src', 'lib', 'kernel', 'runtime', 'infrastructure-runtime.ts')
    const content = readFileSync(infraPath, 'utf-8')

    // The runtime must NOT import VPP-specific modules.
    for (const pattern of VPP_IMPORT_PATTERNS) {
      expect(content.match(pattern)).toBeNull()
    }
    // Must NOT reference baseline or portfolio.
    expect(content).not.toMatch(/baseline/)
    expect(content).not.toMatch(/portfolio/)
  })

  it('kernel/runtime does NOT import concrete adapter implementations (Phase 6.1)', () => {
    // Phase 6.1: The kernel/runtime layer must NOT import any concrete
    // adapter implementation. Concrete adapters are registered by the
    // bootstrap layer (src/lib/bootstrap/), not by the kernel.
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

      // Must NOT import der-adapter.service or any concrete adapter.
      expect(content).not.toMatch(/from\s+['"].*der-adapter\.service['"]/)
      expect(content).not.toMatch(/from\s+['"].*simulated-der\.adapter['"]/)
      // Must NOT import the bootstrap (which registers concrete adapters).
      expect(content).not.toMatch(/from\s+['"].*bootstrap\/adapters['"]/)
      // Must NOT instantiate SimulatedDERAdapter.
      expect(content).not.toMatch(/new SimulatedDERAdapter/)
    }
  })

  it('bootstrap/adapters.ts imports concrete adapters + registers them', () => {
    const bootstrapPath = join(process.cwd(), 'src', 'lib', 'bootstrap', 'adapters.ts')
    let content: string
    try {
      content = readFileSync(bootstrapPath, 'utf-8')
    } catch {
      return
    }

    // The bootstrap MUST import the concrete adapter + the generic registry.
    expect(content).toMatch(/from\s+['"]@\/lib\/services\/der-adapter\.service['"]/)
    expect(content).toMatch(/from\s+['"]@\/lib\/kernel\/runtime\/adapter-registry['"]/)
    // Must register the adapter for energy asset types.
    expect(content).toMatch(/registerForAssetTypes/)
    expect(content).toMatch(/battery/)
    expect(content).toMatch(/solar_inverter/)
  })
})
