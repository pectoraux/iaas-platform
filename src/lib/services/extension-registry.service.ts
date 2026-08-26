// =============================================================================
// ExtensionRegistry — IAAS-DOM-ARCH-4 / DOM-019 / WORK-016
// =============================================================================
// The service-layer catalog/lifecycle authority for Extensions. Provides
// tenant-scoped registration, lookup by (extensionType, extensionVersion),
// version compatibility rules, certification metadata, revocation metadata,
// and authoritative lifecycle state transitions.
//
// Contract source: spec/domain-architecture-v4.md §2.2 + §2.7,
// spec/domain-requirements-v4.md DOM-019, spec/work-orders/WORK-016.md.
//
// ARCHITECTURAL BOUNDARIES (frozen by IAAS-DOM-ARCH-4):
//   - Service-layer, NOT kernel (this module is in src/lib/services/).
//   - Does NOT execute extensions (that is ExtensionRuntime — future).
//   - Does NOT import vertical services (VPP/Compute/Storage/Wireless/Manufacturing).
//   - Does NOT import EconomicPipeline, Route/Transport, RuntimeRegistry, or kernel.
//   - PostgreSQL is the durable source of registry metadata.
//   - Tenant isolation is mandatory.
//   - Lifecycle authority: registered → installed → activated ⇌ deactivated → revoked (terminal).
//   - Deterministic idempotency: (tenantId, extensionType, extensionVersion).
//
// This service does NOT:
//   - execute(), reverse(), estimateCost(), verify() — those are ExtensionRuntime.
//   - own ExtensionProvenance storage — that is a separate provenance boundary.
//   - implement marketplace/licensing/pricing — future.
//   - implement cryptographic signatures — certification is metadata only.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtensionRegistryEntryInput {
  extensionType: string
  extensionVersion: string
  description?: string
  compatibleVersions?: string[]
  certifierIdentity?: string
  certificationStatus?: string
  declaredCapabilities?: string[]
  declaredResourceLimits?: { cpuMs?: number; memoryBytes?: number; timeMs?: number }
  publisherIdentity?: string
  idempotencyKey: string
}

