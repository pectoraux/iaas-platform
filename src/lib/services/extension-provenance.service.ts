// =============================================================================
// ExtensionProvenanceService — IAAS-DOM-ARCH-4 / DOM-022 / WORK-018
// =============================================================================
// The service-layer durable provenance boundary for Extension execution.
// Consumes immutable ExtensionProvenancePayload objects emitted by
// ExtensionRuntime (WORK-017) through the ExtensionProvenanceSink boundary
// contract, and persists them to PostgreSQL as immutable durable records.
//
// Contract source: spec/domain-architecture-v4.md §2.4,
// spec/domain-requirements-v4.md DOM-022, spec/work-orders/WORK-018.md.
//
// ARCHITECTURAL BOUNDARIES (frozen by IAAS-DOM-ARCH-4):
//   - Service-layer, NOT kernel (this module is in src/lib/services/).
//   - OWNS durable provenance persistence. ExtensionRuntime emits; this service
//     persists. The Runtime does NOT write to the database directly.
//   - IMMUTABLE after creation — no update/delete path is exposed.
//   - PostgreSQL is the durable source of truth.
//   - Tenant isolation is mandatory; cross-tenant queries are prohibited.
//   - One durable record per (tenantId, executionIdempotencyKey) — concurrent
//     writes converge (P2002 catch + re-read).
//   - SHA-256 fingerprint over the frozen material fields (V4 §2.4).
//   - Provenance persisted after both success and failure.
//
// This service does NOT:
//   - execute extensions (that is ExtensionRuntime);
//   - own catalog/lifecycle state (that is ExtensionRegistry);
//   - select or implement sandbox technology (OPEN/RESEARCH);
//   - implement concrete extensions, Marketplace, SDK, licensing, economics;
//   - import vertical services, EconomicPipeline, Route/Transport,
//     RuntimeRegistry, or kernel code;
//   - expose any update or delete path for provenance records (immutability);
//   - import ExtensionRuntime (no reverse dependency — Runtime emits to the
//     sink interface, which this service implements).
// =============================================================================

import { db } from '@/lib/db'
import { NotFoundError, ValidationError, ConflictError } from '@/lib/domain/errors'
import { sha256 } from '@/lib/domain/crypto'
import { appendAudit } from '@/lib/domain/audit'
import type {
  ExtensionProvenancePayload,
  ExtensionProvenanceSink,
  ExtensionResourceLimits,
} from '@/lib/services/extension-runtime.service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtensionProvenanceRecord {
  id: string
  tenantId: string
  extensionType: string
  extensionVersion: string
  executionIdempotencyKey: string
  inputHash: string
  outputHash: string
  resultStatus: 'success' | 'failed'
  resourceUsage: ExtensionResourceLimits
  capabilitiesExercised: string[]
  tenantApprovedCeiling: {
    capabilities: string[]
    resourceLimits: ExtensionResourceLimits
  }
  failureMetadata?: {
    error: string
    errorType: string
    denialReason?: string
  }
  fingerprint: string
  createdAt: string
}

export interface ExtensionProvenanceEmitResult {
  recordId: string
  status: 'created' | 'replay'
}

export interface ExtensionProvenanceListFilter {
  extensionType?: string
  extensionVersion?: string
  resultStatus?: 'success' | 'failed'
}

// ---------------------------------------------------------------------------
// Persist Provenance (the sole write path — idempotent, immutable)
// ---------------------------------------------------------------------------

/**
 * Persist an ExtensionProvenance payload to PostgreSQL. This is the sole write
 * path for provenance records — it is called by the durable sink (which
 * implements ExtensionProvenanceSink) and is NOT called by ExtensionRuntime
 * directly.
 *
 * Idempotent: the same (tenantId, executionIdempotencyKey) tuple always
 * resolves to the same durable record. Concurrent calls converge (P2002 catch
 * + re-read).
 *
 * Fingerprint validation: the payload's fingerprint is recomputed from the
 * material fields and compared to the declared fingerprint. A mismatch
 * indicates tampering or a Runtime bug → ValidationError.
 *
 * Immutability: once a record exists, it is NEVER updated. A duplicate
 * emission with the same fingerprint returns the existing record (replay). A
 * duplicate emission with the same (tenantId, executionIdempotencyKey) but a
 * DIFFERENT fingerprint is an idempotency conflict → ConflictError.
 *
 * DOM-022 acceptance:
 *   - AC01: immutable 11-field record (plus failureMetadata for failed).
 *   - AC03: SHA-256 fingerprint over frozen material fields.
 *   - AC04: one durable record per tenant/idempotency key with convergence.
 *   - AC05: success/failure persistence (resultStatus preserved).
 *   - AC07: PostgreSQL durable source, no update/delete path.
 */
