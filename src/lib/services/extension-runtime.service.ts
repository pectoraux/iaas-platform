// =============================================================================
// ExtensionRuntime — IAAS-DOM-ARCH-4 / DOM-020 / WORK-017
// =============================================================================
// The service-layer execution and isolation authority for Extensions. Resolves
// Extensions through ExtensionRegistry (WORK-016), executes them through an
// abstract Extension contract, enforces the V4 capability/resource ceiling
// (min of extension-declared and tenant/operator-approved limits), gates on
// lifecycle state (only `activated` may execute), and emits immutable
// ExtensionProvenance payloads through a boundary contract.
//
// Contract source: spec/domain-architecture-v4.md §2.3 + §2.4 + §2.6 + §2.7,
// spec/domain-requirements-v4.md DOM-020, spec/work-orders/WORK-017.md.
//
// ARCHITECTURAL BOUNDARIES (frozen by IAAS-DOM-ARCH-4):
//   - Service-layer, NOT kernel (this module is in src/lib/services/).
//   - Resolves Extensions via ExtensionRegistry (does NOT own catalog/lifecycle).
//   - Emits ExtensionProvenance payloads to an injectable sink (does NOT own
//     durable provenance storage — that is a separate boundary, future WORK).
//   - Does NOT import vertical services (VPP/Compute/Storage/Wireless/Manufacturing).
//   - Does NOT import EconomicPipeline, Route/Transport, RuntimeRegistry, or kernel.
//   - Tenant isolation is mandatory.
//   - Deterministic idempotency for replay convergence (1:1 per tenant/idempotency key).
//   - Explicit failure semantics (failures emit failed provenance and re-throw).
//   - Capability/resource ceiling = min(declared, approved) per V4 §2.6.
//   - Only `activated` extensions may execute (V4 §2.7).
//
// This service does NOT:
//   - discover, register, certify, revoke, or transition lifecycle of extensions
//     (that is ExtensionRegistry — sole catalog/lifecycle authority);
//   - own durable ExtensionProvenance storage/schema/service (DOM-022 — future);
//   - select or implement sandbox technology (WASM/container/native — OPEN/RESEARCH);
//   - implement concrete extensions (future);
//   - implement Marketplace, SDK, licensing, or economic attribution (future);
//   - import or mutate TransformRegistry/TransformRecord (Extension→Transform is
//     one-way and NOT exercised by the runtime itself — only by concrete
//     extension implementations at application bootstrap);
//   - introduce kernel primitives or vertical coupling.
// =============================================================================

import { NotFoundError, ValidationError } from '@/lib/domain/errors'
import { sha256 } from '@/lib/domain/crypto'
import { getExtension } from '@/lib/services/extension-registry.service'
import type { ExtensionRegistryEntryResult } from '@/lib/services/extension-registry.service'

// ---------------------------------------------------------------------------
// Extension Abstract Contract (DOM-018)
// ---------------------------------------------------------------------------

/**
 * The abstract operation contract for an Extension. Concrete implementations
 * are registered by the caller (not by the runtime — the runtime dispatches
 * through this interface). The runtime does NOT hard-code any concrete
 * extension implementation.
 *
 * The `execute` method receives an {@link ExtensionExecutionContext} that
 * carries the runtime-enforced capability/resource ceiling. The extension
 * implementation MUST NOT exceed this ceiling; the runtime cannot observe
 * actual usage without a sandbox (OPEN/RESEARCH), so enforcement is at the
 * declaration/approval level (the ceiling is computed before execution and
 * denied if the declared request exceeds the approved authorization).
 */
export interface ExtensionContract {
  /** Extension identity (must match an ExtensionRegistryEntry). */
  extensionType: string
  extensionVersion: string
  /** Execute the extension on an input payload within the given context. */
  execute(context: ExtensionExecutionContext, input: Buffer): Promise<Buffer>
  /** Reverse the extension (if reversible). Throws if not reversible. */
  reverse?(output: Buffer, parameters?: Record<string, unknown>): Promise<Buffer>
  /** Verify that the (input, output) pair is consistent with this extension. */
  verify(input: Buffer, output: Buffer, parameters?: Record<string, unknown>): Promise<boolean>
}

