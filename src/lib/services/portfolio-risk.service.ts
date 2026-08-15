// =============================================================================
// VPP-2D: Portfolio Risk Engine (POWER-based, normal approximation)
// =============================================================================
// THE CENTRAL QUESTION OF VPP-2D:
//
//   Given N DERs, each with uncertain power output and a probability of being
//   unavailable, AND given that failures may be correlated across DERs, how
//   much aggregate POWER capacity can the platform safely promise to a buyer
//   without systematically overcommitting?
//
// DIMENSIONAL DISCIPLINE (VPP-2D-1 correction):
//
//   This engine operates strictly in POWER (kW) for CAPACITY COMMITMENT.
//   Actual delivery / performance contribution remains in ENERGY (kWh) —
//   that is handled by the contribution/settlement layer, NOT here.
//
//   The separation matches the capacity-vs-usage distinction already
//   established in the platform:
//     Capacity (what we promise):  kW
//     Usage / performance (what was delivered): kWh
//
//   Per-DER historical/evaluation errors are often in kWh (energy per
//   dispatch). When constructing a DerUncertaintyProfile, the caller MUST
//   convert those to kW using the dispatch duration:
//     stdDevKw = stdDevKwh / durationHours
//   deriveUncertaintyFromEvaluation() does this conversion automatically.
//
// MATHEMATICAL MODEL
//
// Per-DER model:
//   DER i has:
//     μ_i  = expected power output (kW) if available
//     σ_i  = std dev of power output (kW) if available
//     p_i  = availability probability ∈ [0, 1]
//
//   X_i = power delivered by DER i (a mixture random variable):
//     With probability p_i:  X_i ~ N(μ_i, σ_i²)
//     With probability 1-p_i: X_i = 0  (DER unavailable)
//
//   E[X_i]    = p_i · μ_i
//   Var(X_i)  = p_i · σ_i² + p_i·(1-p_i)·μ_i²
//     (law of total variance: the availability mixture adds a term that
//      grows with μ_i² and the unavailability probability)
//
// Portfolio model:
//   S = Σ X_i  (aggregate power)
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
// SAFE CAPACITY (normal approximation — NOT an exact delivery guarantee):
//
//   normalApproximationSafeCapacity = E[S] - z_c · √Var(S)  (floored at 0)
//
//   where z_c is the inverse normal CDF at c (z_0.99 ≈ 2.326).
//
//   IMPORTANT: this is a NORMAL APPROXIMATION. The actual portfolio
//   distribution is a mixture (availability failures create a point mass
//   at 0), and correlated failures produce heavier tails than the Gaussian
//   model predicts. The result is labelled `normalApproximationSafeCapacity`
//   and the result object carries `distributionModel: 'normal_approximation'`
//   so downstream consumers NEVER mistake it for an exact confidence
//   guarantee.
//
//   The approximation is a useful first-pass risk budget. Empirical
//   validation (VPP-2D-2+) will replace it with simulation-based or
//   copula-based quantiles when real dispatch data is available.
//
// CORRELATION MATRIX VALIDATION:
//
//   Every correlation matrix is validated BEFORE computation:
//     - square with correct dimensions
//     - diagonal = 1.0
//     - symmetric
//     - every entry ∈ [-1, 1]
//     - positive semidefinite (PSD) — verified via Cholesky decomposition
//
//   An invalid matrix throws ValidationError. The engine NEVER silently
//   clamps a negative portfolio variance to zero — that would hide an
//   invalid correlation model, which is the wrong failure mode for a risk
//   engine.
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

import { ValidationError } from '@/lib/domain/errors'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-DER uncertainty profile — the input to the portfolio risk engine.
 *
 * All quantities are in POWER (kW). This is the capacity dimension: what
 * the platform commits to a buyer. Actual delivery (kWh) is handled
 * separately by the contribution/settlement layer.
 *
 * The `clusterId` groups DERs that share common-mode failure risk (e.g.,
 * same geographic region, same asset type, same operator). DERs in the same
 * cluster get a higher correlation coefficient than those in different
 * clusters.
 */
