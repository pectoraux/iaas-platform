// =============================================================================
// TransformRegistry — IAAS-DOM-ARCH-3 / DOM-015 / WORK-010
// =============================================================================
// The service-layer catalog/discovery primitive for Transforms. Provides
// tenant-scoped registration, lookup by (transformType, transformVersion),
// version compatibility rules, certification metadata, and revocation metadata.
//
// Contract source: spec/domain-architecture-v3.md §2.4, spec/domain-requirements-
// v3.md DOM-015, spec/work-orders/WORK-010.md.
//
// ARCHITECTURAL BOUNDARIES (frozen by IAAS-DOM-ARCH-3):
//   - Service-layer, NOT kernel (this module is in src/lib/services/).
//   - Does NOT execute transforms (that is TransformRuntime — future).
//   - Does NOT import vertical services (VPP/Compute/Storage/Wireless/Manufacturing).
//   - Does NOT import EconomicPipeline, Route/Transport, RuntimeRegistry, or kernel.
//   - PostgreSQL is the durable source of registry metadata.
//   - Tenant isolation is mandatory.
//   - Deterministic idempotency: (tenantId, transformType, transformVersion).
//
// This service does NOT:
//   - execute(), reverse(), estimateCost(), verify() — those are TransformRuntime.
//   - own TransformRecord storage — it references transforms by type+version.
//   - implement marketplace/licensing/pricing — future.
//   - implement cryptographic signatures — certification is metadata only.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransformRegistryEntryInput {
  transformType: string
  transformVersion: string
  description?: string
  compatibleVersions?: string[] // semver range strings (e.g. ">=1.0.0 <2.0.0")
  certifierIdentity?: string
  certificationStatus?: string // uncertified | pending | certified | rejected
  inputContentTypes?: string[]
  outputContentTypes?: string[]
  reversibility?: boolean
  lossiness?: boolean
  idempotencyKey: string
}

export interface TransformRegistryEntryResult {
  id: string
  tenantId: string
  transformType: string
  transformVersion: string
  description: string
  compatibleVersions: string[]
  certifierIdentity: string | null
  certificationStatus: string
  certifiedAt: string | null
  revocationStatus: string
  revocationReason: string | null
  revokedAt: string | null
  inputContentTypes: string[]
  outputContentTypes: string[]
  reversibility: boolean
  lossiness: boolean
  idempotencyKey: string
  createdAt: string
  updatedAt: string
}

export interface CertificationUpdate {
  certifierIdentity: string
  certificationStatus: 'pending' | 'certified' | 'rejected'
}

export interface RevocationUpdate {
  reason: string
}

// ---------------------------------------------------------------------------
// Registration (idempotent)
// ---------------------------------------------------------------------------

/**
 * Register a Transform in the registry. Idempotent: if an entry with the same
 * (tenantId, transformType, transformVersion) already exists, it is returned
 * as-is (concurrent registrations converge). Tenant-scoped.
 */
