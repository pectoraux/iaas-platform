/**
 * VPP-2C: Publication-event atomicity tests.
 *
 * Verifies that the NetworkPublished outbox event and the publication audit
 * record commit atomically with the publication itself — using the existing
 * outbox pattern. This closes the failure window:
 *
 *   publish commits successfully
 *     → process crashes
 *     → NetworkPublished outbox event never emitted
 *
 * The fix: appendAudit() and emit() now run INSIDE the publishNetworkVersion
 * transaction (passing `tx`), so:
 *   - if the transaction commits → version + event + audit all persist
 *   - if the transaction rolls back (e.g. validation failure) → none persist
 *
 * This is the same atomic-outbox principle previously applied to ingestion
 * and settlement. Publication is a critical immutable policy transition, so
 * its event/audit MUST be part of the atomic operation.
 *
 * Run: bun test tests/vpp-publication-atomicity.test.ts --timeout 120000
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import {
  createNetwork,
  createNetworkVersion,
  publishNetworkVersion,
} from '../src/lib/services/network.service'
import { createRewardRule } from '../src/lib/services/reward.service'
import { runAndPersistBaselineEvaluation } from '../src/lib/services/baseline-evaluation.service'
import { ValidationError } from '@/lib/domain/errors'

const config = {
  asset_types: ['battery'],
  capabilities: [{ type: 'energy_discharge', unit: 'kWh', schema_version: 1, fields: { power_kw: 'number', available_energy_kwh: 'number', state_of_charge_pct: 'number' } }],
  verification: { checks: ['device_signature', 'timestamp_window', 'replay_protection', 'schema_validation', 'numeric_range'], numeric_ranges: { power_kw: { min: 0, max: 1000 }, state_of_charge_pct: { min: 0, max: 100 } }, timestamp_window_seconds: 120 },
  reward: { type: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD', platform_fee_pct: 5 },
}

let tenantId: string
let networkId: string

beforeAll(async () => {
  const t = await createTenant({ name: 'Pub Atomic', slug: `pubatomic-${Date.now()}`, plan: 'growth' })
  tenantId = t.id
  const n = await createNetwork(tenantId, { name: 'Pub Atomic Net', slug: `pubatomic-net-${Date.now()}`, vertical: 'energy_vpp' })
  networkId = n.id
})

/**
 * Helper: create an energy_vpp draft version with an accepted baseline policy
 * (ready to publish). Returns the versionId.
 */
