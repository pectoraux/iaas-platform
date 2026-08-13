/**
 * Seed script.
 *
 * 1. Creates the REAL admin account (ekontetevi@gmail / Payswap123456).
 * 2. Creates demo accounts with quick-login for all user types.
 * 3. Creates a demo tenant with seeded infrastructure data (both templates).
 * 4. Runs one full VPP telemetry → settlement chain.
 *
 * Usage: bun run scripts/seed.ts
 */
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { createOperator, createAsset, createDevice } from '../src/lib/services/registry.service'
import { ingestEvent, buildCanonicalMessage } from '../src/lib/services/ingestion.service'
import { createContribution } from '../src/lib/services/contribution.service'
import { calculateReward } from '../src/lib/services/reward.service'
import { postRewardToLedger } from '../src/lib/services/ledger.service'
import { createSettlement } from '../src/lib/services/settlement.service'
import { signMessage, deriveSigningKey } from '../src/lib/domain/crypto'
import { hashPassword } from '../src/lib/domain/auth'

async function ensureUser(opts: {
  email: string
  password: string
  role: string
  displayName: string
  isDemo: boolean
  tenantId?: string | null
}) {
  const existing = await db.platformUser.findUnique({ where: { email: opts.email } })
  if (existing) {
    console.log(`  ↳ User already exists: ${opts.email} (${opts.role})`)
    return existing
  }
  const user = await db.platformUser.create({
    data: {
      email: opts.email,
      passwordHash: hashPassword(opts.password),
      role: opts.role,
      tenantId: opts.tenantId ?? null,
      status: 'active',
      isDemo: opts.isDemo,
      displayName: opts.displayName,
    },
  })
  console.log(`  ↳ Created user: ${opts.email} (${opts.role}${opts.isDemo ? ', demo' : ''})`)
  return user
}

async function main() {
  console.log('🌱 Seeding Infrastructure-as-a-Network platform...\n')

  // ---- 1. Demo tenant with infrastructure data ----
  console.log('📋 Creating demo tenant...')
  let tenant = await db.tenant.findUnique({ where: { slug: 'acme' } })
  if (!tenant) {
    tenant = await createTenant({ name: 'Acme Networks', slug: 'acme', plan: 'growth' })
  }
  console.log(`  ↳ Tenant: ${tenant.id} (${tenant.slug})`)

  // Instantiate both templates (proves generality).
  console.log('📋 Instantiating network templates...')
  const generic = await instantiateTemplate(tenant.id, 'generic-resource-network')
  console.log(`  ↳ Network (generic): ${generic.network.slug} v${generic.version?.version}`)
  const vpp = await instantiateTemplate(tenant.id, 'energy-vpp', { slug: 'acme-vpp' })
  console.log(`  ↳ Network (energy-vpp): ${vpp.network.slug} v${vpp.version?.version}`)

  // Operator + asset + device for the VPP.
  console.log('📋 Registering operator + asset + device...')
  let operator = await db.operator.findFirst({ where: { tenantId: tenant.id } })
  if (!operator) {
    operator = await createOperator(tenant.id, { displayName: 'GreenPower Co', organizationName: 'GreenPower', trustScore: 0.92 })
  }
  let asset = await db.asset.findFirst({ where: { tenantId: tenant.id } })
  if (!asset) {
    asset = await createAsset(tenant.id, {
      operatorId: operator.id,
      assetType: 'battery',
      name: 'Tesla Powerwall #1',
      location: 'grid-edge',
    })
  }
  let device = await db.device.findFirst({ where: { tenantId: tenant.id } })
  if (!device) {
    const provisioned = await createDevice(tenant.id, {
      assetId: asset.id,
      deviceType: 'battery_controller',
      manufacturer: 'Tesla',
      model: 'Powerwall 3',
    })
    device = provisioned.device as any
    // Run one full VPP telemetry → settlement chain.
    console.log('📋 Running VPP telemetry → settlement chain...')
    const externalEventId = `seed-evt-${Date.now()}`
    const timestamp = new Date().toISOString()
    const payload = { power_kw: 4.8, available_energy_kwh: 13.5, state_of_charge_pct: 72 }
    const message = buildCanonicalMessage({
      device_id: provisioned.device.id,
      event_id: externalEventId,
      timestamp,
      event_type: 'telemetry',
      sequence: 1,
      payload,
    })
    const signature = signMessage(message, deriveSigningKey(provisioned.provisioningSecret))
    const ingest = await ingestEvent(tenant.id, {
      device_id: provisioned.device.id,
      event_id: externalEventId,
      timestamp,
      event_type: 'telemetry',
      sequence: 1,
      payload,
      signature,
      network_version_id: vpp.version?.id,
    })
    console.log(`  ↳ Event: ${ingest.event_id} (${ingest.status}) → attestation ${ingest.attestation_id}`)

    if (ingest.attestation_id) {
      const contribution = await createContribution(tenant.id, { attestationIds: [ingest.attestation_id] }, `seed-att-${ingest.attestation_id}`)
      const reward = await calculateReward(tenant.id, contribution.id, `seed-contrib-${contribution.id}`)
      const ledger = await postRewardToLedger(tenant.id, { rewardId: reward.id }, `seed-reward-${reward.id}`)
      const settlement = await createSettlement(tenant.id, reward.id)
      console.log(`  ↳ Chain: contribution ${contribution.id} → reward $${reward.amount.toFixed(4)} → ledger $${ledger.balance_after.toFixed(4)} → settlement ${settlement.status}`)
    }
  } else {
    console.log('  ↳ Device already exists, skipping telemetry chain')
  }

  // ---- 2. Auth accounts ----
  console.log('\n🔐 Creating authentication accounts...')

  // REAL admin (non-demo).
  await ensureUser({
    email: 'ekontetevi@gmail',
    password: 'Payswap123456',
    role: 'admin',
    displayName: 'Admin',
    isDemo: false,
    tenantId: null,
  })

  // Demo accounts — all linked to the Acme tenant.
  await ensureUser({
    email: 'demo-admin@iaas.network',
    password: 'DemoAdmin123!',
    role: 'admin',
    displayName: 'Demo Admin',
    isDemo: true,
    tenantId: tenant.id,
  })
  await ensureUser({
    email: 'demo-owner@iaas.network',
    password: 'DemoOwner123!',
    role: 'owner',
    displayName: 'Demo Owner',
    isDemo: true,
    tenantId: tenant.id,
  })
  await ensureUser({
    email: 'demo-operator@iaas.network',
    password: 'DemoOperator123!',
    role: 'operator',
    displayName: 'Demo Operator',
    isDemo: true,
    tenantId: tenant.id,
  })
  await ensureUser({
    email: 'demo-viewer@iaas.network',
    password: 'DemoViewer123!',
    role: 'viewer',
    displayName: 'Demo Viewer',
    isDemo: true,
    tenantId: tenant.id,
  })

  console.log('\n✅ Seed complete.')
  console.log('\n📋 Login credentials:')
  console.log('  Admin:     ekontetevi@gmail / Payswap123456')
  console.log('  Demo Admin:    demo-admin@iaas.network / DemoAdmin123!')
  console.log('  Demo Owner:    demo-owner@iaas.network / DemoOwner123!')
  console.log('  Demo Operator: demo-operator@iaas.network / DemoOperator123!')
  console.log('  Demo Viewer:   demo-viewer@iaas.network / DemoViewer123!')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
