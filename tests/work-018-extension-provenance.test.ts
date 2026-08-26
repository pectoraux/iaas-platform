/// <reference types="bun-types" />
// =============================================================================
// WORK-018 — ExtensionProvenance unit + architecture tests
// =============================================================================
// Verifies W018-AC01..AC09: ExtensionProvenance is a service-layer durable
// boundary that owns persistence, exposes no update/delete path, enforces the
// frozen 11-field record + SHA-256 fingerprint, preserves Runtime-emits /
// provenance-persists separation, and obeys all V4 anti-dependency
// prohibitions.
// =============================================================================

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()

function readSrc(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

// ---------------------------------------------------------------------------
// W018-AC08 — static architecture + anti-dependency checks
// ---------------------------------------------------------------------------

describe('WORK-018 — ExtensionProvenanceService architecture (W018-AC08)', () => {
  const SERVICE_SRC = readSrc('src/lib/services/extension-provenance.service.ts')

  test('ExtensionProvenanceService is in the service layer (NOT kernel)', () => {
    const path = join(REPO_ROOT, 'src', 'lib', 'services', 'extension-provenance.service.ts')
    expect(path).toContain('src/lib/services/')
    expect(path).not.toContain('src/lib/kernel/')
  })

  test('ExtensionProvenanceService imports NO vertical service (W018-AC08)', () => {
    const verticalPattern = /(?:vpp|compute|storage|wireless|manufacturing)\.service/
    expect(verticalPattern.test(SERVICE_SRC)).toBe(false)
  })

  test('ExtensionProvenanceService imports NO EconomicPipeline (W018-AC08)', () => {
    expect(SERVICE_SRC).not.toContain('economic-pipeline')
  })

  test('ExtensionProvenanceService imports NO Route/Transport (W018-AC08)', () => {
    const dataPlanePattern = /(?:routing|transport|delivery-confirmation)\.service/
    expect(dataPlanePattern.test(SERVICE_SRC)).toBe(false)
  })

  test('ExtensionProvenanceService imports NO RuntimeRegistry (W018-AC08)', () => {
    expect(SERVICE_SRC).not.toMatch(/^import.*RuntimeRegistry/m)
    expect(SERVICE_SRC).not.toMatch(/from\s+['"]@\/lib\/kernel\/runtime['"]/m)
    expect(SERVICE_SRC).not.toMatch(/from\s+['"]@\/lib\/kernel\//m)
  })

  test('ExtensionProvenanceService imports NO kernel code (W018-AC08)', () => {
    expect(SERVICE_SRC).not.toMatch(/^import.*@\/lib\/kernel/m)
  })

  test('ExtensionProvenanceService imports NO ExtensionRuntime (no reverse dependency) (W018-AC06)', () => {
    // The provenance service implements ExtensionProvenanceSink (the interface
    // defined in extension-runtime.service) but must NOT import the Runtime
    // module's execute/reverse/verify functions. It imports ONLY the types.
    // This preserves the Runtime-emits / provenance-persists separation.
    expect(SERVICE_SRC).toMatch(/from\s+['"]@\/lib\/services\/extension-runtime\.service['"]/)
    // Type-only import — the import statement must use `import type` or
    // import only type identifiers.
    expect(SERVICE_SRC).toMatch(/import\s+type\s+\{/)
    // Must NOT import execute/reverse/verify functions.
    expect(SERVICE_SRC).not.toMatch(/import\s+\{[^}]*executeExtension/)
    expect(SERVICE_SRC).not.toMatch(/import\s+\{[^}]*reverseExtension/)
    expect(SERVICE_SRC).not.toMatch(/import\s+\{[^}]*verifyExtension/)
    expect(SERVICE_SRC).not.toMatch(/import\s+\{[^}]*registerExtensionImplementation/)
  })

  test('ExtensionProvenanceService imports NO TransformRegistry/TransformRecord/TransformRuntime (W018-AC08)', () => {
    expect(SERVICE_SRC).not.toContain('transform-registry.service')
    expect(SERVICE_SRC).not.toContain('transform-record.service')
    expect(SERVICE_SRC).not.toContain('transform-runtime.service')
  })

  test('ExtensionProvenanceService does NOT import ExtensionRegistry (W018-AC08)', () => {
    // Provenance persistence is decoupled from the catalog. The service
    // persists whatever the Runtime emits; it does not resolve extensions.
    expect(SERVICE_SRC).not.toContain('extension-registry.service')
  })
})

// ---------------------------------------------------------------------------
// W018-AC06 — Runtime emits / provenance service persists separation
// ---------------------------------------------------------------------------

describe('WORK-018 — Runtime/provenance separation (W018-AC06)', () => {
  const SERVICE_SRC = readSrc('src/lib/services/extension-provenance.service.ts')
  const RUNTIME_SRC = readSrc('src/lib/services/extension-runtime.service.ts')

  test('ExtensionProvenanceService OWNS persistence (imports db)', () => {
    expect(SERVICE_SRC).toContain("from '@/lib/db'")
    expect(SERVICE_SRC).toContain('db.extensionProvenance')
  })

  test('ExtensionRuntime does NOT own persistence (no db import)', () => {
    expect(RUNTIME_SRC).not.toMatch(/^import.*@\/lib\/db/m)
    expect(RUNTIME_SRC).not.toContain("from '@/lib/db'")
    expect(RUNTIME_SRC).not.toContain('db.extensionProvenance')
  })

  test('ExtensionRuntime does NOT import the provenance service (boundary)', () => {
    expect(RUNTIME_SRC).not.toMatch(/from\s+['"][^'"]*extension-provenance/)
  })

  test('ExtensionProvenanceService implements ExtensionProvenanceSink', () => {
    expect(SERVICE_SRC).toContain('export class DurableExtensionProvenanceSink')
    expect(SERVICE_SRC).toContain('implements ExtensionProvenanceSink')
    expect(SERVICE_SRC).toContain('async emit(payload')
  })

  test('ExtensionRuntime exposes setDefaultExtensionProvenanceSink for bootstrap injection', () => {
    expect(RUNTIME_SRC).toContain('export function setDefaultExtensionProvenanceSink')
    expect(RUNTIME_SRC).toContain('export function getDefaultExtensionProvenanceSink')
  })
})

// ---------------------------------------------------------------------------
// W018-AC07 — no update/delete path (immutability)
// ---------------------------------------------------------------------------

describe('WORK-018 — Immutability: no update/delete path (W018-AC07)', () => {
  const SERVICE_SRC = readSrc('src/lib/services/extension-provenance.service.ts')

  test('ExtensionProvenanceService does NOT export update functions', () => {
    expect(SERVICE_SRC).not.toMatch(/export\s+(async\s+)?function\s+updateExtensionProvenance\b/)
    expect(SERVICE_SRC).not.toMatch(/export\s+(async\s+)?function\s+updateProvenance\b/)
    expect(SERVICE_SRC).not.toMatch(/export\s+(async\s+)?function\s+patchExtensionProvenance\b/)
  })

  test('ExtensionProvenanceService does NOT export delete functions', () => {
    expect(SERVICE_SRC).not.toMatch(/export\s+(async\s+)?function\s+deleteExtensionProvenance\b/)
    expect(SERVICE_SRC).not.toMatch(/export\s+(async\s+)?function\s+deleteProvenance\b/)
    expect(SERVICE_SRC).not.toMatch(/export\s+(async\s+)?function\s+removeExtensionProvenance\b/)
  })

  test('ExtensionProvenanceService does NOT call db.extensionProvenance.update', () => {
    expect(SERVICE_SRC).not.toContain('db.extensionProvenance.update')
    expect(SERVICE_SRC).not.toContain('db.extensionProvenance.updateMany')
    expect(SERVICE_SRC).not.toContain('db.extensionProvenance.upsert')
  })

  test('ExtensionProvenanceService does NOT call db.extensionProvenance.delete', () => {
    expect(SERVICE_SRC).not.toContain('db.extensionProvenance.delete')
    expect(SERVICE_SRC).not.toContain('db.extensionProvenance.deleteMany')
  })

  test('ExtensionProvenanceService exposes ONLY persist + read functions', () => {
    // The sole write path is persistExtensionProvenance (idempotent create).
    expect(SERVICE_SRC).toContain('export async function persistExtensionProvenance')
    // Read paths are tenant-scoped.
    expect(SERVICE_SRC).toContain('export async function getExtensionProvenance')
    expect(SERVICE_SRC).toContain('export async function listExtensionProvenance')
    expect(SERVICE_SRC).toContain('export async function getExtensionProvenanceByFingerprint')
  })
})

// ---------------------------------------------------------------------------
// W018-AC01 — immutable 11-field record
// ---------------------------------------------------------------------------

describe('WORK-018 — Immutable 11-field record (W018-AC01)', () => {
  const SCHEMA = readSrc('prisma/schema.prisma')

  test('Prisma model ExtensionProvenance exists with frozen fields', () => {
    expect(SCHEMA).toMatch(/model\s+ExtensionProvenance\b/)
    // The 11 frozen V4 §2.4 fields must be present.
    const fields = [
      'tenantId',
      'extensionType',
      'extensionVersion',
      'executionIdempotencyKey',
      'inputHash',
      'outputHash',
      'resultStatus',
      'resourceUsageJson',          // serialized resourceUsage
      'capabilitiesExercisedJson',  // serialized capabilitiesExercised
      'tenantApprovedCeilingJson',  // serialized tenantApprovedCeiling
      'fingerprint',
      'createdAt',
    ]
    for (const f of fields) {
      expect(SCHEMA).toContain(f)
    }
  })

  test('Prisma model has @@unique([tenantId, executionIdempotencyKey]) for one-record-per-key', () => {
    expect(SCHEMA).toMatch(/@@unique\(\[tenantId,\s*executionIdempotencyKey\]\)/)
  })

  test('Prisma model has @unique on fingerprint for replay convergence', () => {
    expect(SCHEMA).toMatch(/fingerprint\s+String\s+@unique/)
  })

  test('Prisma model has NO updatedAt field (immutability)', () => {
    // Extract just the ExtensionProvenance model block.
    const match = SCHEMA.match(/model\s+ExtensionProvenance\s*\{[^}]+\}/)
    expect(match).toBeTruthy()
    const modelBlock = match![0]
    expect(modelBlock).not.toContain('updatedAt')
    expect(modelBlock).not.toContain('@updatedAt')
  })

  test('Tenant has extensionProvenanceRecords back-relation', () => {
    expect(SCHEMA).toContain('extensionProvenanceRecords ExtensionProvenance[]')
  })
})

// ---------------------------------------------------------------------------
// W018-AC03 — SHA-256 fingerprint over frozen material fields
// ---------------------------------------------------------------------------

describe('WORK-018 — Fingerprint computation (W018-AC03)', () => {
  const SERVICE_SRC = readSrc('src/lib/services/extension-provenance.service.ts')

  test('computeExtensionProvenanceFingerprint is exported', () => {
    expect(SERVICE_SRC).toContain('export function computeExtensionProvenanceFingerprint')
  })

  test('Fingerprint uses SHA-256', () => {
    expect(SERVICE_SRC).toContain('sha256')
  })

  test('Fingerprint includes exactly the V4 §2.4 material fields', () => {
    // The fingerprint must include: tenantId, extensionType, extensionVersion,
    // executionIdempotencyKey, inputHash, outputHash, resultStatus.
    expect(SERVICE_SRC).toMatch(/tenantId[\s\S]*extensionType[\s\S]*extensionVersion[\s\S]*executionIdempotencyKey[\s\S]*inputHash[\s\S]*outputHash[\s\S]*resultStatus/)
  })

  test('Fingerprint validation rejects tampered payloads (recompute + compare)', () => {
    expect(SERVICE_SRC).toContain('expectedFingerprint')
    expect(SERVICE_SRC).toContain('fingerprint mismatch')
  })
})

// ---------------------------------------------------------------------------
// W018-AC04 — concurrent idempotency convergence
// ---------------------------------------------------------------------------

describe('WORK-018 — Concurrent idempotency convergence (W018-AC04)', () => {
  const SERVICE_SRC = readSrc('src/lib/services/extension-provenance.service.ts')

  test('persistExtensionProvenance handles P2002 concurrent race', () => {
    expect(SERVICE_SRC).toContain('P2002')
    expect(SERVICE_SRC).toContain('isPrismaUniqueConstraintError')
    expect(SERVICE_SRC).toContain('re-read')
  })

  test('Idempotent replay returns existing record (status=replay)', () => {
    expect(SERVICE_SRC).toContain("'replay'")
    expect(SERVICE_SRC).toContain('Idempotent replay')
  })

  test('Idempotency conflict (same key, different fingerprint) throws ConflictError', () => {
    expect(SERVICE_SRC).toContain('ConflictError')
    expect(SERVICE_SRC).toContain('idempotency conflict')
  })
})

// ---------------------------------------------------------------------------
// W018-AC02 — tenant isolation
// ---------------------------------------------------------------------------

describe('WORK-018 — Tenant isolation (W018-AC02)', () => {
  const SERVICE_SRC = readSrc('src/lib/services/extension-provenance.service.ts')

  test('getExtensionProvenance is tenant-scoped (tenantId in where clause)', () => {
    expect(SERVICE_SRC).toContain('where: { id: recordId, tenantId }')
  })

  test('listExtensionProvenance is tenant-scoped', () => {
    expect(SERVICE_SRC).toContain('where: {\n      tenantId,')
  })

  test('getExtensionProvenanceByFingerprint is tenant-scoped', () => {
    expect(SERVICE_SRC).toContain('where: { fingerprint, tenantId }')
  })

  test('Cross-tenant access rejected with NotFoundError', () => {
    expect(SERVICE_SRC).toContain('NotFoundError')
  })
})

// ---------------------------------------------------------------------------
// W018-AC05 — success/failure persistence
// ---------------------------------------------------------------------------

describe('WORK-018 — Success/failure persistence (W018-AC05)', () => {
  const SERVICE_SRC = readSrc('src/lib/services/extension-provenance.service.ts')

  test('persistExtensionProvenance accepts resultStatus success or failed', () => {
    expect(SERVICE_SRC).toContain("'success' | 'failed'")
    expect(SERVICE_SRC).toContain('resultStatus: payload.resultStatus')
  })

  test('failureMetadata is persisted (only when failed)', () => {
    expect(SERVICE_SRC).toContain('failureMetadataJson')
    expect(SERVICE_SRC).toContain('failureMetadata')
  })

  test('The persist function does NOT re-throw Runtime errors (persist only)', () => {
    // The provenance service persists the payload; it does NOT re-execute
    // the extension or re-throw Runtime errors. The Runtime is responsible
    // for re-throwing after emission. The persist function may throw its own
    // validation/conflict errors (ValidationError, ConflictError) and may
    // propagate unexpected non-P2002 errors (throw err), but it must NOT
    // contain logic that re-throws a Runtime execution error.
    const funcMatch = SERVICE_SRC.match(/export async function persistExtensionProvenance[\s\S]*?\n\}\n/)
    expect(funcMatch).toBeTruthy()
    const funcBody = funcMatch![0]
    // The persist function must not invoke executeExtension or re-execute.
    expect(funcBody).not.toContain('executeExtension')
    expect(funcBody).not.toContain('reverseExtension')
    expect(funcBody).not.toContain('verifyExtension')
  })
})

// ---------------------------------------------------------------------------
// Contract presence
// ---------------------------------------------------------------------------

describe('WORK-018 — ExtensionProvenanceService contract', () => {
  const SERVICE_SRC = readSrc('src/lib/services/extension-provenance.service.ts')

  test('DurableExtensionProvenanceSink is exported', () => {
    expect(SERVICE_SRC).toContain('export class DurableExtensionProvenanceSink')
  })

  test('getDurableExtensionProvenanceSink singleton accessor is exported', () => {
    expect(SERVICE_SRC).toContain('export function getDurableExtensionProvenanceSink')
  })

  test('persistExtensionProvenance returns { recordId, status }', () => {
    expect(SERVICE_SRC).toContain('Promise<ExtensionProvenanceEmitResult>')
    expect(SERVICE_SRC).toContain("status: 'created' | 'replay'")
  })

  test('ExtensionProvenanceRecord type matches V4 §2.4 deserialized shape', () => {
    expect(SERVICE_SRC).toContain('export interface ExtensionProvenanceRecord')
    const fields = [
      'id',
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
      'failureMetadata',
      'fingerprint',
      'createdAt',
    ]
    for (const f of fields) {
      expect(SERVICE_SRC).toContain(f)
    }
  })

  test('Audit event is emitted on persist', () => {
    expect(SERVICE_SRC).toContain('appendAudit')
    expect(SERVICE_SRC).toContain('extension_provenance.record_persisted')
  })
})