export async function persistExtensionProvenance(
  payload: ExtensionProvenancePayload,
  actorId?: string,
): Promise<ExtensionProvenanceEmitResult> {
  // 1. Validate the fingerprint (recompute + compare). This catches Runtime
  //    bugs or payload tampering before persistence.
  const expectedFingerprint = computeExtensionProvenanceFingerprint({
    tenantId: payload.tenantId,
    extensionType: payload.extensionType,
    extensionVersion: payload.extensionVersion,
    executionIdempotencyKey: payload.executionIdempotencyKey,
    inputHash: payload.inputHash,
    outputHash: payload.outputHash,
    resultStatus: payload.resultStatus,
  })
  if (expectedFingerprint !== payload.fingerprint) {
    throw new ValidationError(
      'ExtensionProvenance fingerprint mismatch: payload fingerprint does not match recomputed fingerprint over material fields',
      {
        declared: payload.fingerprint,
        recomputed: expectedFingerprint,
      },
    )
  }

  // 2. Idempotent insert: try to create, catch P2002, re-read.
  //    ExtensionProvenance has TWO unique constraints:
  //      - @@unique([tenantId, executionIdempotencyKey]) — one record per key
  //      - @unique on fingerprint — identical payloads converge
  //    A P2002 on (tenantId, executionIdempotencyKey) with a DIFFERENT
  //    fingerprint is an idempotency conflict (same key, different fact).
  try {
    const record = await db.extensionProvenance.create({
      data: {
        tenantId: payload.tenantId,
        extensionType: payload.extensionType,
        extensionVersion: payload.extensionVersion,
        executionIdempotencyKey: payload.executionIdempotencyKey,
        inputHash: payload.inputHash,
        outputHash: payload.outputHash,
        resultStatus: payload.resultStatus,
        resourceUsageJson: JSON.stringify(payload.resourceUsage ?? {}),
        capabilitiesExercisedJson: JSON.stringify(payload.capabilitiesExercised ?? []),
        tenantApprovedCeilingJson: JSON.stringify(payload.tenantApprovedCeiling ?? {
          capabilities: [],
          resourceLimits: {},
        }),
        failureMetadataJson: JSON.stringify(payload.failureMetadata ?? {}),
        fingerprint: payload.fingerprint,
      },
    })

    await appendAudit({
      tenantId: payload.tenantId,
      actorId,
      eventType: 'extension_provenance.record_persisted' as never,
      resourceType: 'extension_provenance',
      resourceId: record.id,
      metadata: {
        extensionType: payload.extensionType,
        extensionVersion: payload.extensionVersion,
        resultStatus: payload.resultStatus,
        fingerprint: payload.fingerprint,
      },
    })

    return { recordId: record.id, status: 'created' }
  } catch (err: unknown) {
    if (!isPrismaUniqueConstraintError(err)) throw err

    // P2002: a record with the same (tenantId, executionIdempotencyKey) OR
    // the same fingerprint already exists. Re-read to determine which.
    const existing = await db.extensionProvenance.findUnique({
      where: {
        tenantId_executionIdempotencyKey: {
          tenantId: payload.tenantId,
          executionIdempotencyKey: payload.executionIdempotencyKey,
        },
      },
    })

    if (!existing) {
      // The P2002 was on the fingerprint unique constraint, but no record
      // exists for this (tenantId, executionIdempotencyKey). This is an
      // extremely unlikely race: another concurrent emission with a different
      // idempotency key but the same fingerprint. Re-read by fingerprint.
      const byFingerprint = await db.extensionProvenance.findUnique({
        where: { fingerprint: payload.fingerprint },
      })
      if (byFingerprint) {
        // Same fingerprint but different idempotency key → the material
        // fields collide on a different idempotency key, which means the
        // caller reused a fingerprint with a different key. This is a
        // conflict (the record is immutable; we cannot re-emit it under a
        // different key).
        throw new ConflictError(
          'ExtensionProvenance fingerprint conflict: a record with this fingerprint already exists under a different idempotency key',
          { existingRecordId: byFingerprint.id, fingerprint: payload.fingerprint },
        )
      }
      // Should not happen — re-throw the original error.
      throw err
    }

    // Idempotency conflict check: same key, different fingerprint → conflict.
    if (existing.fingerprint !== payload.fingerprint) {
      throw new ConflictError(
        'ExtensionProvenance idempotency conflict: same (tenantId, executionIdempotencyKey) but different fingerprint (material fields differ)',
        {
          idempotencyKey: payload.executionIdempotencyKey,
          existingRecordId: existing.id,
          existingFingerprint: existing.fingerprint,
          declaredFingerprint: payload.fingerprint,
        },
      )
    }

    // Idempotent replay — return the existing record.
    return { recordId: existing.id, status: 'replay' }
  }
}

