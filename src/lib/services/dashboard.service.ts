// =============================================================================
// Dashboard service — aggregated stats + end-to-end orchestration helper.
//
// Task 10: the E2E flow now uses the async outbox pattern:
//   ingest (queued) → processEventOutbox (verify + attest) → continue
// Task 8: settlement now uses the outbox pattern:
//   createSettlement (created) → processSettlementOutbox (pay + finalize)
// =============================================================================

import { db } from '@/lib/db'
import { createTenant } from './tenant.service'
import { instantiateTemplate } from './network.service'
import { createOperator, createAsset, createDevice, assignAssetToNetwork } from './registry.service'
import { ingestEvent, buildCanonicalMessage } from './ingestion.service'
import { createContribution } from './contribution.service'
import { calculateReward } from './reward.service'
import { postRewardToLedger } from './ledger.service'
import { createSettlement } from './settlement.service'
import { processEventOutbox, processSettlementOutbox } from './worker.service'
import { signMessage, deriveSigningKey } from '@/lib/domain/crypto'

export interface DashboardStats {
  tenants: number
  networks: number
  operators: number
  assets: number
  devices: number
  events_received: number
  events_verified: number
  events_rejected: number
  verification_success_rate: number
  attestations: number
  contributions: number
  rewards: number
  ledger_entries: number
  ledger_postings: number
  settlements: number
  settlements_completed: number
  settlements_failed: number
  total_reward_amount: number
  total_settled_amount: number
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const [tenants, networks, operators, assets, devices, eventsTotal, eventsVerified, eventsRejected, attestations, contributions, rewards, ledgerEntries, ledgerPostings, settlements, settlementsCompleted, settlementsFailed] = await Promise.all([
    db.tenant.count(),
    db.networkDefinition.count(),
    db.operator.count(),
    db.asset.count(),
    db.device.count(),
    db.event.count(),
    db.event.count({ where: { status: 'verified' } }),
    db.event.count({ where: { status: 'rejected' } }),
    db.attestation.count(),
    db.contribution.count(),
    db.reward.count(),
    db.ledgerEntry.count(),
    db.ledgerPosting.count(),
    db.settlement.count(),
    db.settlement.count({ where: { status: 'completed' } }),
    db.settlement.count({ where: { status: 'failed' } }),
  ])
  const verification_success_rate = eventsTotal === 0 ? 0 : (eventsVerified / eventsTotal) * 100
  const rewardAgg = await db.reward.aggregate({ _sum: { amount: true } })
  const settledAgg = await db.settlement.aggregate({ _sum: { amount: true }, where: { status: 'completed' } })
  return {
    tenants, networks, operators, assets, devices,
    events_received: eventsTotal,
    events_verified: eventsVerified,
    events_rejected: eventsRejected,
    verification_success_rate,
    attestations, contributions, rewards, ledger_entries: ledgerEntries, ledger_postings: ledgerPostings, settlements,
    settlements_completed: settlementsCompleted,
    settlements_failed: settlementsFailed,
    total_reward_amount: rewardAgg._sum.amount ?? 0,
    total_settled_amount: settledAgg._sum.amount ?? 0,
  }
}

// ---------------------------------------------------------------------------
// End-to-end orchestration: run the full telemetry → settlement vertical slice
// for a given template. Returns every id along the chain.
// ---------------------------------------------------------------------------

export interface E2EFlowResult {
  tenant: { id: string; slug: string }
  network: { id: string; slug: string; version_id: string; version: number }
  operator: { id: string }
  asset: { id: string }
  device: { id: string; provisioning_secret: string }
  event: { id: string; external_event_id: string; status: string }
  verification: { overall_status: string; confidence: number; checks: Array<{ name: string; status: string; detail?: string }> }
  attestation: { id: string; quantity: number; unit: string }
  contribution: { id: string; quantity: number; unit: string }
  reward: { id: string; amount: number; currency: string; breakdown: { gross: number; fee: number; net: number } }
  ledger: { posting_id: string; balance_after: number; balanced: boolean }
  settlement: { id: string; status: string; provider_payout_id: string | null }
  chain: {
    event_id: string
    attestation_id: string
    contribution_id: string
    reward_id: string
    ledger_posting_id: string
    settlement_id: string
  }
}

/**
 * Run the complete vertical slice. Creates its own tenant so it never
 * interferes with existing data. Uses the async outbox pattern internally.
 */
