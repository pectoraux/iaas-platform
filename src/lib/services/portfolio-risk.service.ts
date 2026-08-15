// =============================================================================
// VPP-2D: Portfolio Risk Engine
// =============================================================================
// THE CENTRAL QUESTION OF VPP-2D:
//
//   Given N DERs, each with uncertain performance and a probability of being
//   unavailable, AND given that failures may be correlated across DERs, how
//   much aggregate capacity can the platform safely promise to a buyer
//   without systematically overcommitting?
//
// This service answers that question. It is a PURE computation engine — no
// database access, no side effects. The caller supplies per-DER uncertainty
// profiles and a correlation model; the engine returns the portfolio-level
// expected performance, standard deviation, and the safe committed capacity
// at a target confidence level.
//
// MATHEMATICAL MODEL
//
// Per-DER model:
//   DER i has:
//     μ_i  = expected performance (kWh) if available
//     σ_i  = std dev of performance (kWh) if available
//     p_i  = availability probability ∈ [0, 1]
//
//   X_i = performance delivered by DER i (a mixture random variable):
//     With probability p_i:  X_i ~ N(μ_i, σ_i²)
//     With probability 1-p_i: X_i = 0  (DER unavailable)
//
//   E[X_i]    = p_i · μ_i
//   Var(X_i)  = p_i · σ_i² + p_i·(1-p_i)·μ_i²
//     (law of total variance: the availability mixture adds a term that
//      grows with μ_i² and the unavailability probability)
//
// Portfolio model:
//   S = Σ X_i  (aggregate performance)
//   E[S]   = Σ E[X_i]  = Σ p_i · μ_i
//   Var(S) = Σ Var(X_i) + 2 · Σ_{i<j} Cov(X_i, X_j)
//     Cov(X_i, X_j) = ρ_ij · √(Var(X_i) · Var(X_j))
//
//   The correlation matrix ρ captures inter-DER dependence:
//     - Common-mode failure (e.g., regional grid outage affecting all DERs
//       in the same cluster → high ρ_within)
//     - Asset-type correlation (e.g., all batteries from one manufacturer
//       have correlated firmware issues)
//     - Weather correlation (solar + wind across a region)
//
// Safe capacity (Value-at-Risk approach):
//   At confidence level c (e.g., 0.99), the safe committed capacity is:
//     safeCapacity = E[S] - z_c · √Var(S)
//   where z_c is the inverse normal CDF at c (z_0.99 ≈ 2.326).
//   Floored at 0 (never promise negative capacity).
//
//   This means: with probability c, the portfolio will deliver at least
//   safeCapacity. The platform can promise safeCapacity to the buyer and
//   be wrong only (1-c) of the time — e.g., 1% of dispatches for c=0.99.
//
// DIVERSIFICATION:
//   For uncorrelated DERs (ρ=0), Var(S) = Σ Var(X_i), so σ_S = √(Σ σ_i²).
//   As N grows, σ_S grows as √N while E[S] grows as N, so σ_S/E[S] → 0.
//   The portfolio becomes MORE reliable per unit of capacity as it grows —
//   the diversification benefit.
//
//   For perfectly correlated DERs (ρ=1), Var(S) = (Σ σ_i)², so σ_S = Σ σ_i.
//   No diversification — the portfolio is as risky as a single DER scaled up.
//
//   Real portfolios sit between these extremes. The correlation model
//   determines where.
//
// FUTURE EXTENSIONS (not in 2D-1):
//   - Fat-tailed distributions (Student-t, copula models) for correlated
//     availability failures (normal underestimates tail risk when ρ is high).
//   - Conditional VaR (Expected Shortfall) for stricter risk budgets.
//   - Empirical correlation matrices from historical dispatch data.
//   - Per-DER uncertainty refined from actual dispatch performance (not just
//     strategy evaluation metrics).
// =============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-DER uncertainty profile — the input to the portfolio risk engine.
 *
 * Each DER contributes a random variable to the portfolio aggregate. This
 * profile captures the first two moments (mean, std dev) of that variable
 * conditional on availability, plus the availability probability itself.
 *
 * The `clusterId` groups DERs that share common-mode failure risk (e.g.,
 * same geographic region, same asset type, same operator). DERs in the same
 * cluster get a higher correlation coefficient than those in different
 * clusters.
 */