// ---------------------------------------------------------------------------
// Tenant-scoped reads (no cross-tenant access)
// ---------------------------------------------------------------------------

/**
 * Get a single ExtensionProvenance record by id, scoped to the caller's tenant.
 * Cross-tenant access is rejected (NotFoundError — the record does not exist
 * from the caller's perspective).
 *
 * DOM-022 AC02: tenant-scoped; cross-tenant queries prohibited.
 */
export async function getExtensionProvenance(
  tenantId: string,
  recordId: string,
): Promise<ExtensionProvenanceRecord> {
  const record = await db.extensionProvenance.findFirst({
    where: { id: recordId, tenantId },
  })
  if (!record) {
    throw new NotFoundError('extension_provenance', recordId)
  }
  return toRecord(record)
}

/**
 * List ExtensionProvenance records for the caller's tenant, with optional
 * filters. Cross-tenant access is structurally impossible (tenantId is
 * always in the where clause).
 *
 * DOM-022 AC02: tenant-scoped; cross-tenant queries prohibited.
 */
export async function listExtensionProvenance(
  tenantId: string,
  filter?: ExtensionProvenanceListFilter,
): Promise<ExtensionProvenanceRecord[]> {
  const records = await db.extensionProvenance.findMany({
    where: {
      tenantId,
      ...(filter?.extensionType ? { extensionType: filter.extensionType } : {}),
      ...(filter?.extensionVersion ? { extensionVersion: filter.extensionVersion } : {}),
      ...(filter?.resultStatus ? { resultStatus: filter.resultStatus } : {}),
    },
    orderBy: { createdAt: 'desc' },
  })
  return records.map(toRecord)
}

/**
 * Get a single ExtensionProvenance record by fingerprint, scoped to the
 * caller's tenant. Used by tests and audit tooling to verify replay
 * convergence.
 *
 * DOM-022 AC02: tenant-scoped; cross-tenant queries prohibited.
 */
export async function getExtensionProvenanceByFingerprint(
  tenantId: string,
  fingerprint: string,
): Promise<ExtensionProvenanceRecord> {
  const record = await db.extensionProvenance.findFirst({
    where: { fingerprint, tenantId },
  })
  if (!record) {
    throw new NotFoundError('extension_provenance', `fingerprint=${fingerprint}`)
  }
  return toRecord(record)
}

// ---------------------------------------------------------------------------
// DurableExtensionProvenanceSink — implements ExtensionProvenanceSink
// ---------------------------------------------------------------------------

/**
 * Durable PostgreSQL-backed ExtensionProvenanceSink. Implements the
 * ExtensionProvenanceSink boundary contract (defined in extension-runtime.service)
 * by delegating to {@link persistExtensionProvenance}.
 *
 * ExtensionRuntime emits payloads to this sink; the sink owns durable storage.
 * The Runtime does NOT write to the database directly and does NOT import this
 * service — it only depends on the ExtensionProvenanceSink interface.
 *
 * DOM-022 AC06: provenance service owns persistence separately from Runtime.
 */
export class DurableExtensionProvenanceSink implements ExtensionProvenanceSink {
  async emit(payload: ExtensionProvenancePayload): Promise<{ recordId: string; status: 'created' | 'replay' }> {
    const result = await persistExtensionProvenance(payload)
    return { recordId: result.recordId, status: result.status }
  }
}

