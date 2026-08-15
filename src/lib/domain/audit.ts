// =============================================================================
// Audit service. Append-only, application-immutable. Every state-changing
// operation must emit an audit event.
// =============================================================================

import { db, type ExtendedTransactionClient } from '@/lib/db'

export const AuditEvents = {
  TenantCreated: 'tenant.created',
  NetworkCreated: 'network.created',
  NetworkPublished: 'network.published',
  OperatorCreated: 'operator.created',
  AssetCreated: 'asset.created',
  DeviceProvisioned: 'device.provisioned',
  DeviceActivated: 'device.activated',
  DeviceSuspended: 'device.suspended',
  EventReceived: 'event.received',
  VerificationCompleted: 'verification.completed',
  AttestationCreated: 'attestation.created',
  ContributionCreated: 'contribution.created',
  RewardCreated: 'reward.created',
  LedgerPosted: 'ledger.posted',
  SettlementCreated: 'settlement.created',
  SettlementCompleted: 'settlement.completed',
  TenantSwitched: 'tenant.switched',
  TemplateInstantiated: 'template.instantiated',
  WaitlistApproved: 'waitlist.approved',
  UserLogin: 'user.login',
  AssetAssignedToNetwork: 'asset.assigned_to_network',
  SettlementFailed: 'settlement.failed',
  PortfolioReservationCreated: 'portfolio.reservation_created',
  PortfolioCommitmentCreated: 'vpp.portfolio_commitment_created',
  PortfolioCommitmentEvaluated: 'vpp.portfolio_commitment_evaluated',
} as const

export type AuditEventType = (typeof AuditEvents)[keyof typeof AuditEvents]

export interface AuditInput {
  tenantId: string
  actorId?: string | null
  eventType: AuditEventType | string
  resourceType: string
  resourceId: string
  metadata?: Record<string, unknown>
  /**
   * Optional transaction client. When provided, the audit row is written
   * INSIDE the caller's transaction, so it commits/rolls back atomically
   * with the main operation. This is required for critical immutable
   * transitions (e.g. NetworkVersion publication) where the audit record
   * MUST NOT be missing if the operation committed.
   *
   * When a tx is passed, audit failures are NOT swallowed — a failure
   * rolls back the entire transaction (the atomicity guarantee).
   */
  tx?: ExtendedTransactionClient
}

/**
 * Append an audit record.
 *
 * WITHOUT a tx (default): best-effort, non-failing. An audit error is logged
 * but never breaks the primary operation. Use this for ordinary side-effect
 * auditing where a missing audit row is tolerable.
 *
 * WITH a tx: the audit row is written inside the caller's transaction and
 * commits/rolls back atomically. A failure throws and rolls back the whole
 * transaction — use this for critical immutable transitions (publication,
 * settlement) where the audit record is part of the atomic operation.
 */
export async function appendAudit(input: AuditInput): Promise<void> {
  // When a transaction client is provided, the audit row MUST commit
  // atomically with the main operation. Do not swallow errors — let them
  // propagate so the transaction rolls back.
  if (input.tx) {
    await input.tx.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actorId: input.actorId ?? null,
        eventType: input.eventType,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        metadataJson: JSON.stringify(input.metadata ?? {}),
      },
    })
    return
  }

  // No tx: best-effort at the application layer; surface but never throw.
  try {
    await db.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actorId: input.actorId ?? null,
        eventType: input.eventType,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        metadataJson: JSON.stringify(input.metadata ?? {}),
      },
    })
  } catch (err) {
    // Audit is best-effort at the application layer; surface but never throw.
    console.error('[audit] failed to append', input.eventType, err)
  }
}
