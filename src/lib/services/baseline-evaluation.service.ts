// =============================================================================
// Baseline Evaluation Service — runs evaluation, persists results, creates policy.
//
// This is the VPP-specific service that:
// 1. Runs 100+ scenario evaluations using the DERHistorySimulator
// 2. Calls selectBaselineStrategy() with real acceptance criteria
// 3. Persists a BaselineEvaluation record (durable, reproducible)
// 4. Creates/updates the BaselinePolicy on a NetworkVersion
//
// The policy is immutable once the NetworkVersion is published.
// =============================================================================

import { db } from '@/lib/db'
import { DERHistorySimulator } from './der-simulator.service'
import {
  evaluateAllBaselines,
  selectBaselineStrategy,
  DEFAULT_ACCEPTANCE_CRITERIA,
  type BaselineAcceptanceCriteria,
  type BaselineEvaluation as BaselineEval,
  type BaselinePolicy,
} from './baseline-engine.service'

const SIMULATOR_VERSION = '1.0.0'
const ENGINE_VERSION = '1.0.0'

export interface RunEvaluationInput {
  tenantId: string
  networkVersionId?: string
  numScenarios?: number
  criteria?: BaselineAcceptanceCriteria
}

export interface RunEvaluationResult {
  evaluationId: string
  policy: BaselinePolicy
  evaluationRecordId: string
}

/**
 * Run a baseline strategy evaluation and persist the results.
 *
 * 1. Generates N varied scenarios using DERHistorySimulator
 * 2. Evaluates all strategies against ground truth
 * 3. Selects the best eligible strategy using acceptance criteria
 * 4. Persists a BaselineEvaluation record (durable, reproducible)
 * 5. Optionally associates the policy with a NetworkVersion
 */
export async function runAndPersistBaselineEvaluation(
  input: RunEvaluationInput,
): Promise<RunEvaluationResult> {
  const N = input.numScenarios ?? 100
  const criteria = input.criteria ?? DEFAULT_ACCEPTANCE_CRITERIA

  // Generate varied scenarios.
  const hours = [3, 7, 12, 14, 17, 18, 19, 20, 22]
  const durations = [1, 2, 3, 4]
  const powers = [2, 5, 8, 10]

  const allEvals: Record<string, BaselineEval[]> = {}
  const scenarioParams: Array<{ seed: number; hour: number; duration: number; power: number }> = []

  let idx = 0
  for (let seed = 1; seed <= N; seed++) {
    const hour = hours[idx % hours.length]
    const duration = durations[idx % durations.length]
    const power = powers[idx % powers.length]
    idx++
    scenarioParams.push({ seed, hour, duration, power })

    const sim = new DERHistorySimulator(seed)
    const history = sim.generateHistory(14, hour, duration, power)
    const evals = evaluateAllBaselines(history)
    for (const e of evals) {
      if (!allEvals[e.method]) allEvals[e.method] = []
      allEvals[e.method].push(e)
    }
  }

  // Select strategy.
  const selection = selectBaselineStrategy(allEvals, criteria)

  // Create a deterministic scenario hash for reproducibility.
  const scenarioDatasetHash = JSON.stringify(scenarioParams).split('').reduce((h, c) => {
    return ((h << 5) - h + c.charCodeAt(0)) | 0
  }, 0).toString(16)

  const evaluationId = `eval-${Date.now()}`

  // Persist the evaluation record.
  const evaluation = await db.baselineEvaluation.create({
    data: {
      tenantId: input.tenantId,
      networkVersionId: input.networkVersionId ?? null,
      evaluationId,
      simulatorVersion: SIMULATOR_VERSION,
      engineVersion: ENGINE_VERSION,
      scenarioDatasetHash,
      numScenarios: N,
      criteriaJson: JSON.stringify(criteria),
      metricsJson: JSON.stringify(selection.allMetrics),
      selectedStrategy: selection.policy.selectedStrategy || '',
      status: selection.policy.status,
    },
  })

  // If a networkVersionId was provided, persist the policy on the version.
  if (input.networkVersionId) {
    const version = await db.networkVersion.findUnique({ where: { id: input.networkVersionId } })
    if (version && !version.publishedAt) {
      // Only set policy on unpublished versions (immutable after publish).
      await db.networkVersion.update({
        where: { id: input.networkVersionId },
        data: { baselinePolicyJson: JSON.stringify(selection.policy) },
      })
    }
  }

  return {
    evaluationId,
    policy: selection.policy,
    evaluationRecordId: evaluation.id,
  }
}

/**
 * Get the baseline policy for a network version.
 * Returns null if no policy is persisted.
 */
export async function getBaselinePolicy(networkVersionId: string): Promise<BaselinePolicy | null> {
  const version = await db.networkVersion.findUnique({ where: { id: networkVersionId } })
  if (!version || !version.baselinePolicyJson) return null
  return JSON.parse(version.baselinePolicyJson) as BaselinePolicy
}
