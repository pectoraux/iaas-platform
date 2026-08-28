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
import {
  revokeActiveExecutionsForExtension,
  deactivateActiveExecutionsForExtension,
  reactivateExtension,
} from '@/lib/services/active-execution-registry.service'
import type { SandboxHost } from '@/lib/services/sandbox-host.service'

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

/**
 * Revoke an Extension (V4 §2.7 / V5 §2.5 terminal state).
 *
 * AR-021-17: revocation is DURABLE in PostgreSQL, then — synchronously, with
 * no await in between — the ActiveExecutionRegistry termination hook fires:
 *
 *   ExtensionRegistry.revokeExtension(...)        (this function)
 *       ↓ durable db.update → lifecycleState='revoked'
 *   ActiveExecutionRegistry.revokeActiveExecutionsForExtension(...)
 *       ↓ (marks the revoked-execution ledger + revokes every active
 *          SandboxExecutionHandle of this extension)
 *   SandboxExecutionHandle.revoke()
 *       ↓
 *   termination (SIGTERM/SIGKILL owned by the sandbox host)
 *
 * This is the authoritative control path required by V5 §2.5 ("revoked:
 * terminal state; future execution denied and active context terminated"):
 * an extension revoked in the catalog can never leave an already-running
 * sandbox execution alive. The registry DELEGATES termination to the
 * ActiveExecutionRegistry — it does not execute extensions.
 */
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

  // AR-021-17 (V5 §2.5): the revocation is now DURABLE. Fire the termination
  // hook SYNCHRONOUSLY (no await between the durable update and the hook) so
  // that no active sandbox execution of this extension survives the durable
  // revocation. Race-safe: registrations that raced with this update were
  // either already in the ActiveExecutionRegistry (revoked now) or arrive
  // after the revoked-ledger mark (refused at registration).
  const termination = revokeActiveExecutionsForExtension(tenantId, extensionType, extensionVersion)
  // WORK-022: the extension left `deactivated` for the TERMINAL state — clear
  // the reversible deactivation mark (NOT a re-activation: the terminal
  // revoked ledger refuses registrations forever regardless of the mark).
  reactivateExtension(tenantId, extensionType, extensionVersion)

  await appendAudit({
    tenantId, actorId,
    eventType: 'extension_registry.entry_revoked' as never,
    resourceType: 'extension_registry_entry',
    resourceId: entry.id,
    metadata: {
      extensionType, extensionVersion, reason: update.reason,
      activeExecutionsTerminated: termination.executionIds.length,
    },
  })

  return toResult(updated)
}

// ---------------------------------------------------------------------------
// Lifecycle Transitions (registry-owned, authoritative)
// ---------------------------------------------------------------------------

/**
 * WORK-022 — options for {@link transitionLifecycle}.
 *
 * For the registered → installed transition, `wasmModule` supplies the
 * extension's WASM binary for install-time VALIDATION (V5 §2.5 "installed:
 * module validation/compilation may occur without execution"): classification
 * + AR-021-18 import verification against the entry's DECLARED capabilities,
 * with NO sandbox spawn and NO execution. Unauthorized or unverifiable
 * imports DENY the transition (the entry stays `registered`).
 *
 * When `wasmModule` is absent the transition proceeds WITHOUT module
 * validation (V4 in-memory extensions have no binary; V5 §2.5 says validation
 * MAY occur) and the audit records `moduleValidated: false`.
 */
export interface LifecycleTransitionOptions {
  /** The extension's WASM binary to validate at install time (optional). */
  wasmModule?: Buffer
  /** Optional SandboxHost override used for install-time validation. */
  sandboxHost?: SandboxHost
}

/**
 * Execute an authoritative lifecycle transition (V4 §2.7 / V5 §2.5).
 *
 * WORK-022 wires the remaining §2.5 semantics (WORK-021 wired `revoked`):
 *
 *   registered → installed     install-time module VALIDATION (no spawn, no
 *                              execution) when a binary is supplied; denied
 *                              imports deny the transition BEFORE any durable
 *                              update (the entry stays `registered`).
 *
 *   activated → deactivated    durable update FIRST, then the SYNCHRONOUS
 *                              ActiveExecutionRegistry deactivation hook:
 *                              terminate every active sandbox execution of the
 *                              extension through SandboxExecutionHandle.revoke()
 *                              (the §2.5 termination abstraction) and mark the
 *                              REVERSIBLE deactivation ledger (registrations
 *                              refused until re-activation). The terminal
 *                              revoked-execution ledger is NEVER used here.
 *
 *   deactivated → activated    durable update FIRST, then the SYNCHRONOUS
 *                              re-activation hook clearing the deactivation
 *                              ledger mark — execution is permitted again
 *                              (the existing Runtime lifecycle gate re-admits
 *                              `activated` extensions).
 */