export async function registerTransform(
  tenantId: string,
  input: TransformRegistryEntryInput,
  actorId?: string,
): Promise<TransformRegistryEntryResult> {
  if (!input.transformType) throw new ValidationError('transformType is required')
  if (!input.transformVersion) throw new ValidationError('transformVersion is required')
  if (!input.idempotencyKey) throw new ValidationError('idempotencyKey is required')

  // Idempotent: check existing first.
  const existing = await db.transformRegistryEntry.findUnique({
    where: {
      tenantId_transformType_transformVersion: {
        tenantId,
        transformType: input.transformType,
        transformVersion: input.transformVersion,
      },
    },
  })
  if (existing) {
    return toResult(existing)
  }

  // WORK-010: handle concurrent registration race. Multiple concurrent calls
  // may pass the findUnique check before any create commits. The unique
  // constraint (tenantId, transformType, transformVersion) causes a P2002
  // error on the loser(s). Catch it and re-read the winning entry.
  let created
  try {
    created = await db.transformRegistryEntry.create({
      data: {
        tenantId,
        transformType: input.transformType,
        transformVersion: input.transformVersion,
        description: input.description ?? '',
        compatibleVersionsJson: JSON.stringify(input.compatibleVersions ?? []),
        certifierIdentity: input.certifierIdentity ?? null,
        certificationStatus: input.certificationStatus ?? 'uncertified',
        inputContentTypesJson: JSON.stringify(input.inputContentTypes ?? []),
        outputContentTypesJson: JSON.stringify(input.outputContentTypes ?? []),
        reversibility: input.reversibility ?? false,
        lossiness: input.lossiness ?? false,
        idempotencyKey: input.idempotencyKey,
      },
    })
  } catch (err: unknown) {
    // Prisma P2002: unique constraint violation — another concurrent call won.
    if (err instanceof Error && err.message.includes('P2002')) {
      const winner = await db.transformRegistryEntry.findUnique({
        where: {
          tenantId_transformType_transformVersion: {
            tenantId,
            transformType: input.transformType,
            transformVersion: input.transformVersion,
          },
        },
      })
      if (winner) return toResult(winner)
    }
    throw err
  }

  await appendAudit({
    tenantId,
    actorId,
    eventType: 'transform_registry.entry_registered' as never,
    resourceType: 'transform_registry_entry',
    resourceId: created.id,
    metadata: {
      transformType: input.transformType,
      transformVersion: input.transformVersion,
    },
  })

  return toResult(created)
}

// ---------------------------------------------------------------------------
// Lookup (tenant-scoped)
// ---------------------------------------------------------------------------

/**
 * Look up a Transform by (transformType, transformVersion). Tenant-scoped:
 * a lookup in tenant A cannot return an entry from tenant B.
 */
export async function getTransform(
  tenantId: string,
  transformType: string,
  transformVersion: string,
): Promise<TransformRegistryEntryResult> {
  const entry = await db.transformRegistryEntry.findUnique({
    where: {
      tenantId_transformType_transformVersion: {
        tenantId,
        transformType,
        transformVersion,
      },
    },
  })
  if (!entry) {
    throw new NotFoundError('transform_registry_entry', `${transformType}@${transformVersion}`)
  }
  return toResult(entry)
}

/**
 * List all registered Transforms for a tenant, optionally filtered by type.
 */
export async function listTransforms(
  tenantId: string,
  filter?: { transformType?: string; certificationStatus?: string; revocationStatus?: string },
): Promise<TransformRegistryEntryResult[]> {
  const entries = await db.transformRegistryEntry.findMany({
    where: {
      tenantId,
      ...(filter?.transformType ? { transformType: filter.transformType } : {}),
      ...(filter?.certificationStatus ? { certificationStatus: filter.certificationStatus } : {}),
      ...(filter?.revocationStatus ? { revocationStatus: filter.revocationStatus } : {}),
    },
    orderBy: { createdAt: 'desc' },
  })
  return entries.map(toResult)
}

// ---------------------------------------------------------------------------
// Version Compatibility
// ---------------------------------------------------------------------------

/**
 * Check if a registered Transform is compatible with a requested version.
 * The registry evaluates compatibility rules (stored as semver ranges) WITHOUT
 * executing the transform.
 */
export async function checkVersionCompatibility(
  tenantId: string,
  transformType: string,
  requestedVersion: string,
): Promise<{ compatible: boolean; compatibleVersions: string[]; registeredVersion: string }> {
  const entry = await db.transformRegistryEntry.findFirst({
    where: { tenantId, transformType },
    orderBy: { transformVersion: 'desc' },
  })
  if (!entry) {
    throw new NotFoundError('transform_registry_entry', `type=${transformType}`)
  }
  const compatibleVersions = JSON.parse(entry.compatibleVersionsJson) as string[]
  // Simple semver-compatible check: if the requested version matches any
  // compatible range, or if no ranges are specified (accept all).
  const compatible = compatibleVersions.length === 0 || compatibleVersions.some(range => {
    // Basic range check: exact match or wildcard.
    // Full semver range parsing is intentionally NOT implemented here —
    // the registry stores metadata, not a semver engine. This is a
    // placeholder for future refinement.
    return range === requestedVersion || range === '*' || range.includes(requestedVersion)
  })
  return { compatible, compatibleVersions, registeredVersion: entry.transformVersion }
}

