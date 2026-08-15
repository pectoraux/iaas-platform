/**
 * VPP-2C: Publication-boundary concurrency tests.
 *
 * Verifies that the publication-readiness gate in publishNetworkVersion() is
 * concurrency-safe — i.e. the readiness check and the publication run
 * against the SAME locked transaction snapshot, so no race window exists
 * where a concurrent writer can mutate baselinePolicyJson between validation
 * and commit.
 *
 * The race this guards against (from the reviewer):
 *
 *   Writer A: reads accepted baseline policy
 *             passes publication gate
 *   Writer B: modifies baselinePolicyJson → status = no_acceptable_strategy
 *   Writer A: BEGIN, publish, COMMIT
 *   → published version contains the unacceptable policy the gate never saw
 *
 * The fix: load the NetworkVersion row FOR UPDATE inside the same
 * transaction that validates + publishes. Writer B's mutation blocks until
 * Writer A commits, by which point the version is immutable.
 *
 * Run: bun test tests/vpp-publication-concurrency.test.ts --timeout 120000
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
import { ValidationError, ImmutableResourceError } from '@/lib/domain/errors'

const config = {
  asset_types: ['battery'],
  capabilities: [{ type: 'energy_discharge', unit: 'kWh', schema_version: 1, fields: { power_kw: 'number', available_energy_kwh: 'number', state_of_charge_pct: 'number' } }],
  verification: { checks: ['device_signature', 'timestamp_window', 'replay_protection', 'schema_validation', 'numeric_range'], numeric_ranges: { power_kw: { min: 0, max: 1000 }, state_of_charge_pct: { min: 0, max: 100 } }, timestamp_window_seconds: 120 },
  reward: { type: 'fixed_rate', rate: '0.08', unit: 'kWh', currency: 'USD', platform_fee_pct: 5 },
}

let tenantId: string
let networkId: string

beforeAll(async () => {
  const t = await createTenant({ name: 'Pub Conc', slug: `pubconc-${Date.now()}`, plan: 'growth' })
  tenantId = t.id
  const n = await createNetwork(tenantId, { name: 'Pub Conc Net', slug: `pubconc-net-${Date.now()}`, vertical: 'energy_vpp' })
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

/**
 * Helper: set a no_acceptable_strategy policy on an unpublished version.
 */
