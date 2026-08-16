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
  // Phase 5: which runtime executes work for this network.
  // Defaults to 'infrastructure' if not specified.
  runtimeKind?: 'infrastructure' | 'protocol' | 'hybrid'
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
      {
        type: 'frequency_response',
        unit: 'kW',
        schemaVersion: 1,
        fields: { frequency_hz: 'number', response_kw: 'number', duration_seconds: 'number' },
      },
      {
        type: 'energy_capacity',
        unit: 'kWh',
        schemaVersion: 1,
        fields: { capacity_kwh: 'number', available_kwh: 'number', reserved_kwh: 'number' },
      },
    ],
    verification: {
      checks: ['device_signature', 'timestamp_window', 'replay_protection', 'schema_validation', 'numeric_range'],
      numeric_ranges: {
        power_kw: { min: 0, max: 1000 },
        state_of_charge_pct: { min: 0, max: 100 },
        frequency_hz: { min: 49.5, max: 50.5 },
        response_kw: { min: 0, max: 1000 },
        capacity_kwh: { min: 0, max: 10000 },
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
  // -------------------------------------------------------------------------
  // compute-gpu-network — Phase 8: first non-energy vertical.
  // Proves the architecture is a Network Operating System, not a VPP app.
  // GPU nodes execute compute jobs; GPU-hours delivered becomes a Contribution
  // rewarded at a fixed rate. Uses the SAME generic pipeline as energy-vpp.
  //
  // Phase 8B: Split into GPU-only and CPU-only templates to avoid the
  // reward-unit mismatch (GPU-hours vs CPU-hours). Each template has a
  // single capability whose unit matches the reward policy unit.
  // -------------------------------------------------------------------------
  {
    key: 'compute-gpu-network',
    name: 'Compute GPU Network',
    slug: 'compute-gpu-network',
    vertical: 'compute',
    description:
      'Decentralized GPU compute network. GPU nodes execute compute jobs; GPU-hours delivered becomes a Contribution rewarded at a fixed rate. Uses only generic platform primitives — the same kernel, runtime, and economic pipeline as energy-vpp.',
    asset_types: ['compute_node', 'gpu_cluster'],
    capabilities: [
      {
        type: 'gpu_compute',
        unit: 'GPU-hours',
        schemaVersion: 1,
        fields: { gpu_count: 'number', gpu_utilization_pct: 'number', memory_gb: 'number', duration_seconds: 'number' },
      },
    ],
    verification: {
      checks: ['device_signature', 'timestamp_window', 'replay_protection', 'schema_validation', 'numeric_range'],
      numeric_ranges: {
        gpu_count: { min: 0, max: 1000 },
        gpu_utilization_pct: { min: 0, max: 100 },
        memory_gb: { min: 0, max: 100000 },
      },
      timestamp_window_seconds: 300,
    },
    reward: {
      type: 'fixed_rate',
      rate: '0.50',
      unit: 'GPU-hours',
      currency: 'USD',
      platform_fee_pct: 10,
    },
  },
  // -------------------------------------------------------------------------
  // compute-cpu-network — Phase 8B: CPU compute network.
  // Separate template because CPU-hours and GPU-hours are different units.
  // Each capability's unit matches its reward policy unit.
  // -------------------------------------------------------------------------
  {
    key: 'compute-cpu-network',
    name: 'Compute CPU Network',
    slug: 'compute-cpu-network',
    vertical: 'compute',
    description:
      'Decentralized CPU compute network. CPU nodes execute compute jobs; CPU-hours delivered becomes a Contribution rewarded at a fixed rate. Uses only generic platform primitives.',
    asset_types: ['compute_node'],
    capabilities: [
      {
        type: 'cpu_compute',
        unit: 'CPU-hours',
        schemaVersion: 1,
        fields: { cpu_cores: 'number', cpu_utilization_pct: 'number', memory_gb: 'number', duration_seconds: 'number' },
      },
    ],
    verification: {
      checks: ['device_signature', 'timestamp_window', 'replay_protection', 'schema_validation', 'numeric_range'],
      numeric_ranges: {
        cpu_cores: { min: 0, max: 10000 },
        cpu_utilization_pct: { min: 0, max: 100 },
        memory_gb: { min: 0, max: 100000 },
      },
      timestamp_window_seconds: 300,
    },
    reward: {
      type: 'fixed_rate',
      rate: '0.10',
      unit: 'CPU-hours',
      currency: 'USD',
      platform_fee_pct: 10,
    },
  },
  // -------------------------------------------------------------------------
  // protocol-network — Phase 9A: first protocol runtime reference.
  // Proves the protocol runtime contract: deterministic state transitions
  // via ProtocolRuntime (not infrastructure execution).
  // runtimeKind = 'protocol' → resolves to ProtocolRuntime via RuntimeRegistry.
  // -------------------------------------------------------------------------
  {
    key: 'protocol-network',
    name: 'Protocol Network',
    slug: 'protocol-network',
    vertical: 'protocol',
    description:
      'A protocol-based network that operates via deterministic state transitions. Transactions are validated and executed against a versioned state store, producing execution receipts. Uses the ProtocolRuntime (runtimeKind=protocol), not the InfrastructureRuntime.',
    asset_types: ['validator_node'],
    capabilities: [
      {
        type: 'protocol_transaction',
        unit: 'transactions',
        schemaVersion: 1,
        fields: { transaction_count: 'number', state_transitions: 'number' },
      },
    ],
    verification: {
      checks: ['device_signature', 'timestamp_window', 'replay_protection', 'schema_validation'],
      timestamp_window_seconds: 300,
    },
    reward: {
      type: 'fixed_rate',
      rate: '0.01',
      unit: 'transactions',
      currency: 'USD',
      platform_fee_pct: 5,
    },
    runtimeKind: 'protocol',
  },
]

export function getTemplate(key: string): NetworkTemplate | undefined {
  return NETWORK_TEMPLATES.find((t) => t.key === key)
}
