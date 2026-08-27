/// <reference types="bun-types" />
// =============================================================================
// WORK-019 — Sandbox Architecture and ACR-004 regression tests
// =============================================================================
// Verifies W019-AC01..AC11: ACR-004 is complete (APPROVED by WORK-020),
// V4 remains FROZEN/immutable, and the sandbox architecture decision is
// properly documented without modifying frozen V4 in place.
//
// NOTE: WORK-020 condensed ACR-004 from the detailed DRAFT to an approved
// summary. These tests were updated to match the approved version.
// W019-AC10 "no sandbox implementation" tests were scoped to V4 immutability
// (the sandbox IS now implemented under V5 by WORK-021, which is correct —
// the W019-AC10 concern was that V4 must not be changed, not that no sandbox
// can ever exist).
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
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

  test('ACR-004 has Status APPROVED (Architect approved in WORK-020)', () => {
    expect(acr).toContain('Status: `APPROVED`')
  })

  test('ACR-004 identifies affected architecture version (V4 FROZEN)', () => {
    expect(acr).toContain('Affected Architecture Version: `IAAS-DOM-ARCH-4` (FROZEN)')
  })

  test('ACR-004 identifies new architecture version (V5)', () => {
    expect(acr).toContain('New Architecture Version: `IAAS-DOM-ARCH-5`')
    expect(acr).toContain('APPROVED FOR FREEZE')
  })

  test('ACR-004 identifies affected requirements (DOM-P05)', () => {
    expect(acr).toContain('DOM-P05')
  })

  test('ACR-004 evaluates all three required alternatives', () => {
    expect(acr).toContain('WASM/WASI')
    expect(acr).toContain('containers')
    expect(acr).toContain('native/plugin-process')
  })

  test('ACR-004 has a recommendation (preferred sandbox technology)', () => {
    expect(acr).toContain('preferred sandbox')
    expect(acr).toContain('WASI Component Model')
  })

  test('ACR-004 has required ACR template fields', () => {
    const requiredFields = [
      'ACR-ID',
      'Status',
      'Decision date',
      'Affected Architecture Version',
      'New Architecture Version',
      'Governing Architecture',
      'Decision',
      'Frozen V5 Contract',
      'Trust Boundary',
      'Capability and Resource Authority',
      'Resource Measurement',
      'Lifecycle and Termination',
      'Isolation and Failure Containment',
      'Fallback',
      'Provenance',
      'Alternatives',
      'Governance Effect',
      'Verification',
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
    expect(acr).toContain('WASM component/instance boundary')
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
    expect(acr).toContain('Capability and Resource Authority')
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

  test('ACR-004 defines in-flight revocation via architectural termination contract', () => {
    expect(acr).toContain('architectural termination contract')
    expect(acr).toContain('terminate sandbox execution context')
    expect(acr).toContain('failed provenance')
    expect(acr).toContain('terminal outcome / re-throw')
  })

  test('ACR-004 states concrete runtime APIs are implementation details', () => {
    expect(acr).toContain('Concrete runtime APIs remain implementation details')
  })
})

// ---------------------------------------------------------------------------
// W019-AC05 — provenance and authoritative resource measurement explicit
// ---------------------------------------------------------------------------

describe('WORK-019 — Provenance and authoritative measurement (W019-AC05)', () => {
  const acr = readSpec('architecture-change-requests/ACR-004.md')

  test('ACR-004 defines five distinct measurement quantities', () => {
    const quantities = [
      'executionBudget',
      'fuelUnits',
      'cpuTimeNs',
      'wallTimeMs',
      'peakLinearMemoryBytes',
      'hostcallBytes',
    ]
    for (const q of quantities) {
      expect(acr).toContain(q)
    }
  })

  test('ACR-004 states fuel is never CPU time (AR-019-02)', () => {
    expect(acr).toContain('never CPU time')
    expect(acr).toContain('never inferred from fuel')
  })

  test('ACR-004 requires measurement-source/version semantics', () => {
    expect(acr).toContain('measurement-source')
    expect(acr).toContain('fuel is never silently represented as CPU milliseconds')
  })

  test('ACR-004 introduces authoritative measured semantics for V5', () => {
    expect(acr).toContain('authoritative measured')
    expect(acr).toContain('Existing V4 records remain valid')
  })
})

// ---------------------------------------------------------------------------
// W019-AC06 — tenant isolation and compromise containment explicit
// ---------------------------------------------------------------------------

describe('WORK-019 — Tenant isolation and compromise containment (W019-AC06)', () => {
  const acr = readSpec('architecture-change-requests/ACR-004.md')

  test('ACR-004 guarantees tenant isolation via isolated sandbox state', () => {
    expect(acr).toContain('isolated sandbox state')
    expect(acr).toContain('capability boundary')
  })

  test('ACR-004 defines compromise containment', () => {
    expect(acr).toContain('compromise containment')
    expect(acr).toContain('Unsandboxed execution is prohibited')
  })
})

// ---------------------------------------------------------------------------
// W019-AC07 — portability/deployment/operational trade-offs evaluated
// ---------------------------------------------------------------------------

describe('WORK-019 — Portability/deployment/operations (W019-AC07)', () => {
  const acr = readSpec('architecture-change-requests/ACR-004.md')

  test('ACR-004 evaluates all 10 dimensions in the Alternatives section', () => {
    const dimensions = [
      'capability enforcement',
      'resource metering',
      'tenant isolation',
      'host I/O control',
      'compromise containment',
      'lifecycle',
      'provenance',
      'portability',
      'operations',
      'failure semantics',
    ]
    for (const dim of dimensions) {
      expect(acr).toContain(dim)
    }
  })

  test('ACR-004 identifies WASM/WASI as the strongest overall fit', () => {
    expect(acr).toContain('WASM/WASI provides the strongest overall fit')
  })

  test('ACR-004 documents container as a possible future fallback', () => {
    expect(acr).toContain('Container isolation remains a possible future implementation')
  })
})

// ---------------------------------------------------------------------------
// W019-AC08 — fallback/unavailability semantics explicit
// ---------------------------------------------------------------------------

describe('WORK-019 — Fallback/unavailability semantics (W019-AC08)', () => {
  const acr = readSpec('architecture-change-requests/ACR-004.md')

  test('ACR-004 defines deny-by-default when sandbox unavailable', () => {
    expect(acr).toContain('sandbox_unavailable')
    expect(acr).toContain('No silent degradation')
  })

  test('ACR-004 prohibits implicit container/native fallback', () => {
    expect(acr).toContain('No silent degradation or implicit container/native fallback')
  })

  test('ACR-004 requires a separate ACR for alternative sandbox implementations', () => {
    expect(acr).toContain('Alternative sandbox implementations require a separate ACR')
  })
})

// ---------------------------------------------------------------------------
// W019-AC09 — V4 impact and need for successor version explicit
// ---------------------------------------------------------------------------

describe('WORK-019 — V4 impact and successor version (W019-AC09)', () => {
  const acr = readSpec('architecture-change-requests/ACR-004.md')

  test('ACR-004 states V4 remains immutable', () => {
    expect(acr).toContain('V4 remains immutable')
  })

  test('ACR-004 authorizes V5 freeze by WORK-020', () => {
    expect(acr).toContain('IAAS-DOM-ARCH-5` is authorized for freeze by WORK-020')
  })

  test('ACR-004 states no sandbox implementation is authorized until V5 is frozen', () => {
    expect(acr).toContain('No sandbox implementation is authorized until V5 is frozen')
  })

  test('ACR-004 states DOM-P05 is promoted when WORK-020 is verified', () => {
    expect(acr).toContain('DOM-P05` is promoted to the V5 sandbox contract')
  })
})

// ---------------------------------------------------------------------------
// W019-AC10 — V4 immutability (scoped: V4 not modified, not "no sandbox exists")
// ---------------------------------------------------------------------------

describe('WORK-019 — V4 immutability (W019-AC10)', () => {
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

  test('no Prisma model for sandbox state exists', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).not.toMatch(/model\s+Sandbox\b/i)
    expect(schema).not.toMatch(/model\s+WasmModule\b/i)
    expect(schema).not.toMatch(/model\s+ContainerImage\b/i)
  })

  test('ExtensionProvenanceService does not import a sandbox module', () => {
    const provenanceSrc = readSrc('src/lib/services/extension-provenance.service.ts')
    expect(provenanceSrc).not.toMatch(/from\s+['"][^'"]*sandbox/)
    expect(provenanceSrc).not.toMatch(/from\s+['"][^'"]*wasm/)
    expect(provenanceSrc).not.toMatch(/from\s+['"][^'"]*container/)
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
// V5 freeze verification (WORK-020 froze V5 based on ACR-004)
// ---------------------------------------------------------------------------

describe('WORK-019 — V5 frozen by WORK-020', () => {
  test('V5 architecture document exists and is FROZEN', () => {
    const v5 = readSpec('domain-architecture-v5.md')
    expect(v5).toContain('IAAS-DOM-ARCH-5')
    expect(v5).toContain('FROZEN')
  })

  test('V5 freezes the WASI Component Model / capability-sandbox contract', () => {
    const v5 = readSpec('domain-architecture-v5.md')
    expect(v5).toContain('WASI Component Model')
    expect(v5).toContain('capability-sandbox contract')
  })

  test('V5 does not freeze a specific WASI revision or runtime', () => {
    const v5 = readSpec('domain-architecture-v5.md')
    expect(v5).toContain('does not freeze a particular WASI revision or concrete runtime')
  })

  test('V5 preserves fuel ≠ CPU time', () => {
    const v5 = readSpec('domain-architecture-v5.md')
    expect(v5).toContain('not CPU time')
    expect(v5).toContain('Fuel is never represented as CPU milliseconds')
  })

  test('V5 preserves deny-by-default fallback', () => {
    const v5 = readSpec('domain-architecture-v5.md')
    expect(v5).toContain('sandbox_unavailable')
    expect(v5).toContain('deny-by-default')
  })
})
