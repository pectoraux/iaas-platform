// =============================================================================
// Network service — definitions + IMMUTABLE versioning.
//
// Rule 6: Published network configuration is immutable.
// Rule 7: Every economically relevant object references the version that
//         produced it.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, ImmutableResourceError, NotFoundError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { emit, DomainEventTypes } from '@/lib/domain/events'
import {
  getTemplate,
  type NetworkTemplate,
} from '@/lib/domain/templates'
import { createCapability } from './registry.service'
import { createRewardRule } from './reward.service'

export interface CreateNetworkInput {
  name: string
  slug: string
  vertical?: string
}

function slugify(s: string): string {
  const cleaned = s.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (!cleaned) throw new ValidationError('Invalid slug')
  return cleaned
}

export async function createNetwork(tenantId: string, input: CreateNetworkInput, actorId?: string) {
  const slug = slugify(input.slug)
  const existing = await db.networkDefinition.findUnique({ where: { tenantId_slug: { tenantId, slug } } })
  if (existing) throw new ConflictError(`Network slug already exists: ${slug}`)

  const network = await db.networkDefinition.create({
    data: { tenantId, name: input.name, slug, vertical: input.vertical ?? 'generic', status: 'draft' },
  })
  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.NetworkCreated,
    resourceType: 'network',
    resourceId: network.id,
    metadata: { name: network.name, slug, vertical: network.vertical },
  })
  return network
}

export async function listNetworks(tenantId: string) {
  return db.networkDefinition.findMany({
    where: { tenantId },
    include: { versions: { orderBy: { version: 'desc' } } },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getNetwork(tenantId: string, id: string) {
  const net = await db.networkDefinition.findFirst({ where: { id, tenantId }, include: { versions: { orderBy: { version: 'desc' } } } })
  if (!net) throw new NotFoundError('network', id)
  return net
}

export interface VersionConfiguration {
  asset_types: string[]
  capabilities: Array<{ type: string; unit: string; schema_version: number; fields: Record<string, string> }>
  verification: { checks: string[]; numeric_ranges?: Record<string, { min?: number; max?: number }>; timestamp_window_seconds?: number }
  reward: { type: string; rate: string; unit: string; currency: string; platform_fee_pct?: number }
}

/** Create a new DRAFT version (mutable until published). */
export async function createNetworkVersion(
  tenantId: string,
  networkId: string,
  configuration: VersionConfiguration,
  actorId?: string,
) {
  await getNetwork(tenantId, networkId) // scoping + 404
  const last = await db.networkVersion.findFirst({
    where: { networkId },
    orderBy: { version: 'desc' },
  })
  const version = (last?.version ?? 0) + 1
  const created = await db.networkVersion.create({
    data: {
      networkId,
      version,
      configurationJson: JSON.stringify(configuration),
    },
  })
  return created
}

/**
 * Publish a version — IMMUTABLE afterwards. Also materialises Capability rows
 * and a RewardRule attached to the version, so downstream services can resolve
 * policy by version id.
 */
export async function publishNetworkVersion(
  tenantId: string,
  networkId: string,
  versionId: string,
  actorId?: string,
) {
  const network = await getNetwork(tenantId, networkId)
  const version = await db.networkVersion.findFirst({ where: { id: versionId, networkId } })
  if (!version) throw new NotFoundError('network_version', versionId)
  if (version.publishedAt) throw new ImmutableResourceError('Network version already published (immutable)')

  const config: VersionConfiguration = JSON.parse(version.configurationJson)

  // Atomic publish + capability/rule materialisation.
  await db.$transaction(async (tx) => {
    await tx.networkVersion.update({
      where: { id: versionId },
      data: { publishedAt: new Date() },
    })
    await tx.networkDefinition.update({
      where: { id: networkId },
      data: { status: 'active', currentVersionId: versionId },
    })
    // Materialise capabilities for this version.
    for (const cap of config.capabilities) {
      await tx.capability.create({
        data: {
          tenantId,
          networkVersionId: versionId,
          capabilityType: cap.type,
          schemaVersion: cap.schema_version,
          fieldsJson: JSON.stringify(cap.fields),
          unit: cap.unit,
        },
      })
    }
    // Materialise the reward rule for this version.
    await tx.rewardRule.create({
      data: {
        tenantId,
        networkVersionId: versionId,
        ruleType: config.reward.type,
        rate: config.reward.rate,
        unit: config.reward.unit,
        currency: config.reward.currency,
        ruleVersion: version.version,
        configJson: JSON.stringify({ platform_fee_pct: config.reward.platform_fee_pct ?? 5 }),
      },
    })
  })

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.NetworkPublished,
    resourceType: 'network_version',
    resourceId: versionId,
    metadata: { networkId, version: version.version, vertical: network.vertical },
  })
  await emit({
    event_type: 'NetworkPublished',
    aggregate_id: versionId,
    tenant_id: tenantId,
    version: version.version,
    payload: { networkId, version: version.version },
  })

  return db.networkVersion.findUnique({ where: { id: versionId } })
}

/** Resolve the configuration for a published version. */
export async function getPublishedConfiguration(versionId: string): Promise<VersionConfiguration> {
  const v = await db.networkVersion.findUnique({ where: { id: versionId } })
  if (!v) throw new NotFoundError('network_version', versionId)
  if (!v.publishedAt) throw new ImmutableResourceError('Network version is not published yet')
  return JSON.parse(v.configurationJson)
}

/**
 * Instantiate a network from a template. Creates Network + a version +
 * publishes it (materialising capabilities + reward rule). One-shot.
 */
export async function instantiateTemplate(
  tenantId: string,
  templateKey: string,
  overrides?: { name?: string; slug?: string },
  actorId?: string,
) {
  const template: NetworkTemplate | undefined = getTemplate(templateKey)
  if (!template) throw new NotFoundError('template', templateKey)

  const name = overrides?.name ?? template.name
  const slug = overrides?.slug ?? template.slug

  const network = await createNetwork(tenantId, { name, slug, vertical: template.vertical }, actorId)

  const configuration: VersionConfiguration = {
    asset_types: template.asset_types,
    capabilities: template.capabilities.map((c) => ({
      type: c.type,
      unit: c.unit,
      schema_version: c.schemaVersion,
      fields: c.fields,
    })),
    verification: template.verification,
    reward: template.reward,
  }
  const version = await createNetworkVersion(tenantId, network.id, configuration, actorId)
  const published = await publishNetworkVersion(tenantId, network.id, version.id, actorId)

  await appendAudit({
    tenantId,
    actorId,
    eventType: AuditEvents.TemplateInstantiated,
    resourceType: 'network',
    resourceId: network.id,
    metadata: { template: templateKey, versionId: published?.id },
  })

  return { network, version: published, template }
}

// Re-export for convenience (used by registry seed).
export { createCapability, createRewardRule }