export interface ExtensionRegistryEntryResult {
  id: string
  tenantId: string
  extensionType: string
  extensionVersion: string
  description: string
  compatibleVersions: string[]
  certifierIdentity: string | null
  certificationStatus: string
  certifiedAt: string | null
  revocationStatus: string
  revocationReason: string | null
  revokedAt: string | null
  lifecycleState: string
  declaredCapabilities: string[]
  declaredResourceLimits: { cpuMs?: number; memoryBytes?: number; timeMs?: number }
  publisherIdentity: string | null
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
// Lifecycle state constants
// ---------------------------------------------------------------------------

export const LIFECYCLE_STATE = {
  REGISTERED: 'registered',
  INSTALLED: 'installed',
  ACTIVATED: 'activated',
  DEACTIVATED: 'deactivated',
  REVOKED: 'revoked',
} as const

// Valid transitions (V4 §2.7):
// registered → installed → activated ⇌ deactivated → revoked (terminal)
const VALID_TRANSITIONS: Record<string, string[]> = {
  registered: [LIFECYCLE_STATE.INSTALLED, LIFECYCLE_STATE.REVOKED],
  installed: [LIFECYCLE_STATE.ACTIVATED, LIFECYCLE_STATE.REVOKED],
  activated: [LIFECYCLE_STATE.DEACTIVATED, LIFECYCLE_STATE.REVOKED],
  deactivated: [LIFECYCLE_STATE.ACTIVATED, LIFECYCLE_STATE.REVOKED],
  revoked: [], // terminal
}

// ---------------------------------------------------------------------------
// Registration (idempotent)
// ---------------------------------------------------------------------------

export async function registerExtension(
  tenantId: string,
  input: ExtensionRegistryEntryInput,
  actorId?: string,
): Promise<ExtensionRegistryEntryResult> {
  if (!input.extensionType) throw new ValidationError('extensionType is required')
  if (!input.extensionVersion) throw new ValidationError('extensionVersion is required')
  if (!input.idempotencyKey) throw new ValidationError('idempotencyKey is required')

  // Idempotent: check existing first.
  const existing = await db.extensionRegistryEntry.findUnique({
    where: {
      tenantId_extensionType_extensionVersion: {
        tenantId,
        extensionType: input.extensionType,
        extensionVersion: input.extensionVersion,
      },
    },
  })
  if (existing) {
    return toResult(existing)
  }

  // Handle concurrent registration race (P2002 catch + re-read).
  let created
  try {
    created = await db.extensionRegistryEntry.create({
      data: {
        tenantId,
        extensionType: input.extensionType,
        extensionVersion: input.extensionVersion,
        description: input.description ?? '',
        compatibleVersionsJson: JSON.stringify(input.compatibleVersions ?? []),
        certifierIdentity: input.certifierIdentity ?? null,
        certificationStatus: input.certificationStatus ?? 'uncertified',
        declaredCapabilitiesJson: JSON.stringify(input.declaredCapabilities ?? []),
        declaredResourceLimitsJson: JSON.stringify(input.declaredResourceLimits ?? {}),
        publisherIdentity: input.publisherIdentity ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    })
  } catch (err: unknown) {
    const isP2002 = (err as { code?: string; message?: string })?.code === 'P2002'
      || (err instanceof Error && err.message.includes('P2002'))
      || (err instanceof Error && err.message.includes('Unique constraint failed'))
    if (isP2002) {
      const winner = await db.extensionRegistryEntry.findUnique({
        where: {
          tenantId_extensionType_extensionVersion: {
            tenantId,
            extensionType: input.extensionType,
            extensionVersion: input.extensionVersion,
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
    eventType: 'extension_registry.entry_registered' as never,
    resourceType: 'extension_registry_entry',
    resourceId: created.id,
    metadata: {
      extensionType: input.extensionType,
      extensionVersion: input.extensionVersion,
    },
  })

  return toResult(created)
}

// ---------------------------------------------------------------------------
// Lookup (tenant-scoped)
// ---------------------------------------------------------------------------

export async function getExtension(
  tenantId: string,
  extensionType: string,
  extensionVersion: string,
): Promise<ExtensionRegistryEntryResult> {
  const entry = await db.extensionRegistryEntry.findUnique({
    where: {
      tenantId_extensionType_extensionVersion: {
        tenantId,
        extensionType,
        extensionVersion,
      },
    },
  })
  if (!entry) {
    throw new NotFoundError('extension_registry_entry', `${extensionType}@${extensionVersion}`)
  }
  return toResult(entry)
}

export async function listExtensions(
  tenantId: string,
  filter?: { extensionType?: string; certificationStatus?: string; lifecycleState?: string },
): Promise<ExtensionRegistryEntryResult[]> {
  const entries = await db.extensionRegistryEntry.findMany({
    where: {
      tenantId,
      ...(filter?.extensionType ? { extensionType: filter.extensionType } : {}),
      ...(filter?.certificationStatus ? { certificationStatus: filter.certificationStatus } : {}),
      ...(filter?.lifecycleState ? { lifecycleState: filter.lifecycleState } : {}),
    },
    orderBy: { createdAt: 'desc' },
  })
  return entries.map(toResult)
}

// ---------------------------------------------------------------------------
// Version Compatibility
// ---------------------------------------------------------------------------

export async function checkExtensionVersionCompatibility(
  tenantId: string,
  extensionType: string,
  requestedVersion: string,
): Promise<{ compatible: boolean; compatibleVersions: string[]; registeredVersion: string }> {
  const entry = await db.extensionRegistryEntry.findFirst({
    where: { tenantId, extensionType },
    orderBy: { extensionVersion: 'desc' },
  })
  if (!entry) {
    throw new NotFoundError('extension_registry_entry', `type=${extensionType}`)
  }
  const compatibleVersions = JSON.parse(entry.compatibleVersionsJson) as string[]
  const compatible = compatibleVersions.length === 0 || compatibleVersions.some(range => {
    return range === requestedVersion || range === '*' || range.includes(requestedVersion)
  })
  return { compatible, compatibleVersions, registeredVersion: entry.extensionVersion }
}

// ---------------------------------------------------------------------------
// Certification Metadata
// ---------------------------------------------------------------------------

export async function updateExtensionCertification(
  tenantId: string,
  extensionType: string,
  extensionVersion: string,
  update: CertificationUpdate,
  actorId?: string,
): Promise<ExtensionRegistryEntryResult> {
  const entry = await db.extensionRegistryEntry.findUnique({
    where: {
      tenantId_extensionType_extensionVersion: {
        tenantId, extensionType, extensionVersion,
      },
    },
  })
  if (!entry) {
    throw new NotFoundError('extension_registry_entry', `${extensionType}@${extensionVersion}`)
  }

  const updated = await db.extensionRegistryEntry.update({
    where: { id: entry.id },
    data: {
      certifierIdentity: update.certifierIdentity,
      certificationStatus: update.certificationStatus,
      certifiedAt: update.certificationStatus === 'certified' ? new Date() : entry.certifiedAt,
    },
  })

  await appendAudit({
    tenantId, actorId,
    eventType: 'extension_registry.certification_updated' as never,
    resourceType: 'extension_registry_entry',
    resourceId: entry.id,
    metadata: { extensionType, extensionVersion, certificationStatus: update.certificationStatus },
  })

  return toResult(updated)
}

// ---------------------------------------------------------------------------
// Revocation Metadata
// ---------------------------------------------------------------------------

export async function revokeExtension(
  tenantId: string,
  extensionType: string,
  extensionVersion: string,
  update: RevocationUpdate,
  actorId?: string,
): Promise<ExtensionRegistryEntryResult> {
  const entry = await db.extensionRegistryEntry.findUnique({
    where: {
      tenantId_extensionType_extensionVersion: {
        tenantId, extensionType, extensionVersion,
      },
    },
  })
  if (!entry) {
    throw new NotFoundError('extension_registry_entry', `${extensionType}@${extensionVersion}`)
  }
  if (entry.revocationStatus === 'revoked') {
    throw new ConflictError(`Extension ${extensionType}@${extensionVersion} is already revoked`)
  }

  const updated = await db.extensionRegistryEntry.update({
    where: { id: entry.id },
    data: {
      revocationStatus: 'revoked',
      revocationReason: update.reason,
      revokedAt: new Date(),
      lifecycleState: LIFECYCLE_STATE.REVOKED, // revocation also transitions lifecycle to revoked
    },
  })

  await appendAudit({
    tenantId, actorId,
    eventType: 'extension_registry.entry_revoked' as never,
    resourceType: 'extension_registry_entry',
    resourceId: entry.id,
    metadata: { extensionType, extensionVersion, reason: update.reason },
  })

  return toResult(updated)
}

// ---------------------------------------------------------------------------
// Lifecycle Transitions (registry-owned, authoritative)
// ---------------------------------------------------------------------------

export async function transitionLifecycle(
  tenantId: string,
  extensionType: string,
  extensionVersion: string,
  targetState: string,
  actorId?: string,
): Promise<ExtensionRegistryEntryResult> {
  const entry = await db.extensionRegistryEntry.findUnique({
    where: {
      tenantId_extensionType_extensionVersion: {
        tenantId, extensionType, extensionVersion,
      },
    },
  })
  if (!entry) {
    throw new NotFoundError('extension_registry_entry', `${extensionType}@${extensionVersion}`)
  }

  const currentState = entry.lifecycleState

  // Revoked is terminal — no transitions allowed.
  if (currentState === LIFECYCLE_STATE.REVOKED) {
    throw new ConflictError(`Extension ${extensionType}@${extensionVersion} is revoked (terminal state)`)
  }

  // Validate transition.
  const allowed = VALID_TRANSITIONS[currentState] ?? []
  if (!allowed.includes(targetState)) {
    throw new ValidationError(
      `Invalid lifecycle transition: ${currentState} → ${targetState} for extension ${extensionType}@${extensionVersion}`,
    )
  }

  const updated = await db.extensionRegistryEntry.update({
    where: { id: entry.id },
    data: { lifecycleState: targetState },
  })

  await appendAudit({
    tenantId, actorId,
    eventType: 'extension_registry.lifecycle_transition' as never,
    resourceType: 'extension_registry_entry',
    resourceId: entry.id,
    metadata: { extensionType, extensionVersion, from: currentState, to: targetState },
  })

  return toResult(updated)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toResult(entry: {
  id: string
  tenantId: string
  extensionType: string
  extensionVersion: string
  description: string
  compatibleVersionsJson: string
  certifierIdentity: string | null
  certificationStatus: string
  certifiedAt: Date | null
  revocationStatus: string
  revocationReason: string | null
  revokedAt: Date | null
  lifecycleState: string
  declaredCapabilitiesJson: string
  declaredResourceLimitsJson: string
  publisherIdentity: string | null
  idempotencyKey: string
  createdAt: Date
  updatedAt: Date
}): ExtensionRegistryEntryResult {
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    extensionType: entry.extensionType,
    extensionVersion: entry.extensionVersion,
    description: entry.description,
    compatibleVersions: JSON.parse(entry.compatibleVersionsJson),
    certifierIdentity: entry.certifierIdentity,
    certificationStatus: entry.certificationStatus,
    certifiedAt: entry.certifiedAt?.toISOString() ?? null,
    revocationStatus: entry.revocationStatus,
    revocationReason: entry.revocationReason,
    revokedAt: entry.revokedAt?.toISOString() ?? null,
    lifecycleState: entry.lifecycleState,
    declaredCapabilities: JSON.parse(entry.declaredCapabilitiesJson),
    declaredResourceLimits: JSON.parse(entry.declaredResourceLimitsJson),
    publisherIdentity: entry.publisherIdentity,
    idempotencyKey: entry.idempotencyKey,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  }
}