async function createPublishableDraft(): Promise<string> {
  const version = await createNetworkVersion(tenantId, networkId, config)
  await createRewardRule(tenantId, { networkVersionId: version.id, ruleType: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD' })
  await runAndPersistBaselineEvaluation({ tenantId, networkVersionId: version.id, numScenarios: 50 })
  return version.id
}

/**
 * Helper: create an energy_vpp draft version WITHOUT a baseline policy.
 */
async function createDraftWithoutPolicy(): Promise<string> {
  const version = await createNetworkVersion(tenantId, networkId, config)
  await createRewardRule(tenantId, { networkVersionId: version.id, ruleType: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD' })
  return version.id
}

describe('VPP-2C: publication event/audit atomicity (outbox pattern)', () => {
  it('successful publication commits version + NetworkPublished event + audit together', async () => {
    const draftId = await createPublishableDraft()

    // Count events/audit BEFORE publication.
    const eventsBefore = await db.domainEvent.count({
      where: { tenantId, aggregateId: draftId, eventType: 'NetworkPublished' },
    })
    const auditBefore = await db.auditLog.count({
      where: { tenantId, resourceType: 'network_version', resourceId: draftId, eventType: 'network.published' },
    })
    expect(eventsBefore).toBe(0)
    expect(auditBefore).toBe(0)

    // Publish — the event + audit are written inside the same transaction.
    const published = await publishNetworkVersion(tenantId, networkId, draftId)
    expect(published?.publishedAt).toBeTruthy()

    // After commit: version is published AND the NetworkPublished outbox
    // event AND the audit record all exist. None can be missing.
    const eventsAfter = await db.domainEvent.findMany({
      where: { tenantId, aggregateId: draftId, eventType: 'NetworkPublished' },
    })
    expect(eventsAfter.length).toBe(1)
    expect(eventsAfter[0].processed).toBe(false) // outbox — worker will fan out
    const payload = JSON.parse(eventsAfter[0].payloadJson)
    expect(payload.networkId).toBe(networkId)
    expect(payload.version).toBe(published!.version)

    const auditAfter = await db.auditLog.findMany({
      where: { tenantId, resourceType: 'network_version', resourceId: draftId, eventType: 'network.published' },
    })
    expect(auditAfter.length).toBe(1)
    const auditMeta = JSON.parse(auditAfter[0].metadataJson)
    expect(auditMeta.networkId).toBe(networkId)
    expect(auditMeta.vertical).toBe('energy_vpp')
  })

  it('failed publication (no baseline policy) rolls back version + event + audit together', async () => {
    // A draft with NO baseline policy — publication must be rejected by the
    // readiness gate. The transaction rolls back, so:
    //   - version stays unpublished
    //   - NO NetworkPublished outbox event is left behind
    //   - NO publication audit record is left behind
    const draftId = await createDraftWithoutPolicy()

    const eventsBefore = await db.domainEvent.count({
      where: { tenantId, aggregateId: draftId, eventType: 'NetworkPublished' },
    })
    const auditBefore = await db.auditLog.count({
      where: { tenantId, resourceType: 'network_version', resourceId: draftId, eventType: 'network.published' },
    })
    expect(eventsBefore).toBe(0)
    expect(auditBefore).toBe(0)

    // Publication must fail.
    await expect(
      publishNetworkVersion(tenantId, networkId, draftId),
    ).rejects.toThrow(ValidationError)

    // After rollback: version is STILL unpublished.
    const stillDraft = await db.networkVersion.findUnique({ where: { id: draftId } })
    expect(stillDraft?.publishedAt).toBeNull()

    // CRITICAL: no orphaned outbox event. The emit() was inside the
    // transaction, so it rolled back with the publication.
    const eventsAfter = await db.domainEvent.count({
      where: { tenantId, aggregateId: draftId, eventType: 'NetworkPublished' },
    })
    expect(eventsAfter).toBe(0)

    // CRITICAL: no orphaned audit record. The appendAudit() was inside the
    // transaction, so it rolled back with the publication.
    const auditAfter = await db.auditLog.count({
      where: { tenantId, resourceType: 'network_version', resourceId: draftId, eventType: 'network.published' },
    })
    expect(auditAfter).toBe(0)
  })

  it('failed publication (no_acceptable_strategy) rolls back event + audit', async () => {
    // A draft with a no_acceptable_strategy policy — publication rejected.
    // Same atomicity guarantee: no orphaned event/audit.
    const draftId = await createPublishableDraft()

    // Overwrite the accepted policy with no_acceptable_strategy (draft is mutable).
    await db.networkVersion.update({
      where: { id: draftId },
      data: {
        baselinePolicyJson: JSON.stringify({
          selectedStrategy: null,
          evaluationId: 'manual-no-acceptable',
          evaluatedAt: new Date().toISOString(),
          criteria: {},
          metrics: {},
          status: 'no_acceptable_strategy',
        }),
      },
    })

    await expect(
      publishNetworkVersion(tenantId, networkId, draftId),
    ).rejects.toThrow(ValidationError)

    // Version stays unpublished.
    const stillDraft = await db.networkVersion.findUnique({ where: { id: draftId } })
    expect(stillDraft?.publishedAt).toBeNull()

    // No orphaned event.
    const eventsAfter = await db.domainEvent.count({
      where: { tenantId, aggregateId: draftId, eventType: 'NetworkPublished' },
    })
    expect(eventsAfter).toBe(0)

    // No orphaned audit.
    const auditAfter = await db.auditLog.count({
      where: { tenantId, resourceType: 'network_version', resourceId: draftId, eventType: 'network.published' },
    })
    expect(auditAfter).toBe(0)
  })

  it('already-published version rejected, no duplicate event/audit', async () => {
    // Publish once (succeeds), then attempt to publish again (rejected).
    // The second attempt must not create a duplicate event or audit.
    const draftId = await createPublishableDraft()
    await publishNetworkVersion(tenantId, networkId, draftId)

    // Second publication attempt — must be rejected as immutable.
    await expect(
      publishNetworkVersion(tenantId, networkId, draftId),
    ).rejects.toThrow()

    // Exactly ONE event (from the first publication), not two.
    const events = await db.domainEvent.findMany({
      where: { tenantId, aggregateId: draftId, eventType: 'NetworkPublished' },
    })
    expect(events.length).toBe(1)

    // Exactly ONE audit record (from the first publication), not two.
    const audit = await db.auditLog.findMany({
      where: { tenantId, resourceType: 'network_version', resourceId: draftId, eventType: 'network.published' },
    })
    expect(audit.length).toBe(1)
  })

  it('instantiateTemplate produces a published version with atomic event + audit', async () => {
    // Regression guard: instantiateTemplate calls publishNetworkVersion, so
    // its publications must also carry the atomic event + audit.
    const { instantiateTemplate } = await import('../src/lib/services/network.service')
    const slug = `atomic-inst-${Date.now()}`
    const { version } = await instantiateTemplate(tenantId, 'energy-vpp', { slug })
    expect(version?.publishedAt).toBeTruthy()

    // The NetworkPublished event must exist for this version.
    const events = await db.domainEvent.findMany({
      where: { tenantId, aggregateId: version!.id, eventType: 'NetworkPublished' },
    })
    expect(events.length).toBe(1)

    // The publication audit must exist.
    const audit = await db.auditLog.findMany({
      where: { tenantId, resourceType: 'network_version', resourceId: version!.id, eventType: 'network.published' },
    })
    expect(audit.length).toBe(1)
  })
})
