// =============================================================================
// Kernel: Hybrid Runtime (Phase 10)
// =============================================================================
// The HybridRuntime bridges two isolated runtime worlds:
//
//   InfrastructureRuntime → physical execution → telemetry → contribution
//   ProtocolRuntime → transactions → state transitions → finality
//
// ARCHITECTURAL RULES (frozen from Phase 9C):
//   1. Infrastructure execution can create protocol state transitions
//      WITHOUT importing infrastructure concepts into the protocol runtime.
//   2. Protocol decisions can trigger infrastructure work WITHOUT coupling
//      consensus to adapters.
//   3. Contribution/reward calculations remain generic primitives.
//   4. A new vertical can still plug in without kernel modification.
//
// THE BRIDGE:
//   The hybrid runtime owns a "HybridBridge" — a set of converter functions
//   that translate between the two worlds:
//     - infrastructureExecutionResult → protocolTransaction (bridge up)
//     - protocolState → infrastructureParameters (bridge down)
//
//   The bridge is the ONLY place that knows about both worlds. Neither
//   InfrastructureRuntime nor ProtocolRuntime imports the other.
//
// DEPENDENCY INJECTION:
//   The hybrid runtime receives both an InfrastructureRuntime and a
//   ProtocolRuntime as constructor parameters. It does NOT construct them.
//   The bootstrap owns construction.
// =============================================================================

import type {
  NetworkRuntime,
  RuntimeAssignmentResults,
  RuntimeClient,
  RuntimeCreateAssignmentInput,
  RuntimeCreateExecutionInput,
  RuntimeExecuteInput,
  RuntimeExecuteResult,
} from './types'
import type { InfrastructureRuntime } from './infrastructure-runtime'
import type { ProtocolRuntime } from './protocol-runtime'
import type {
  ProtocolTransaction,
  ProtocolExecutionResult,
} from './protocol/types'
import { computeTransactionId } from './protocol/executor'

// ---------------------------------------------------------------------------
// Hybrid Bridge — the only place that knows about both worlds
// ---------------------------------------------------------------------------

/**
 * A bridge that converts infrastructure execution results into protocol
 * transactions (bridge UP: infrastructure → protocol).
 *
 * This is the mechanism by which physical infrastructure work creates
 * protocol state transitions. The bridge is a PURE CONVERTER — it does
 * not execute anything. It takes an infrastructure result and produces
 * a protocol transaction that the protocol runtime can execute.
 *
 * ARCHITECTURAL RULE: The bridge does NOT import adapters, consensus, or
 * state stores. It receives data and produces data.
 */
export interface HybridBridge {
  /**
   * Convert an infrastructure execution result into a protocol transaction.
   *
   * The protocol transaction records what happened in the infrastructure
   * world as a deterministic state transition. For example, a GPU job
   * that delivered 9.5 GPU-hours becomes a protocol transaction that
   * updates a 'gpu-hours-delivered' balance in the protocol state.
   *
   * @param executionResult The result from InfrastructureRuntime.executeAssignment.
   * @param networkVersionId The network version for protocol isolation.
   * @param sender The sender identity for the protocol transaction.
   * @param nonce The sender's current nonce.
   * @returns A protocol transaction ready for the protocol runtime.
   */
  infrastructureResultToTransaction(
    executionResult: RuntimeExecuteResult,
    networkVersionId: string,
    sender: string,
    nonce: number,
  ): ProtocolTransaction
}

// ---------------------------------------------------------------------------
// DefaultHybridBridge — a reference implementation
// ---------------------------------------------------------------------------

/**
 * A reference HybridBridge that converts infrastructure execution results
 * into 'record_delivery' protocol transactions.
 *
 * The protocol transaction payload is:
 *   { type: 'record_delivery', data: { quantity, unit, assetId, telemetry } }
 *
 * The protocol state stores the delivered quantity as a balance:
 *   'delivery:<assetId>' → cumulative quantity
 *
 * This is deliberately simple — it proves the bridge works without
 * defining a specific hybrid application semantics.
 */
export class DefaultHybridBridge implements HybridBridge {
  infrastructureResultToTransaction(
    executionResult: RuntimeExecuteResult,
    networkVersionId: string,
    sender: string,
    nonce: number,
  ): ProtocolTransaction {
    const payload = {
      type: 'record_delivery',
      data: {
        quantity: executionResult.actualQuantity,
        unit: executionResult.actualUnit,
        success: executionResult.success,
      },
    }

    const id = computeTransactionId(networkVersionId, sender, nonce, payload)

    return {
      id,
      networkVersionId,
      sender,
      nonce,
      payload: { type: payload.type, data: payload.data },
      signature: 'hybrid-bridge-signature',
      submittedAt: new Date('2024-01-01T00:00:00Z'), // deterministic
    }
  }
}

// ---------------------------------------------------------------------------
// HybridRuntimeDeps — dependencies injected into HybridRuntime
// ---------------------------------------------------------------------------

/**
 * The dependencies injected into HybridRuntime.
 *
 * The hybrid runtime receives BOTH an InfrastructureRuntime and a
 * ProtocolRuntime, plus a HybridBridge. It does NOT construct any of them.
 */
export interface HybridRuntimeDeps {
  infrastructureRuntime: InfrastructureRuntime
  protocolRuntime: ProtocolRuntime
  bridge: HybridBridge
  /** The sender identity for protocol transactions created by the bridge. */
  protocolSender: string
}

// ---------------------------------------------------------------------------
// HybridRuntime
// ---------------------------------------------------------------------------

