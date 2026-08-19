-- Phase 12B Slice 5: Execution Ownership & Fencing
--
-- Adds the ExecutionLease model — ownership of a physical execution attempt.
-- At most one ACTIVE lease per ExecutionAssignment (DB-enforced via partial
-- unique index).
--
-- CRITICAL: lease expiry does NOT auto-transition. An expired lease is
-- detected by recovery, which then decides: fence (if adapter can cancel)
-- or unsafe_to_retry (if it cannot). Expiry is evidence recovery is needed,
-- NOT proof that physical execution stopped.

-- 1. Create the ExecutionLease table.
CREATE TABLE "ExecutionLease" (
  "id"                      TEXT NOT NULL,
  "executionAssignmentId"   TEXT NOT NULL,
  "leaseVersion"            INTEGER NOT NULL,
  "workerIdentity"          TEXT NOT NULL,
  "leaseUntil"              TIMESTAMP(3) NOT NULL,
  "status"                  TEXT NOT NULL DEFAULT 'active',
  "acquiredAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "renewedAt"               TIMESTAMP(3),
  "releasedAt"              TIMESTAMP(3),
  "fencedAt"                TIMESTAMP(3),
  "fenceReason"             TEXT,
  "fenceOutcome"            TEXT,

  CONSTRAINT "ExecutionLease_pkey" PRIMARY KEY ("id")
);

-- 2. Foreign key to ExecutionAssignment (cascade on delete).
ALTER TABLE "ExecutionLease"
  ADD CONSTRAINT "ExecutionLease_executionAssignmentId_fkey"
  FOREIGN KEY ("executionAssignmentId") REFERENCES "ExecutionAssignment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. E1 — SINGLE ACTIVE OWNER: partial unique index.
-- At most one row with status='active' per executionAssignmentId.
-- Two concurrent acquireExecutionLease calls cannot both create an active
-- lease for the same assignment — the second will fail with P2002.
CREATE UNIQUE INDEX "ExecutionLease_executionAssignmentId_status_active_key"
  ON "ExecutionLease" ("executionAssignmentId")
  WHERE "status" = 'active';

-- 4. Helpful indexes for recovery scans + worker queries.
CREATE INDEX "ExecutionLease_executionAssignmentId_idx"
  ON "ExecutionLease" ("executionAssignmentId");
CREATE INDEX "ExecutionLease_status_idx"
  ON "ExecutionLease" ("status");
CREATE INDEX "ExecutionLease_leaseUntil_idx"
  ON "ExecutionLease" ("leaseUntil");
CREATE INDEX "ExecutionLease_workerIdentity_idx"
  ON "ExecutionLease" ("workerIdentity");