async function setNoAcceptablePolicy(versionId: string): Promise<void> {
  await db.networkVersion.update({
    where: { id: versionId },
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
}

describe('VPP-2C: publication-readiness gate is concurrency-safe', () => {
  it('concurrent publish attempts on the same draft → exactly one succeeds', async () => {
    // Two concurrent publishNetworkVersion calls on the same draft.
    // The FOR UPDATE lock serializes them: the first gets the lock and
    // publishes; the second gets ImmutableResourceError on the locked row.
    const draftId = await createPublishableDraft()

    const results = await Promise.allSettled([
      publishNetworkVersion(tenantId, networkId, draftId),
      publishNetworkVersion(tenantId, networkId, draftId),
    ])

    const succeeded = results.filter((r) => r.status === 'fulfilled')
    const failed = results.filter((r) => r.status === 'rejected')
    expect(succeeded.length).toBe(1)
    expect(failed.length).toBe(1)

    // The failed one must be an "already published" error, NOT a validation
    // error (the draft had an accepted policy).
    const failedReason = (failed[0] as PromiseRejectedResult).reason
    expect(failedReason).toBeInstanceOf(ImmutableResourceError)

    // The published version must have an accepted policy.
    const published = await db.networkVersion.findUnique({ where: { id: draftId } })
    expect(published?.publishedAt).toBeTruthy()
    const policy = JSON.parse(published!.baselinePolicyJson!)
    expect(policy.status).toBe('accepted')
  })

  it('mutation of baselinePolicyJson during publish is blocked by FOR UPDATE lock', async () => {
    // This is the core race the reviewer identified:
    //   Writer A: starts publish (holds FOR UPDATE lock, validates accepted policy)
    //   Writer B: tries to mutate baselinePolicyJson to no_acceptable_strategy
    //   Writer A: commits → version published with the ACCEPTED policy
    //
    // Writer B's mutation MUST block until Writer A commits. After A commits,
    // the version is immutable — B's update is a stale write to a published
    // version (which the application layer does not expose, but we simulate
    // it here via direct DB access to prove the lock works).
    //
    // The published version must contain status='accepted', NEVER the
    // no_acceptable_strategy that Writer B tried to inject.
    const draftId = await createPublishableDraft()

    // Snapshot the accepted policy before the race.
    const beforePolicy = JSON.parse((await db.networkVersion.findUnique({ where: { id: draftId } }))!.baselinePolicyJson!)
    expect(beforePolicy.status).toBe('accepted')

    // Writer A publishes; Writer B concurrently tries to mutate the policy.
    // Promise.allSettled runs them in parallel.
    const results = await Promise.allSettled([
      // Writer A: publish (acquires FOR UPDATE lock, validates, commits)
      publishNetworkVersion(tenantId, networkId, draftId),
      // Writer B: direct DB mutation of baselinePolicyJson (simulates a
      // concurrent writer / migration / tamper attempt). This will BLOCK on
      // the FOR UPDATE lock held by Writer A until A commits.
      (async () => {
        // Small delay so Writer A acquires the lock first.
        await new Promise((r) => setTimeout(r, 50))
        await db.networkVersion.update({
          where: { id: draftId },
          data: {
            baselinePolicyJson: JSON.stringify({
              selectedStrategy: null,
              evaluationId: 'race-injection',
              evaluatedAt: new Date().toISOString(),
              criteria: {},
              metrics: {},
              status: 'no_acceptable_strategy',
            }),
          },
        })
      })(),
    ])

    // Writer A must succeed.
    const writerA = results[0]
    expect(writerA.status).toBe('fulfilled')

    // Writer B: the mutation either (a) blocked until after publication and
    // then overwrote the published row's baselinePolicyJson, or (b) threw.
    // Both are possible depending on DB timing. The CRITICAL invariant is
    // tested below: regardless of B's outcome, the published version's
    // policy must be re-read and verified.
    const afterVersion = await db.networkVersion.findUnique({ where: { id: draftId } })

    // The version MUST be published (Writer A committed).
    expect(afterVersion?.publishedAt).toBeTruthy()

    // The CRITICAL assertion: if Writer B's mutation landed AFTER publication,
    // that's a separate integrity issue (mutating an already-published
    // version) — but the publication gate itself was concurrency-safe:
    // Writer A validated and published the ACCEPTED policy atomically.
    //
    // For a fully immutable boundary, we additionally verify that the
    // published version's policy is still 'accepted'. If Writer B's stale
    // write overwrote it, this assertion catches the integrity violation
    // (the application layer never exposes mutations to published versions,
    // but we defend in depth).
    const afterPolicy = JSON.parse(afterVersion!.baselinePolicyJson!)
    // The published version's policy MUST remain 'accepted'. Writer B's
    // attempted injection of no_acceptable_strategy must NOT be visible on
    // the published version.
    expect(afterPolicy.status).toBe('accepted')
    expect(afterPolicy.selectedStrategy).toBeTruthy()
    expect(afterPolicy.evaluationId).not.toBe('race-injection')
  })

  it('publish with an accepted policy that is concurrently changed to no_acceptable → publication fails', async () => {
    // Variant of the race where Writer B's mutation lands BEFORE Writer A's
    // transaction acquires the lock. Writer A then loads the (now-mutated)
    // row FOR UPDATE, sees status='no_acceptable_strategy', and the gate
    // rejects publication.
    //
    // This proves the gate validates the CURRENT state of the locked row,
    // not a stale pre-transaction snapshot.
    const draftId = await createPublishableDraft()

    // Writer B mutates the policy to no_acceptable_strategy FIRST (before
    // Writer A starts publishing). No lock conflict — the draft is mutable.
    await setNoAcceptablePolicy(draftId)

    // Writer A now tries to publish. The gate must see the mutated policy
    // on the locked row and reject.
    await expect(
      publishNetworkVersion(tenantId, networkId, draftId),
    ).rejects.toThrow(ValidationError)

    // The version must remain unpublished.
    const stillDraft = await db.networkVersion.findUnique({ where: { id: draftId } })
    expect(stillDraft?.publishedAt).toBeNull()
  })

  it('a draft with no baseline policy cannot be published even under concurrent pressure', async () => {
    // A draft with no policy: concurrent publish attempts must ALL fail the
    // gate. None can slip through.
    const draftId = await createDraftWithoutPolicy()

    const results = await Promise.allSettled([
      publishNetworkVersion(tenantId, networkId, draftId),
      publishNetworkVersion(tenantId, networkId, draftId),
      publishNetworkVersion(tenantId, networkId, draftId),
    ])

    // ALL must fail — the draft has no baseline policy.
    const succeeded = results.filter((r) => r.status === 'fulfilled')
    const failed = results.filter((r) => r.status === 'rejected')
    expect(succeeded.length).toBe(0)
    expect(failed.length).toBe(3)

    // At least one failure must be a ValidationError (no baseline policy).
    // The others may be ValidationError or ImmutableResourceError depending
    // on lock ordering, but the version must NOT be published.
    const validationErrors = failed.filter(
      (r) => (r as PromiseRejectedResult).reason instanceof ValidationError,
    )
    expect(validationErrors.length).toBeGreaterThanOrEqual(1)

    const stillDraft = await db.networkVersion.findUnique({ where: { id: draftId } })
    expect(stillDraft?.publishedAt).toBeNull()
  })

  it('sequential publish of an accepted draft still works after the concurrency fixes', async () => {
    // Regression guard: the concurrency-safe implementation must not break
    // the normal sequential happy path.
    const draftId = await createPublishableDraft()

    const published = await publishNetworkVersion(tenantId, networkId, draftId)
    expect(published?.publishedAt).toBeTruthy()

    const policy = JSON.parse(published!.baselinePolicyJson!)
    expect(policy.status).toBe('accepted')
    expect(policy.selectedStrategy).toBeTruthy()

    // The network must point to it as current.
    const net = await db.networkDefinition.findUnique({ where: { id: networkId } })
    expect(net?.currentVersionId).toBe(draftId)
  })
})
