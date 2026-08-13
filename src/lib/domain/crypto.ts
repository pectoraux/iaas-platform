// =============================================================================
// Device credential crypto.
//
// For the MVP we use HMAC-SHA256 signing (simple, deterministic, and enough to
// demonstrate the device_signature verification primitive). The interface is
// designed so an Ed25519 implementation can be swapped in later without
// changing the verification pipeline.
//
// SECRETS ARE NEVER STORED IN PLAINTEXT.
//   - provisioningSecret: returned ONCE to the caller at provisioning time.
//   - secretHash: SHA-256(provisioningSecret) stored for auth comparison.
//   - publicKey: derived key base used to recompute the expected signature.
// =============================================================================

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'crypto'

const PROVISIONING_PREFIX = 'psk_'

/** Generate a provisioning secret + its derived signing key base. */
export function generateProvisioningSecret(): {
  provisioningSecret: string
  secretHash: string
  publicKey: string
} {
  // provisioningSecret = psk_<32 random bytes hex>
  // publicKey (signing base) = sha256(provisioningSecret) — used to recompute signatures
  // secretHash = sha256(publicKey) — stored, used to verify provisioningSecret on auth
  const raw = randomBytes(32).toString('hex')
  const provisioningSecret = `${PROVISIONING_PREFIX}${raw}`
  const publicKey = sha256(provisioningSecret)
  const secretHash = sha256(publicKey)
  return { provisioningSecret, secretHash, publicKey }
}

/** Hash a value with SHA-256 (hex). */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Canonical message used for signing/verifying device events.
 * Deterministic ordering guarantees replay-ability across nodes.
 */
export function canonicalEventMessage(input: {
  device_id: string
  event_id: string
  timestamp: string
  event_type: string
  sequence?: number
  payload: unknown
}): string {
  const payloadJson = JSON.stringify(input.payload)
  const seq = input.sequence ?? 0
  return [
    input.device_id,
    input.event_id,
    input.timestamp,
    input.event_type,
    String(seq),
    payloadJson,
  ].join('\n')
}

/** Sign a canonical message with the provisioning secret (HMAC-SHA256). */
export function signMessage(message: string, provisioningSecret: string): string {
  return createHmac('sha256', provisioningSecret).update(message).digest('hex')
}

/**
 * Verify a device event signature.
 * Recomputes the expected signature using the credential's publicKey (which is
 * sha256(provisioningSecret)) as the HMAC key — note: this means the verifier
 * must possess the provisioningSecret OR the platform must store the derived
 * signing key. For the MVP we store publicKey (= sha256(provisioningSecret)) as
 * the HMAC key base, so the verifier uses publicKey directly.
 *
 * This keeps the provisioning secret out of the database while letting the
 * platform verify signatures offline.
 */
export function verifySignature(
  message: string,
  signature: string,
  publicKey: string,
): boolean {
  const expected = createHmac('sha256', publicKey).update(message).digest('hex')
  const a = Buffer.from(signature, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Validate a provisioning secret against a stored hash (used by device auth). */
export function verifyProvisioningSecret(
  provisioningSecret: string,
  secretHash: string,
): boolean {
  const publicKey = sha256(provisioningSecret)
  const computed = sha256(publicKey)
  const a = Buffer.from(computed, 'hex')
  const b = Buffer.from(secretHash, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Resolve the publicKey (signing base) from a provisioning secret. */
export function publicKeyFromProvisioningSecret(provisioningSecret: string): string {
  return sha256(provisioningSecret)
}
