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
  validateNoDuplicateConstraintIds,
  IdempotencyConflictError,
  RequestAuthorizationError,
} from './service'
export type { SubmitNetworkRequestInput, SubmitNetworkRequestResult } from './service'

// Phase 12B Slice 3: Allocation → Commitment → Execution → Assignment orchestration.
// Phase 12B Slice 4: Actual execution (executeDecision) + stuck-state recovery.
// Phase 12B Slice 5: Execution ownership & fencing (ExecutionLease).
export {
  commitDecisionToExecution,
  releaseDecisionExecution,
  releaseFailedAssignments,
  executeDecision,
  recoverStuckAssignments,
  OrchestratorError,
  ExecutionFailedError,
  ProtocolRuntimeNotSupportedError,
  EXECUTION_SOURCE_TYPE,
  COMMITMENT_SOURCE_TYPE,
  EXECUTION_LEASE_MS,
} from './execution-orchestrator'
export type {
  CommitDecisionToExecutionResult,
  CommittedAssignment,
  ExecuteDecisionResult,
  ExecutedAssignment,
  RecoveredAssignment,
} from './execution-orchestrator'

// Phase 12B Slice 5: Execution lease primitives (ownership + fencing).
export {
  acquireExecutionLease,
  renewExecutionLease,
  completeExecutionLease,
  fenceExecutionLease,
  validateLeaseForExecution,
  DEFAULT_LEASE_MS,
  LEASE_STATUS,
  ASSIGNMENT_STATUS,
  LeaseConflictError,
  StaleLeaseError,
  UnsafeToRetryError,
} from './execution-lease'
export type {
  ExecutionLeaseRecord,
  LeaseStatus,
  FenceOutcome,
  AcquireLeaseResult,
  RenewLeaseResult,
  CompleteLeaseResult,
  FenceLeaseResult,
} from './execution-lease'