export interface DerUncertaintyProfile {
  assetId: string
  clusterId: string
  /** Expected power output (kW) if the DER is available. */
  expectedPerformanceKw: number
  /** Std dev of power output (kW) if available. */
  stdDevKw: number
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
  /** E[X_i] = p_i · μ_i — expected contribution (kW) after availability. */
  expectedKw: number
  /** Var(X_i) = p_i·σ_i² + p_i·(1-p_i)·μ_i² — variance (kW²) after availability. */
  varianceKw2: number
  /** √Var(X_i) — std dev of contribution (kW). */
  stdDevKw: number
}

/**
 * The distribution model used for the safe-capacity approximation.
 *
 * 'normal_approximation' is the only model in VPP-2D-1. Future versions may
 * add 'empirical_quantile', 'student_t', 'copula', etc. Downstream consumers
 * MUST check this field — a normal-approximation result is NOT an exact
 * delivery guarantee.
 */
export type DistributionModel = 'normal_approximation'

/**
 * Portfolio risk result — the aggregate statistics (all in kW).
 */
export interface PortfolioRiskResult {
  /** E[S] = Σ p_i·μ_i — expected aggregate power (kW). */
  expectedKw: number
  /** √Var(S) — std dev of aggregate power (kW). */
  stdDevKw: number
  /** Var(S) — raw variance (kW², for diagnostics). */
  varianceKw2: number
  derCount: number
  /** Per-DER contributions (for diagnostics / attribution). */
  contributions: DerContribution[]
  /** The correlation model used (for diagnostics / persistence). */
  correlationModel: CorrelationModel
}

/**
 * Safe capacity result — the answer to "how much POWER can we promise?"
 *
 * IMPORTANT: `normalApproximationSafeCapacity` is a normal-approximation
 * risk budget, NOT an exact confidence guarantee. The actual portfolio
 * distribution is a mixture with heavier tails. See `distributionModel`.
 */
export interface SafeCapacityResult extends PortfolioRiskResult {
  /** What the buyer requested (kW). */
  requestedKw: number
  /**
   * What the platform safely promises (kW). ≤ requested, ≥ 0.
   *
   * This is the normal-approximation safe capacity — see distributionModel.
   */
  committedKw: number
  /**
   * The raw normal-approximation safe capacity before capping at requested.
   * E[S] - z_c · σ_S, floored at 0.
   */
  normalApproximationSafeCapacity: number
  /** Confidence level used (e.g., 0.99). */
  confidenceLevel: number
  /** z-score for the confidence level (e.g., 2.326 for 0.99). */
  zScore: number
  /**
   * The distribution model used. 'normal_approximation' means the result is
   * based on the Gaussian approximation of the portfolio aggregate. This is
   * NOT an exact delivery guarantee — the true distribution is a mixture.
   * Downstream consumers MUST check this field.
   */
  distributionModel: DistributionModel
  /** Whether the platform could fully serve the buyer's request. */
  fullyServed: boolean
  /** The capacity gap (requested - committed) in kW, if any. */
  shortfallKw: number
}

// ---------------------------------------------------------------------------
// Correlation matrix validation
// ---------------------------------------------------------------------------

const EPSILON = 1e-9

/**
 * Validate that a matrix is a proper correlation matrix.
 *
 * Checks:
 *   1. Square with dimensions matching the profile count
 *   2. Diagonal entries are exactly 1.0
 *   3. Matrix is symmetric (within floating-point tolerance)
 *   4. Every off-diagonal entry ∈ [-1, 1]
 *   5. Matrix is positive semidefinite (PSD) — verified via Cholesky
 *      decomposition. A non-PSD matrix can produce negative variance and
 *      represents an invalid dependence model.
 *
 * Throws ValidationError if any check fails. A risk engine must fail closed
 * on invalid inputs — silently clamping negative variance would hide the
 * problem and produce nonsensical "safe" capacities.
 */