/**
 * The runtime implementation for runtimeKind = 'hybrid'.
 *
 * Phase 10: Bridges infrastructure execution and protocol state transitions.
 *
 * The hybrid runtime implements the NetworkRuntime interface (infrastructure-
 * shaped methods) by delegating to the InfrastructureRuntime. It adds a
 * hybrid-specific method, `executeHybrid()`, that:
 *   1. Executes physical work via InfrastructureRuntime
 *   2. Converts the result to a protocol transaction via the bridge
 *   3. Executes the protocol transaction via ProtocolRuntime
 *
 * ARCHITECTURAL ISOLATION:
 *   - InfrastructureRuntime does NOT know about ProtocolRuntime.
 *   - ProtocolRuntime does NOT know about InfrastructureRuntime.
 *   - The bridge is the ONLY place that converts between them.
 *   - Neither runtime imports the other's types.
 */
export class HybridRuntime implements NetworkRuntime {
  readonly kind = 'hybrid' as const

  constructor(private readonly deps: HybridRuntimeDeps) {}

  /**
   * @returns The protocol runtime (for direct protocol operations).
   */
  get protocol() {
    return this.deps.protocolRuntime
  }

  /**
   * @returns The infrastructure runtime (for direct infrastructure operations).
   */
  get infrastructure() {
    return this.deps.infrastructureRuntime
  }

  // -------------------------------------------------------------------------
  // Hybrid-specific entry point
  // -------------------------------------------------------------------------

  /**
   * Execute a hybrid assignment:
   *   1. Execute physical work via InfrastructureRuntime.executeAssignment
   *   2. Convert the result to a protocol transaction via the bridge
   *   3. Execute the protocol transaction via ProtocolRuntime.executeTransaction
   *
   * This proves the two worlds can interact WITHOUT coupling:
   *   - Infrastructure produces telemetry/actuals.
   *   - The bridge converts them to a protocol transaction.
   *   - Protocol executes the transaction deterministically.
   *
   * @param input The infrastructure execution input.
   * @param currentNonce The sender's current protocol nonce.
   * @returns Both the infrastructure result and the protocol execution result.
   */
  async executeHybrid(
    input: RuntimeExecuteInput,
    currentNonce: number,
  ): Promise<{
    infrastructureResult: RuntimeExecuteResult
    protocolResult: ProtocolExecutionResult
  }> {
    // 1. Execute physical work via the infrastructure runtime.
    const infrastructureResult = await this.deps.infrastructureRuntime.executeAssignment(input)

    // 2. Convert the result to a protocol transaction via the bridge.
    const transaction = this.deps.bridge.infrastructureResultToTransaction(
      infrastructureResult,
      this.deps.protocolRuntime.stateStore.networkVersionId,
      this.deps.protocolSender,
      currentNonce,
    )

    // 3. Execute the protocol transaction via the protocol runtime.
    const protocolResult = await this.deps.protocolRuntime.executeTransaction(transaction)

    return { infrastructureResult, protocolResult }
  }

  // -------------------------------------------------------------------------
  // NetworkRuntime interface (delegates to InfrastructureRuntime)
  // -------------------------------------------------------------------------

  async createExecution(
    tx: RuntimeClient,
    input: RuntimeCreateExecutionInput,
  ): Promise<{ id: string }> {
    return this.deps.infrastructureRuntime.createExecution(tx, input)
  }

  async linkExecutionSource(
    tx: RuntimeClient,
    executionId: string,
    sourceId: string,
  ): Promise<void> {
    await this.deps.infrastructureRuntime.linkExecutionSource(tx, executionId, sourceId)
  }

  async createExecutionAssignment(
    tx: RuntimeClient,
    input: RuntimeCreateAssignmentInput,
  ): Promise<{ id: string }> {
    return this.deps.infrastructureRuntime.createExecutionAssignment(tx, input)
  }

  async beginAssignmentExecution(
    tx: RuntimeClient,
    executionId: string,
    executionAssignmentId: string,
  ): Promise<void> {
    await this.deps.infrastructureRuntime.beginAssignmentExecution(tx, executionId, executionAssignmentId)
  }

  async executeAssignment(
    input: RuntimeExecuteInput,
  ): Promise<RuntimeExecuteResult> {
    return this.deps.infrastructureRuntime.executeAssignment(input)
  }

  async recordAssignmentResults(
    tx: RuntimeClient,
    executionAssignmentId: string,
    results: RuntimeAssignmentResults,
  ): Promise<void> {
    await this.deps.infrastructureRuntime.recordAssignmentResults(tx, executionAssignmentId, results)
  }

  async linkContribution(
    tx: RuntimeClient,
    executionAssignmentId: string,
    contributionId: string,
  ): Promise<void> {
    await this.deps.infrastructureRuntime.linkContribution(tx, executionAssignmentId, contributionId)
  }

  async completeAssignment(
    tx: RuntimeClient,
    tenantId: string,
    executionAssignmentId: string,
    executionId: string,
  ): Promise<void> {
    await this.deps.infrastructureRuntime.completeAssignment(tx, tenantId, executionAssignmentId, executionId)
  }

  async failAssignment(
    tx: RuntimeClient,
    tenantId: string,
    executionAssignmentId: string,
    executionId: string,
  ): Promise<void> {
    await this.deps.infrastructureRuntime.failAssignment(tx, tenantId, executionAssignmentId, executionId)
  }

  async finalizeIfTerminal(
    tx: RuntimeClient,
    tenantId: string,
    executionId: string,
  ): Promise<string | null> {
    return this.deps.infrastructureRuntime.finalizeIfTerminal(tx, tenantId, executionId)
  }
}
