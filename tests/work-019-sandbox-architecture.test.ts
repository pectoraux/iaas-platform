/// <reference types="bun-types" />
// =============================================================================
// WORK-019 — Sandbox Architecture and ACR-004 regression tests
// =============================================================================
// Verifies W019-AC01..AC11: ACR-004 is complete, V4 remains FROZEN/immutable,
// no sandbox technology is implemented, and the candidate architecture
// decision is properly documented without modifying frozen V4 in place.
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()

function readSpec(path: string): string {
  return readFileSync(join(REPO_ROOT, 'spec', path), 'utf8')
}

function readSrc(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

// ---------------------------------------------------------------------------
// W019-AC01 — ACR-004 identifies problem, affected contracts, alternatives, recommendation
// ---------------------------------------------------------------------------

describe('WORK-019 — ACR-004 completeness (W019-AC01)', () => {
  const acr = readSpec('architecture-change-requests/ACR-004.md')

  test('ACR-004 file exists', () => {
    expect(acr).toBeTruthy()
  })

  test('ACR-004 has ACR-ID', () => {
    expect(acr).toContain('ACR-ID: `ACR-004`')
  })

  test('ACR-004 has Status DRAFT (Architect decides approval)', () => {
    expect(acr).toContain('Status: `DRAFT`')
  })

  test('ACR-004 identifies affected architecture version (V4 FROZEN)', () => {
    expect(acr).toContain('Affected Architecture Version: `IAAS-DOM-ARCH-4` (FROZEN)')
  })

  test('ACR-004 identifies candidate new architecture version (V5, NOT frozen)', () => {
    expect(acr).toContain('New Architecture Version: `IAAS-DOM-ARCH-5` (CANDIDATE')
    expect(acr).toContain('NOT frozen by this ACR')
  })

  test('ACR-004 identifies affected requirements (V4 §2.8, sandbox area, DOM-P05)', () => {
    expect(acr).toContain('§2.8 Security and Isolation')
    expect(acr).toContain('DOM-P05')
  })

  test('ACR-004 identifies the problem (no isolation boundary, no metering)', () => {
    expect(acr).toContain('Problem / Evidence')
    expect(acr).toContain('compromise containment')
    expect(acr).toContain('resource metering')
  })

  test('ACR-004 evaluates all three required alternatives', () => {
    expect(acr).toContain('WASM/WASI')
    expect(acr).toContain('Container')
    expect(acr).toContain('Native/plugin-process')
  })

  test('ACR-004 has a recommendation (preferred sandbox technology)', () => {
    expect(acr).toContain('Recommendation:')
    expect(acr).toContain('WASM/WASI')
  })

  test('ACR-004 has required ACR template fields', () => {
    const requiredFields = [
      'ACR-ID',
      'Requested by',
      'Date',
      'Affected Architecture Version',
      'New Architecture Version',
      'Affected Requirements',
      'Affected Work Items',
      'Current Rule',
      'Problem / Evidence',
      'Proposed Change',
      'Alternatives Considered',
      'Compatibility / Migration Impact',
      'Verification Impact',
      'Decision',
      'Decision Authority',
    ]
    for (const field of requiredFields) {
      expect(acr).toContain(field)
    }
  })
})

// ---------------------------------------------------------------------------
// W019-AC02 — trust boundary explicit
// ---------------------------------------------------------------------------

describe('WORK-019 — Trust boundary (W019-AC02)', () => {
  const acr = readSpec('architecture-change-requests/ACR-004.md')

  test('ACR-004 defines the sandbox trust boundary', () => {
    expect(acr).toContain('Trust Boundary')
    expect(acr).toContain('WASM instance boundary')
  })

  test('ACR-004 distinguishes trusted host from untrusted module', () => {
    expect(acr).toContain('untrusted')
    expect(acr).toContain('trusted')
  })
})

// ---------------------------------------------------------------------------
// W019-AC03 — capability/resource authority and precedence explicit
// ---------------------------------------------------------------------------

describe('WORK-019 — Capability/resource authority (W019-AC03)', () => {
  const acr = readSpec('architecture-change-requests/ACR-004.md')

  test('ACR-004 names ExtensionRuntime as the capability authority', () => {
    expect(acr).toContain('ExtensionRuntime')
    expect(acr).toContain('capability/resource authority')
  })

  test('ACR-004 preserves V4 §2.6 min(declared, approved) precedence', () => {
    expect(acr).toContain('min(declared, approved)')
    expect(acr).toContain('V4 §2.6')
  })
})

// ---------------------------------------------------------------------------
// W019-AC04 — lifecycle/revocation/termination semantics explicit
// ---------------------------------------------------------------------------

describe('WORK-019 — Lifecycle/revocation/termination (W019-AC04)', () => {
  const acr = readSpec('architecture-change-requests/ACR-004.md')

  test('ACR-004 maps sandbox lifecycle to ExtensionRegistry lifecycle', () => {
    expect(acr).toContain('registered → installed')
    expect(acr).toContain('installed → activated')
    expect(acr).toContain('activated ⇌ deactivated')
    expect(acr).toContain('revoked')
  })

  test('ACR-004 defines in-flight revocation semantics', () => {
    expect(acr).toContain('revoked_mid_execution')
    expect(acr).toContain('drop')
  })

  test('ACR-004 defines resource exhaustion termination', () => {
    expect(acr).toContain('fuel depleted')
    expect(acr).toContain('memory limit')
    expect(acr).toContain('timeout')
  })
})

// ---------------------------------------------------------------------------
// W019-AC05 — provenance and authoritative resource measurement explicit
// ---------------------------------------------------------------------------

describe('WORK-019 — Provenance and authoritative measurement (W019-AC05)', () => {
  const acr = readSpec('architecture-change-requests/ACR-004.md')

  test('ACR-004 upgrades resourceUsage from ceiling to authoritative measurement', () => {
    expect(acr).toContain('authoritative')
    expect(acr).toContain('fuel consumed')
    expect(acr).toContain('peak linear memory')
    expect(acr).toContain('wall-clock')
  })

  test('ACR-004 upgrades capabilitiesExercised to authoritative set', () => {
    expect(acr).toContain('capabilitiesExercised')
    expect(acr).toContain('WASI capabilities actually invoked')
  })

  test('ACR-004 documents this as a contract change requiring V5', () => {
    expect(acr).toContain('contract change')
    expect(acr).toContain('IAAS-DOM-ARCH-5')
  })
})

// ---------------------------------------------------------------------------
// W019-AC06 — tenant isolation and compromise containment explicit
// ---------------------------------------------------------------------------

describe('WORK-019 — Tenant isolation and compromise containment (W019-AC06)', () => {
  const acr = readSpec('architecture-change-requests/ACR-004.md')

  test('ACR-004 guarantees structural tenant isolation', () => {
    expect(acr).toContain('structural')
    expect(acr).toContain('no shared address space')
  })

  test('ACR-004 defines compromise containment', () => {
    expect(acr).toContain('Compromise Containment')
    expect(acr).toContain('trapped inside the sandbox')
  })
})

// ---------------------------------------------------------------------------
// W019-AC07 — portability/deployment/operational trade-offs evaluated
// ---------------------------------------------------------------------------

describe('WORK-019 — Portability/deployment/operations (W019-AC07)', () => {
  const acr = readSpec('architecture-change-requests/ACR-004.md')

  test('ACR-004 evaluates portability across deployment environments', () => {
    expect(acr).toContain('Vercel')
    expect(acr).toContain('self-hosted')
    expect(acr).toContain('edge')
  })

  test('ACR-004 evaluates operational complexity', () => {
    expect(acr).toContain('Operational Complexity')
    expect(acr).toContain('Single binary dependency')
  })
})

// ---------------------------------------------------------------------------
// W019-AC08 — fallback/unavailability semantics explicit
// ---------------------------------------------------------------------------

describe('WORK-019 — Fallback/unavailability semantics (W019-AC08)', () => {
  const acr = readSpec('architecture-change-requests/ACR-004.md')

  test('ACR-004 defines deny-by-default when sandbox unavailable', () => {
    expect(acr).toContain('sandbox_unavailable')
    expect(acr).toContain('Deny all untrusted extension execution')
    expect(acr).toContain('No silent degradation')
  })
})

// ---------------------------------------------------------------------------
// W019-AC09 — V4 impact and need for successor version explicit
// ---------------------------------------------------------------------------

describe('WORK-019 — V4 impact and successor version (W019-AC09)', () => {
  const acr = readSpec('architecture-change-requests/ACR-004.md')

  test('ACR-004 states V4 remains FROZEN', () => {
    expect(acr).toContain('V4 remains FROZEN')
    expect(acr).toContain('does NOT modify V4 in place')
  })

  test('ACR-004 proposes IAAS-DOM-ARCH-5 as candidate (not frozen)', () => {
    expect(acr).toContain('IAAS-DOM-ARCH-5` (CANDIDATE')
    expect(acr).toContain('separate freeze Work Item')
  })

  test('ACR-004 states no implementation is authorized by the ACR alone', () => {
    expect(acr).toContain('No production sandbox implementation is authorized by ACR approval alone')
  })
})

// ---------------------------------------------------------------------------
// W019-AC10 — regression tests prove V4 immutability and no sandbox implementation
// ---------------------------------------------------------------------------

describe('WORK-019 — V4 immutability and no sandbox implementation (W019-AC10)', () => {
  test('frozen V4 architecture document is not modified in place', () => {
    const arch = readSpec('domain-architecture-v4.md')
    // V4 must still say sandbox is OPEN/RESEARCH (ACR-004 does not change V4)
    expect(arch).toContain('Sandbox technology (WASM/container/native) remains OPEN/RESEARCH')
    expect(arch).toContain('not frozen by V4')
  })

  test('frozen V4 requirements document is not modified in place', () => {
    const req = readSpec('domain-requirements-v4.md')
    // DOM-P05..P08 must still be FUTURE/OPEN/RESEARCH in V4
    expect(req).toContain('DOM-P05..DOM-P08: remain FUTURE/OPEN/RESEARCH')
  })

  test('no sandbox runtime is imported in src/lib/services/', () => {
    // No WASM runtime, container runtime, or native plugin runtime may be
    // imported by any service module.
    const servicesDir = join(REPO_ROOT, 'src', 'lib', 'services')
    const serviceFiles = readdirSync(servicesDir).filter(f => f.endsWith('.ts'))
    const sandboxPatterns = [
      /@bytecodealliance\/wasmtime/,
      /wasmtime/,
      /wasmer/,
      /wasm-edge/,
      /dockerode/,
      /containerd/,
      /child_process/,
      /node:child_process/,
      /worker_threads/,
      /node:worker_threads/,
    ]
    for (const file of serviceFiles) {
      const src = readSrc(join('src', 'lib', 'services', file))
      for (const pattern of sandboxPatterns) {
        expect(src).not.toMatch(pattern)
      }
    }
  })

  test('no sandbox service file exists in src/lib/services/', () => {
    const servicesDir = join(REPO_ROOT, 'src', 'lib', 'services')
    const serviceFiles = readdirSync(servicesDir)
    const sandboxFilePatterns = [
      /sandbox/i,
      /wasm/i,
      /container/i,
      /isolation/i,
    ]
    for (const file of serviceFiles) {
      for (const pattern of sandboxFilePatterns) {
        expect(file).not.toMatch(pattern)
      }
    }
  })

  test('no Prisma model for sandbox state exists', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).not.toMatch(/model\s+Sandbox\b/i)
    expect(schema).not.toMatch(/model\s+WasmModule\b/i)
    expect(schema).not.toMatch(/model\s+ContainerImage\b/i)
  })

  test('ExtensionRuntime does not import a sandbox module', () => {
    const runtimeSrc = readSrc('src/lib/services/extension-runtime.service.ts')
    expect(runtimeSrc).not.toMatch(/from\s+['"][^'"]*sandbox/)
    expect(runtimeSrc).not.toMatch(/from\s+['"][^'"]*wasm/)
    expect(runtimeSrc).not.toMatch(/from\s+['"][^'"]*container/)
    expect(runtimeSrc).not.toMatch(/from\s+['"][^'"]*isolation/)
  })

  test('ExtensionProvenanceService does not import a sandbox module', () => {
    const provenanceSrc = readSrc('src/lib/services/extension-provenance.service.ts')
    expect(provenanceSrc).not.toMatch(/from\s+['"][^'"]*sandbox/)
    expect(provenanceSrc).not.toMatch(/from\s+['"][^'"]*wasm/)
    expect(provenanceSrc).not.toMatch(/from\s+['"][^'"]*container/)
    expect(provenanceSrc).not.toMatch(/from\s+['"][^'"]*isolation/)
  })
})

// ---------------------------------------------------------------------------
// W019-AC11 — required gates pass (verified by CI, not this test file)
// ---------------------------------------------------------------------------

describe('WORK-019 — Required gates (W019-AC11)', () => {
  test('ACR-004 is registered in the architecture-change-requests directory', () => {
    const acrPath = join(REPO_ROOT, 'spec', 'architecture-change-requests', 'ACR-004.md')
    expect(existsSync(acrPath)).toBe(true)
  })

  test('WORK-019 work order is released', () => {
    const order = readSpec('work-orders/WORK-019.md')
    expect(order).toContain('`READY`')
    expect(order).toContain('ACR-004')
    expect(order).toContain('sandbox')
  })

  test('WORK-019 is registered in work-items.md', () => {
    const items = readSpec('work-items.md')
    expect(items).toContain('## WORK-019 — Sandbox Architecture and ACR-004')
    expect(items).toContain('W019-AC01')
    expect(items).toContain('W019-AC11')
  })

  test('WORK-019 dependency edge is in dependency-graph.md', () => {
    const deps = readSpec('dependency-graph.md')
    expect(deps).toContain('WORK-018 -> WORK-019')
  })
})

// ---------------------------------------------------------------------------
// Architectural Questions Resolved (WORK-019 Required Analysis)
// ---------------------------------------------------------------------------

describe('WORK-019 — Architectural questions resolved', () => {
  const acr = readSpec('architecture-change-requests/ACR-004.md')

  test('all 8 architectural questions are resolved', () => {
    expect(acr).toContain('Architectural Questions Resolved')
    // The 8 questions from the Work Order
    expect(acr).toContain('trust boundary')
    expect(acr).toContain('authoritative for capabilities')
    expect(acr).toContain('granted and revoked')
    expect(acr).toContain('in-flight execution on revocation')
    expect(acr).toContain('authoritative for provenance')
    expect(acr).toContain('minimum isolation guarantee')
    expect(acr).toContain('fallback behavior')
    expect(acr).toContain('require a new architecture version')
  })
})

// ---------------------------------------------------------------------------
// Evaluation dimensions coverage (WORK-019 Required Analysis)
// ---------------------------------------------------------------------------

describe('WORK-019 — Evaluation dimensions covered', () => {
  const acr = readSpec('architecture-change-requests/ACR-004.md')

  test('all 10 evaluation dimensions are covered', () => {
    const dimensions = [
      'Capability Enforcement',
      'Resource Limits and Metering',
      'Tenant Isolation',
      'Filesystem/Network/Device Access',
      'Process Escape / Compromise Containment',
      'Lifecycle Integration',
      'Provenance Implications',
      'Portability and Deployment',
      'Operational Complexity',
      'Failure and Termination',
    ]
    for (const dim of dimensions) {
      expect(acr).toContain(dim)
    }
  })

  test('comparison summary table exists', () => {
    expect(acr).toContain('Alternatives Comparison Summary')
  })
})
