// =============================================================================
// PaymentsService abstraction.
//
// Rule 5: PaySwap is a settlement provider, not the internal accounting system.
// The rest of the platform depends ONLY on this interface. A PaySwap adapter
// (or a sandbox/mock adapter) sits behind it. Reward and Ledger services never
// import PaySwap directly.
//
//   Reward → Ledger → Settlement Instruction → PaymentsService → PaySwap
// =============================================================================

export interface PayoutRequest {
  idempotency_key: string
  recipient_ref: string // operator id (would map to a PaySwap recipient in prod)
  amount: number
  currency: string
  reference: string
}

export interface PayoutResult {
  provider_payout_id: string
  status: 'submitted' | 'processing' | 'completed' | 'failed'
  raw?: unknown
}

export interface PayoutStatus {
  provider_payout_id: string
  status: 'submitted' | 'processing' | 'completed' | 'failed'
  failure_reason?: string
  raw?: unknown
}

/**
 * The payments interface. Swappable: PaySwap sandbox, Stripe, mock, etc.
 */
export interface PaymentsService {
  readonly provider: string
  create_payout(req: PayoutRequest): Promise<PayoutResult>
  get_payout(provider_payout_id: string): Promise<PayoutStatus>
  handle_webhook(payload: unknown): Promise<{ payout_id: string; status: PayoutStatus['status'] }>
  reconcile(provider_payout_id: string): Promise<PayoutStatus>
}

// ---------------------------------------------------------------------------
// Mock / sandbox PaySwap adapter.
//
// Simulates a payout provider with deterministic completion. In sandbox mode,
// payouts complete immediately (configurable). This lets the full E2E flow run
// without external dependencies.
// ---------------------------------------------------------------------------

const SANDBOX_PAYOUTS = new Map<string, PayoutStatus & { request: PayoutRequest }>()

export class PaySwapSandboxAdapter implements PaymentsService {
  readonly provider = 'payswap_sandbox'
  constructor(private opts: { autoComplete?: boolean } = { autoComplete: true }) {}

  async create_payout(req: PayoutRequest): Promise<PayoutResult> {
    // Idempotency handled at the settlement layer; here we simulate provider
    // idempotency by keying on recipient_ref + amount + reference.
    const providerPayoutId = `psp_${sha(req.idempotency_key)}`
    const status: PayoutStatus['status'] = this.opts.autoComplete ? 'completed' : 'submitted'
    SANDBOX_PAYOUTS.set(providerPayoutId, {
      provider_payout_id: providerPayoutId,
      status,
      raw: { recipient_ref: req.recipient_ref, amount: req.amount, currency: req.currency },
      request: req,
    })
    return { provider_payout_id: providerPayoutId, status, raw: { sandbox: true } }
  }

  async get_payout(provider_payout_id: string): Promise<PayoutStatus> {
    const p = SANDBOX_PAYOUTS.get(provider_payout_id)
    if (!p) return { provider_payout_id, status: 'failed', failure_reason: 'not found' }
    return { provider_payout_id: p.provider_payout_id, status: p.status, raw: p.raw }
  }

  async handle_webhook(payload: unknown): Promise<{ payout_id: string; status: PayoutStatus['status'] }> {
    const p = payload as { provider_payout_id: string; status: PayoutStatus['status'] }
    const existing = SANDBOX_PAYOUTS.get(p.provider_payout_id)
    if (existing) {
      existing.status = p.status
    }
    return { payout_id: p.provider_payout_id, status: p.status }
  }

  async reconcile(provider_payout_id: string): Promise<PayoutStatus> {
    return this.get_payout(provider_payout_id)
  }
}

function sha(s: string): string {
  // Tiny non-crypto hash for deterministic sandbox payout ids.
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(16).padStart(8, '0')
}

// Singleton sandbox instance. In production this would be configured via DI.
export const paymentsService: PaymentsService = new PaySwapSandboxAdapter({ autoComplete: true })
