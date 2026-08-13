// =============================================================================
// Verification engine — pluggable pipeline of composable checks.
//
// Rule 9: Verification mechanisms must be composable.
// Generic primitives ONLY. No proof_of_energy / proof_of_storage / etc. in the
// platform core — verticals compose these primitives.
//
// Task 5: schema_validation now uses REAL JSON Schema validation via Zod,
// validating the event payload against the capability's field definitions.
//
// Task 6: policy_version is now the actual NetworkVersion.version, not
// hardcoded `1`.
// =============================================================================

import { db } from '@/lib/db'
import { verifySignature, canonicalEventMessage } from '@/lib/domain/crypto'
import type { VersionConfiguration } from './network.service'
import { z } from 'zod'

export type CheckStatus = 'pass' | 'fail' | 'skipped'

export interface CheckResult {
  name: string
  status: CheckStatus
  detail?: string
}

export interface VerificationContext {
  tenantId: string
  event: {
    id: string
    deviceId: string | null
    externalEventId: string | null
    eventType: string
    occurredAt: Date
    sequence: number | null
    payloadJson: string
    signature: string | null
  }
  device: {
    id: string
    credential: { verificationKey: string; status: string } | null
  }
  configuration: VersionConfiguration
  networkVersion: { id: string; version: number } // task 6: actual version
  raw: {
    device_id: string
    event_id: string
    timestamp: string
    event_type: string
    sequence?: number
    payload: unknown
    signature?: string
  }
}

export interface VerificationResult {
  policy_version: number // = NetworkVersion.version (task 6)
  verifier_version: string
  checks: CheckResult[]
  overall_status: 'verified' | 'rejected'
  risk: number
  confidence: number
}

export const VERIFIER_VERSION = '1.1.0'

// ---------------------------------------------------------------------------
// Generic verification primitives
// ---------------------------------------------------------------------------

export interface VerificationCheck {
  name: string
  verify(ctx: VerificationContext): Promise<CheckResult>
}

const deviceSignatureCheck: VerificationCheck = {
  name: 'device_signature',
  async verify(ctx): Promise<CheckResult> {
    if (!ctx.device.credential) return { name: 'device_signature', status: 'fail', detail: 'No credential on device' }
    if (!ctx.event.signature) return { name: 'device_signature', status: 'fail', detail: 'Missing signature' }
    const message = canonicalEventMessage(ctx.raw)
    const ok = verifySignature(message, ctx.event.signature, ctx.device.credential.verificationKey)
    return ok
      ? { name: 'device_signature', status: 'pass' }
      : { name: 'device_signature', status: 'fail', detail: 'Signature mismatch' }
  },
}

const timestampWindowCheck: VerificationCheck = {
  name: 'timestamp_window',
  async verify(ctx): Promise<CheckResult> {
    const windowSec = ctx.configuration.verification.timestamp_window_seconds ?? 300
    const occurred = ctx.event.occurredAt.getTime()
    const now = Date.now()
    const drift = Math.abs(now - occurred) / 1000
    if (drift > windowSec) {
      return { name: 'timestamp_window', status: 'fail', detail: `Drift ${drift.toFixed(0)}s > ${windowSec}s` }
    }
    return { name: 'timestamp_window', status: 'pass' }
  },
}

const replayProtectionCheck: VerificationCheck = {
  name: 'replay_protection',
  async verify(ctx): Promise<CheckResult> {
    // Idempotency on (tenant, externalEventId) is enforced at ingest via a
    // unique constraint. Here we additionally check the sequence is monotonic
    // per device when sequences are used.
    if (ctx.event.sequence == null) {
      return { name: 'replay_protection', status: 'pass', detail: 'No sequence; idempotency-key enforced' }
    }
    const last = await db.event.findFirst({
      where: {
        tenantId: ctx.tenantId,
        deviceId: ctx.event.deviceId,
        sequence: { not: null },
        id: { not: ctx.event.id },
      },
      orderBy: { sequence: 'desc' },
    })
    if (last && (last.sequence as number) >= ctx.event.sequence) {
      return { name: 'replay_protection', status: 'fail', detail: `Sequence ${ctx.event.sequence} <= last ${last.sequence}` }
    }
    return { name: 'replay_protection', status: 'pass' }
  },
}

