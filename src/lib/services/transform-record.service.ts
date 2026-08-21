// =============================================================================
// TransformRecord service — Phase 14F: Transform Provenance Record.
//
// TransformRecord is the "transform chain" from the dependency graph
// (Bundle → Transform chain → Delivery), made real as a durable provenance
// record. It records that a specific transform was applied to a Bundle's
// payload, producing an output.
//
// It is DISTINCT from:
//   - TransformRegistry (catalog of available transforms — future phase).
//   - TransformRuntime (execution engine that calls execute/reverse/verify —
//     future phase).
//   - Bundle (the data-plane object — TransformRecord references it, does NOT
//     modify Bundle identity/payload).
//
// TransformRecord IS the provenance fact — it records that a transform
// happened, not how to execute it. It captures (constitution §9 Transform
// Provenance):
//   - input hash + output hash + transform identity + transform version
//   + parameters + node + result
//
// ARCHITECTURAL RULES (frozen):
//   - TransformRecord is IMMUTABLE. It is created once; it is never updated.
//     (like DeliveryConfirmation).
//   - It does NOT modify Bundle, Route, Node, TransportExecution, TransportAttempt,
//     or DeliveryConfirmation (immutability preserved).
//   - Tenant isolation: all queries filter by tenantId.
//   - Idempotent creation: deterministic key (tenantId, bundleId, nodeId,
//     transformType, idempotencyKey) → concurrent calls converge.
//   - It does NOT implement execute/reverse/estimateCost/verify — those are
//     TransformRuntime (future). TransformRecord records that a transform
//     happened, not how to execute it.
//   - It does NOT implement a registry — TransformRegistry is future.
//
// This service does NOT import:
//   - VPP / Compute / Storage / Wireless vertical services (anti-drift).
//   - ProtocolRuntime / HybridRuntime / economic pipeline (no kernel coupling).
//   - DTN / Extension / Marketplace / SDK (future).
//   - TransformRuntime / TransformRegistry (future — not in 14F).
//
// NOT in scope (explicit non-goals):
//   execute/reverse/estimateCost/verify, TransformRegistry, TransformRuntime,
//   marketplace, pricing, settlement, SDK, DTN, custody transfer, signatures.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { sha256 } from '@/lib/domain/crypto'
import { getBundle } from '@/lib/services/data-plane.service'
import { getNode } from '@/lib/services/node.service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateTransformRecordInput {
  /** The Bundle whose payload was transformed (must exist in tenant). */
  bundleId: string
  /** The Node that applied the transform (optional — may be system-applied). */
  nodeId?: string
  /** Generic transform identity (e.g. "compression", "encryption_proxy"). NOT a registry reference. */
  transformType: string
  /** Transform version (semantic versioning string). */
  transformVersion: string
  /** SHA-256 of the input payload. */
  inputHash: string
  /** SHA-256 of the output payload. */
  outputHash: string
  /** Transform parameters (canonical JSON). */
  parameters?: Record<string, unknown>
  /** Result status. */
  resultStatus?: 'success' | 'failed'
  /** Result metadata (e.g. compression ratio, error code). */
  resultMetadata?: Record<string, unknown>
  /** Caller-supplied key for deterministic identity (idempotency). */
  idempotencyKey: string
}

// ---------------------------------------------------------------------------
// createTransformRecord — idempotent immutable provenance record creation
// ---------------------------------------------------------------------------

/**
 * Create a TransformRecord. Idempotent: the same
 * (tenantId, bundleId, nodeId, transformType, idempotencyKey) always resolves
 * to the same durable record. Concurrent calls converge.
 *
 * Validation:
 *   - The Bundle must exist in the tenant.
 *   - If nodeId is provided, the Node must exist and be active in the tenant.
 *
 * The record is IMMUTABLE — it is never updated. A duplicate record (same key)
 * returns the existing record if the material fields match, or throws
 * ConflictError if they differ (idempotency conflict detection).
 */
