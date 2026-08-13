// =============================================================================
// Registry service — Operator, Asset, Device, Capability, DeviceCredential.
//
// Rule 8: A Node must NOT become a catch-all. Operator / Asset / Device /
// Capability are distinct entities.
// Rule 33: Never trust operator_id / device ownership / etc. from client input.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import {
  generateProvisioningSecret,
  publicKeyFromProvisioningSecret,
  sha256,
} from '@/lib/domain/crypto'

// ---------------------------------------------------------------------------
// Operator
// ---------------------------------------------------------------------------

export interface CreateOperatorInput {
  displayName: string
  organizationName?: string
  trustScore?: number
}

export async function createOperator(tenantId: string, input: CreateOperatorInput, actorId?: string) {
  let organizationId: string | undefined
  if (input.organizationName) {
    const org = await db.organization.create({ data: { tenantId, name: input.organizationName } })
    organizationId = org.id
  }
  const operator = await db.operator.create({
    data: {
      tenantId,
      organizationId,
      displayName: input.displayName,
      trustScore: input.trustScore ?? null,
      status: 'active',
    },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.OperatorCreated,
    resourceType: 'operator',
    resourceId: operator.id,
    metadata: { displayName: operator.displayName, organizationId },
  })
  return operator
}

export async function listOperators(tenantId: string) {
  return db.operator.findMany({ where: { tenantId }, include: { organization: true }, orderBy: { createdAt: 'desc' } })
}

export async function getOperator(tenantId: string, id: string) {
  const op = await db.operator.findFirst({ where: { id, tenantId }, include: { organization: true } })
  if (!op) throw new NotFoundError('operator', id)
  return op
}

// ---------------------------------------------------------------------------
// Asset
// ---------------------------------------------------------------------------

export interface CreateAssetInput {
  operatorId: string
  assetType: string
  name: string
  location?: string
  metadata?: Record<string, unknown>
}

export async function createAsset(tenantId: string, input: CreateAssetInput, actorId?: string) {
  // Validate operator belongs to tenant.
  await getOperator(tenantId, input.operatorId)
  const asset = await db.asset.create({
    data: {
      tenantId,
      operatorId: input.operatorId,
      assetType: input.assetType,
      name: input.name,
      location: input.location ?? null,
      metadataJson: JSON.stringify(input.metadata ?? {}),
      status: 'registered',
    },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.AssetCreated,
    resourceType: 'asset',
    resourceId: asset.id,
    metadata: { name: asset.name, assetType: asset.assetType, operatorId: input.operatorId },
  })
  return asset
}