export function validateCorrelationMatrix(
  matrix: number[][],
  expectedSize: number,
): void {
  if (!Array.isArray(matrix) || matrix.length !== expectedSize) {
    throw new ValidationError(
      `Correlation matrix must have ${expectedSize} rows, got ${matrix.length}`,
    )
  }

  for (let i = 0; i < expectedSize; i++) {
    if (!Array.isArray(matrix[i]) || matrix[i].length !== expectedSize) {
      throw new ValidationError(
        `Correlation matrix row ${i} must have ${expectedSize} entries, got ${matrix[i]?.length ?? 'undefined'}`,
      )
    }
  }

  // Diagonal = 1.0
  for (let i = 0; i < expectedSize; i++) {
    if (Math.abs(matrix[i][i] - 1.0) > EPSILON) {
      throw new ValidationError(
        `Correlation matrix diagonal[${i}][${i}] must be 1.0, got ${matrix[i][i]}`,
      )
    }
  }

  // Symmetric + range
  for (let i = 0; i < expectedSize; i++) {
    for (let j = i + 1; j < expectedSize; j++) {
      if (Math.abs(matrix[i][j] - matrix[j][i]) > EPSILON) {
        throw new ValidationError(
          `Correlation matrix must be symmetric: [${i}][${j}]=${matrix[i][j]} ≠ [${j}][${i}]=${matrix[j][i]}`,
        )
      }
      const rho = matrix[i][j]
      if (rho < -1 - EPSILON || rho > 1 + EPSILON) {
        throw new ValidationError(
          `Correlation matrix entry [${i}][${j}]=${rho} is out of range [-1, 1]`,
        )
      }
    }
  }

  // Positive semidefinite via Cholesky decomposition.
  // A matrix is PSD iff its Cholesky decomposition exists (no negative
  // pivot during the algorithm). We attempt the decomposition and throw
  // if we encounter a negative pivot.
  if (!isPositiveSemidefinite(matrix, expectedSize)) {
    throw new ValidationError(
      'Correlation matrix is not positive semidefinite. ' +
        'This produces invalid (potentially negative) portfolio variance. ' +
        'Use a valid correlation matrix — e.g., one built from a valid ' +
        'covariance structure or nearest-PSD projection.',
    )
  }
}

/**
 * Check if a symmetric matrix is positive semidefinite via Cholesky
 * decomposition. Returns false if a negative pivot is encountered.
 *
 * Cholesky: A = L·Lᵀ where L is lower-triangular. The algorithm fails
 * (negative pivot) iff A is not PSD.
 */
function isPositiveSemidefinite(matrix: number[][], n: number): boolean {
  // Work on a copy to avoid mutating the input.
  const a = matrix.map((row) => [...row])

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i][j]
      for (let k = 0; k < j; k++) {
        sum -= a[i][k] * a[j][k]
      }
      if (i === j) {
        // Diagonal pivot — must be non-negative for PSD.
        if (sum < -EPSILON) {
          return false
        }
        // Avoid sqrt of tiny negative from floating-point.
        a[i][j] = Math.sqrt(Math.max(0, sum))
      } else {
        const pivot = a[j][j]
        if (Math.abs(pivot) < EPSILON) {
          // Zero pivot — the matrix is PSD but singular. Continue with 0.
          a[i][j] = 0
        } else {
          a[i][j] = sum / pivot
        }
      }
    }
  }
  return true
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
  const { expectedPerformanceKw: mu, stdDevKw: sigma, availabilityProb: p } = profile
  const expected = p * mu
  // Law of total variance:
  //   Var(X) = E[Var(X|A)] + Var(E[X|A])
  //          = p · σ² + p·(1-p)·μ²
  const variance = p * sigma * sigma + p * (1 - p) * mu * mu
  return {
    assetId: profile.assetId,
    clusterId: profile.clusterId,
    expectedKw: expected,
    varianceKw2: variance,
    stdDevKw: Math.sqrt(variance),
  }
}