export async function runE2EFlow(opts?: {
  templateKey?: string
  tenantSlug?: string
  payload?: Record<string, unknown>
}): Promise<E2EFlowResult> {
  const templateKey = opts?.templateKey ?? 'generic-resource-network'
  const tenantSlug = opts?.tenantSlug ?? `e2e-${Date.now()}`
  const payload = opts?.payload ?? { output_value: 4.8, duration_seconds: 3600 }

  // 1. Tenant
  const tenant = await createTenant({ name: `E2E ${tenantSlug}`, slug: tenantSlug, plan: 'growth' })

  // 2-3. Network + published version (from template)
  const { network, version } = await instantiateTemplate(tenant.id, templateKey)

  // 4. Operator
  const operator = await createOperator(tenant.id, { displayName: 'E2E Operator', organizationName: 'E2E Org' })

  // 5. Asset
  const asset = await createAsset(tenant.id, {
    operatorId: operator.id,
    assetType: templateKey === 'energy-vpp' ? 'battery' : 'resource_device',
    name: 'E2E Resource Device',
    location: 'us-east-1',
  })

  // Task 4: explicitly assign asset to the network.
  const capType = templateKey === 'energy-vpp' ? 'energy_discharge' : 'measured_output'
  await assignAssetToNetwork(tenant.id, asset.id, network.id, capType)

  // 6-7. Device + credential provisioning
  const provisioned = await createDevice(tenant.id, {
    assetId: asset.id,
    deviceType: 'controller',
    manufacturer: 'Acme',
    model: 'R-1000',
  })

  // 8. Signed telemetry (async — persists + enqueues)
  const externalEventId = `evt-${Date.now()}`
  const timestamp = new Date().toISOString()
  const message = buildCanonicalMessage({
    device_id: provisioned.device.id,
    event_id: externalEventId,
    timestamp,
    event_type: 'telemetry',
    sequence: 1,
    payload,
  })
  const signingKey = deriveSigningKey(provisioned.provisioningSecret)
  const signature = signMessage(message, signingKey)

  const ingest = await ingestEvent(tenant.id, {
    device_id: provisioned.device.id,
    event_id: externalEventId,
    timestamp,
    event_type: 'telemetry',
    sequence: 1,
    payload,
    signature,
    network_version_id: version?.id,
  })

  // Task 10: process the outbox (runs verification + creates attestation).
  await processEventOutbox(tenant.id)

  // Reload the event to get verification + attestation results.
  const processedEvent = await db.event.findUnique({
    where: { id: ingest.event_id },
    include: { verification: true, attestations: true },
  })

  if (!processedEvent || processedEvent.status !== 'verified' || !processedEvent.attestations[0]) {
    throw new Error(`E2E flow: verification failed: ${JSON.stringify(processedEvent?.verification?.checksJson)}`)
  }

  // 10. Contribution
  const attestationId = processedEvent.attestations[0].id
  const contribution = await createContribution(
    tenant.id,
    { attestationIds: [attestationId] },
    `att-${attestationId}`,
  )

  // 11. Reward
  const reward = await calculateReward(tenant.id, contribution.id, `contrib-${contribution.id}`)

  // 12. Ledger (double-entry)
  const ledger = await postRewardToLedger(tenant.id, { rewardId: reward.id }, `reward-${reward.id}`)

  // 13. Settlement (creates instruction — worker processes it)
  const settlement = await createSettlement(tenant.id, reward.id)

  // Task 8: process the settlement outbox (calls provider + finalizes ledger).
  await processSettlementOutbox(tenant.id)

  // Reload settlement to get final status.
  const finalSettlement = await db.settlement.findUnique({ where: { id: settlement.id } })

  return {
    tenant: { id: tenant.id, slug: tenant.slug },
    network: { id: network.id, slug: network.slug, version_id: version?.id ?? '', version: version?.version ?? 1 },
    operator: { id: operator.id },
    asset: { id: asset.id },
    device: { id: provisioned.device.id, provisioning_secret: provisioned.provisioningSecret },
    event: { id: ingest.event_id, external_event_id: ingest.external_event_id, status: processedEvent.status },
    verification: {
      overall_status: processedEvent.verification?.overallStatus ?? 'unknown',
      confidence: processedEvent.verification?.confidence ?? 0,
      checks: JSON.parse(processedEvent.verification?.checksJson ?? '[]'),
    },
    attestation: {
      id: attestationId,
      quantity: processedEvent.attestations[0].quantity,
      unit: processedEvent.attestations[0].unit,
    },
    contribution: { id: contribution.id, quantity: contribution.quantity, unit: contribution.unit },
    reward: {
      id: reward.id,
      amount: reward.amount,
      currency: reward.currency,
      breakdown: reward.calculation,
    },
    ledger: {
      posting_id: ledger.posting_id,
      balance_after: ledger.operator_balance_after,
      balanced: ledger.breakdown.balanced,
    },
    settlement: {
      id: settlement.id,
      status: finalSettlement?.status ?? settlement.status,
      provider_payout_id: finalSettlement?.providerPayoutId ?? null,
    },
    chain: {
      event_id: ingest.event_id,
      attestation_id: attestationId,
      contribution_id: contribution.id,
      reward_id: reward.id,
      ledger_posting_id: ledger.posting_id,
      settlement_id: settlement.id,
    },
  }
}
