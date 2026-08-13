// =============================================================================
// Network templates.
//
// Templates are pure configuration that instantiate a NetworkDefinition +
// an immutable NetworkVersion + Capability + RewardRule. They prove the
// platform is general-purpose: a new vertical only needs a new template,
// never a change to core domain code.
//
// Rule 10: Tenant-specific logic sits ABOVE generic platform primitives.
// =============================================================================

export interface CapabilityTemplate {
  type: string
  unit: string
  schemaVersion: number
  fields: Record<string, string>
}

export interface VerificationPolicyTemplate {
  checks: string[]
  numeric_ranges?: Record<string, { min?: number; max?: number }>
  timestamp_window_seconds?: number
}

export interface RewardPolicyTemplate {
  type: 'fixed_rate' | 'revenue_share'
  rate: string
  unit: string
  currency: string
  platform_fee_pct?: number
}

export interface NetworkTemplate {
  key: string
  name: string
  slug: string
  vertical: string
  description: string
  asset_types: string[]
  capabilities: CapabilityTemplate[]
  verification: VerificationPolicyTemplate
  reward: RewardPolicyTemplate
}

export const NETWORK_TEMPLATES: NetworkTemplate[] = [
  // -------------------------------------------------------------------------
  // generic-resource-network — proves the platform WITHOUT energy specifics.
  // -------------------------------------------------------------------------
  {
    key: 'generic-resource-network',
    name: 'Generic Resource Network',
    slug: 'generic-resource-network',
    vertical: 'generic',
    description:
      'A reference template that proves the full Event → Settlement pipeline without tying the platform to any specific vertical. Any measurable resource output is rewarded at a fixed rate.',
    asset_types: ['resource_device'],
    capabilities: [
      {
        type: 'measured_output',
        unit: 'unit',
        schemaVersion: 1,
        fields: { output_value: 'number', duration_seconds: 'number' },
      },
    ],
    verification: {
      checks: ['device_signature', 'timestamp_window', 'replay_protection', 'schema_validation', 'numeric_range'],
      numeric_ranges: { output_value: { min: 0, max: 100000 } },
      timestamp_window_seconds: 300,
    },
    reward: {
      type: 'fixed_rate',
      rate: '0.10',
      unit: 'unit',
      currency: 'USD',
      platform_fee_pct: 5,
    },
  },
  // -------------------------------------------------------------------------
  // energy-vpp — first specialised template. Sits ON TOP of the generic core.
  // VPP telemetry → generic Event; VPP kWh → generic Contribution; etc.
  // -------------------------------------------------------------------------
  {
    key: 'energy-vpp',
    name: 'Energy Virtual Power Plant',
    slug: 'energy-vpp',
    vertical: 'energy_vpp',
    description:
      'Decentralized Virtual Power Plant. Batteries and DERs discharge energy on dispatch; kWh delivered becomes a Contribution rewarded at a fixed rate. Uses only generic platform primitives.',
    asset_types: ['battery', 'solar_inverter', 'ev_charger', 'smart_meter'],
    capabilities: [
      {
        type: 'energy_discharge',
        unit: 'kWh',
        schemaVersion: 1,
        fields: { power_kw: 'number', available_energy_kwh: 'number', state_of_charge_pct: 'number' },
      },
    ],
    verification: {
      checks: ['device_signature', 'timestamp_window', 'replay_protection', 'schema_validation', 'numeric_range'],
      numeric_ranges: {
        power_kw: { min: 0, max: 1000 },
        state_of_charge_pct: { min: 0, max: 100 },
      },
      timestamp_window_seconds: 120,
    },
    reward: {
      type: 'fixed_rate',
      rate: '0.08',
      unit: 'kWh',
      currency: 'USD',
      platform_fee_pct: 5,
    },
  },
]

export function getTemplate(key: string): NetworkTemplate | undefined {
  return NETWORK_TEMPLATES.find((t) => t.key === key)
}
