// =============================================================================
// TransformRuntime — IAAS-DOM-ARCH-3 / DOM-016 / WORK-011
// =============================================================================
// The service-layer execution engine for Transforms. Resolves Transforms via
// TransformRegistry (WORK-010), executes them through an abstract Transform
// contract, and emits immutable TransformRecord provenance (Phase 14F).
//
// Contract source: spec/domain-architecture-v3.md §2.5, spec/domain-requirements-
// v3.md DOM-016, spec/work-orders/WORK-011.md.
//
// ARCHITECTURAL BOUNDARIES (frozen by IAAS-DOM-ARCH-3):
//   - Service-layer, NOT kernel (this module is in src/lib/services/).
//   - Resolves Transforms via TransformRegistry (does NOT own catalog/discovery).
//   - Emits TransformRecord after execution (does NOT own durable record storage).
//   - Does NOT import vertical services (VPP/Compute/Storage/Wireless/Manufacturing).
//   - Does NOT import EconomicPipeline, Route/Transport, RuntimeRegistry, or kernel.
//   - PostgreSQL is the durable source of truth (via TransformRecord).
//   - Tenant isolation is mandatory.
//   - Deterministic idempotency for replay convergence.
//   - Explicit failure semantics (failures do NOT produce successful provenance).
//
// This service does NOT:
//   - discover, certify, or revoke transforms (that is TransformRegistry);
//   - own transform metadata (the Registry is the sole catalog authority);
//   - mutate prior TransformRecords (it creates new ones only);
//   - implement marketplace/licensing/pricing — future;
//   - implement concrete VPP/Compute/Storage transforms — future;
//   - implement cryptographic signatures — future.
// =============================================================================

import { db } from '@/lib/db'
import { NotFoundError, ValidationError } from '@/lib/domain/errors'
import { sha256 } from '@/lib/domain/crypto'
import { getTransform } from '@/lib/services/transform-registry.service'
import { createTransformRecord } from '@/lib/services/transform-record.service'
import type { TransformRegistryEntryResult } from '@/lib/services/transform-registry.service'

// ---------------------------------------------------------------------------
// Transform Abstract Contract
// ---------------------------------------------------------------------------

/**
 * The abstract operation contract for a Transform. Concrete implementations
 * are registered by the caller (not by the runtime — the runtime dispatches
 * through this interface). The runtime does NOT hard-code any concrete
 * transform implementation.
 */
export interface TransformContract {
  /** Transform identity (must match a TransformRegistryEntry). */
  transformType: string
  transformVersion: string
  /** Execute the transform on an input payload. */
  execute(input: Buffer, parameters?: Record<string, unknown>): Promise<Buffer>
  /** Reverse the transform (if reversible). Throws if not reversible. */
  reverse?(output: Buffer, parameters?: Record<string, unknown>): Promise<Buffer>
  /** Estimate the resource cost of executing on the given input. */
  estimateCost(input: Buffer, parameters?: Record<string, unknown>): Promise<TransformCostEstimate>
  /** Verify that the (input, output) pair is consistent with this transform. */
  verify(input: Buffer, output: Buffer, parameters?: Record<string, unknown>): Promise<boolean>
}

export interface TransformCostEstimate {
  cpuMs: number
  memoryBytes: number
  description: string
}

// ---------------------------------------------------------------------------
// Runtime Types
// ---------------------------------------------------------------------------

export interface TransformExecutionInput {
  /** The Bundle whose payload is being transformed (for provenance). */
  bundleId: string
  /** The Node applying the transform (optional — may be system-applied). */
  nodeId?: string
  /** The transform type to resolve via TransformRegistry. */
  transformType: string
  /** The transform version to resolve via TransformRegistry. */
  transformVersion: string
  /** The input payload to transform. */
  inputPayload: Buffer
  /** Transform parameters (canonical JSON-serializable). */
  parameters?: Record<string, unknown>
  /** Caller-supplied idempotency key for replay convergence. */
  idempotencyKey: string
}

export interface TransformExecutionResult {
  /** The transformed output payload. */
  outputPayload: Buffer
  /** The SHA-256 hash of the input payload. */
  inputHash: string
  /** The SHA-256 hash of the output payload. */
  outputHash: string
  /** The TransformRecord ID (durable provenance). */
  transformRecordId: string
  /** Result status. */
  resultStatus: 'success' | 'failed'
}