/**
 * Task 5: REAL JSON Schema validation.
 *
 * Builds a Zod schema from the capability's field definitions and validates
 * the event payload against it. This replaces the old "JSON parses + is object"
 * check, which let `{"power_kw": "banana"}` through.
 */
const schemaValidationCheck: VerificationCheck = {
  name: 'schema_validation',
  async verify(ctx): Promise<CheckResult> {
    let payload: unknown
    try {
      payload = JSON.parse(ctx.event.payloadJson)
    } catch {
      return { name: 'schema_validation', status: 'fail', detail: 'Invalid JSON payload' }
    }
    if (typeof payload !== 'object' || payload === null) {
      return { name: 'schema_validation', status: 'fail', detail: 'Payload must be an object' }
    }

    // Build a Zod schema from the capability field definitions.
    const cap = ctx.configuration.capabilities[0]
    if (!cap || !cap.fields) {
      // No capability schema defined — accept any object (backward compat).
      return { name: 'schema_validation', status: 'pass', detail: 'No capability schema; object validated' }
    }

    const schemaShape: Record<string, z.ZodTypeAny> = {}
    for (const [field, type] of Object.entries(cap.fields)) {
      switch (type) {
        case 'number':
          schemaShape[field] = z.number()
          break
        case 'string':
          schemaShape[field] = z.string()
          break
        case 'boolean':
          schemaShape[field] = z.boolean()
          break
        default:
          schemaShape[field] = z.unknown()
      }
    }
    const schema = z.object(schemaShape).strict() // strict = reject unknown fields

    const result = schema.safeParse(payload)
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      return { name: 'schema_validation', status: 'fail', detail: issues }
    }
    return { name: 'schema_validation', status: 'pass' }
  },
}

const numericRangeCheck: VerificationCheck = {
  name: 'numeric_range',
  async verify(ctx): Promise<CheckResult> {
    const ranges = ctx.configuration.verification.numeric_ranges
    if (!ranges) return { name: 'numeric_range', status: 'skipped', detail: 'No ranges configured' }
    const payload = JSON.parse(ctx.event.payloadJson) as Record<string, number>
    for (const [field, range] of Object.entries(ranges)) {
      const v = payload[field]
      if (v == null) continue
      if (typeof v !== 'number') return { name: 'numeric_range', status: 'fail', detail: `${field} not numeric` }
      if (range.min != null && v < range.min) return { name: 'numeric_range', status: 'fail', detail: `${field}=${v} < min ${range.min}` }
      if (range.max != null && v > range.max) return { name: 'numeric_range', status: 'fail', detail: `${field}=${v} > max ${range.max}` }
    }
    return { name: 'numeric_range', status: 'pass' }
  },
}

/** Registry of all generic checks. Verticals compose subsets of these. */
export const CHECK_REGISTRY: Record<string, VerificationCheck> = {
  device_signature: deviceSignatureCheck,
  timestamp_window: timestampWindowCheck,
  replay_protection: replayProtectionCheck,
  schema_validation: schemaValidationCheck,
  numeric_range: numericRangeCheck,
}

/**
 * Run the verification pipeline for an event. The set of checks is determined
 * by the network version's verification policy (versioned, immutable).
 *
 * Task 6: policy_version is the actual NetworkVersion.version.
 */
export async function runVerification(ctx: VerificationContext): Promise<VerificationResult> {
  const checks: CheckResult[] = []
  const policyChecks: string[] = ctx.configuration.verification.checks
  for (const name of policyChecks) {
    const check = CHECK_REGISTRY[name]
    if (!check) {
      checks.push({ name, status: 'skipped', detail: 'Unknown check' })
      continue
    }
    try {
      checks.push(await check.verify(ctx))
    } catch (err) {
      checks.push({ name, status: 'fail', detail: err instanceof Error ? err.message : 'Check threw' })
    }
  }
  const anyFail = checks.some((c) => c.status === 'fail')
  const passed = checks.filter((c) => c.status === 'pass').length
  const total = checks.length
  const confidence = total === 0 ? 0 : passed / total
  const risk = anyFail ? 1 - confidence : 0
  return {
    policy_version: ctx.networkVersion.version, // task 6: actual version
    verifier_version: VERIFIER_VERSION,
    checks,
    overall_status: anyFail ? 'rejected' : 'verified',
    risk,
    confidence,
  }
}
