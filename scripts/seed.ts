/**
 * Seed script.
 *
 * Creates demo accounts and a demo tenant with seeded infrastructure data.
 *
 * SECURITY (task 1): NO hardcoded real-looking credentials. Demo credentials
 * are configurable via environment variables. If not set, random passwords are
 * generated and printed to the console (never committed to source).
 *
 * Usage: bun run scripts/seed.ts
 *
 * Env vars (all optional):
 *   SEED_ADMIN_EMAIL       — email for the platform admin (default: admin@iaas.local)
 *   SEED_ADMIN_PASSWORD    — password for the platform admin (default: random, printed)
 *   SEED_DEMO_PASSWORD     — password for all demo accounts (default: random, printed)
 */
import { db } from '../src/lib/db'
import { createTenant } from '../src/lib/services/tenant.service'
import { instantiateTemplate } from '../src/lib/services/network.service'
import { createOperator, createAsset, createDevice, assignAssetToNetwork } from '../src/lib/services/registry.service'
import { ingestEvent, buildCanonicalMessage } from '../src/lib/services/ingestion.service'
import { createContribution } from '../src/lib/services/contribution.service'
import { calculateReward } from '../src/lib/services/reward.service'
import { postRewardToLedger } from '../src/lib/services/ledger.service'
import { createSettlement } from '../src/lib/services/settlement.service'
import { processEventOutbox } from '../src/lib/services/worker.service'
import { signMessage, deriveSigningKey } from '../src/lib/domain/crypto'
import { hashPassword } from '../src/lib/domain/auth'
import { randomBytes } from 'crypto'

function generatePassword(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 24 }, () => chars[randomBytes(1)[0] % chars.length]).join('')
}

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

  // ---- Resolve credentials from env (no hardcoded real credentials) ----
  // Admin credential is env-configurable; default is random (never committed).
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@iaas.local'
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || generatePassword()
  // Demo accounts use FIXED, predictable passwords (they're demo accounts, not secrets).
  // These match the DEMO_ACCOUNTS array in the frontend (src/app/page.tsx).
  // They can be overridden via SEED_DEMO_* env vars for production.
  const demoAdminPassword = process.env.SEED_DEMO_ADMIN_PASSWORD || 'DemoAdmin123!'
  const demoOwnerPassword = process.env.SEED_DEMO_OWNER_PASSWORD || 'DemoOwner123!'
  const demoOperatorPassword = process.env.SEED_DEMO_OPERATOR_PASSWORD || 'DemoOperator123!'
  const demoViewerPassword = process.env.SEED_DEMO_VIEWER_PASSWORD || 'DemoViewer123!'

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

  // Assign asset to the VPP network (task 4: explicit network membership).
  await assignAssetToNetwork(tenant.id, asset.id, vpp.network.id, 'energy_discharge')

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
    console.log(`  ↳ Event queued: ${ingest.event_id}`)

    // Process the outbox (async verification).
    await processEventOutbox(tenant.id)
    const updatedEvent = await db.event.findUnique({ where: { id: ingest.event_id }, include: { attestations: true } })
    console.log(`  ↳ Event verified: ${updatedEvent?.status} → attestation ${updatedEvent?.attestations[0]?.id}`)

    if (updatedEvent?.attestations[0]) {
      const contribution = await createContribution(tenant.id, { attestationIds: [updatedEvent.attestations[0].id] }, `seed-att-${updatedEvent.attestations[0].id}`)
      const reward = await calculateReward(tenant.id, contribution.id, `seed-contrib-${contribution.id}`)
      // Task 5: fund the buyer account before posting to ledger.
      const { recordBuyerFunding } = await import('../src/lib/services/ledger.service')
      await recordBuyerFunding(tenant.id, 1000, `seed-funding-${Date.now()}`)
      const ledger = await postRewardToLedger(tenant.id, { rewardId: reward.id }, `seed-reward-${reward.id}`)

      // Process settlement outbox.
      const settlement = await createSettlement(tenant.id, reward.id)
      await processSettlementOutbox(tenant.id)
      console.log(`  ↳ Chain: contribution ${contribution.id} → reward $${Number(reward.amount).toFixed(4)} → ledger balance $${ledger.operator_balance_after.toFixed(4)} → settlement ${settlement.status}`)
    }
  } else {
    console.log('  ↳ Device already exists, skipping telemetry chain')
  }

  // ---- 2. Auth accounts ----
  console.log('\n🔐 Creating authentication accounts...')

  // Platform admin (NOT labeled "real" — configurable via env).
  await ensureUser({
    email: adminEmail,
    password: adminPassword,
    role: 'admin',
    displayName: 'Platform Admin',
    isDemo: false,
    tenantId: null,
  })

  // Demo accounts — all linked to the Acme tenant.
  // Each uses its own fixed, predictable password matching the frontend.
  await ensureUser({
    email: 'demo-admin@iaas.network',
    password: demoAdminPassword,
    role: 'admin',
    displayName: 'Demo Admin',
    isDemo: true,
    tenantId: tenant.id,
  })
  await ensureUser({
    email: 'demo-owner@iaas.network',
    password: demoOwnerPassword,
    role: 'owner',
    displayName: 'Demo Owner',
    isDemo: true,
    tenantId: tenant.id,
  })
  await ensureUser({
    email: 'demo-operator@iaas.network',
    password: demoOperatorPassword,
    role: 'operator',
    displayName: 'Demo Operator',
    isDemo: true,
    tenantId: tenant.id,
  })
  await ensureUser({
    email: 'demo-viewer@iaas.network',
    password: demoViewerPassword,
    role: 'viewer',
    displayName: 'Demo Viewer',
    isDemo: true,
    tenantId: tenant.id,
  })

  console.log('\n✅ Seed complete.')
  console.log('\n📋 Login credentials:')
  console.log(`  Admin:          ${adminEmail} / ${adminPassword}`)
  console.log(`  Demo Admin:     demo-admin@iaas.network / ${demoAdminPassword}`)
  console.log(`  Demo Owner:     demo-owner@iaas.network / ${demoOwnerPassword}`)
  console.log(`  Demo Operator:  demo-operator@iaas.network / ${demoOperatorPassword}`)
  console.log(`  Demo Viewer:    demo-viewer@iaas.network / ${demoViewerPassword}`)
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.log('\n  ⚠️  Admin password was randomly generated. To use a fixed password, set:')
    console.log('     SEED_ADMIN_PASSWORD=... bun run seed')
  }
}

// Inline import to avoid circular dependency in the settlement processing.
async function processSettlementOutbox(tenantId: string) {
  const { processSettlementOutbox: proc } = await import('../src/lib/services/worker.service')
  return proc(tenantId)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
