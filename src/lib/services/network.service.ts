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
import { validateRuntimeKind, type RuntimeKind } from '@/lib/kernel/runtime'

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
  // WORK-026 (IAAS-DOM-ARCH-6 §3.5 / NET-002): the DECLARED canonical
  // dependency contract of the definition — { from } REQUIRES { to }, both
  // referencing capability types declared by this same configuration. This is
  // the intra-definition declaration surface consumed by the Network-as-Code
  // compiler (network-compiler.service.ts); publication persists it into
  // configurationJson untouched (it is inert to publication semantics and to
  // every pre-WORK-026 consumer).
  dependencies?: Array<{ from: string; to: string }>
}

/** Create a new DRAFT version (mutable until published). */
export async function createNetworkVersion(
  tenantId: string,
  networkId: string,
  configuration: VersionConfiguration,
  actorId?: string,
  runtimeKind: RuntimeKind = 'infrastructure',
) {
  await getNetwork(tenantId, networkId) // scoping + 404
  // Phase 5: validate runtimeKind at creation. A new runtime choice requires
  // a new NetworkVersion — runtimeKind is immutable after publication.
  validateRuntimeKind(runtimeKind)

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
      runtimeKind,
    },
  })
  return created
}

/**
 * Publish a version — IMMUTABLE afterwards. Also materialises Capability rows
 * and a RewardRule attached to the version, so downstream services can resolve
 * policy by version id.
 *
 * VPP-2C publication-readiness gate (concurrency-safe):
 *   Publication is the immutable-version boundary — once publishedAt is set,
 *   the version becomes an immutable policy artifact. Therefore the
 *   publication-readiness invariant is enforced HERE, INSIDE the same
 *   transaction that flips publishedAt, against a FOR UPDATE locked row.
 *
 *   Why the lock matters: an unpublished NetworkVersion is still mutable, so
 *   another writer could change baselinePolicyJson between a pre-transaction
 *   validation and the publish commit. By loading the row FOR UPDATE inside
 *   the transaction, we guarantee the readiness check validates the exact
 *   policy snapshot that gets published. No race window exists.
 *
 *   Current vertical rules (extensible):
 *     energy_vpp: baselinePolicyJson must exist, status === 'accepted',
 *                 and selectedStrategy must be non-empty.
 *     (other verticals: no gate yet — add proof/coverage/workload gates here
 *      when those verticals land.)
 */
export async function publishNetworkVersion(
  tenantId: string,
  networkId: string,
  versionId: string,
  actorId?: string,
) {
  const network = await getNetwork(tenantId, networkId)

  // CONCURRENCY-SAFE PUBLICATION:
  // The readiness check and the publication run against the SAME locked
  // transaction snapshot. The FOR UPDATE lock on the NetworkVersion row
  // prevents any concurrent writer from mutating baselinePolicyJson between
  // validation and commit.
  const publishedVersion = await db.$transaction(async (tx) => {
    // Lock the NetworkVersion row FOR UPDATE. This blocks any concurrent
    // transaction that tries to read/update this row until we COMMIT (or
    // ROLLBACK on validation failure).
    const lockedRows = await tx.$queryRaw<Array<{
      id: string
      networkId: string
      version: number
      configurationJson: string
      baselinePolicyJson: string | null
      runtimeKind: string
      publishedAt: Date | null
    }>>`
      SELECT "id", "networkId", "version", "configurationJson",
             "baselinePolicyJson", "runtimeKind", "publishedAt"
      FROM "NetworkVersion"
      WHERE "id" = ${versionId}::text
      FOR UPDATE
    `
    const version = lockedRows[0]
    if (!version) throw new NotFoundError('network_version', versionId)

    // The networkId scope check still applies (defend against a caller passing
    // a versionId from a different network).
    if (version.networkId !== networkId) {
      throw new NotFoundError('network_version', versionId)
    }

    // Re-check immutability against the LOCKED row — a concurrent caller may
    // have published it between our initial getNetwork and this transaction.
    if (version.publishedAt) {
      throw new ImmutableResourceError('Network version already published (immutable)')
    }

    // Publication-readiness gate — validated against the LOCKED row, so the
    // policy snapshot we check here is exactly the one that gets published.
    // This closes the race where Writer B mutates baselinePolicyJson between
    // a pre-transaction validation and the publish commit.
    //
    // Phase 5: runtimeKind is also validated here (defense-in-depth). It was
    // already validated at createNetworkVersion, but this check ensures a
    // version that somehow has an invalid runtimeKind (e.g., direct DB access)
    // cannot be published.
    assertPublicationReadiness(network.vertical, version)

    const config: VersionConfiguration = JSON.parse(version.configurationJson)

    // Flip the version to immutable + make it the network's current version.
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

    // ATOMIC OUTBOX (VPP-2C final atomicity fix):
    // The publication audit record and the NetworkPublished outbox event are
    // written INSIDE the same transaction as the publication itself. This
    // guarantees that if the transaction commits, the audit + outbox row
    // commit too — no orphaned/missing events if the process crashes between
    // the publish commit and the emit. If the transaction rolls back (e.g.
    // validation failure), neither the publication nor the event/audit
    // persists.
    //
    // This is the same atomic-outbox principle applied to ingestion and
    // settlement. Publication is a critical immutable policy transition, so
    // its event/audit MUST be part of the atomic operation.
    await appendAudit({
      tenantId,
      actorId,
      eventType: AuditEvents.NetworkPublished,
      resourceType: 'network_version',
      resourceId: versionId,
      metadata: { networkId, version: version.version, vertical: network.vertical },
      tx, // ← commits/rolls back with the publication
    })
    await emit(
      {
        event_type: 'NetworkPublished',
        aggregate_id: versionId,
        tenant_id: tenantId,
        version: version.version,
        payload: { networkId, version: version.version },
      },
      tx, // ← commits/rolls back with the publication
    )

    return version
  }, { timeout: 30000 })

  return db.networkVersion.findUnique({ where: { id: versionId } })
}