export interface DerUncertaintyProfile {
  assetId: string
  clusterId: string
  /** Expected performance (kWh) if the DER is available. */
  expectedPerformanceKwh: number
  /** Std dev of performance (kWh) if available. */
  stdDevKwh: number
  /** Probability the DER is available and dispatchable ∈ [0, 1]. */
  availabilityProb: number
}

/**
 * Correlation model — determines the inter-DER correlation matrix.
 *
 * Block-correlation model: DERs in the same cluster get `withinCluster`,
 * DERs in different clusters get `crossCluster`. This captures the key risk
 * (common-mode failure within a cluster) while remaining interpretable and
 * configurable.
 *
 * For a general correlation matrix (e.g., empirical), use
 * `computePortfolioRiskWithMatrix` directly.
 */
export interface CorrelationModel {
  /** ρ for DERs in the same cluster (common-mode failure). Typical: 0.5–0.8. */
  withinCluster: number
  /** ρ for DERs in different clusters. Typical: 0.0–0.2. */
  crossCluster: number
}

/**
 * Per-DER contribution to the portfolio — the intermediate result showing
 * each DER's marginal expected value and variance after accounting for
 * availability.
 */
export interface DerContribution {
  assetId: string
  clusterId: string
  /** E[X_i] = p_i · μ_i — expected contribution after availability. */
  expectedKwh: number
  /** Var(X_i) = p_i·σ_i² + p_i·(1-p_i)·μ_i² — variance after availability. */
  varianceKwh2: number
  /** √Var(X_i) — std dev of contribution. */
  stdDevKwh: number
}

/**
 * Portfolio risk result — the aggregate statistics.
 */
export interface PortfolioRiskResult {
  /** E[S] = Σ p_i·μ_i — expected aggregate performance. */
  expectedKwh: number
  /** √Var(S) — std dev of aggregate performance. */
  stdDevKwh: number
  /** Var(S) — raw variance (for diagnostics). */
  varianceKwh2: number
  derCount: number
  /** Per-DER contributions (for diagnostics / attribution). */
  contributions: DerContribution[]
  /** The correlation model used. */
  correlationModel: CorrelationModel
}

/**
 * Safe capacity result — the answer to "how much can we promise?"
 */
export interface SafeCapacityResult extends PortfolioRiskResult {
  /** What the buyer requested. */
  requestedKw: number
  /** What the platform safely promises (≤ requested, ≥ 0). */
  committedKw: number
  /** Confidence level used (e.g., 0.99). */
  confidenceLevel: number
  /** z-score for the confidence level (e.g., 2.326 for 0.99). */
  zScore: number
  /** Whether the platform could fully serve the buyer's request. */
  fullyServed: boolean
  /** The capacity gap (requested - committed), if any. */
  shortfallKw: number
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/**
 * Compute the per-DER contribution to the portfolio, accounting for
 * availability.
 *
 * X_i is a mixture: with probability p_i, X_i ~ N(μ_i, σ_i²); otherwise 0.
 *   E[X_i]   = p_i · μ_i
 *   Var(X_i) = p_i · σ_i² + p_i·(1-p_i)·μ_i²
 */
export function computeDerContribution(profile: DerUncertaintyProfile): DerContribution {
  const { expectedPerformanceKwh: mu, stdDevKwh: sigma, availabilityProb: p } = profile
  const expected = p * mu
  // Law of total variance:
  //   Var(X) = E[Var(X|A)] + Var(E[X|A])
  //          = p · σ² + p·(1-p)·μ²
  const variance = p * sigma * sigma + p * (1 - p) * mu * mu
  return {
    assetId: profile.assetId,
    clusterId: profile.clusterId,
    expectedKwh: expected,
    varianceKwh2: variance,
    stdDevKwh: Math.sqrt(variance),
  }
}

/**
 * Build a correlation matrix from the block-correlation model.
 *
 * ρ_ij = withinCluster if cluster_i === cluster_j, else crossCluster.
 * Diagonal is 1.0 (a DER is perfectly correlated with itself).
 */
export function buildCorrelationMatrix(
  profiles: DerUncertaintyProfile[],
  model: CorrelationModel,
): number[][] {
  const n = profiles.length
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1.0
    for (let j = i + 1; j < n; j++) {
      const rho = profiles[i].clusterId === profiles[j].clusterId
        ? model.withinCluster
        : model.crossCluster
      matrix[i][j] = rho
      matrix[j][i] = rho
    }
  }
  return matrix
}

