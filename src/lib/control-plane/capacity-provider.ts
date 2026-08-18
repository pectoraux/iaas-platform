// =============================================================================
// Control Plane: Capacity Provider Boundary (Phase 12B Slice 2 fix)
// =============================================================================
// The universal ResourceIdentity abstraction must NOT collapse back into
// Asset at the control-plane-to-kernel boundary. The existing CapacityService
// expects an assetId, but future resources (storage nodes, fiber links,
// industrial robots, human work units, validators) have no Asset record.
//
// This boundary abstracts the capacity source: the control plane asks a
// CapacityProvider to create a reservation, and the provider knows how to
// translate the universal ResourceIdentity into the existing capacity
// primitive (or a future one).
//
// The FIRST provider is AssetCapacityProvider, which handles today's VPP and
// Compute resources by mapping ResourceIdentity → Asset. Future providers
// (StorageCapacityProvider, etc.) will map to the same capacity primitive
// without going through Asset.
// =============================================================================

import type { ExtendedTransactionClient } from '@/lib/db'

/**
 * The result of creating a capacity reservation through a provider.
 */
export interface CapacityReservationResult {
  reservationId: string
  capabilityType: string
  unit: string
  allocatedAmount: string
}

/**
 * A capacity provider creates reservations for a specific resource kind.
 *
 * The control plane calls this interface — it does NOT call the existing
 * CapacityService directly with a raw assetId. The provider translates the
 * universal ResourceIdentity into the appropriate capacity primitive.
 *
 * ARCHITECTURAL RULE: the control plane never passes ResourceIdentity.id
 * as an assetId to the existing CapacityService. The provider decides how
 * to bridge to the capacity layer.
 *
 * PHASE 12B SLICE 3: the provider is ALSO the boundary for resolving the
 * kernel-level execution binding (assetId + operatorId) needed to create
 * an ExecutionAssignment. The control plane does NOT read the Asset table
 * directly — that would collapse ResourceIdentity back into Asset. The
 * provider, which already owns the resourceId → assetId translation for
 * capacity, also owns it for execution assignment creation. This keeps the
 * "Resource/Capacity provider → kernel execution assignment" boundary
 * authoritative for BOTH capacity and execution.
 */
export interface CapacityProvider {
  /**
   * Create a capacity reservation for a resource within a transaction.
   *
   * @param resourceId — the ResourceIdentity ID (NOT an assetId)
   * @param networkId — the network scope
   * @param tenantId — the tenant
   * @param capabilityType — what capability to reserve
   * @param amount — how much to reserve
   * @param unit — the unit
   * @param startTime — window start
   * @param endTime — window end
   * @param sourceType — the control-plane source type ('network_request')
   * @param sourceId — the request/decision ID (for idempotency)
   * @param tx — the transaction client (for atomic reservation)
   * @returns the reservation result
   */
  createReservation(input: {
    resourceId: string
    networkId: string
    tenantId: string
    capabilityType: string
    amount: string
    unit: string
    startTime: Date
    endTime: Date
    sourceType: string
    sourceId: string
    tx: ExtendedTransactionClient
  }): Promise<CapacityReservationResult>

  /**
   * Resolve the kernel-level execution binding for a resource.
   *
   * Phase 12B Slice 3: the control-plane orchestrator needs `assetId` +
   * `operatorId` to call `runtime.createExecutionAssignment(...)`. These are
   * kernel-level concepts that live on the Asset table, but the control plane
   * must NOT read the Asset table directly (that would collapse
   * ResourceIdentity → Asset). The provider, which already owns the
   * resourceId → assetId translation for capacity, also owns it for execution.
   *
   * For a future non-Asset-backed resource kind (storage, connectivity,
   * industrial, human, protocol), a different provider would return a different
   * binding shape — but for Slice 3, only Asset-backed resources are supported.
   *
   * @param resourceId — the ResourceIdentity ID
   * @param tx — the transaction client (so the read is consistent with the
   *   orchestrator's atomic transaction)
   * @returns the assetId + operatorId for ExecutionAssignment creation
   */
  resolveExecutionBinding(input: {
    resourceId: string
    tx: ExtendedTransactionClient
  }): Promise<{ assetId: string; operatorId: string }>
}

/**
 * The Asset-backed capacity provider. Maps ResourceIdentity → Asset for
 * the existing CapacityService. This is the first and currently only
 * provider, handling VPP (physical) and Compute resources.
 *
 * PHASE 12B: for resources whose ResourceIdentity was created from an
 * existing Asset (the backward-compatible migration), the resource's
 * metadata contains `assetId` — the original Asset ID. This provider
 * reads that metadata and passes it to the existing CapacityService.
 *
 * For future resource kinds (storage, connectivity, industrial, human,
 * protocol), a different provider will be registered that does NOT go
 * through Asset.
 */
