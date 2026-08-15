// =============================================================================
// VPP-2D-3: Portfolio Reservation Service
// =============================================================================
// Connects the portfolio optimizer to the real generic capacity system.
//
// THE FLOW:
//
//   Buyer request (kW + confidence)
//         ↓
//   Candidate DER pool (uncertainty profiles + available capacity)
//         ↓
//   Portfolio optimizer (greedy lexicographic + partial allocation)
//         ↓
//   Selected assets with allocated kW:
//     asset A → 37.4 kW
//     asset B → 62.1 kW
//     asset C → 18.7 kW
//         ↓
//   ATOMIC multi-reservation (single db.$transaction):
//     - Lock all CapacityResource rows FOR UPDATE (sorted to avoid deadlocks)
//     - For each asset, createCapacityReservation(tx, allocatedKw)
//     - If ANY reservation fails (insufficient capacity) → entire tx rolls back
//     - No orphan reservations, no negative remaining capacity
//         ↓
//   Buyer commitment (all reservations persisted or none)
//
// =============================================================================
// THREE MANDATORY SAFETY PROPERTIES (from the reviewer)
// =============================================================================
//
//   1. NEVER OVER-RESERVE. Every allocatedKw is checked against the current
//      verified available capacity INSIDE the same transaction that creates
//      the reservations. The optimizer's view of available capacity may be
//      stale by the time the transaction runs — the capacity service's
//      FOR UPDATE lock + overlap-sum check is the source of truth.
//
//   2. OPTIMIZER IS NOT THE CONCURRENCY AUTHORITY. Two buyer requests can
//      independently compute the same allocation. The generic capacity
//      service (via FOR UPDATE row locking) is the final arbiter. If buyer
//      A wins the lock, buyer B's reservation fails cleanly.
//
//   3. ALL-OR-NOTHING RESERVATION SET. If the optimizer selects A+B+C and
//      C cannot be reserved (another buyer won the race), the entire
//      transaction rolls back. A and B are NOT left as orphan reservations.
//      The buyer gets a clean "insufficient capacity" error and can retry
//      with a fresh candidate pool.
//
// =============================================================================
// ALGORITHM
// =============================================================================
//
//   1. Run optimizePortfolio() on the candidate pool (outside the transaction
//      — it's a pure computation).
//
//   2. If the portfolio is empty or can't meet the target, return early
//      (no reservations created).
//
//   3. Open a single db.$transaction with a 30s timeout:
//      a. Sort the selected assets by (assetId, networkId, capabilityType)
//         to ensure stable lock ordering across concurrent transactions
//         (prevents deadlocks).
//      b. For each selected asset, call createCapacityReservation() with:
//         - tx (the transaction client)
//         - requestedAmount = allocatedKw
//         - sourceType = 'portfolio_reservation'
//         - sourceId = unique per asset (portfolioId + assetId)
//         - startTime/endTime = the dispatch window
//      c. If any createCapacityReservation throws (insufficient capacity,
//         resource not found, etc.), the transaction rolls back — ALL
//         reservations are discarded. No orphans.
//      d. Collect the reservation results.
//
//   4. After the transaction commits, append audit (outside tx, best-effort).
//
//   5. Return the portfolio result + reservation records.
//
// The portfolio result carries the algorithm label and optimality guarantee:
//   algorithm = 'greedy_lexicographic_marginal_safe_capacity'
//   referenceModel = '10pct_grid_exhaustive' (when available)
//   optimalityGuarantee = 'heuristic'
//
// The buyer-facing contract does NOT depend on the optimizer being globally
// optimal. The generic capacity layer is the source of truth for what can
// actually be reserved.
// =============================================================================

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { ValidationError, NotFoundError, InsufficientCapacityError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import {
  createCapacityReservation as allocateReservation,
  type CreateReservationResult,
} from './capacity.service'
import {
  optimizePortfolio,
  type CandidateAsset,
  type OptimizationTarget,
  type OptimizationResult,
} from './portfolio-optimizer.service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Input to the portfolio reservation service.
 *
 * The caller (VPP layer or any future vertical) provides:
 *   - tenantId, networkId, capabilityType: the capacity context
 *   - candidates: the pool of available assets with uncertainty profiles
 *   - target: the buyer's request (kW + confidence + correlation model)
 *   - startTime/endTime: the dispatch/reservation window
 *   - portfolioId: a unique identifier for this buyer request (used for
 *     sourceId generation and idempotency)
 */
export interface OptimizeAndReserveInput {
  tenantId: string
  networkId: string
  capabilityType: string
  candidates: CandidateAsset[]
  target: OptimizationTarget
  startTime: Date
  endTime: Date
  /** Unique identifier for this buyer request (e.g., buyer program + dispatch ID). */
  portfolioId: string
  actorId?: string
}

/**
 * A reservation created for a selected asset.
 */
export interface AssetReservation {
  assetId: string
  clusterId: string
  allocatedKw: number
  reservation: CreateReservationResult
}

/**
 * The typed status of a reservation attempt.
 *
 * This distinguishes expected capacity conflicts (which are normal market
 * behavior — the caller can retry with a fresh candidate pool) from
 * system failures (which are infrastructure problems that must NOT be
 * presented to the caller as "insufficient capacity").
 */
export type ReservationStatus =
  | 'reserved'
  | 'insufficient_capacity'
  | 'retryable_conflict'
  | 'system_error'

/**
 * The result of optimizeAndReserve.
 */
export interface OptimizeAndReserveResult {
  /** The optimizer's portfolio result (selected assets + risk stats). */
  portfolio: OptimizationResult
  /** The created reservations (one per selected asset). */
  reservations: AssetReservation[]
  /**
   * The typed reservation status. Callers MUST check this field to
   * distinguish expected capacity conflicts from system failures.
   *
   *   reserved                — all reservations created successfully
   *   insufficient_capacity   — the pool couldn't meet the target, or a
   *                             concurrent buyer won the capacity race.
   *                             This is EXPECTED market behavior; the
   *                             caller can retry with a fresh pool.
   *   retryable_conflict      — a serialization/timeout conflict. The
   *                             caller should retry with backoff.
   *   system_error            — an unexpected DB/infrastructure failure.
   *                             NOT a capacity problem. Must be surfaced
   *                             as an infrastructure error, not a buyer
   *                             capacity result.
   */
  status: ReservationStatus
  /** Whether all reservations were created successfully (status === 'reserved'). */
  reserved: boolean
  /**
   * Human-readable explanation. For insufficient_capacity, this is the
   * capacity service's error message. For system_error, this is the
   * underlying error message (for diagnostics).
   */
  failureReason?: string
  /**
   * The algorithm used. Always 'greedy_lexicographic_marginal_safe_capacity'
   * for the heuristic optimizer.
   */
  algorithm: string
  /**
   * The optimality guarantee. Always 'heuristic' — the optimizer is NOT
   * globally optimal. The buyer-facing contract does not depend on
   * global optimality.
   */
  optimalityGuarantee: 'heuristic' | 'optimal'
}

// ---------------------------------------------------------------------------
// optimizeAndReserve
// ---------------------------------------------------------------------------

/**
 * Optimize a portfolio AND atomically reserve the selected capacity.
 *
 * This is the VPP-2D-3 integration point: the optimizer's abstract result
 * locks real distributed capacity via the generic capacity layer.
 *
 * SAFETY PROPERTIES:
 *   1. Never over-reserve: each allocatedKw is checked against current
 *      available capacity inside the transaction (FOR UPDATE lock).
 *   2. Optimizer is not the concurrency authority: the capacity service's
 *      row locking is the final arbiter.
 *   3. All-or-nothing: if any reservation fails, the entire transaction
 *      rolls back. No orphan reservations.
 *
 * If the reservation fails (e.g., concurrent buyer won the capacity race),
 * the caller receives a clean error and can retry with a fresh candidate pool.
 */
export async function optimizeAndReserve(
  input: OptimizeAndReserveInput,
): Promise<OptimizeAndReserveResult> {
  const { tenantId, networkId, capabilityType, candidates, target, startTime, endTime, portfolioId, actorId } = input

  // Phase 1: Run the optimizer (pure computation, no DB).
  const portfolio = optimizePortfolio(candidates, target)

  // If the optimizer selected nothing, return early.
  if (portfolio.selected.length === 0) {
    return {
      portfolio,
      reservations: [],
      status: 'insufficient_capacity',
      reserved: false,
      failureReason: portfolio.shortfallKw > 0
        ? `Insufficient candidate pool: safe capacity ${portfolio.committedKw.toFixed(1)} kW < requested ${target.requestedKw} kW`
        : 'No assets selected by optimizer',
      algorithm: portfolio.algorithm,
      optimalityGuarantee: 'heuristic',
    }
  }

  // Phase 2: Atomically reserve all selected assets in a single transaction.
  // If ANY reservation fails, the entire transaction rolls back — no orphans.
  try {
    const reservations = await db.$transaction(async (tx) => {
      // Sort selected assets by (assetId, networkId, capabilityType) for
      // stable lock ordering. This prevents deadlocks when two concurrent
      // transactions try to reserve overlapping sets of resources — they'll
      // acquire locks in the same order.
      const sorted = [...portfolio.selected].sort((a, b) => {
        const cmp = a.assetId.localeCompare(b.assetId)
        if (cmp !== 0) return cmp
        return a.clusterId.localeCompare(b.clusterId)
      })

      const results: AssetReservation[] = []

      for (const asset of sorted) {
        // Each reservation uses a unique sourceId (portfolioId + assetId)
        // to prevent idempotency short-circuits within the same transaction.
        const sourceId = `${portfolioId}:${asset.assetId}`

        const reservation = await allocateReservation(
          {
            tenantId,
            assetId: asset.assetId,
            networkId,
            capabilityType,
            requestedAmount: asset.committedKw.toFixed(8),
            startTime,
            endTime,
            sourceType: 'portfolio_reservation',
            sourceId,
          },
          tx, // ← thread the transaction client
        )

        results.push({
          assetId: asset.assetId,
          clusterId: asset.clusterId,
          allocatedKw: asset.committedKw,
          reservation,
        })
      }

      return results
    }, { timeout: 30000 })

    // Audit (outside the transaction — best-effort, doesn't roll back capacity).
    await appendAudit({
      tenantId,
      actorId,
      eventType: AuditEvents.PortfolioReservationCreated,
      resourceType: 'portfolio_reservation',
      resourceId: portfolioId,
      metadata: {
        algorithm: portfolio.algorithm,
        optimalityGuarantee: 'heuristic',
        requestedKw: target.requestedKw,
        committedKw: portfolio.committedKw,
        totalCommittedKw: portfolio.totalCommittedKw,
        assetCount: reservations.length,
        reservationIds: reservations.map((r) => r.reservation.reservationId),
      },
    })

    return {
      portfolio,
      reservations,
      status: 'reserved',
      reserved: true,
      algorithm: portfolio.algorithm,
      optimalityGuarantee: 'heuristic',
    }
  } catch (err) {
    // The transaction rolled back — NO reservations were persisted.
    //
    // ERROR CLASSIFICATION (critical for operational correctness):
    //
    // We must distinguish:
    //   1. EXPECTED capacity conflicts (ValidationError from the capacity
    //      service — insufficient capacity, stale optimizer view). These
    //      are normal market behavior; the caller can retry with a fresh
    //      candidate pool.
    //   2. RETRYABLE transaction conflicts (serialization failures,
    //      deadlocks, timeouts). The caller should retry with backoff.
    //   3. UNEXPECTED system errors (DB connection failures, Prisma
    //      internal errors, etc.). These must NOT be presented to the
    //      caller as "insufficient capacity" — they are infrastructure
    //      problems that need operator attention.
    //
    // The old code caught every error and converted it to
    // `reserved=false, failureReason=err.message`, which made DB outages
    // look like capacity conflicts. That's operationally dangerous.
    return classifyReservationError(err, portfolio)
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify a reservation error into one of three externally observable
 * outcomes (the fourth — system_error — is the re-throw path).
 *
 *   1. INSUFFICIENT_CAPACITY — the capacity service threw
 *      InsufficientCapacityError, meaning the requested amount exceeds
 *      currently available capacity (physical minus overlapping
 *      reservations). This is EXPECTED market behavior; the caller can
 *      retry with a fresh candidate pool.
 *
 *   2. RETRYABLE_CONFLICT — a transaction serialization failure, deadlock,
 *      or timeout. The caller should retry with backoff.
 *
 *   3. RE-THROWN (system_error path) — everything else, including:
 *      - ValidationError ("Requested amount must be positive", "Unit
 *        mismatch") — these are input/programming errors, NOT capacity
 *        conflicts.
 *      - NotFoundError — a missing asset/assignment is a stale/invalid
 *        candidate, not a capacity shortage.
 *      - Unexpected DB/Prisma errors — infrastructure failures.
 *
 *      These must NOT be presented to the caller as "insufficient
 *      capacity." They propagate as infrastructure/input errors.
 *
 * Only InsufficientCapacityError (code: CAPACITY_UNAVAILABLE) maps to
 * insufficient_capacity. This gives the reservation layer a precise
 * contract rather than inferring market semantics from a broad
 * ValidationError.
 *
 * Exported for direct unit testing.
 */
export function classifyReservationError(
  err: unknown,
  portfolio: OptimizationResult,
): OptimizeAndReserveResult {
  // 1. InsufficientCapacityError — the ONLY error that maps to
  //    insufficient_capacity. This is a specific capacity-contention
  //    error from the capacity service, NOT a generic ValidationError.
  if (err instanceof InsufficientCapacityError) {
    return {
      portfolio,
      reservations: [], // transaction rolled back
      status: 'insufficient_capacity',
      reserved: false,
      failureReason: err.message,
      algorithm: portfolio.algorithm,
      optimalityGuarantee: 'heuristic',
    }
  }

  // 2. Retryable transaction conflicts (Prisma serialization/deadlock/timeout).
  if (isRetryableTransactionError(err)) {
    return {
      portfolio,
      reservations: [], // transaction rolled back
      status: 'retryable_conflict',
      reserved: false,
      failureReason: `Retryable transaction conflict: ${err instanceof Error ? err.message : String(err)}. Retry with backoff.`,
      algorithm: portfolio.algorithm,
      optimalityGuarantee: 'heuristic',
    }
  }

  // 3. Everything else — RE-THROW.
  //    This includes:
  //    - ValidationError ("Requested amount must be positive", "Unit mismatch")
  //    - NotFoundError (missing asset/assignment — stale/invalid candidate)
  //    - Unexpected DB/Prisma errors (infrastructure failures)
  //    - Non-domain errors
  //
  //    None of these are capacity conflicts. They must propagate to the
  //    caller as infrastructure/input errors, NOT be disguised as
  //    "insufficient capacity."
  throw err
}

/**
 * Check if an error is a retryable transaction conflict (serialization
 * failure, deadlock, or timeout).
 *
 * Prisma error codes:
 *   P2034 — too many connections / serialization failure
 *   P2031 — transaction timeout
 *   P2024 — operation timeout
 *   P2033 — connection error
 *   P1001 — connection lost
 *   P1002 — connection timed out
 */
function isRetryableTransactionError(err: unknown): boolean {
  // PrismaKnownRequestError carries a `code` field.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const retryableCodes = ['P2034', 'P2031', 'P2024', 'P2033', 'P1001', 'P1002']
    if (retryableCodes.includes(err.code)) return true
  }

  // Check for transaction timeout (our 30s timeout throws a generic Error).
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    if (msg.includes('transaction') && (msg.includes('timeout') || msg.includes('expired'))) {
      return true
    }
    if (msg.includes('serialization') || msg.includes('deadlock')) {
      return true
    }
  }

  return false
}

// ---------------------------------------------------------------------------
// Query: get reservations by portfolio ID
// ---------------------------------------------------------------------------

/**
 * Find all reservations created for a given portfolio ID.
 * Useful for verifying that a portfolio's reservations reconcile exactly
 * with the optimizer's allocation.
 */
export async function findPortfolioReservations(
  tenantId: string,
  portfolioId: string,
): Promise<CreateReservationResult[]> {
  const reservations = await db.capacityReservation.findMany({
    where: {
      tenantId,
      sourceType: 'portfolio_reservation',
      status: 'active',
      OR: [
        { sourceId: { startsWith: `${portfolioId}:` } },
      ],
    },
    orderBy: { createdAt: 'asc' },
  })

  // Reconstruct the CreateReservationResult shape from the raw rows.
  // We need to look up the resource for physicalCapacity + unit.
  const resourceIds = [...new Set(reservations.map((r) => r.resourceId))]
  const resources = await db.capacityResource.findMany({
    where: { id: { in: resourceIds } },
  })
  const resourceMap = new Map(resources.map((r) => [r.id, r]))

  return reservations.map((r) => {
    const resource = resourceMap.get(r.resourceId)
    return {
      reservationId: r.id,
      resourceId: r.resourceId,
      reservedAmount: r.reservedAmount,
      remainingAmount: r.remainingAmount,
      physicalCapacity: resource?.physicalCapacity ?? '0',
      unit: resource?.unit ?? '',
      duplicate: false,
    }
  })
}

// ---------------------------------------------------------------------------
// Reconciliation helper
// ---------------------------------------------------------------------------

/**
 * Verify that a portfolio's reservations reconcile exactly with the
 * optimizer's allocation. Every selected asset must have a corresponding
 * reservation with reservedAmount == allocatedKw.
 *
 * Returns a list of discrepancies (empty if everything reconciles).
 */
export function reconcilePortfolioWithReservations(
  portfolio: OptimizationResult,
  reservations: AssetReservation[],
): Array<{ assetId: string; issue: string }> {
  const discrepancies: Array<{ assetId: string; issue: string }> = []

  for (const asset of portfolio.selected) {
    const reservation = reservations.find((r) => r.assetId === asset.assetId)
    if (!reservation) {
      discrepancies.push({ assetId: asset.assetId, issue: 'No reservation found for selected asset' })
      continue
    }

    // Compare allocatedKw with reservedAmount (as decimal).
    const reservedKw = parseFloat(reservation.reservation.reservedAmount)
    if (Math.abs(reservedKw - asset.committedKw) > 0.01) {
      discrepancies.push({
        assetId: asset.assetId,
        issue: `Amount mismatch: optimizer allocated ${asset.committedKw.toFixed(4)} kW, reservation reserved ${reservedKw.toFixed(4)} kW`,
      })
    }
  }

  // Check for orphan reservations (reservations without a matching selected asset).
  for (const reservation of reservations) {
    const asset = portfolio.selected.find((s) => s.assetId === reservation.assetId)
    if (!asset) {
      discrepancies.push({ assetId: reservation.assetId, issue: 'Orphan reservation (no matching selected asset)' })
    }
  }

  return discrepancies
}
