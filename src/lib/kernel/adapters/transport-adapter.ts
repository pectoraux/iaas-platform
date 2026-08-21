// =============================================================================
// Kernel: Generic Transport Adapter Interface (Phase 14D)
// =============================================================================
// The top-level abstraction for data-plane transport execution. This is the
// boundary that future network implementations (DTN, TransitNet, Local-first
// Internet, Cloudlet) plug into.
//
// DISTINCTION from InfrastructureAdapter:
//   - InfrastructureAdapter (Phase 4) is for PHYSICAL INFRASTRUCTURE execution
//     (discover/readTelemetry/execute/health on assets like batteries/GPUs).
//   - TransportAdapter (Phase 14D) is for DATA-PLANE TRANSPORT execution
//     (executeTransportAttempt/getCapabilities/validate on Bundles along Routes).
//
// The TransportAdapter contract:
//   - executeTransportAttempt(): attempt to move a Bundle along one hop
//   - getCapabilities(): what transport capabilities this adapter supports
//   - validate(): validate that an attempt is executable by this adapter
//
// Future network implementations implement this:
//   - DTNTransportAdapter → store-carry-forward
//   - TransitNetTransportAdapter → vehicle-to-vehicle
//   - CloudletTransportAdapter → edge relay
//   - LocalInternetTransportAdapter → local-first delivery
//
// ARCHITECTURAL RULE:
//   Bundle → Route → TransportExecution → TransportAdapter
//
// The TransportAdapter NEVER:
//   - makes routing decisions (routing is Phase 14C — already decided)
//   - modifies Bundle identity/payload (T2)
//   - modifies Route (T3)
//   - creates Nodes (T8)
//   - touches the economic kernel (economics is a separate substrate)
//
// A mock/null adapter is acceptable for Phase 14D. No TCP/UDP/sockets/network
// calls are made — the adapter records execution STATE, not network behavior.
// =============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The input to a transport attempt execution. The adapter receives this and
 * attempts to move the Bundle from fromNodeId to toNodeId.
 *
 * This is transport-neutral: no TCP/UDP/Bluetooth/WiFi/satellite fields.
 */
export interface TransportAttemptInput {
  /** The TransportExecution this attempt belongs to. */
  executionId: string
  /** The Bundle being moved (reference only — adapter must NOT modify it). */
  bundleId: string
  /** The Route being executed (reference only — adapter must NOT modify it). */
  routeId: string
  /** The hop source Node. */
  fromNodeId: string
  /** The hop destination Node. */
  toNodeId: string
  /** The attempt number within this execution (1-based). */
  attemptNumber: number
}

/**
 * The result of a transport attempt execution.
 */
export interface TransportAttemptResult {
  /** Whether the attempt succeeded. */
  success: boolean
  /** The resulting attempt status. */
  status: 'sent' | 'acknowledged' | 'failed'
  /** Error code if failed. */
  errorCode?: string
  /** Optional diagnostic metadata. */
  metadata?: Record<string, unknown>
}

/**
 * The capabilities a transport adapter supports. Generic, NOT
 * transport-protocol-specific.
 */
export interface TransportAdapterCapabilities {
  /** Adapter type identifier (e.g., 'mock_transport', 'dtn_transport'). */
  adapterType: string
  /** Generic capabilities this adapter supports. */
  capabilities: string[] // STORE_AND_FORWARD | BUNDLE_TRANSFER | TRANSPORT_EXECUTION | generic
  /** Whether the adapter supports cancellation of in-flight attempts. */
  supportsCancellation: boolean
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Generic transport adapter interface.
 *
 * Future network implementations implement this to plug into the transport
 * execution layer:
 *   - DTNTransportAdapter → store-carry-forward
 *   - TransitNetTransportAdapter → vehicle-to-vehicle
 *   - CloudletTransportAdapter → edge relay
 *
 * The adapter NEVER makes routing decisions (routing is Phase 14C). It
 * executes transport attempts along already-decided Routes.
 *
 * The adapter NEVER modifies Bundle identity/payload (T2) or Route (T3).
 * It records execution STATE, not network behavior.
 */
export interface TransportAdapter {
  /** Adapter type identifier (e.g., 'mock_transport', 'dtn_transport'). */
  readonly adapterType: string

  /**
   * Execute a transport attempt. The adapter attempts to move the Bundle
   * from fromNodeId to toNodeId.
   *
   * Returns the result (success/failure + status). Does NOT throw on
   * transport failure — returns a failed result so the caller can record
   * the attempt and decide whether to retry.
   */
  executeTransportAttempt(input: TransportAttemptInput): Promise<TransportAttemptResult>

  /**
   * Get the capabilities this adapter supports. Generic, NOT
   * transport-protocol-specific.
   */
  getCapabilities(): Promise<TransportAdapterCapabilities>

  /**
   * Validate that an attempt is executable by this adapter. Returns true
   * if the adapter can attempt this transport, false otherwise.
   *
   * This is a pre-flight check — it does NOT execute the attempt.
   */
  validate(input: TransportAttemptInput): Promise<boolean>
}

// ---------------------------------------------------------------------------
// MockTransportAdapter — a null/mock implementation for Phase 14D
// ---------------------------------------------------------------------------

/**
 * A mock transport adapter for Phase 14D. It always succeeds (or always
 * fails if configured). No TCP/UDP/sockets/network calls are made — it
 * records execution STATE only.
 *
 * Future network implementations will provide real TransportAdapter
 * implementations. This mock proves the contract is usable.
 */
export class MockTransportAdapter implements TransportAdapter {
  readonly adapterType = 'mock_transport'
  private readonly failMode: boolean

  constructor(opts: { failMode?: boolean } = {}) {
    this.failMode = opts.failMode ?? false
  }

  async executeTransportAttempt(
    _input: TransportAttemptInput,
  ): Promise<TransportAttemptResult> {
    if (this.failMode) {
      return {
        success: false,
        status: 'failed',
        errorCode: 'MOCK_FAILURE',
        metadata: { reason: 'mock adapter configured to fail' },
      }
    }
    return {
      success: true,
      status: 'acknowledged',
      metadata: { reason: 'mock adapter always succeeds' },
    }
  }

  async getCapabilities(): Promise<TransportAdapterCapabilities> {
    return {
      adapterType: this.adapterType,
      capabilities: ['STORE_AND_FORWARD', 'BUNDLE_TRANSFER', 'TRANSPORT_EXECUTION'],
      supportsCancellation: true,
    }
  }

  async validate(_input: TransportAttemptInput): Promise<boolean> {
    return true
  }
}