export interface TransformReverseInput {
  bundleId: string
  nodeId?: string
  transformType: string
  transformVersion: string
  outputPayload: Buffer
  parameters?: Record<string, unknown>
  idempotencyKey: string
}

export interface TransformCostInput {
  transformType: string
  transformVersion: string
  inputPayload: Buffer
  parameters?: Record<string, unknown>
}

export interface TransformVerifyInput {
  transformType: string
  transformVersion: string
  inputPayload: Buffer
  outputPayload: Buffer
  parameters?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Transform Registry (for concrete Transform resolution)
// ---------------------------------------------------------------------------

/**
 * Registry of concrete Transform implementations. The runtime resolves
 * Transform metadata via TransformRegistry (PostgreSQL), and resolves concrete
 * Transform implementations via this in-memory registry. Callers register
 * concrete Transform contracts at application bootstrap — the runtime does NOT
 * hard-code any concrete transform.
 *
 * This is NOT TransformRegistry (which is the PostgreSQL catalog). This is a
 * simple in-memory dispatch table that maps (transformType, transformVersion)
 * to a concrete TransformContract implementation. The runtime is the sole
 * consumer of this table.
 */
const transformImplementations = new Map<string, TransformContract>()

/**
 * Register a concrete Transform implementation for runtime dispatch.
 * This is called by application bootstrap (not by the runtime itself).
 * The runtime does NOT hard-code any concrete transform — it dispatches
 * through whatever implementations are registered here.
 */
export function registerTransformImplementation(impl: TransformContract): void {
  const key = `${impl.transformType}@${impl.transformVersion}`
  transformImplementations.set(key, impl)
}

/**
 * Resolve a concrete Transform implementation by (type, version).
 * Returns undefined if no implementation is registered (the transform exists
 * in the catalog but no executable code is available).
 */
function getImplementation(transformType: string, transformVersion: string): TransformContract | undefined {
  return transformImplementations.get(`${transformType}@${transformVersion}`)
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

/**
 * Execute a Transform on a payload. Resolves the Transform via TransformRegistry
 * (catalog), dispatches execution through the concrete Transform implementation,
 * and emits an immutable TransformRecord with the full 7-element provenance.
 *
 * Idempotent: the same (bundleId, nodeIdentity, transformType, idempotencyKey)
 * tuple converges to the same TransformRecord (via TransformRecord's own
 * idempotency).
 *
 * Failure semantics: if the Transform execution throws, a TransformRecord with
 * resultStatus='failed' is still emitted (durable provenance of the failure),
 * and the error is re-thrown to the caller. The caller does NOT get a silent
 * success.
 */
export async function executeTransform(
  tenantId: string,
  input: TransformExecutionInput,
  actorId?: string,
): Promise<TransformExecutionResult> {
  // 1. Resolve Transform metadata via TransformRegistry (catalog authority).
  const registryEntry = await resolveFromRegistry(tenantId, input.transformType, input.transformVersion)

  // 2. Check revocation status.
  if (registryEntry.revocationStatus === 'revoked') {
    throw new ValidationError(
      `Transform ${input.transformType}@${input.transformVersion} is revoked: ${registryEntry.revocationReason ?? 'no reason given'}`,
    )
  }

  // 3. Resolve concrete implementation.
  const impl = getImplementation(input.transformType, input.transformVersion)
  if (!impl) {
    throw new NotFoundError(
      'transform_implementation',
      `${input.transformType}@${input.transformVersion} (registered in catalog but no executable implementation available)`,
    )
  }

  // 4. Compute input hash.
  const inputHash = sha256(input.inputPayload.toString('hex'))

  // 5. Execute the transform.
  let outputPayload: Buffer
  let resultStatus: 'success' | 'failed' = 'success'
  let resultMetadata: Record<string, unknown> = {}

  try {
    outputPayload = await impl.execute(input.inputPayload, input.parameters)
  } catch (err) {
    // Failure semantics: emit a TransformRecord with resultStatus='failed',
    // then re-throw. The caller does NOT get a silent success.
    resultStatus = 'failed'
    resultMetadata = {
      error: err instanceof Error ? err.message : String(err),
      errorType: err instanceof Error ? err.constructor.name : 'Unknown',
    }
    const outputHash = sha256(Buffer.alloc(0).toString('hex')) // empty output on failure

    // Emit failure provenance.
    const record = await createTransformRecord(tenantId, {
      bundleId: input.bundleId,
      nodeId: input.nodeId,
      transformType: input.transformType,
      transformVersion: input.transformVersion,
      inputHash,
      outputHash,
      parameters: input.parameters,
      resultStatus: 'failed',
      resultMetadata,
      idempotencyKey: input.idempotencyKey,
    }, actorId)

    // Re-throw the original error (caller sees the failure).
    throw err
  }

  // 6. Compute output hash.
  const outputHash = sha256(outputPayload.toString('hex'))

  // 7. Emit immutable TransformRecord (success provenance).
  const record = await createTransformRecord(tenantId, {
    bundleId: input.bundleId,
    nodeId: input.nodeId,
    transformType: input.transformType,
    transformVersion: input.transformVersion,
    inputHash,
    outputHash,
    parameters: input.parameters,
    resultStatus: 'success',
    resultMetadata,
    idempotencyKey: input.idempotencyKey,
  }, actorId)

  return {
    outputPayload,
    inputHash,
    outputHash,
    transformRecordId: record.id,
    resultStatus,
  }
}

// ---------------------------------------------------------------------------
// Reverse
// ---------------------------------------------------------------------------

/**
 * Reverse a Transform on an output payload. Only succeeds if the Transform
 * is reversible (declared in the registry). Emits a TransformRecord for the
 * reverse operation.
 */
export async function reverseTransform(
  tenantId: string,
  input: TransformReverseInput,
  actorId?: string,
): Promise<TransformExecutionResult> {
  const registryEntry = await resolveFromRegistry(tenantId, input.transformType, input.transformVersion)

  if (!registryEntry.reversibility) {
    throw new ValidationError(
      `Transform ${input.transformType}@${input.transformVersion} is not reversible`,
    )
  }

  const impl = getImplementation(input.transformType, input.transformVersion)
  if (!impl || !impl.reverse) {
    throw new NotFoundError(
      'transform_reverse_implementation',
      `${input.transformType}@${input.transformVersion}`,
    )
  }

  const inputHash = sha256(input.outputPayload.toString('hex')) // output becomes input for reverse
  const reversedPayload = await impl.reverse(input.outputPayload, input.parameters)
  const outputHash = sha256(reversedPayload.toString('hex'))

  const record = await createTransformRecord(tenantId, {
    bundleId: input.bundleId,
    nodeId: input.nodeId,
    transformType: `${input.transformType}:reverse`,
    transformVersion: input.transformVersion,
    inputHash,
    outputHash,
    parameters: input.parameters,
    resultStatus: 'success',
    idempotencyKey: input.idempotencyKey,
  }, actorId)

  return {
    outputPayload: reversedPayload,
    inputHash,
    outputHash,
    transformRecordId: record.id,
    resultStatus: 'success',
  }
}

// ---------------------------------------------------------------------------
// Estimate Cost
// ---------------------------------------------------------------------------

/**
 * Estimate the resource cost of executing a Transform. Does NOT execute the
 * transform — only calls the Transform's estimateCost() method.
 */
export async function estimateTransformCost(
  tenantId: string,
  input: TransformCostInput,
): Promise<TransformCostEstimate> {
  await resolveFromRegistry(tenantId, input.transformType, input.transformVersion)

  const impl = getImplementation(input.transformType, input.transformVersion)
  if (!impl) {
    throw new NotFoundError(
      'transform_implementation',
      `${input.transformType}@${input.transformVersion}`,
    )
  }

  return impl.estimateCost(input.inputPayload, input.parameters)
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify that an (input, output) pair is consistent with a Transform. Does NOT
 * execute the transform — only calls the Transform's verify() method.
 */
export async function verifyTransform(
  tenantId: string,
  input: TransformVerifyInput,
): Promise<boolean> {
  await resolveFromRegistry(tenantId, input.transformType, input.transformVersion)

  const impl = getImplementation(input.transformType, input.transformVersion)
  if (!impl) {
    throw new NotFoundError(
      'transform_implementation',
      `${input.transformType}@${input.transformVersion}`,
    )
  }

  return impl.verify(input.inputPayload, input.outputPayload, input.parameters)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve Transform metadata from TransformRegistry. Throws if the transform
 * is not found in the tenant's catalog. The runtime does NOT own catalog
 * metadata — TransformRegistry is the sole authority.
 */
async function resolveFromRegistry(
  tenantId: string,
  transformType: string,
  transformVersion: string,
): Promise<TransformRegistryEntryResult> {
  return getTransform(tenantId, transformType, transformVersion)
}