// ---------------------------------------------------------------------------
// Certification Metadata
// ---------------------------------------------------------------------------

/**
 * Update certification metadata for a Transform. Does NOT freeze a
 * cryptographic mechanism — just records who certified and the status.
 */
export async function updateCertification(
  tenantId: string,
  transformType: string,
  transformVersion: string,
  update: CertificationUpdate,
  actorId?: string,
): Promise<TransformRegistryEntryResult> {
  const entry = await db.transformRegistryEntry.findUnique({
    where: {
      tenantId_transformType_transformVersion: {
        tenantId,
        transformType,
        transformVersion,
      },
    },
  })
  if (!entry) {
    throw new NotFoundError('transform_registry_entry', `${transformType}@${transformVersion}`)
  }

  const updated = await db.transformRegistryEntry.update({
    where: { id: entry.id },
    data: {
      certifierIdentity: update.certifierIdentity,
      certificationStatus: update.certificationStatus,
      certifiedAt: update.certificationStatus === 'certified' ? new Date() : entry.certifiedAt,
    },
  })

  await appendAudit({
    tenantId,
    actorId,
    eventType: 'transform_registry.certification_updated' as never,
    resourceType: 'transform_registry_entry',
    resourceId: entry.id,
    metadata: { transformType, transformVersion, certificationStatus: update.certificationStatus },
  })

  return toResult(updated)
}

// ---------------------------------------------------------------------------
// Revocation Metadata
// ---------------------------------------------------------------------------

/**
 * Revoke a Transform entry. Records the revocation reason and timestamp.
 * The entry remains in the registry (for audit) but is marked revoked.
 */
export async function revokeTransform(
  tenantId: string,
  transformType: string,
  transformVersion: string,
  update: RevocationUpdate,
  actorId?: string,
): Promise<TransformRegistryEntryResult> {
  const entry = await db.transformRegistryEntry.findUnique({
    where: {
      tenantId_transformType_transformVersion: {
        tenantId,
        transformType,
        transformVersion,
      },
    },
  })
  if (!entry) {
    throw new NotFoundError('transform_registry_entry', `${transformType}@${transformVersion}`)
  }
  if (entry.revocationStatus === 'revoked') {
    throw new ConflictError(`Transform ${transformType}@${transformVersion} is already revoked`)
  }

  const updated = await db.transformRegistryEntry.update({
    where: { id: entry.id },
    data: {
      revocationStatus: 'revoked',
      revocationReason: update.reason,
      revokedAt: new Date(),
    },
  })

  await appendAudit({
    tenantId,
    actorId,
    eventType: 'transform_registry.entry_revoked' as never,
    resourceType: 'transform_registry_entry',
    resourceId: entry.id,
    metadata: { transformType, transformVersion, reason: update.reason },
  })

  return toResult(updated)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toResult(entry: {
  id: string
  tenantId: string
  transformType: string
  transformVersion: string
  description: string
  compatibleVersionsJson: string
  certifierIdentity: string | null
  certificationStatus: string
  certifiedAt: Date | null
  revocationStatus: string
  revocationReason: string | null
  revokedAt: Date | null
  inputContentTypesJson: string
  outputContentTypesJson: string
  reversibility: boolean
  lossiness: boolean
  idempotencyKey: string
  createdAt: Date
  updatedAt: Date
}): TransformRegistryEntryResult {
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    transformType: entry.transformType,
    transformVersion: entry.transformVersion,
    description: entry.description,
    compatibleVersions: JSON.parse(entry.compatibleVersionsJson),
    certifierIdentity: entry.certifierIdentity,
    certificationStatus: entry.certificationStatus,
    certifiedAt: entry.certifiedAt?.toISOString() ?? null,
    revocationStatus: entry.revocationStatus,
    revocationReason: entry.revocationReason,
    revokedAt: entry.revokedAt?.toISOString() ?? null,
    inputContentTypes: JSON.parse(entry.inputContentTypesJson),
    outputContentTypes: JSON.parse(entry.outputContentTypesJson),
    reversibility: entry.reversibility,
    lossiness: entry.lossiness,
    idempotencyKey: entry.idempotencyKey,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  }
}