/**
 * Build a correlation matrix from the block-correlation model.
 *
 * ρ_ij = withinCluster if cluster_i === cluster_j, else crossCluster.
 * Diagonal is 1.0 (a DER is perfectly correlated with itself).
 *
 * The resulting matrix is always valid (symmetric, unit diagonal, in-range,
 * and PSD for valid block-correlation parameters).
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
 * Compute portfolio risk given per-DER contributions and a validated
 * correlation matrix.
 *
 * E[S]   = Σ E[X_i]
 * Var(S) = Σ Var(X_i) + 2 · Σ_{i<j} ρ_ij · √(Var(X_i)·Var(X_j))
 *
 * The correlation matrix is validated (shape, diagonal, symmetry, range,
 * PSD) before computation. An invalid matrix throws ValidationError — the
 * engine never silently produces a nonsensical variance.
 */
export function computePortfolioRiskWithMatrix(
  profiles: DerUncertaintyProfile[],
  correlationMatrix: number[][],
): PortfolioRiskResult {
  const n = profiles.length
  if (n === 0) {
    return {
      expectedKw: 0,
      stdDevKw: 0,
      varianceKw2: 0,
      derCount: 0,
      contributions: [],
      correlationModel: { withinCluster: 0, crossCluster: 0 },
    }
  }

  // Validate the correlation matrix BEFORE any computation.
  validateCorrelationMatrix(correlationMatrix, n)

  const contributions = profiles.map(computeDerContribution)

  // E[S] = Σ E[X_i]
  const expected = contributions.reduce((sum, c) => sum + c.expectedKw, 0)

  // Var(S) = Σ Var(X_i) + 2 · Σ_{i<j} Cov(X_i, X_j)
  // Cov(X_i, X_j) = ρ_ij · √(Var(X_i)·Var(X_j))
  let variance = contributions.reduce((sum, c) => sum + c.varianceKw2, 0)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const cov = correlationMatrix[i][j]
        * Math.sqrt(contributions[i].varianceKw2 * contributions[j].varianceKw2)
      variance += 2 * cov
    }
  }

  // With a validated PSD correlation matrix, variance CANNOT be negative
  // (a PSD covariance matrix produces a non-negative portfolio variance for
  // any linear combination). If we somehow see a tiny negative from
  // floating-point cancellation, floor at 0 — but this is a numerical
  // artifact, not an invalid-model fallback.
  if (variance < 0) {
    if (variance < -1e-6) {
      // This should be unreachable after PSD validation. If it happens, it's
      // a bug — throw rather than hide it.
      throw new Error(
        `Portfolio variance is negative (${variance}) despite PSD correlation matrix. ` +
          'This indicates a numerical bug in the risk engine.',
      )
    }
    variance = 0
  }

  return {
    expectedKw: expected,
    stdDevKw: Math.sqrt(variance),
    varianceKw2: variance,
    derCount: n,
    contributions,
    correlationModel: { withinCluster: 0, crossCluster: 0 },
  }
}

/**
 * Compute portfolio risk using the block-correlation model.
 *
 * This is the standard entry point. It builds the correlation matrix from
 * the cluster assignments and delegates to computePortfolioRiskWithMatrix
 * (which validates the matrix).
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
 * Compute the normal-approximation safe committed capacity for a buyer
 * request.
 *
 * normalApproximationSafeCapacity = E[S] - z_c · σ_S, floored at 0.
 *
 * committed = min(safeCapacity, requested).
 *
 * IMPORTANT: This is a NORMAL APPROXIMATION, not an exact delivery
 * guarantee. The result carries `distributionModel: 'normal_approximation'`
 * so downstream consumers never mistake it for a precise confidence. The
 * true portfolio distribution is a mixture (availability creates a point
 * mass at 0) with heavier tails than the Gaussian model predicts,
 * especially under high correlation.
 *
 * @param profiles      Per-DER uncertainty profiles (the portfolio, in kW)
 * @param model         Correlation model (block-correlation)
 * @param requestedKw   What the buyer asked for (kW)
 * @param confidenceLevel  Target confidence (e.g., 0.99). Under the normal
 *                         approximation, this is the probability that S ≥
 *                         safeCapacity. The true probability may be lower.
 */