export async function transitionLifecycle(
  tenantId: string,
  extensionType: string,
  extensionVersion: string,
  targetState: string,
  actorId?: string,
  options?: LifecycleTransitionOptions,
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

  // WORK-022 (W022-AC03) — registered → installed: install-time module
  // validation BEFORE the durable update. A denied transition must leave the
  // entry in its current state (no partial durable effect).
  let installAuditMetadata: Record<string, unknown> = {}
  if (targetState === LIFECYCLE_STATE.INSTALLED) {
    if (options?.wasmModule !== undefined) {
      const validation = await validateModuleForInstall(
        tenantId,
        extensionType,
        extensionVersion,
        JSON.parse(entry.declaredCapabilitiesJson) as string[],
        options.wasmModule,
        options.sandboxHost,
      )
      installAuditMetadata = {
        moduleValidated: true,
        moduleClassification: validation.classification,
        moduleDeclaredImports: validation.declaredImports,
      }
    } else {
      // V5 §2.5 "validation MAY occur": no binary supplied (e.g. a V4
      // in-memory extension with no WASM artifact) — nothing to validate.
      installAuditMetadata = { moduleValidated: false }
    }
  }

  const updated = await db.extensionRegistryEntry.update({
    where: { id: entry.id },
    data: { lifecycleState: targetState },
  })

  // AR-021-17 (V5 §2.5): transitionLifecycle is the second durable path to
  // the `revoked` lifecycle state. Fire the SAME termination hook
  // synchronously after the durable update so the "revoked → active context
  // terminated" contract holds regardless of which API path reached it.
  //
  // WORK-022 (V5 §2.5 "deactivated: active execution context terminated/
  // deactivated"): the SAME authoritative control path serves deactivation —
  // durable update FIRST, then the SYNCHRONOUS deactivation hook. There is
  // NO await between the durable update above and the hooks below.
  let activeExecutionsTerminated = 0
  if (targetState === LIFECYCLE_STATE.REVOKED) {
    const termination = revokeActiveExecutionsForExtension(tenantId, extensionType, extensionVersion)
    activeExecutionsTerminated = termination.executionIds.length
    // The extension is no longer deactivated — it is TERMINAL. Clear the
    // reversible deactivation mark (NOT a re-activation: the terminal revoked
    // ledger refuses registrations forever regardless).
    reactivateExtension(tenantId, extensionType, extensionVersion)
  } else if (targetState === LIFECYCLE_STATE.DEACTIVATED) {
    const termination = deactivateActiveExecutionsForExtension(tenantId, extensionType, extensionVersion)
    activeExecutionsTerminated = termination.executionIds.length
  } else if (targetState === LIFECYCLE_STATE.ACTIVATED) {
    // Re-activation (deactivated → activated): clear the deactivation-ledger
    // mark so registrations are permitted again (idempotent for the fresh
    // installed → activated path, where no mark exists).
    reactivateExtension(tenantId, extensionType, extensionVersion)
  }

  await appendAudit({
    tenantId, actorId,
    eventType: 'extension_registry.lifecycle_transition' as never,
    resourceType: 'extension_registry_entry',
    resourceId: entry.id,
    metadata: {
      extensionType, extensionVersion,
      from: currentState, to: targetState,
      // W022-AC06: lifecycle transitions ALWAYS record the number of active
      // sandbox executions terminated by the transition (0 for transitions
      // that cannot terminate in-flight executions).
      activeExecutionsTerminated,
      ...installAuditMetadata,
    },
  })

  return toResult(updated)
}

/**
 * WORK-022 (W022-AC03) — install-time module validation: classification +
 * AR-021-18 import verification against the DECLARED capabilities, with NO
 * sandbox spawn and NO execution. Deny-by-default (V5 §2.7): an unavailable
 * host, or one without the validate-only path, DENIES the transition — there
 * is no silent unvalidated install when a binary was supplied.
 *
 * Throws ValidationError when the transition must be denied (unauthorized or
 * unverifiable imports; unavailable host) — BEFORE any durable update.
 */
async function validateModuleForInstall(
  tenantId: string,
  extensionType: string,
  extensionVersion: string,
  declaredCapabilities: string[],
  wasmModule: Buffer,
  sandboxHostOverride?: SandboxHost,
): Promise<{ classification: 'component' | 'core-module'; declaredImports: string[] }> {
  const { getSandboxHost, SandboxCapabilityDeniedError, SandboxUnavailableError } =
    await import('@/lib/services/sandbox-host.service')
  const host = sandboxHostOverride ?? getSandboxHost()
  if (!host.isAvailable() || typeof host.validateOnly !== 'function') {
    throw new ValidationError(
      `Extension ${extensionType}@${extensionVersion} install denied: the sandbox host cannot validate the ` +
      `module (unavailable or no validate-only path — deny-by-default, V5 §2.7); the transition is refused`,
    )
  }
  try {
    return host.validateOnly(wasmModule, declaredCapabilities)
  } catch (err) {
    if (err instanceof SandboxCapabilityDeniedError || err instanceof SandboxUnavailableError) {
      // Unauthorized (or unverifiable) imports deny the transition — the
      // entry STAYS in its current lifecycle state (no durable update).
      throw new ValidationError(
        `Extension ${extensionType}@${extensionVersion} install denied: ${err.message}`,
      )
    }
    throw err
  }
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