/**
 * The runtime execution context passed to a concrete Extension's `execute`.
 * Carries the runtime-enforced ceiling (effective capabilities + resource limits)
 * computed as min(declared, approved) per V4 §2.6.
 */
export interface ExtensionExecutionContext {
  tenantId: string
  /** Effective capabilities = intersection(declared, approved). */
  capabilities: string[]
  /** Effective resource ceiling = min(declared, approved) per resource. */
  resourceLimits: ExtensionResourceLimits
  /** Caller-supplied execution parameters. */
  parameters?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Resource + Capability Types
// ---------------------------------------------------------------------------

export interface ExtensionResourceLimits {
  cpuMs?: number
  memoryBytes?: number
  timeMs?: number
}

export interface ExtensionCapabilityCeiling {
  /** Effective capabilities = intersection(declared, approved). */
  capabilities: string[]
  /** Effective resource limits = min(declared, approved) per resource. */
  resourceLimits: ExtensionResourceLimits
  /** The tenant/operator-approved ceiling (recorded in provenance). */
  tenantApprovedCeiling: {
    capabilities: string[]
    resourceLimits: ExtensionResourceLimits
  }
}

// ---------------------------------------------------------------------------
// ExtensionProvenance Payload (V4 §2.4 / DOM-022)
// ---------------------------------------------------------------------------

/**
 * The immutable ExtensionProvenance payload emitted after execution (success
 * or failure). Conforms to the V4 §2.4 minimum identity.
 *
 * The runtime computes and emits this payload; a provenance boundary (sink)
 * owns durable storage. The runtime does NOT write to the database directly.
 */
export interface ExtensionProvenancePayload {
  tenantId: string
  extensionType: string
  extensionVersion: string
  executionIdempotencyKey: string
  inputHash: string
  outputHash: string
  resultStatus: 'success' | 'failed'
  /** Resource usage actually exercised (over-approximates to effective ceiling without sandbox). */
  resourceUsage: ExtensionResourceLimits
  /** Capabilities actually exercised (over-approximates to effective ceiling without sandbox). */
  capabilitiesExercised: string[]
  /** The tenant/operator-approved ceiling recorded for audit. */
  tenantApprovedCeiling: {
    capabilities: string[]
    resourceLimits: ExtensionResourceLimits
  }
  /** Failure metadata (only present when resultStatus='failed'). */
  failureMetadata?: {
    error: string
    errorType: string
    denialReason?: string
  }
  /** SHA-256 fingerprint of the material fields (V4 §2.4). */
  fingerprint: string
  /** ISO timestamp of emission. */
  createdAt: string
}

// ---------------------------------------------------------------------------
// ExtensionProvenanceSink — boundary contract (durable storage is future WORK)
// ---------------------------------------------------------------------------

/**
 * The provenance boundary contract. The runtime emits payloads to this sink;
 * the sink owns durable storage and idempotent deduplication. The runtime does
 * NOT write to the database directly.
 *
 * Durable PostgreSQL implementation of this sink is DOM-022 / future WORK and
 * is NOT implemented by WORK-017. The default sink is an in-memory recorder
 * suitable for tests and no-op production fallback.
 */
export interface ExtensionProvenanceSink {
  /**
   * Emit a provenance payload. Idempotent: identical payloads (by fingerprint)
   * converge to the same canonical record id. Returns the canonical record id
   * and whether this emission created a new record or replayed an existing one.
   */
  emit(payload: ExtensionProvenancePayload): Promise<{
    recordId: string
    status: 'created' | 'replay'
  }>
}

/**
 * In-memory ExtensionProvenanceSink. Deduplicates by fingerprint so identical
 * emissions converge 1:1 (replay convergence). NOT for production durable
 * storage — production requires a PostgreSQL-backed sink (DOM-022, future).
 */
export class InMemoryExtensionProvenanceSink implements ExtensionProvenanceSink {
  private readonly records = new Map<string, ExtensionProvenancePayload & { id: string }>()

