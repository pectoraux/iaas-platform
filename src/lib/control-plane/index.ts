// =============================================================================
// Control Plane: Index (Phase 12B — slice 1)
// =============================================================================
// Public exports for the control-plane layer. This module is the boundary
// between the control plane and the rest of the application.
//
// ARCHITECTURAL RULE: importing this module is a pure import — no side
// effects, no DB access, no kernel imports. The control plane is above the
// frozen kernel.
// =============================================================================

export type {
  ParticipantIdentity,
  ParticipantMembership,
  ParticipantRole,
  ResourceKind,
  ResourceIdentity,
  NetworkResourceMembership,
  CapacityEntry,
  NetworkRequest,
  CapabilityRequirement,
  CommitmentConstraint,
  CapacityConstraint,
  ServiceConstraint,
  AllocationDecision,
  ConstraintEvaluator,
  ConstraintObservationSnapshot,
  CapacitySourceSnapshot,
} from './types'

export {
  verifyNetworkScopeIntegrity,
  assertNetworkScopeIntegrity,
  NetworkScopeIntegrityError,
  authorizeRequest,
  computeDecisionSnapshotHash,
  createNetworkRequest,
  deriveRequestId,
  DefaultConstraintEvaluator,
  compareCanonicalStrings,
} from './types'

export { schedule, SCHEDULER_VERSION } from './scheduler'
export type { SchedulerInput, SchedulerResult } from './scheduler'

export {
  submitNetworkRequest,
  computePayloadHash,
  validateNoDuplicateCapabilityDimensions,
  IdempotencyConflictError,
  RequestAuthorizationError,
} from './service'
export type { SubmitNetworkRequestInput, SubmitNetworkRequestResult } from './service'
