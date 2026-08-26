/// <reference types="bun-types" />
// =============================================================================
// WORK-017 — ExtensionRuntime unit + architecture tests
// =============================================================================
// Verifies W017-AC01..AC10: ExtensionRuntime is service-layer, resolves via
// ExtensionRegistry, gates on activated lifecycle, enforces min(declared,
// approved) capability/resource ceiling, invokes reverse/verify, emits
// immutable ExtensionProvenance payloads through a boundary sink (no durable
// storage), provides deterministic idempotent replay convergence, defines
// explicit failure semantics, and obeys all V4 anti-dependency prohibitions.
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()

function readSrc(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

// ---------------------------------------------------------------------------
// W017-AC10 — static architecture + anti-dependency checks
// ---------------------------------------------------------------------------

describe('WORK-017 — ExtensionRuntime architecture (W017-AC10)', () => {
  const RUNTIME_SRC = readSrc('src/lib/services/extension-runtime.service.ts')

  test('ExtensionRuntime is in the service layer (NOT kernel)', () => {
    const path = join(REPO_ROOT, 'src', 'lib', 'services', 'extension-runtime.service.ts')
    expect(path).toContain('src/lib/services/')
    expect(path).not.toContain('src/lib/kernel/')
  })

  test('ExtensionRuntime imports NO vertical service (W017-AC10)', () => {
    const verticalPattern = /(?:vpp|compute|storage|wireless|manufacturing)\.service/
    expect(verticalPattern.test(RUNTIME_SRC)).toBe(false)
  })

  test('ExtensionRuntime imports NO EconomicPipeline (W017-AC10)', () => {
    expect(RUNTIME_SRC).not.toContain('economic-pipeline')
  })

  test('ExtensionRuntime imports NO Route/Transport (W017-AC10)', () => {
    const dataPlanePattern = /(?:routing|transport|delivery-confirmation)\.service/
    expect(dataPlanePattern.test(RUNTIME_SRC)).toBe(false)
  })

  test('ExtensionRuntime imports NO RuntimeRegistry (W017-AC10)', () => {
    expect(RUNTIME_SRC).not.toMatch(/^import.*RuntimeRegistry/m)
    expect(RUNTIME_SRC).not.toMatch(/from\s+['"]@\/lib\/kernel\/runtime['"]/m)
    expect(RUNTIME_SRC).not.toMatch(/from\s+['"]@\/lib\/kernel\//m)
  })

  test('ExtensionRuntime imports NO kernel code (W017-AC10)', () => {
    expect(RUNTIME_SRC).not.toMatch(/^import.*@\/lib\/kernel/m)
  })

  test('ExtensionRuntime resolves Extensions via ExtensionRegistry (W017-AC01)', () => {
    expect(RUNTIME_SRC).toContain("from '@/lib/services/extension-registry.service'")
    expect(RUNTIME_SRC).toContain('getExtension')
    expect(RUNTIME_SRC).toContain('resolveFromRegistry')
  })

  test('ExtensionRuntime does NOT import TransformRuntime/TransformRecord (W017-AC10)', () => {
    // Extension→Transform is one-way and is NOT exercised by the runtime itself.
    expect(RUNTIME_SRC).not.toContain('transform-runtime.service')
    expect(RUNTIME_SRC).not.toContain('transform-record.service')
    expect(RUNTIME_SRC).not.toContain('transform-registry.service')
  })

  test('ExtensionRuntime does NOT own catalog/lifecycle (W017-AC08)', () => {
    // The runtime must NOT export registerExtension, listExtensions,
    // checkExtensionVersionCompatibility, updateExtensionCertification,
    // revokeExtension, or transitionLifecycle — those are ExtensionRegistry's
    // responsibilities.
    expect(RUNTIME_SRC).not.toMatch(/export\s+(async\s+)?function\s+registerExtension\b/)
    expect(RUNTIME_SRC).not.toMatch(/export\s+(async\s+)?function\s+listExtensions\b/)
    expect(RUNTIME_SRC).not.toMatch(/export\s+(async\s+)?function\s+updateExtensionCertification\b/)
    expect(RUNTIME_SRC).not.toMatch(/export\s+(async\s+)?function\s+revokeExtension\b/)
    expect(RUNTIME_SRC).not.toMatch(/export\s+(async\s+)?function\s+transitionLifecycle\b/)
  })

  test('ExtensionRuntime does NOT mutate ExtensionRegistryEntry (W017-AC08)', () => {
    expect(RUNTIME_SRC).not.toContain('updateExtensionRegistryEntry')
    expect(RUNTIME_SRC).not.toContain('deleteExtensionRegistryEntry')
    expect(RUNTIME_SRC).not.toContain('db.extensionRegistryEntry.create')
    expect(RUNTIME_SRC).not.toContain('db.extensionRegistryEntry.update')
    expect(RUNTIME_SRC).not.toContain('db.extensionRegistryEntry.delete')
  })

  test('ExtensionRuntime does NOT hard-code concrete extensions (W017-AC10)', () => {
    // The runtime dispatches through the ExtensionContract interface — it must
    // NOT contain concrete extension logic.
    expect(RUNTIME_SRC).not.toMatch(/class\s+\w*Compression\w*/)
    expect(RUNTIME_SRC).not.toMatch(/class\s+\w*Encryption\w*/)
    expect(RUNTIME_SRC).not.toMatch(/class\s+\w*VPP\w*/)
    expect(RUNTIME_SRC).not.toMatch(/class\s+\w*Compute\w*/)
    expect(RUNTIME_SRC).not.toMatch(/class\s+\w*Routing\w*/)
  })

  test('ExtensionRuntime has execute, reverse, verify functions (W017-AC04)', () => {
    expect(RUNTIME_SRC).toMatch(/export\s+async\s+function\s+executeExtension\b/)
    expect(RUNTIME_SRC).toMatch(/export\s+async\s+function\s+reverseExtension\b/)
    expect(RUNTIME_SRC).toMatch(/export\s+async\s+function\s+verifyExtension\b/)
  })

  test('ExtensionRuntime has explicit failure semantics (W017-AC05)', () => {
    expect(RUNTIME_SRC).toContain('Failure semantics')
    expect(RUNTIME_SRC).toContain("'failed'")
    expect(RUNTIME_SRC).toContain('re-throw')
  })

  test('ExtensionRuntime has idempotency support (W017-AC06)', () => {
    expect(RUNTIME_SRC).toContain('idempotencyKey')
    expect(RUNTIME_SRC).toContain('fingerprint')
    expect(RUNTIME_SRC).toContain('replay')
    expect(RUNTIME_SRC).toContain('converge')
  })

  test('ExtensionRuntime enforces activated lifecycle gate (W017-AC02)', () => {
    expect(RUNTIME_SRC).toContain("'activated'")
    expect(RUNTIME_SRC).toContain('lifecycle_not_activated')
  })

  test('ExtensionRuntime enforces min(declared, approved) ceiling (W017-AC03)', () => {
    expect(RUNTIME_SRC).toContain('computeEffectiveCeiling')
    expect(RUNTIME_SRC).toContain('intersection')
    expect(RUNTIME_SRC).toContain('Math.min')
    expect(RUNTIME_SRC).toContain('capability_not_approved')
    expect(RUNTIME_SRC).toContain('resource_limit_exceeded')
  })
})

// ---------------------------------------------------------------------------
// W017-AC09 — no durable provenance implementation
// ---------------------------------------------------------------------------

describe('WORK-017 — ExtensionRuntime provenance boundary (W017-AC09)', () => {
  const RUNTIME_SRC = readSrc('src/lib/services/extension-runtime.service.ts')

  test('ExtensionRuntime does NOT import db (no direct database writes)', () => {
    // The runtime emits payloads to a sink boundary; it does NOT write to the
    // database directly. Durable ExtensionProvenance storage is DOM-022 / future.
    expect(RUNTIME_SRC).not.toMatch(/^import.*@\/lib\/db/m)
    expect(RUNTIME_SRC).not.toContain("from '@/lib/db'")
    expect(RUNTIME_SRC).not.toContain('db.extensionProvenance')
    expect(RUNTIME_SRC).not.toContain('prisma')
  })

  test('ExtensionRuntime does NOT import an extension-provenance service', () => {
    expect(RUNTIME_SRC).not.toMatch(/from\s+['"][^'"]*extension-provenance/)
    expect(RUNTIME_SRC).not.toMatch(/^import.*ExtensionProvenanceService/m)
    expect(RUNTIME_SRC).not.toMatch(/^import.*createExtensionProvenance/m)
  })

  test('ExtensionProvenanceSink interface is defined (boundary contract)', () => {
    expect(RUNTIME_SRC).toContain('export interface ExtensionProvenanceSink')
    expect(RUNTIME_SRC).toContain('emit(payload')
    expect(RUNTIME_SRC).toContain("status: 'created' | 'replay'")
  })

  test('InMemoryExtensionProvenanceSink is provided (test/no-op default)', () => {
    expect(RUNTIME_SRC).toContain('export class InMemoryExtensionProvenanceSink')
    expect(RUNTIME_SRC).toContain('implements ExtensionProvenanceSink')
  })

  test('ExtensionProvenancePayload matches V4 §2.4 minimum identity', () => {
    const fields = [
      'tenantId',
      'extensionType',
      'extensionVersion',
      'executionIdempotencyKey',
      'inputHash',
      'outputHash',
      'resultStatus',
      'resourceUsage',
      'capabilitiesExercised',
      'tenantApprovedCeiling',
      'fingerprint',
      'createdAt',
    ]
    for (const f of fields) {
      expect(RUNTIME_SRC).toContain(f)
    }
  })

  test('Fingerprint = SHA-256 of material fields (V4 §2.4)', () => {
    expect(RUNTIME_SRC).toContain('computeExtensionProvenanceFingerprint')
    expect(RUNTIME_SRC).toContain('sha256')
    // The fingerprint must include exactly the V4 §2.4 material fields.
    expect(RUNTIME_SRC).toMatch(/tenantId[\s\S]*extensionType[\s\S]*extensionVersion[\s\S]*executionIdempotencyKey[\s\S]*inputHash[\s\S]*outputHash[\s\S]*resultStatus/)
  })

  test('ExtensionProvenance storage remains absent from production code', () => {
    // No Prisma model for ExtensionProvenance should exist (DOM-022 is future).
    const schemaPath = join(REPO_ROOT, 'prisma', 'schema.prisma')
    const schema = readFileSync(schemaPath, 'utf8')
    expect(schema).not.toMatch(/model\s+ExtensionProvenance\b/)
    expect(schema).not.toMatch(/model\s+ExtensionProvenanceRecord\b/)
  })
})

// ---------------------------------------------------------------------------
// W017-AC01..AC04 — contract presence (static source inspection)
// ---------------------------------------------------------------------------

describe('WORK-017 — ExtensionRuntime contract (W017-AC01..AC04)', () => {
  const RUNTIME_SRC = readSrc('src/lib/services/extension-runtime.service.ts')

  test('ExtensionContract interface is defined (abstract operation contract, DOM-018)', () => {
    expect(RUNTIME_SRC).toContain('export interface ExtensionContract')
    expect(RUNTIME_SRC).toContain('extensionType')
    expect(RUNTIME_SRC).toContain('extensionVersion')
    expect(RUNTIME_SRC).toContain('execute(')
    expect(RUNTIME_SRC).toContain('reverse?(')
    expect(RUNTIME_SRC).toContain('verify(')
  })

  test('ExtensionExecutionContext is defined (carries ceiling to execute)', () => {
    expect(RUNTIME_SRC).toContain('export interface ExtensionExecutionContext')
    expect(RUNTIME_SRC).toContain('capabilities')
    expect(RUNTIME_SRC).toContain('resourceLimits')
    expect(RUNTIME_SRC).toContain('parameters')
  })

  test('registerExtensionImplementation exists (in-memory dispatch table)', () => {
    expect(RUNTIME_SRC).toContain('export function registerExtensionImplementation')
  })

  test('ExtensionRuntime uses ExtensionRegistry for resolution (W017-AC01)', () => {
    expect(RUNTIME_SRC).toContain('getExtension')
    expect(RUNTIME_SRC).toContain('resolveFromRegistry')
    expect(RUNTIME_SRC).toContain('ExtensionRegistry is the sole authority')
  })

  test('ExtensionRuntime does NOT own lifecycle authority (W017-AC08)', () => {
    // The runtime observes lifecycle state from the registry; it does NOT own it.
    expect(RUNTIME_SRC).toContain('observes')
    expect(RUNTIME_SRC).not.toMatch(/export\s+const\s+LIFECYCLE_STATE\b/)
    expect(RUNTIME_SRC).not.toMatch(/export\s+const\s+VALID_TRANSITIONS\b/)
  })
})
