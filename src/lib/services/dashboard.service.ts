// =============================================================================
// Dashboard service — aggregated stats + end-to-end orchestration helper.
// =============================================================================

import { db } from '@/lib/db'
import { createTenant } from './tenant.service'
import { instantiateTemplate } from './network.service'
import { createOperator, createAsset, createDevice } from './registry.service'
import { ingestEvent, buildCanonicalMessage } from './ingestion.service'
import { createContribution } from './contribution.service'
import { calculateReward } from './reward.service'
import { postRewardToLedger } from './ledger.service'
import { createSettlement } from './settlement.service'
import { signMessage } from '@/lib/domain/crypto'

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
  settlements: number
  settlements_completed: number
  settlements_failed: number
  total_reward_amount: number
  total_settled_amount: number
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const [tenants, networks, operators, assets, devices, eventsTotal, eventsVerified, eventsRejected, attestations, contributions, rewards, ledgerEntries, settlements, settlementsCompleted, settlementsFailed] = await Promise.all([
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
    attestations, contributions, rewards, ledger_entries: ledgerEntries, settlements,
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
  network: { id: string; slug: string; version_id: string }
  operator: { id: string }
  asset: { id: string }
  device: { id: string; provisioning_secret: string }
  event: { id: string; external_event_id: string; status: string }
  verification: { overall_status: string; confidence: number; checks: Array<{ name: string; status: string }> }
  attestation: { id: string; quantity: number; unit: string }
  contribution: { id: string; quantity: number; unit: string }
  reward: { id: string; amount: number; currency: string }
  ledger: { reward_credit_entry_id: string; platform_fee_entry_id: string; balance_after: number }
  settlement: { id: string; status: string; provider_payout_id: string | null }
  chain: {
    event_id: string
    attestation_id: string
    contribution_id: string
    reward_id: string
    ledger_entry_id: string
    settlement_id: string
  }
}

/**
 * Run the complete vertical slice. Creates its own tenant so it never
 * interferes with existing data. Perfect for the dashboard "Run Full Flow"
 * button + automated E2E tests.
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
    assetType: 'resource_device',
    name: 'E2E Resource Device',
    location: 'us-east-1',
  })

  // 6-7. Device + credential provisioning
  const provisioned = await createDevice(tenant.id, {
    assetId: asset.id,
    deviceType: 'controller',
    manufacturer: 'Acme',
    model: 'R-1000',
  })

  // 8. Signed telemetry
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
  const signature = signMessage(message, provisioned.provisioningSecret)

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

  if (ingest.status !== 'verified' || !ingest.attestation_id) {
    throw new Error(`E2E flow: ingestion/verification failed: ${JSON.stringify(ingest.verification)}`)
  }

  // 10. Attestation already auto-created. Contribution.
  const contribution = await createContribution(
    tenant.id,
    { attestationIds: [ingest.attestation_id] },
    `att-${ingest.attestation_id}`,
  )

  // 11. Reward
  const reward = await calculateReward(tenant.id, contribution.id, `contrib-${contribution.id}`)

  // 12. Ledger
  const ledger = await postRewardToLedger(tenant.id, { rewardId: reward.id }, `reward-${reward.id}`)

  // 13-14. Settlement
  const settlement = await createSettlement(tenant.id, reward.id)

  return {
    tenant: { id: tenant.id, slug: tenant.slug },
    network: { id: network.id, slug: network.slug, version_id: version?.id ?? '' },
    operator: { id: operator.id },
    asset: { id: asset.id },
    device: { id: provisioned.device.id, provisioning_secret: provisioned.provisioningSecret },
    event: { id: ingest.event_id, external_event_id: ingest.external_event_id, status: ingest.status },
    verification: {
      overall_status: ingest.verification!.overall_status,
      confidence: ingest.verification!.confidence,
      checks: ingest.verification!.checks,
    },
    attestation: { id: ingest.attestation_id, quantity: 0, unit: '' },
    contribution: { id: contribution.id, quantity: contribution.quantity, unit: contribution.unit },
    reward: { id: reward.id, amount: reward.amount, currency: reward.currency },
    ledger: {
      reward_credit_entry_id: ledger.reward_credit_entry_id,
      platform_fee_entry_id: ledger.platform_fee_entry_id,
      balance_after: ledger.balance_after,
    },
    settlement: {
      id: settlement.id,
      status: settlement.status,
      provider_payout_id: settlement.provider_payout_id,
    },
    chain: {
      event_id: ingest.event_id,
      attestation_id: ingest.attestation_id,
      contribution_id: contribution.id,
      reward_id: reward.id,
      ledger_entry_id: ledger.reward_credit_entry_id,
      settlement_id: settlement.id,
    },
  }
}