  async emit(payload: ExtensionProvenancePayload): Promise<{ recordId: string; status: 'created' | 'replay' }> {
    const existing = this.records.get(payload.fingerprint)
    if (existing) {
      return { recordId: existing.id, status: 'replay' }
    }
    // Use the fingerprint as the canonical record id. This makes replay
    // convergence deterministic: identical payloads always map to the same id.
    const id = `extprov_${payload.fingerprint}`
    this.records.set(payload.fingerprint, { ...payload, id })
    return { recordId: id, status: 'created' }
  }

  /** Test helper: retrieve a record by fingerprint. */
  getByFingerprint(fingerprint: string): (ExtensionProvenancePayload & { id: string }) | undefined {
    return this.records.get(fingerprint)
  }

  /** Test helper: retrieve all emitted records. */
  list(): readonly (ExtensionProvenancePayload & { id: string })[] {
    return Array.from(this.records.values())
  }

  /** Test helper: count emitted records. */
  size(): number {
    return this.records.size
  }

  /** Test helper: clear all records. */
  clear(): void {
    this.records.clear()
  }
}

// Module-level default sink. Application bootstrap may install a durable sink
// (future WORK). Tests inject sinks per-call via the execution input.
const defaultSink = new InMemoryExtensionProvenanceSink()

/**
 * Get the module-level default ExtensionProvenanceSink. Used when no sink is
 * provided in the execution input. The default is an in-memory recorder (NOT
 * durable) — production deployments must install a durable sink (future WORK).
 */
export function getDefaultExtensionProvenanceSink(): ExtensionProvenanceSink {
  return defaultSink
}

// ---------------------------------------------------------------------------
// Runtime Types
// ---------------------------------------------------------------------------

export interface ExtensionExecutionInput {
  /** The extension type to resolve via ExtensionRegistry. */
  extensionType: string
  /** The extension version to resolve via ExtensionRegistry. */
  extensionVersion: string
  /** The input payload to execute on. */
  inputPayload: Buffer
  /** Caller-supplied execution parameters (canonical JSON-serializable). */
  parameters?: Record<string, unknown>
  /**
   * Tenant/operator-approved capabilities (V4 §2.6). The effective ceiling is
   * the intersection of these and the extension-declared capabilities.
   */
  approvedCapabilities?: string[]
  /**
   * Tenant/operator-approved resource limits (V4 §2.6). The effective ceiling
   * is the minimum of these and the extension-declared limits per resource.
   */
  approvedResourceLimits?: ExtensionResourceLimits
  /** Caller-supplied idempotency key for replay convergence. */
  idempotencyKey: string
  /**
   * Optional provenance sink override. If not provided, the module-level
   * default sink is used.
   */
  provenanceSink?: ExtensionProvenanceSink
}

export interface ExtensionExecutionResult {
  /** The executed output payload. */
  outputPayload: Buffer
  /** SHA-256 hash of the input payload. */
  inputHash: string
  /** SHA-256 hash of the output payload. */
  outputHash: string
  /** Result status. */
  resultStatus: 'success' | 'failed'
  /** The canonical provenance record id (from the sink). */
  provenanceRecordId: string
  /** Whether this emission created a new record or replayed an existing one. */
  provenanceStatus: 'created' | 'replay'
  /** The effective capability/resource ceiling applied to this execution. */
  effectiveCeiling: ExtensionCapabilityCeiling
}

export interface ExtensionReverseInput {
  extensionType: string
  extensionVersion: string
  outputPayload: Buffer
  parameters?: Record<string, unknown>
  idempotencyKey: string
  provenanceSink?: ExtensionProvenanceSink
}

export interface ExtensionVerifyInput {
  extensionType: string
  extensionVersion: string
  inputPayload: Buffer
  outputPayload: Buffer
  parameters?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Extension Implementation Registry (in-memory dispatch table)
// ---------------------------------------------------------------------------

/**
 * Registry of concrete Extension implementations. The runtime resolves
 * Extension metadata via ExtensionRegistry (PostgreSQL), and resolves concrete
 * Extension implementations via this in-memory registry. Callers register
 * concrete Extension contracts at application bootstrap — the runtime does NOT
 * hard-code any concrete extension.
 *
 * This is NOT ExtensionRegistry (which is the PostgreSQL catalog). This is a
 * simple in-memory dispatch table that maps (extensionType, extensionVersion)
 * to a concrete ExtensionContract implementation. The runtime is the sole
 * consumer of this table.
 */
const extensionImplementations = new Map<string, ExtensionContract>()

/**
 * Register a concrete Extension implementation for runtime dispatch.
 * This is called by application bootstrap (not by the runtime itself).
 * The runtime does NOT hard-code any concrete extension — it dispatches
 * through whatever implementations are registered here.
 */
export function registerExtensionImplementation(impl: ExtensionContract): void {
  const key = `${impl.extensionType}@${impl.extensionVersion}`
  extensionImplementations.set(key, impl)
}

/**
 * Resolve a concrete Extension implementation by (type, version).
 * Returns undefined if no implementation is registered (the extension exists
 * in the catalog but no executable code is available).
 */
function getImplementation(extensionType: string, extensionVersion: string): ExtensionContract | undefined {
  return extensionImplementations.get(`${extensionType}@${extensionVersion}`)
}

/**
 * Test helper: clear all registered Extension implementations.
 * Production code should NOT call this — it is for test isolation only.
 */
export function __clearExtensionImplementationsForTesting(): void {
  extensionImplementations.clear()
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

/**
 * Execute an Extension on a payload. Resolves the Extension via
 * ExtensionRegistry (catalog), enforces the V4 capability/resource ceiling,
 * gates on lifecycle state (only `activated` may execute), dispatches execution
 * through the concrete Extension implementation, and emits an immutable
 * ExtensionProvenance payload through the provenance boundary sink.
 *
 * Idempotent: the same (tenantId, extensionType, extensionVersion,
 * executionIdempotencyKey, inputHash, outputHash, resultStatus) tuple
 * converges to the same provenance record (via the sink's fingerprint-based
 * deduplication).
 *
 * Failure semantics: if the Extension execution throws (or is denied by
 * capability/resource/lifecycle enforcement), a failed ExtensionProvenance
 * payload is still emitted (durable provenance of the failure), and the error
 * is re-thrown to the caller. The caller does NOT get a silent success.
 *
 * DOM-020 acceptance:
 *   - AC01: resolves only through ExtensionRegistry.
 *   - AC02: only `activated` extensions may execute.
 *   - AC03: ceiling = min(declared, approved); requests outside the ceiling
 *     are denied and produce failed provenance.
 *   - AC05: failed executions emit failed provenance and re-throw.
 *   - AC06: deterministic idempotent replay convergence.
 *   - AC07: tenant isolation (via ExtensionRegistry tenant-scoped lookup).
 *   - AC08: no catalog/lifecycle ownership (runtime observes, does not own).
 *   - AC09: no durable provenance implementation (emits to sink boundary).
 */
export async function executeExtension(
  tenantId: string,
  input: ExtensionExecutionInput,
  actorId?: string,
): Promise<ExtensionExecutionResult> {
  // 1. Resolve Extension metadata via ExtensionRegistry (catalog authority).
  //    This is the ONLY resolution path — the runtime does NOT own catalog state.
  const registryEntry = await resolveFromRegistry(tenantId, input.extensionType, input.extensionVersion)

  // 2. Compute input hash (deterministic identity for provenance).
  const inputHash = sha256(input.inputPayload.toString('hex'))

  // 3. Compute effective capability/resource ceiling = min(declared, approved).
  const ceiling = computeEffectiveCeiling(registryEntry, input)

  // 4. Resolve concrete implementation (BEFORE enforcement so we can report
  //    implementation-missing as a failed-provenance failure too).
  const impl = getImplementation(input.extensionType, input.extensionVersion)

  // 5. Enforce lifecycle gate + capability/resource ceiling. Each denial
  //    emits a failed provenance payload and throws.
  const denialReason = checkExecutionAuthority(registryEntry, ceiling)
  if (denialReason) {
    await emitFailedProvenance(tenantId, input, registryEntry, inputHash, ceiling, denialReason)
    throw new ValidationError(
      `Extension ${input.extensionType}@${input.extensionVersion} execution denied: ${denialReason.reason}`,
    )
  }

  // 6. Implementation must be available.
  if (!impl) {
    const denialReason: ExtensionDenialReason = {
      kind: 'implementation_missing',
      reason: `no executable implementation registered for ${input.extensionType}@${input.extensionVersion}`,
    }
    await emitFailedProvenance(tenantId, input, registryEntry, inputHash, ceiling, denialReason)
    throw new NotFoundError(
      'extension_implementation',
      `${input.extensionType}@${input.extensionVersion} (registered in catalog but no executable implementation available)`,
    )
  }

  // 7. Execute the extension.
  let outputPayload: Buffer
  let resultStatus: 'success' | 'failed' = 'success'

  try {
    outputPayload = await impl.execute(
      {
        tenantId,
        capabilities: ceiling.capabilities,
        resourceLimits: ceiling.resourceLimits,
        parameters: input.parameters,
      },
      input.inputPayload,
    )
  } catch (err) {
    // Failure semantics: emit a failed ExtensionProvenance payload, then
    // re-throw the original error. The caller does NOT get a silent success.
    resultStatus = 'failed'
    const failureMetadata = {
      error: err instanceof Error ? err.message : String(err),
      errorType: err instanceof Error ? err.constructor.name : 'Unknown',
    }
    const outputHash = sha256(Buffer.alloc(0).toString('hex')) // empty output on failure

    await emitProvenance(tenantId, input, registryEntry, inputHash, outputHash, 'failed', ceiling, failureMetadata)

    // Re-throw the original error (caller sees the failure).
    throw err
  }

  // 8. Compute output hash.
  const outputHash = sha256(outputPayload.toString('hex'))

  // 9. Emit immutable ExtensionProvenance (success provenance).
  const provenanceResult = await emitProvenance(
    tenantId,
    input,
    registryEntry,
    inputHash,
    outputHash,
    'success',
    ceiling,
    undefined,
  )

  return {
    outputPayload,
    inputHash,
    outputHash,
    resultStatus,
    provenanceRecordId: provenanceResult.recordId,
    provenanceStatus: provenanceResult.status,
    effectiveCeiling: ceiling,
  }
}

// ---------------------------------------------------------------------------
// Reverse
// ---------------------------------------------------------------------------

/**
 * Reverse an Extension on an output payload. Only succeeds if the Extension
 * is activated and a concrete `reverse` implementation is registered. Emits
 * an ExtensionProvenance payload for the reverse operation.
 *
 * DOM-020 AC04: reverse/verify semantics.
 */
export async function reverseExtension(
  tenantId: string,
  input: ExtensionReverseInput,
  actorId?: string,
): Promise<ExtensionExecutionResult> {
  const registryEntry = await resolveFromRegistry(tenantId, input.extensionType, input.extensionVersion)

  // Lifecycle gate: only activated extensions may execute (or reverse).
  if (registryEntry.lifecycleState !== 'activated') {
    const ceiling = computeEffectiveCeiling(registryEntry, {
      extensionType: input.extensionType,
      extensionVersion: input.extensionVersion,
      inputPayload: input.outputPayload,
      parameters: input.parameters,
      idempotencyKey: input.idempotencyKey,
    })
    const inputHash = sha256(input.outputPayload.toString('hex'))
    await emitFailedProvenance(tenantId, {
      extensionType: input.extensionType,
      extensionVersion: input.extensionVersion,
      inputPayload: input.outputPayload,
      parameters: input.parameters,
      idempotencyKey: input.idempotencyKey,
      provenanceSink: input.provenanceSink,
    }, registryEntry, inputHash, ceiling, {
      kind: 'lifecycle_not_activated',
      reason: `extension lifecycle state is '${registryEntry.lifecycleState}', not 'activated'`,
    })
    throw new ValidationError(
      `Extension ${input.extensionType}@${input.extensionVersion} reverse denied: lifecycle state is '${registryEntry.lifecycleState}'`,
    )
  }

  const impl = getImplementation(input.extensionType, input.extensionVersion)
  if (!impl || !impl.reverse) {
    throw new NotFoundError(
      'extension_reverse_implementation',
      `${input.extensionType}@${input.extensionVersion}`,
    )
  }

  const inputHash = sha256(input.outputPayload.toString('hex')) // output becomes input for reverse
  const reversedPayload = await impl.reverse(input.outputPayload, input.parameters)
  const outputHash = sha256(reversedPayload.toString('hex'))

  const ceiling = computeEffectiveCeiling(registryEntry, {
    extensionType: input.extensionType,
    extensionVersion: input.extensionVersion,
    inputPayload: input.outputPayload,
    parameters: input.parameters,
    idempotencyKey: input.idempotencyKey,
    provenanceSink: input.provenanceSink,
  })

  const provenanceResult = await emitProvenance(
    tenantId,
    {
      extensionType: input.extensionType,
      extensionVersion: input.extensionVersion,
      inputPayload: input.outputPayload,
      parameters: input.parameters,
      idempotencyKey: input.idempotencyKey,
      provenanceSink: input.provenanceSink,
    },
    registryEntry,
    inputHash,
    outputHash,
    'success',
    ceiling,
    undefined,
  )

  return {
    outputPayload: reversedPayload,
    inputHash,
    outputHash,
    resultStatus: 'success',
    provenanceRecordId: provenanceResult.recordId,
    provenanceStatus: provenanceResult.status,
    effectiveCeiling: ceiling,
  }
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify that an (input, output) pair is consistent with an Extension. Does NOT
 * execute the extension — only calls the Extension's verify() method. Does NOT
 * emit provenance (read-only check).
 *
 * DOM-020 AC04: reverse/verify semantics.
 */
export async function verifyExtension(
  tenantId: string,
  input: ExtensionVerifyInput,
): Promise<boolean> {
  await resolveFromRegistry(tenantId, input.extensionType, input.extensionVersion)

  const impl = getImplementation(input.extensionType, input.extensionVersion)
  if (!impl) {
    throw new NotFoundError(
      'extension_implementation',
      `${input.extensionType}@${input.extensionVersion}`,
    )
  }

  return impl.verify(input.inputPayload, input.outputPayload, input.parameters)
}

// ---------------------------------------------------------------------------
// Helpers — Registry resolution, ceiling computation, authority enforcement
// ---------------------------------------------------------------------------

/**
 * Resolve Extension metadata from ExtensionRegistry. Throws if the extension
 * is not found in the tenant's catalog. The runtime does NOT own catalog
 * metadata — ExtensionRegistry is the sole authority.
 */
async function resolveFromRegistry(
  tenantId: string,
  extensionType: string,
  extensionVersion: string,
): Promise<ExtensionRegistryEntryResult> {
  return getExtension(tenantId, extensionType, extensionVersion)
}

/**
 * Compute the effective capability/resource ceiling = min(declared, approved)
 * per V4 §2.6.
 *
 *   - Capabilities: effective = intersection(declared, approved).
 *   - Resource limits: effective = min(declared, approved) per resource
 *     (where both are present; else the present one; else undefined).
 *
 * The tenant/operator-approved ceiling is recorded in provenance for audit.
 */
function computeEffectiveCeiling(
  registryEntry: ExtensionRegistryEntryResult,
  input: ExtensionExecutionInput,
): ExtensionCapabilityCeiling {
  const declaredCaps = registryEntry.declaredCapabilities ?? []
  const approvedCaps = input.approvedCapabilities ?? []

  // Effective capabilities = intersection(declared, approved).
  // Preserves the declared order (declared capabilities that are also approved).
  const effectiveCaps = declaredCaps.filter(c => approvedCaps.includes(c))

  const declaredLimits = registryEntry.declaredResourceLimits ?? {}
  const approvedLimits = input.approvedResourceLimits ?? {}

  // Effective resource limits = min(declared, approved) per resource.
  const effectiveLimits: ExtensionResourceLimits = {}
  for (const key of ['cpuMs', 'memoryBytes', 'timeMs'] as const) {
    const d = declaredLimits[key]
    const a = approvedLimits[key]
    if (typeof d === 'number' && typeof a === 'number') {
      effectiveLimits[key] = Math.min(d, a)
    } else if (typeof d === 'number') {
      effectiveLimits[key] = d
    } else if (typeof a === 'number') {
      effectiveLimits[key] = a
    }
  }

  return {
    capabilities: effectiveCaps,
    resourceLimits: effectiveLimits,
    tenantApprovedCeiling: {
      capabilities: approvedCaps,
      resourceLimits: approvedLimits,
    },
  }
}

/**
 * Denial reason structure. Used to classify why an execution was denied
 * (lifecycle, revocation, capability mismatch, resource overrun) for
 * provenance and error reporting.
 */
interface ExtensionDenialReason {
  kind:
    | 'lifecycle_not_activated'
    | 'revoked'
    | 'capability_not_approved'
    | 'resource_limit_exceeded'
    | 'implementation_missing'
  reason: string
}

/**
 * Check execution authority: lifecycle state, revocation, and capability/resource
 * ceiling enforcement. Returns a denial reason if execution must be denied, or
 * undefined if execution is allowed.
 *
 * V4 §2.6: "Requests outside the effective ceiling are denied and produce
 * failed provenance."
 * V4 §2.7: "Only `activated` extensions may execute."
 */
function checkExecutionAuthority(
  registryEntry: ExtensionRegistryEntryResult,
  ceiling: ExtensionCapabilityCeiling,
): ExtensionDenialReason | undefined {
  // Lifecycle gate: only `activated` may execute.
  if (registryEntry.lifecycleState !== 'activated') {
    return {
      kind: 'lifecycle_not_activated',
      reason: `extension lifecycle state is '${registryEntry.lifecycleState}', not 'activated'`,
    }
  }

  // Revocation gate (redundant with lifecycle since revoke→revoked, but explicit).
  if (registryEntry.revocationStatus === 'revoked') {
    return {
      kind: 'revoked',
      reason: `extension is revoked: ${registryEntry.revocationReason ?? 'no reason given'}`,
    }
  }

  // Capability ceiling: declared capabilities must be a subset of approved.
  // If the extension declares capabilities that the tenant did NOT approve,
  // the extension cannot safely run (it expects capabilities it doesn't have).
  const declaredCaps = registryEntry.declaredCapabilities ?? []
  const approvedCaps = ceiling.tenantApprovedCeiling.capabilities
  if (declaredCaps.length > 0) {
    const unapproved = declaredCaps.filter(c => !approvedCaps.includes(c))
    if (unapproved.length > 0) {
      return {
        kind: 'capability_not_approved',
        reason: `extension declares capabilities not approved by tenant/operator: ${unapproved.join(', ')}`,
      }
    }
  }

  // Resource ceiling: declared limits must not exceed approved.
  const declaredLimits = registryEntry.declaredResourceLimits ?? {}
  const approvedLimits = ceiling.tenantApprovedCeiling.resourceLimits
  for (const key of ['cpuMs', 'memoryBytes', 'timeMs'] as const) {
    const d = declaredLimits[key]
    const a = approvedLimits[key]
    if (typeof d === 'number' && typeof a === 'number' && d > a) {
      return {
        kind: 'resource_limit_exceeded',
        reason: `extension declares ${key}=${d} but tenant/operator approved ${key}=${a}`,
      }
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Provenance emission helpers
// ---------------------------------------------------------------------------

/**
 * Emit a failed ExtensionProvenance payload. Computes the payload with
 * resultStatus='failed', empty output hash, and the denial reason as failure
 * metadata. The payload is sent to the sink (boundary contract).
 */
async function emitFailedProvenance(
  tenantId: string,
  input: ExtensionExecutionInput,
  registryEntry: ExtensionRegistryEntryResult,
  inputHash: string,
  ceiling: ExtensionCapabilityCeiling,
  denialReason: ExtensionDenialReason,
): Promise<void> {
  const outputHash = sha256(Buffer.alloc(0).toString('hex')) // empty output on failure

  await emitProvenance(
    tenantId,
    input,
    registryEntry,
    inputHash,
    outputHash,
    'failed',
    ceiling,
    {
      error: denialReason.reason,
      errorType: 'ExtensionExecutionDenied',
      denialReason: denialReason.kind,
    },
  )
}

/**
 * Emit an ExtensionProvenance payload to the sink. Computes the V4 §2.4
 * fingerprint and delegates durable storage to the sink boundary.
 */
async function emitProvenance(
  tenantId: string,
  input: ExtensionExecutionInput,
  registryEntry: ExtensionRegistryEntryResult,
  inputHash: string,
  outputHash: string,
  resultStatus: 'success' | 'failed',
  ceiling: ExtensionCapabilityCeiling,
  failureMetadata?: { error: string; errorType: string; denialReason?: string },
): Promise<{ recordId: string; status: 'created' | 'replay' }> {
  const payload = computeProvenancePayload({
    tenantId,
    extensionType: input.extensionType,
    extensionVersion: input.extensionVersion,
    executionIdempotencyKey: input.idempotencyKey,
    inputHash,
    outputHash,
    resultStatus,
    resourceUsage: ceiling.resourceLimits,
    capabilitiesExercised: ceiling.capabilities,
    tenantApprovedCeiling: ceiling.tenantApprovedCeiling,
    failureMetadata,
  })

  const sink = input.provenanceSink ?? defaultSink
  return sink.emit(payload)
}

/**
 * Compute an immutable ExtensionProvenance payload (V4 §2.4).
 *
 * The fingerprint is SHA-256 of the material fields:
 *   {tenantId, extensionType, extensionVersion, executionIdempotencyKey,
 *    inputHash, outputHash, resultStatus}
 *
 * Non-identity-bearing fields (resourceUsage, capabilitiesExercised,
 * tenantApprovedCeiling, failureMetadata, createdAt) are excluded from the
 * fingerprint — they are observational.
 */
function computeProvenancePayload(input: {
  tenantId: string
  extensionType: string
  extensionVersion: string
  executionIdempotencyKey: string
  inputHash: string
  outputHash: string
  resultStatus: 'success' | 'failed'
  resourceUsage: ExtensionResourceLimits
  capabilitiesExercised: string[]
  tenantApprovedCeiling: { capabilities: string[]; resourceLimits: ExtensionResourceLimits }
  failureMetadata?: { error: string; errorType: string; denialReason?: string }
}): ExtensionProvenancePayload {
  const fingerprint = computeExtensionProvenanceFingerprint({
    tenantId: input.tenantId,
    extensionType: input.extensionType,
    extensionVersion: input.extensionVersion,
    executionIdempotencyKey: input.executionIdempotencyKey,
    inputHash: input.inputHash,
    outputHash: input.outputHash,
    resultStatus: input.resultStatus,
  })

  return {
    tenantId: input.tenantId,
    extensionType: input.extensionType,
    extensionVersion: input.extensionVersion,
    executionIdempotencyKey: input.executionIdempotencyKey,
    inputHash: input.inputHash,
    outputHash: input.outputHash,
    resultStatus: input.resultStatus,
    resourceUsage: input.resourceUsage,
    capabilitiesExercised: input.capabilitiesExercised,
    tenantApprovedCeiling: input.tenantApprovedCeiling,
    failureMetadata: input.failureMetadata,
    fingerprint,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Compute the V4 §2.4 ExtensionProvenance fingerprint.
 *
 * SHA-256 of the canonical JSON of the material fields:
 *   {tenantId, extensionType, extensionVersion, executionIdempotencyKey,
 *    inputHash, outputHash, resultStatus}
 *
 * This is the SOLE canonical derivation — used for both payload construction
 * and replay-convergence deduplication (the sink deduplicates by fingerprint).
 * Repeated identical attempts converge 1:1 per tenant/idempotency key.
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
