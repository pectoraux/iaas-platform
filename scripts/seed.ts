/**
 * Seed script.
 *
 * Creates a demo tenant ("Acme Networks"), instantiates BOTH the
 * generic-resource-network AND the energy-vpp templates, registers a sample
 * operator/asset/device for each, and submits one signed telemetry event that
 * flows all the way to settlement. Proves the full pipeline + multi-template
 * support in a single command.
 *
 * Usage: bun run scripts/seed.ts
 */
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { createOperator, createAsset, createDevice } from '../src/lib/services/registry.service'
import { ingestEvent, buildCanonicalMessage } from '../src/lib/services/ingestion.service'
import { createContribution } from '../src/lib/services/contribution.service'
import { calculateReward } from '../src/lib/services/reward.service'
import { postRewardToLedger } from '../src/lib/services/ledger.service'
import { createSettlement } from '../src/lib/services/settlement.service'
import { signMessage, deriveSigningKey } from '../src/lib/domain/crypto'
import { runE2EFlow } from '../src/lib/services/dashboard.service'

async function main() {
  console.log('🌱 Seeding Infrastructure-as-a-Network platform...\n')

  // 1. Demo tenant
  const tenant = await createTenant({ name: 'Acme Networks', slug: 'acme', plan: 'growth' })
  console.log(`✓ Tenant: ${tenant.id} (${tenant.slug})`)

  // 2. Both templates (proves generality)
  const generic = await instantiateTemplate(tenant.id, 'generic-resource-network')
  console.log(`✓ Network (generic): ${generic.network.slug} → version ${generic.version?.version}`)
  const vpp = await instantiateTemplate(tenant.id, 'energy-vpp', { slug: 'acme-vpp' })
  console.log(`✓ Network (energy-vpp): ${vpp.network.slug} → version ${vpp.version?.version}`)

  // 3-7. Operator + asset + device for the VPP
  const operator = await createOperator(tenant.id, { displayName: 'GreenPower Co', organizationName: 'GreenPower', trustScore: 0.92 })
  console.log(`✓ Operator: ${operator.id}`)
  const asset = await createAsset(tenant.id, {
    operatorId: operator.id,
    assetType: 'battery',
    name: 'Tesla Powerwall #1',
    location: 'grid-edge',
  })
  console.log(`✓ Asset: ${asset.id}`)
  const device = await createDevice(tenant.id, {
    assetId: asset.id,
    deviceType: 'battery_controller',
    manufacturer: 'Tesla',
    model: 'Powerwall 3',
  })
  console.log(`✓ Device: ${device.device.id} (provisioning secret returned)`)

  // 8-14. Signed telemetry → settlement for the VPP device
  const externalEventId = `seed-evt-${Date.now()}`
  const timestamp = new Date().toISOString()
  const payload = { power_kw: 4.8, available_energy_kwh: 13.5, state_of_charge_pct: 72 }
  const message = buildCanonicalMessage({
    device_id: device.device.id,
    event_id: externalEventId,
    timestamp,
    event_type: 'telemetry',
    sequence: 1,
    payload,
  })
  const signature = signMessage(message, deriveSigningKey(device.provisioningSecret))
  const ingest = await ingestEvent(tenant.id, {
    device_id: device.device.id,
    event_id: externalEventId,
    timestamp,
    event_type: 'telemetry',
    sequence: 1,
    payload,
    signature,
    network_version_id: vpp.version?.id,
  })
  console.log(`✓ Event ingested+verified: ${ingest.event_id} → attestation ${ingest.attestation_id}`)

  const contribution = await createContribution(tenant.id, { attestationIds: [ingest.attestation_id!] }, `seed-att-${ingest.attestation_id}`)
  console.log(`✓ Contribution: ${contribution.id} (${contribution.quantity} ${contribution.unit})`)

  const reward = await calculateReward(tenant.id, contribution.id, `seed-contrib-${contribution.id}`)
  console.log(`✓ Reward: ${reward.id} ($${reward.amount.toFixed(4)} ${reward.currency})`)

  const ledger = await postRewardToLedger(tenant.id, { rewardId: reward.id }, `seed-reward-${reward.id}`)
  console.log(`✓ Ledger posted: balance $${ledger.balance_after.toFixed(4)}`)

  const settlement = await createSettlement(tenant.id, reward.id)
  console.log(`✓ Settlement: ${settlement.id} → ${settlement.status} (payout ${settlement.provider_payout_id})`)

  // 15. Full generic-template E2E (separate tenant to demonstrate isolation)
  console.log('\n🌱 Running full generic-resource-network E2E flow...')
  const e2e = await runE2EFlow({ templateKey: 'generic-resource-network', tenantSlug: 'e2e-generic' })
  console.log(`✓ E2E chain:`)
  console.log(`    event       → ${e2e.chain.event_id}`)
  console.log(`    attestation → ${e2e.chain.attestation_id}`)
  console.log(`    contribution→ ${e2e.chain.contribution_id}`)
  console.log(`    reward      → ${e2e.chain.reward_id} ($${e2e.reward.amount.toFixed(4)})`)
  console.log(`    ledger      → ${e2e.chain.ledger_entry_id}`)
  console.log(`    settlement  → ${e2e.chain.settlement_id} (${e2e.settlement.status})`)

  console.log('\n✅ Seed complete. Open the dashboard to explore.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