/**
 * Module-level singleton durable sink. Used as the default sink by
 * ExtensionRuntime (via getDefaultExtensionProvenanceSink in
 * extension-runtime.service). Lazy-initialized to avoid requiring a database
 * connection at module import time (tests that use the in-memory sink do not
 * need a database).
 */
let durableSinkSingleton: DurableExtensionProvenanceSink | null = null

/**
 * Get the singleton DurableExtensionProvenanceSink. Lazily initialized.
 */
export function getDurableExtensionProvenanceSink(): DurableExtensionProvenanceSink {
  if (!durableSinkSingleton) {
    durableSinkSingleton = new DurableExtensionProvenanceSink()
  }
  return durableSinkSingleton
}

/**
 * Test helper: reset the singleton durable sink. Production code should NOT
 * call this — it is for test isolation only.
 */
export function __resetDurableExtensionProvenanceSinkForTesting(): void {
  durableSinkSingleton = null
}

// ---------------------------------------------------------------------------
// Fingerprint computation (V4 §2.4)
// ---------------------------------------------------------------------------

/**
 * Compute the V4 §2.4 ExtensionProvenance fingerprint.
 *
 * SHA-256 of the canonical JSON of the material fields:
 *   {tenantId, extensionType, extensionVersion, executionIdempotencyKey,
 *    inputHash, outputHash, resultStatus}
 *
 * This MUST match the fingerprint computed by ExtensionRuntime
 * (computeExtensionProvenanceFingerprint in extension-runtime.service). The
 * canonical form is identical: keys in declaration order, no whitespace.
 *
 * Exported so tests can verify the two computations agree.
 */
export function computeExtensionProvenanceFingerprint(input: {
  tenantId: string
  extensionType: string
  extensionVersion: string
  executionIdempotencyKey: string
  inputHash: string
  outputHash: string
  resultStatus: 'success' | 'failed'
}): string {
  const canonical = JSON.stringify({
    tenantId: input.tenantId,
    extensionType: input.extensionType,
    extensionVersion: input.extensionVersion,
    executionIdempotencyKey: input.executionIdempotencyKey,
    inputHash: input.inputHash,
    outputHash: input.outputHash,
    resultStatus: input.resultStatus,
  })
  return sha256(canonical)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a Prisma ExtensionProvenance row to the service-layer record type.
 * Deserializes JSON fields back to their structured forms.
 */
function toRecord(row: {
  id: string
  tenantId: string
  extensionType: string
  extensionVersion: string
  executionIdempotencyKey: string
  inputHash: string
  outputHash: string
  resultStatus: string
  resourceUsageJson: string
  capabilitiesExercisedJson: string
  tenantApprovedCeilingJson: string
  failureMetadataJson: string
  fingerprint: string
  createdAt: Date
}): ExtensionProvenanceRecord {
  const resourceUsage = JSON.parse(row.resourceUsageJson) as ExtensionResourceLimits
  const capabilitiesExercised = JSON.parse(row.capabilitiesExercisedJson) as string[]
  const tenantApprovedCeiling = JSON.parse(row.tenantApprovedCeilingJson) as {
    capabilities: string[]
    resourceLimits: ExtensionResourceLimits
  }
  const failureMetadataRaw = JSON.parse(row.failureMetadataJson || '{}') as {
    error?: string
    errorType?: string
    denialReason?: string
  }

  return {
    id: row.id,
    tenantId: row.tenantId,
    extensionType: row.extensionType,
    extensionVersion: row.extensionVersion,
    executionIdempotencyKey: row.executionIdempotencyKey,
    inputHash: row.inputHash,
    outputHash: row.outputHash,
    resultStatus: row.resultStatus as 'success' | 'failed',
    resourceUsage,
    capabilitiesExercised,
    tenantApprovedCeiling,
    failureMetadata:
      failureMetadataRaw.error !== undefined
        ? {
            error: failureMetadataRaw.error,
            errorType: failureMetadataRaw.errorType ?? 'Unknown',
            denialReason: failureMetadataRaw.denialReason,
          }
        : undefined,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Type guard for Prisma unique-constraint violation (P2002).
 * ExtensionProvenance has TWO unique constraints:
 *   - @@unique([tenantId, executionIdempotencyKey])
 *   - @unique on fingerprint
 * The service re-reads both to determine which constraint fired.
 */
function isPrismaUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string }
  return e.code === 'P2002'
}
