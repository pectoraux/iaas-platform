// =============================================================================
// Audit service. Append-only, application-immutable. Every state-changing
// operation must emit an audit event.
// =============================================================================

import { db } from '@/lib/db'

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
} as const

export type AuditEventType = (typeof AuditEvents)[keyof typeof AuditEvents]

export interface AuditInput {
  tenantId: string
  actorId?: string | null
  eventType: AuditEventType | string
  resourceType: string
  resourceId: string
  metadata?: Record<string, unknown>
}

/**
 * Append an audit record. Non-failing: an audit error must never break the
 * primary operation. We log and continue.
 */
export async function appendAudit(input: AuditInput): Promise<void> {
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