/**
 * Compute portfolio risk given per-DER contributions and a general
 * correlation matrix.
 *
 * E[S]   = Σ E[X_i]
 * Var(S) = Σ Var(X_i) + 2 · Σ_{i<j} ρ_ij · √(Var(X_i)·Var(X_j))
 */
export function computePortfolioRiskWithMatrix(
  profiles: DerUncertaintyProfile[],
  correlationMatrix: number[][],
): PortfolioRiskResult {
  const n = profiles.length
  if (n === 0) {
    return {
      expectedKwh: 0,
      stdDevKwh: 0,
      varianceKwh2: 0,
      derCount: 0,
      contributions: [],
      correlationModel: { withinCluster: 0, crossCluster: 0 },
    }
  }

  const contributions = profiles.map(computeDerContribution)

  // E[S] = Σ E[X_i]
  const expected = contributions.reduce((sum, c) => sum + c.expectedKwh, 0)

  // Var(S) = Σ Var(X_i) + 2 · Σ_{i<j} Cov(X_i, X_j)
  // Cov(X_i, X_j) = ρ_ij · √(Var(X_i)·Var(X_j))
  let variance = contributions.reduce((sum, c) => sum + c.varianceKwh2, 0)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const cov = correlationMatrix[i][j]
        * Math.sqrt(contributions[i].varianceKwh2 * contributions[j].varianceKwh2)
      variance += 2 * cov
    }
  }

  // Numerical guard: variance should never be negative, but floating-point
  // cancellation in the covariance sum can produce tiny negatives.
  const safeVariance = Math.max(0, variance)

  return {
    expectedKwh: expected,
    stdDevKwh: Math.sqrt(safeVariance),
    varianceKwh2: safeVariance,
    derCount: n,
    contributions,
    correlationModel: { withinCluster: 0, crossCluster: 0 },
  }
}

/**
 * Compute portfolio risk using the block-correlation model.
 *
 * This is the standard entry point. It builds the correlation matrix from
 * the cluster assignments and delegates to computePortfolioRiskWithMatrix.
 */
export function computePortfolioRisk(
  profiles: DerUncertaintyProfile[],
  model: CorrelationModel,
): PortfolioRiskResult {
  const matrix = buildCorrelationMatrix(profiles, model)
  const result = computePortfolioRiskWithMatrix(profiles, matrix)
  // Attach the actual model used (for diagnostics / persistence).
  result.correlationModel = model
  return result
}

/**
 * Compute the safe committed capacity for a buyer request.
 *
 * safeCapacity = E[S] - z_c · σ_S, floored at 0.
 *
 * If safeCapacity ≥ requestedKw, the platform can fully serve the buyer
 * (committed = requested). Otherwise, the platform under-promises
 * (committed = safeCapacity) and the buyer's request is partially served.
 *
 * @param profiles      Per-DER uncertainty profiles (the portfolio)
 * @param model         Correlation model (block-correlation)
 * @param requestedKw   What the buyer asked for
 * @param confidenceLevel  Target confidence (e.g., 0.99 = 99% chance of delivery)
 */