export class AssetCapacityProvider implements CapacityProvider {
  async createReservation(input: {
    resourceId: string
    networkId: string
    tenantId: string
    capabilityType: string
    amount: string
    unit: string
    startTime: Date
    endTime: Date
    sourceType: string
    sourceId: string
    tx: ExtendedTransactionClient
  }): Promise<CapacityReservationResult> {
    // Import here to avoid circular dependency at module load time.
    const { createCapacityReservation } = await import('@/lib/services/capacity.service')

    // Look up the ResourceIdentity to find the original assetId.
    // For backward-compatible resources, metadataJson contains {"assetId": "..."}.
    // For new universal resources, this provider is not the right one.
    const resource = await input.tx.resourceIdentity.findUnique({
      where: { id: input.resourceId },
    })

    if (!resource) {
      throw new Error(
        `AssetCapacityProvider: ResourceIdentity '${input.resourceId}' not found`,
      )
    }

    // Parse metadata to find the assetId mapping.
    const metadata = JSON.parse(resource.metadataJson || '{}') as Record<string, unknown>
    const assetId = metadata.assetId as string | undefined

    if (!assetId) {
      throw new Error(
        `AssetCapacityProvider: ResourceIdentity '${input.resourceId}' has no assetId in metadata. ` +
          `This resource is not Asset-backed — a different CapacityProvider is required.`,
      )
    }

    // Each capability gets a distinct sourceId to prevent the capacity service's
    // idempotency from collapsing multiple capabilities into one reservation.
    const sourceId = `${input.sourceId}:${input.capabilityType}`

    const result = await createCapacityReservation({
      tenantId: input.tenantId,
      assetId,
      networkId: input.networkId,
      capabilityType: input.capabilityType,
      requestedAmount: input.amount,
      startTime: input.startTime,
      endTime: input.endTime,
      sourceType: input.sourceType,
      sourceId,
    }, input.tx)

    return {
      reservationId: result.reservationId,
      capabilityType: input.capabilityType,
      unit: input.unit,
      allocatedAmount: input.amount,
    }
  }

  /**
   * Phase 12B Slice 3: resolve the kernel-level execution binding for a resource.
   *
   * Reads ResourceIdentity.metadataJson.assetId (the backward-compatible
   * mapping set when the resource was created from an Asset), then reads the
   * Asset to get its operatorId. The control-plane orchestrator uses these two
   * values to call `runtime.createExecutionAssignment(...)`.
   *
   * This keeps the resource→kernel translation entirely behind the provider
   * boundary — the orchestrator never touches the Asset table directly.
   */
  async resolveExecutionBinding(input: {
    resourceId: string
    tx: ExtendedTransactionClient
  }): Promise<{ assetId: string; operatorId: string }> {
    const resource = await input.tx.resourceIdentity.findUnique({
      where: { id: input.resourceId },
    })

    if (!resource) {
      throw new Error(
        `AssetCapacityProvider.resolveExecutionBinding: ResourceIdentity '${input.resourceId}' not found`,
      )
    }

    const metadata = JSON.parse(resource.metadataJson || '{}') as Record<string, unknown>
    const assetId = metadata.assetId as string | undefined

    if (!assetId) {
      throw new Error(
        `AssetCapacityProvider.resolveExecutionBinding: ResourceIdentity '${input.resourceId}' has no assetId in metadata. ` +
          `This resource is not Asset-backed — a different CapacityProvider is required.`,
      )
    }

    const asset = await input.tx.asset.findUnique({
      where: { id: assetId },
      select: { id: true, operatorId: true },
    })

    if (!asset) {
      throw new Error(
        `AssetCapacityProvider.resolveExecutionBinding: Asset '${assetId}' (referenced by ResourceIdentity '${input.resourceId}') not found`,
      )
    }

    return { assetId: asset.id, operatorId: asset.operatorId }
  }
}

/**
 * Registry of capacity providers by resource kind.
 * The control plane looks up the provider based on the selected resource's kind.
 */
export class CapacityProviderRegistry {
  private readonly providers = new Map<string, CapacityProvider>()

  register(resourceKind: string, provider: CapacityProvider): void {
    if (this.providers.has(resourceKind)) {
      throw new Error(`CapacityProvider already registered for kind '${resourceKind}'`)
    }
    this.providers.set(resourceKind, provider)
  }

  resolve(resourceKind: string): CapacityProvider {
    const provider = this.providers.get(resourceKind)
    if (!provider) {
      throw new Error(
        `No CapacityProvider registered for resourceKind '${resourceKind}'. ` +
          `Registered kinds: ${Array.from(this.providers.keys()).join(', ')}.`,
      )
    }
    return provider
  }
}

/**
 * The default registry, pre-populated with the AssetCapacityProvider for
 * physical and compute resources. Future slices will add providers for
 * storage, connectivity, industrial, human, and protocol resources.
 */
export function createDefaultCapacityProviderRegistry(): CapacityProviderRegistry {
  const registry = new CapacityProviderRegistry()
  const assetProvider = new AssetCapacityProvider()
  registry.register('physical', assetProvider)
  registry.register('compute', assetProvider)
  // Future: registry.register('storage', new StorageCapacityProvider())
  // Future: registry.register('connectivity', new ConnectivityCapacityProvider())
  // etc.
  return registry
}
