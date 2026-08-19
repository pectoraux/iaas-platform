-- Phase 12B Slice 6: Economic Pipeline State — generic checkpoint + reconciliation
--
-- Adds the EconomicPipelineState model — a 1:1 checkpoint on ExecutionAssignment
-- that tracks the progress of the economic pipeline:
--   evidence_pending → evidence_recorded → verified → contribution_created
--   → reward_calculated → ledger_posted → settlement_created → completed
--   → reconciliation_required (on partial failure)
--
-- This is NOT a new economic primitive. It is the durable checkpoint layer that
-- ties together the EXISTING generic primitives (Event, VerificationResult,
-- Attestation, Contribution, Reward, LedgerPosting, Settlement).

CREATE TABLE "EconomicPipelineState" (
  "id"                      TEXT NOT NULL,
  "executionAssignmentId"   TEXT NOT NULL,
  "tenantId"                TEXT NOT NULL,
  "networkVersionId"        TEXT NOT NULL,
  "networkId"               TEXT NOT NULL,
  "stage"                   TEXT NOT NULL DEFAULT 'evidence_pending',
  "eventIdempotencyKey"     TEXT NOT NULL,
  "contributionIdempotencyKey" TEXT NOT NULL,
  "rewardIdempotencyKey"    TEXT NOT NULL,
  "ledgerIdempotencyKey"    TEXT NOT NULL,
  "settlementIdempotencyKey" TEXT NOT NULL,
  "eventId"                 TEXT,
  "attestationId"           TEXT,
  "contributionId"          TEXT,
  "rewardId"                TEXT,
  "ledgerPostingId"         TEXT,
  "settlementId"            TEXT,
  "reconciliationReason"    TEXT,
  "lastReconciledAt"        TIMESTAMP(3),
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,

  CONSTRAINT "EconomicPipelineState_pkey" PRIMARY KEY ("id")
);

-- 1:1 with ExecutionAssignment (unique).
CREATE UNIQUE INDEX "EconomicPipelineState_executionAssignmentId_key"
  ON "EconomicPipelineState" ("executionAssignmentId");

-- FK to ExecutionAssignment (cascade on delete).
ALTER TABLE "EconomicPipelineState"
  ADD CONSTRAINT "EconomicPipelineState_executionAssignmentId_fkey"
  FOREIGN KEY ("executionAssignmentId") REFERENCES "ExecutionAssignment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Helpful indexes.
CREATE INDEX "EconomicPipelineState_tenantId_idx"
  ON "EconomicPipelineState" ("tenantId");
CREATE INDEX "EconomicPipelineState_stage_idx"
  ON "EconomicPipelineState" ("stage");
CREATE INDEX "EconomicPipelineState_networkVersionId_idx"
  ON "EconomicPipelineState" ("networkVersionId");