export async function createTransformRecord(
  tenantId: string,
  input: CreateTransformRecordInput,
  actorId?: string,
) {
  if (!input.bundleId) throw new ValidationError('bundleId is required')
  if (!input.transformType) throw new ValidationError('transformType is required')
  if (!input.transformVersion) throw new ValidationError('transformVersion is required')
  if (!input.inputHash) throw new ValidationError('inputHash is required')
  if (!input.outputHash) throw new ValidationError('outputHash is required')
  if (!input.idempotencyKey) throw new ValidationError('idempotencyKey is required')

  // Validate Bundle exists in tenant (references, does not modify).
  const bundle = await getBundle(tenantId, input.bundleId)

  // Validate Node exists + is active (if provided).
  if (input.nodeId) {
    const node = await getNode(tenantId, input.nodeId)
    if (node.status !== 'active') {
      throw new ValidationError(
        `Node ${input.nodeId} is ${node.status}; only active Nodes can apply transforms`,
      )
    }
  }

  // Compute nodeIdentity — the non-null identity representation.
  // This is nodeId when a Node is specified, or '__system__' when no Node is
  // attributable (system-applied transform). This makes the @@unique constraint
  // non-null, so PostgreSQL enforces idempotency even for system-applied records
  // (nodeId = NULL). PostgreSQL UNIQUE allows multiple NULLs; nodeIdentity
  // replaces nodeId in the unique constraint to fix this.
  const nodeIdentity = input.nodeId ?? '__system__'

  // Compute the request fingerprint — the material content of the record.
  // This is used for idempotency conflict detection: same key + different
  // fingerprint → ConflictError. resultMetadata is non-identity-bearing.
  // resultStatus IS material (a success vs failed record are different facts).
  // Parameters are canonicalized (recursive key sort) so insertion-order
  // differences do not produce different fingerprints.
  const fingerprint = computeTransformFingerprint({
    bundleId: input.bundleId,
    payloadHash: bundle.payloadHash,
    nodeIdentity,
    transformType: input.transformType,
    transformVersion: input.transformVersion,
    inputHash: input.inputHash,
    outputHash: input.outputHash,
    parameters: input.parameters ?? {},
    resultStatus: input.resultStatus ?? 'success',
    idempotencyKey: input.idempotencyKey,
  })

  // Idempotent insert: try to create, catch P2002, re-read.
  // TransformRecord has ONE unique constraint (the idempotency key on
  // nodeIdentity, not nodeId), so there is no P2002 source ambiguity.
  try {
    const record = await db.transformRecord.create({
      data: {
        tenantId,
        bundleId: input.bundleId,
        nodeId: input.nodeId ?? null,
        nodeIdentity,
        transformType: input.transformType,
        transformVersion: input.transformVersion,
        inputHash: input.inputHash,
        outputHash: input.outputHash,
        parametersJson: canonicalStringify(input.parameters ?? {}),
        resultStatus: input.resultStatus ?? 'success',
        resultMetadataJson: JSON.stringify(input.resultMetadata ?? {}),
        idempotencyKey: input.idempotencyKey,
      },
    })

    await appendAudit({
      tenantId,
      actorId,
      eventType: AuditEvents.TransformRecordCreated,
      resourceType: 'transform_record',
      resourceId: record.id,
      metadata: {
        bundleId: input.bundleId,
        nodeId: input.nodeId ?? null,
        nodeIdentity,
        transformType: input.transformType,
        transformVersion: input.transformVersion,
      },
    })

    return record
  } catch (err: unknown) {
    // P2002: concurrent createTransformRecord won the insert race.
    // TransformRecord has only ONE unique constraint (on nodeIdentity), so
    // any P2002 is an idempotency race — no source ambiguity.
    if (isPrismaUniqueConstraintError(err)) {
      const existing = await db.transformRecord.findFirst({
        where: {
          tenantId,
          bundleId: input.bundleId,
          nodeIdentity,
          transformType: input.transformType,
          idempotencyKey: input.idempotencyKey,
        },
      })
      if (!existing) throw err
      // Idempotency conflict check: same key, different fingerprint → conflict.
      const existingFingerprint = computeTransformFingerprint({
        bundleId: existing.bundleId,
        payloadHash: bundle.payloadHash,
        nodeIdentity: existing.nodeIdentity,
        transformType: existing.transformType,
        transformVersion: existing.transformVersion,
        inputHash: existing.inputHash,
        outputHash: existing.outputHash,
        parameters: JSON.parse(existing.parametersJson),
        resultStatus: existing.resultStatus,
        idempotencyKey: existing.idempotencyKey,
      })
      if (existingFingerprint !== fingerprint) {
        throw new ConflictError(
          'TransformRecord idempotency conflict: same identity key but different request fingerprint (transformVersion, inputHash, outputHash, resultStatus, or parameters differ)',
          { idempotencyKey: input.idempotencyKey, recordId: existing.id },
        )
      }
      // Idempotent replay — return the existing record.
      return existing
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// getTransformRecord / listTransformRecords — tenant-scoped reads
// ---------------------------------------------------------------------------

export async function getTransformRecord(tenantId: string, recordId: string) {
  const record = await db.transformRecord.findFirst({
    where: { id: recordId, tenantId },
    include: {
      bundle: true,
      node: true,
    },
  })
  if (!record) throw new NotFoundError('transform_record', recordId)
  return record
}

export interface ListTransformRecordFilter {
  bundleId?: string
  nodeId?: string
  transformType?: string
  resultStatus?: string
}

export async function listTransformRecords(
  tenantId: string,
  filter?: ListTransformRecordFilter,
) {
  return db.transformRecord.findMany({
    where: {
      tenantId,
      ...(filter?.bundleId ? { bundleId: filter.bundleId } : {}),
      ...(filter?.nodeId ? { nodeId: filter.nodeId } : {}),
      ...(filter?.transformType ? { transformType: filter.transformType } : {}),
      ...(filter?.resultStatus ? { resultStatus: filter.resultStatus } : {}),
    },
    include: {
      bundle: true,
      node: true,
    },
    orderBy: { createdAt: 'desc' },
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the request fingerprint for idempotency conflict detection.
 *
 * MATERIAL fields (included in fingerprint):
 *   - bundleId, payloadHash, nodeIdentity
 *   - transformType, transformVersion
 *   - inputHash, outputHash
 *   - parameters (canonicalized via canonicalStringify)
 *   - resultStatus (success vs failed are different facts)
 *   - idempotencyKey
 *
 * NON-identity-bearing (excluded):
 *   - resultMetadata (observational — compression ratio, timestamps, etc.)
 *
 * There is ONE canonical derivation — this function is used by both
 * createTransformRecord and the idempotency conflict check.
 */
function computeTransformFingerprint(input: {
  bundleId: string
  payloadHash: string
  nodeIdentity: string
  transformType: string
  transformVersion: string
  inputHash: string
  outputHash: string
  parameters: Record<string, unknown>
  resultStatus: string
  idempotencyKey: string
}): string {
  const canonical = JSON.stringify({
    bundleId: input.bundleId,
    payloadHash: input.payloadHash,
    nodeIdentity: input.nodeIdentity,
    transformType: input.transformType,
    transformVersion: input.transformVersion,
    inputHash: input.inputHash,
    outputHash: input.outputHash,
    parameters: canonicalize(input.parameters),
    resultStatus: input.resultStatus,
    idempotencyKey: input.idempotencyKey,
  })
  return sha256(canonical)
}

/**
 * Deterministic JSON serialization for parameters. Recursively sorts object
 * keys so that { a: 1, b: 2 } and { b: 2, a: 1 } produce the same string.
 * This prevents false idempotency conflicts from key-insertion-order differences.
 *
 * This follows the same pattern as the canonicalize() helper in
 * src/lib/control-plane/types.ts (which is module-private and not exported).
 * The smallest local copy is introduced here to avoid modifying the control-plane
 * module (scope discipline).
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  const sortedKeys = Object.keys(value as Record<string, unknown>).sort()
  const result: Record<string, unknown> = {}
  for (const key of sortedKeys) {
    result[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return result
}

/**
 * Canonical JSON string — uses canonicalize() for deterministic key ordering.
 */
function canonicalStringify(value: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(value))
}

/**
 * Type guard for Prisma unique-constraint violation (P2002).
 * TransformRecord has only ONE unique constraint, so any P2002 is an
 * idempotency race — no source ambiguity.
 */
function isPrismaUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string }
  return e.code === 'P2002'
}