export function computeSafeCapacity(
  profiles: DerUncertaintyProfile[],
  model: CorrelationModel,
  requestedKw: number,
  confidenceLevel: number,
): SafeCapacityResult {
  if (confidenceLevel <= 0 || confidenceLevel >= 1) {
    throw new Error(`confidenceLevel must be in (0, 1), got ${confidenceLevel}`)
  }

  const risk = computePortfolioRisk(profiles, model)
  const zScore = inverseNormalCDF(confidenceLevel)

  // VaR: the capacity we can promise with probability `confidenceLevel`.
  // E[S] - z·σ means: with probability c, S ≥ committed (by the normal model).
  const rawSafeCapacity = risk.expectedKwh - zScore * risk.stdDevKwh
  const safeCapacity = Math.max(0, rawSafeCapacity)

  // The platform commits min(safeCapacity, requested). It never over-promises
  // beyond what the buyer asked, and never promises more than the risk model
  // allows.
  const committedKw = Math.min(safeCapacity, requestedKw)
  const fullyServed = committedKw >= requestedKw
  const shortfallKw = Math.max(0, requestedKw - committedKw)

  return {
    ...risk,
    requestedKw,
    committedKw,
    confidenceLevel,
    zScore,
    fullyServed,
    shortfallKw,
  }
}

// ---------------------------------------------------------------------------
// Inverse Normal CDF (Acklam's algorithm)
// ---------------------------------------------------------------------------

/**
 * Inverse of the standard normal CDF, using Acklam's rational approximation.
 *
 * Accurate to ~1.15e-9 relative error across the full range (0, 1).
 * This avoids adding a dependency on a statistics library.
 *
 * @param p  Probability in (0, 1)
 * @returns z such that P(Z ≤ z) = p for Z ~ N(0, 1)
 */
export function inverseNormalCDF(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new Error(`inverseNormalCDF requires p in (0, 1), got ${p}`)
  }

  // Acklam's coefficients.
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ]
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ]

  const plow = 0.02425
  const phigh = 1 - plow

  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    )
  } else if (p <= phigh) {
    const q = p - 0.5
    const r = q * q
    return (
      (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + b[5])
    )
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    )
  }
}

// ---------------------------------------------------------------------------
// Uncertainty profile derivation (from baseline evaluation metrics)
// ---------------------------------------------------------------------------

/**
 * Derive a per-DER uncertainty profile from baseline evaluation metrics.
 *
 * The baseline evaluation (VPP-2B) produces per-strategy metrics: MAE, P95
 * error, bias. These characterize the baseline prediction error. The
 * performance delivered = actual - baseline, so the uncertainty in
 * performance has two sources:
 *   1. Baseline prediction error (characterized by MAE)
 *   2. Actual device variability (characterized by P95, which captures
 *      both baseline error and device variability)
 *
 * For the first-pass model:
 *   σ_i = max(MAE, P95Error / 1.96)
 *     (P95 / 1.96 converts the 95th-percentile error to an approximate std
 *      dev under normality. We take the max of the two to be conservative.)
 *   μ_i = reservedKw * durationHours
 *     (expected full delivery — refined in 2D-2 with historical actuals)
 *   p_i = availabilityProb ?? 0.98
 *     (default 98% availability, refined in 2D-2 with uptime data)
 *
 * This is a defensible starting point. The risk engine itself is pure and
 * doesn't depend on this derivation — it can be replaced with a more
 * sophisticated model without changing the engine.
 */
export function deriveUncertaintyFromEvaluation(input: {
  assetId: string
  clusterId: string
  reservedKw: number
  durationHours: number
  evaluationMetrics: {
    mae: number
    p95Error: number
  }
  availabilityProb?: number
}): DerUncertaintyProfile {
  const { assetId, clusterId, reservedKw, durationHours, evaluationMetrics, availabilityProb } = input

  // Expected performance: full delivery at reserved power for the duration.
  const expectedPerformanceKwh = reservedKw * durationHours

  // Std dev: take the conservative max of MAE and P95/1.96.
  // P95 / 1.96 converts a 95th-percentile value to an approximate std dev
  // under the normal assumption.
  const sigmaFromP95 = evaluationMetrics.p95Error / 1.96
  const stdDevKwh = Math.max(evaluationMetrics.mae, sigmaFromP95)

  // Default availability: 98% (refined with real uptime data in 2D-2).
  const availability = availabilityProb ?? 0.98

  return {
    assetId,
    clusterId,
    expectedPerformanceKwh,
    stdDevKwh,
    availabilityProb: availability,
  }
}