export async function listAssets(tenantId: string) {
  return db.asset.findMany({
    where: { tenantId },
    include: { operator: true, devices: true },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getAsset(tenantId: string, id: string) {
  const a = await db.asset.findFirst({ where: { id, tenantId }, include: { operator: true, devices: true } })
  if (!a) throw new NotFoundError('asset', id)
  return a
}

// ---------------------------------------------------------------------------
// Device + credentials
// ---------------------------------------------------------------------------

export interface CreateDeviceInput {
  assetId: string
  deviceType: string
  manufacturer?: string
  model?: string
  metadata?: Record<string, unknown>
}

export interface ProvisionedDevice {
  device: {
    id: string
    tenantId: string
    assetId: string
    deviceType: string
    manufacturer: string | null
    model: string | null
    status: string
    createdAt: Date
  }
  credential: {
    id: string
    credentialType: string
    publicKey: string
    status: string
  }
  // Returned ONLY at provisioning time. Never stored in plaintext, never re-issued.
  provisioningSecret: string
}

/**
 * Create a device AND provision its credential in one atomic step. The
 * provisioning secret is returned exactly once. We hash it before storage.
 */
export async function createDevice(
  tenantId: string,
  input: CreateDeviceInput,
  actorId?: string,
): Promise<ProvisionedDevice> {
  await getAsset(tenantId, input.assetId) // scoping + 404

  const { provisioningSecret, secretHash, publicKey } = generateProvisioningSecret()

  const result = await db.$transaction(async (tx) => {
    const device = await tx.device.create({
      data: {
        tenantId,
        assetId: input.assetId,
        deviceType: input.deviceType,
        manufacturer: input.manufacturer ?? null,
        model: input.model ?? null,
        status: 'provisioned',
        metadataJson: JSON.stringify(input.metadata ?? {}),
      },
    })
    const credential = await tx.deviceCredential.create({
      data: {
        tenantId,
        deviceId: device.id,
        credentialType: 'hmac_sha256',
        publicKey,
        secretHash,
        provisioningSecretHash: sha256(provisioningSecret),
        status: 'active',
      },
    })
    return { device, credential }
  })

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.DeviceProvisioned,
    resourceType: 'device',
    resourceId: result.device.id,
    metadata: { deviceType: result.device.deviceType, assetId: input.assetId, credentialId: result.credential.id },
  })

  return {
    device: result.device,
    credential: {
      id: result.credential.id,
      credentialType: result.credential.credentialType,
      publicKey: result.credential.publicKey,
      status: result.credential.status,
    },
    provisioningSecret,
  }
}

export async function listDevices(tenantId: string) {
  return db.device.findMany({
    where: { tenantId },
    include: { asset: true, credential: true },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getDevice(tenantId: string, id: string) {
  const d = await db.device.findFirst({ where: { id, tenantId }, include: { asset: true, credential: true } })
  if (!d) throw new NotFoundError('device', id)
  return d
}

export async function activateDevice(tenantId: string, id: string, actorId?: string) {
  const device = await getDevice(tenantId, id)
  await db.device.update({ where: { id }, data: { status: 'active' } })
  if (device.credentialId) {
    await db.deviceCredential.updateMany({ where: { id: device.credentialId }, data: { status: 'active', activatedAt: new Date() } })
  }
  await appendAudit({ tenantId, actorId, eventType: AuditEvents.DeviceActivated, resourceType: 'device', resourceId: id })
  return getDevice(tenantId, id)
}

export async function suspendDevice(tenantId: string, id: string, actorId?: string) {
  const device = await getDevice(tenantId, id)
  await db.device.update({ where: { id }, data: { status: 'suspended' } })
  if (device.credentialId) {
    await db.deviceCredential.updateMany({ where: { id: device.credentialId }, data: { status: 'suspended', suspendedAt: new Date() } })
  }
  await appendAudit({ tenantId, actorId, eventType: AuditEvents.DeviceSuspended, resourceType: 'device', resourceId: id })
  return getDevice(tenantId, id)
}

/**
 * Resolve a device credential by device id + tenant. Used by ingestion to
 * authenticate signed events. Throws if device/credential is suspended.
 */
export async function resolveDeviceCredential(tenantId: string, deviceId: string) {
  const device = await db.device.findFirst({
    where: { id: deviceId, tenantId },
    include: { credential: true, asset: true },
  })
  if (!device) throw new NotFoundError('device', deviceId)
  if (device.status === 'suspended' || device.status === 'revoked') {
    throw new ValidationError(`Device ${deviceId} is ${device.status}`)
  }
  if (!device.credential) throw new ValidationError(`Device ${deviceId} has no credential`)
  if (device.credential.status !== 'active') throw new ValidationError(`Credential for device ${deviceId} is ${device.credential.status}`)
  return device
}

// ---------------------------------------------------------------------------
// Capability (also created during template instantiation)
// ---------------------------------------------------------------------------

export interface CreateCapabilityInput {
  networkVersionId?: string
  capabilityType: string
  schemaVersion?: number
  fields?: Record<string, string>
  unit?: string
}

export async function createCapability(tenantId: string, input: CreateCapabilityInput) {
  return db.capability.create({
    data: {
      tenantId,
      networkVersionId: input.networkVersionId ?? null,
      capabilityType: input.capabilityType,
      schemaVersion: input.schemaVersion ?? 1,
      fieldsJson: JSON.stringify(input.fields ?? {}),
      unit: input.unit ?? 'unit',
    },
  })
}

export async function listCapabilities(tenantId: string) {
  return db.capability.findMany({ where: { tenantId }, include: { networkVersion: true }, orderBy: { createdAt: 'desc' } })
}

export async function getCapabilityForVersion(tenantId: string, versionId: string, capabilityType: string) {
  const cap = await db.capability.findFirst({ where: { tenantId, networkVersionId: versionId, capabilityType } })
  if (!cap) throw new NotFoundError('capability', `${capabilityType}@${versionId}`)
  return cap
}

export { publicKeyFromProvisioningSecret }