/**
 * Publication-readiness policy — the extensible per-vertical gate that
 * determines whether a NetworkVersion may transition from mutable draft to
 * immutable published.
 *
 * This function is PURE: it validates a version object's policy fields and
 * throws ValidationError if the version is not publication-ready. It does
 * NOT touch the database. The caller is responsible for passing a version
 * object loaded FOR UPDATE inside the same transaction that will publish it,
 * so the check is concurrency-safe.
 *
 * This is the defense-in-depth layer:
 *   - Template builder (instantiateTemplate)        ✅
 *   - Program creation (createBuyerProgram)          ✅
 *   - Version publication (publishNetworkVersion)    ✅ ← THIS (locked row)
 *   - Runtime execution (executeDispatchAssignment)  ✅
 *
 * Publication is the most important layer because after publication the
 * version becomes an immutable policy artifact — every downstream economic
 * calculation resolves against it.
 *
 * To add a new vertical's gate, extend this function with a case for that
 * vertical. For example:
 *   case 'storage': assert proof policy accepted
 *   case 'wireless': assert coverage verification accepted
 *   case 'compute': assert workload verification accepted
 */
function assertPublicationReadiness(
  vertical: string,
  version: { id: string; version: number; baselinePolicyJson: string | null; runtimeKind: string },
): void {
  // Phase 5: runtimeKind must be a valid value. This was validated at creation,
  // but this defense-in-depth check ensures a version with an invalid runtimeKind
  // (e.g., set via direct DB access) cannot be published.
  validateRuntimeKind(version.runtimeKind)

  switch (vertical) {
    case 'energy_vpp': {
      // An energy_vpp NetworkVersion MUST have an accepted baseline policy
      // before it becomes immutable. Without it, no dispatch can compute a
      // valid baseline, and no program can be safely bound.
      if (!version.baselinePolicyJson) {
        throw new ValidationError(
          `Cannot publish energy_vpp version v${version.version} (${version.id}): ` +
            `no baseline policy has been persisted. Run runAndPersistBaselineEvaluation ` +
            `before publishing so the version carries an accepted baseline strategy.`,
        )
      }
      const policy = JSON.parse(version.baselinePolicyJson)
      if (policy.status !== 'accepted' || !policy.selectedStrategy) {
        throw new ValidationError(
          `Cannot publish energy_vpp version v${version.version} (${version.id}): ` +
            `baseline policy status is '${policy.status}' (selectedStrategy: ` +
            `${policy.selectedStrategy ?? 'null'}). A published version requires ` +
            `status='accepted' with a non-empty selectedStrategy.`,
        )
      }
      break
    }
    default:
      // No publication-readiness gate for this vertical yet. When storage /
      // wireless / compute land, add their gates here.
      break
  }
}

/** Resolve the configuration for a published version. */
export async function getPublishedConfiguration(versionId: string): Promise<VersionConfiguration> {
  const v = await db.networkVersion.findUnique({ where: { id: versionId } })
  if (!v) throw new NotFoundError('network_version', versionId)
  if (!v.publishedAt) throw new ImmutableResourceError('Network version is not published yet')
  return JSON.parse(v.configurationJson)
}

/** Get a network version by id, scoped to tenant. Used by ingestion. */
export async function getNetworkVersion(tenantId: string, versionId: string) {
  const version = await db.networkVersion.findFirst({
    where: { id: versionId, network: { tenantId } },
    include: { network: true },
  })
  if (!version) throw new NotFoundError('network_version', versionId)
  return version
}

/** Get the network version record (with version number) for policy resolution. */
export async function getNetworkVersionRecord(versionId: string) {
  const v = await db.networkVersion.findUnique({ where: { id: versionId } })
  if (!v) throw new NotFoundError('network_version', versionId)
  return v
}

/**
 * Instantiate a network from a template. Creates Network + a version +
 * publishes it (materialising capabilities + reward rule). Idempotent — if
 * the network already exists with a published version, returns it.
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

  // Idempotent: check if network already exists with a published version.
  const existing = await db.networkDefinition.findUnique({
    where: { tenantId_slug: { tenantId, slug } },
    include: { versions: { where: { publishedAt: { not: null } }, orderBy: { version: 'desc' }, take: 1 } },
  })
  if (existing && existing.currentVersionId) {
    return {
      network: existing,
      version: existing.versions[0] ?? null,
      template,
    }
  }

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
  const version = await createNetworkVersion(
    tenantId,
    network.id,
    configuration,
    actorId,
    template.runtimeKind ?? 'infrastructure',
  )

  // VPP-2C strict-baseline rule (option A): an energy_vpp NetworkVersion
  // MUST have an accepted baseline policy before it is published. This makes
  // the immutable-policy architecture strict — no published VPP version can
  // ever lack a baseline strategy, so no program can silently fall back to
  // a hardcoded source-code default at execution time.
  //
  // For non-VPP verticals (generic, storage, wireless, compute), baseline
  // policy is not applicable and this step is skipped.
  if (template.vertical === 'energy_vpp') {
    const { runAndPersistBaselineEvaluation } = await import('./baseline-evaluation.service')
    await runAndPersistBaselineEvaluation({ tenantId, networkVersionId: version.id, numScenarios: 50 })
  }

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