export function computeSafeCapacity(
  profiles: DerUncertaintyProfile[],
  model: CorrelationModel,
  requestedKw: number,
  confidenceLevel: number,
): SafeCapacityResult {
  if (confidenceLevel <= 0 || confidenceLevel >= 1) {
    throw new ValidationError(`confidenceLevel must be in (0, 1), got ${confidenceLevel}`)
  }
  if (requestedKw < 0) {
    throw new ValidationError(`requestedKw must be non-negative, got ${requestedKw}`)
  }

  const risk = computePortfolioRisk(profiles, model)
  const zScore = inverseNormalCDF(confidenceLevel)

  // Normal-approximation VaR: the capacity we can promise with probability
  // ~c under the Gaussian model. NOT an exact guarantee.
  const rawSafeCapacity = risk.expectedKw - zScore * risk.stdDevKw
  const normalApproximationSafeCapacity = Math.max(0, rawSafeCapacity)

  // The platform commits min(safeCapacity, requested). It never over-promises
  // beyond what the buyer asked, and never promises more than the risk model
  // allows.
  const committedKw = Math.min(normalApproximationSafeCapacity, requestedKw)
  const fullyServed = committedKw >= requestedKw
  const shortfallKw = Math.max(0, requestedKw - committedKw)

  return {
    ...risk,
    requestedKw,
    committedKw,
    normalApproximationSafeCapacity,
    confidenceLevel,
    zScore,
    distributionModel: 'normal_approximation',
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
    throw new ValidationError(`inverseNormalCDF requires p in (0, 1), got ${p}`)
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
 * Derive a per-DER uncertainty profile (in kW) from baseline evaluation
 * metrics (which are in kWh).
 *
 * The baseline evaluation (VPP-2B) produces per-strategy metrics in ENERGY
 * (kWh): MAE, P95 error, bias. The portfolio risk engine operates in POWER
 * (kW). This function converts kWh errors to kW by dividing by the dispatch
 * duration, producing a profile the engine can consume directly.
 *
 * Conversion:
 *   μ_i (kW) = reservedKw
 *     (expected power output = the reserved capacity; the DER is expected
 *      to deliver its full reserved power if available)
 *   σ_i (kW) = max(MAE, P95/1.96) / durationHours
 *     (convert the energy error to a power error using the dispatch duration)
 *   p_i = availabilityProb ?? 0.98
 *
 * ENGINEERING ASSUMPTION (must be replaced in VPP-2D-2):
 *   The expected performance μ_i = reservedKw assumes every available DER
 *   delivers its full reserved capacity. This is an optimistic engineering
 *   assumption, NOT an empirically measured expectation. VPP-2D-2 will
 *   replace this with historical actual-dispatch performance (mean and
 *   std dev of realized power output per DER).
 *
 *   Until that replacement lands, the risk engine's safe-capacity output
 *   should NOT be used to make real buyer commitments — only as a
 *   structural / exploratory tool.
 */
export function deriveUncertaintyFromEvaluation(input: {
  assetId: string
  clusterId: string
  reservedKw: number
  durationHours: number
  evaluationMetrics: {
    mae: number       // kWh
    p95Error: number  // kWh
  }
  availabilityProb?: number
}): DerUncertaintyProfile {
  const { assetId, clusterId, reservedKw, durationHours, evaluationMetrics, availabilityProb } = input

  if (durationHours <= 0) {
    throw new ValidationError(`durationHours must be positive, got ${durationHours}`)
  }

  // Expected power output (kW): the reserved capacity. ENGINEERING ASSUMPTION
  // — replaced with historical actuals in VPP-2D-2.
  const expectedPerformanceKw = reservedKw

  // Convert energy errors (kWh) to power errors (kW) via dispatch duration.
  // P95 / 1.96 converts a 95th-percentile value to an approximate std dev
  // under the normal assumption. Take the max of MAE and P95/1.96 to be
  // conservative, then divide by duration to get kW.
  const sigmaFromP95Kwh = evaluationMetrics.p95Error / 1.96
  const stdDevKwh = Math.max(evaluationMetrics.mae, sigmaFromP95Kwh)
  const stdDevKw = stdDevKwh / durationHours

  // Default availability: 98% (refined with real uptime data in 2D-2).
  const availability = availabilityProb ?? 0.98

  return {
    assetId,
    clusterId,
    expectedPerformanceKw,
    stdDevKw,
    availabilityProb: availability,
  }
}
