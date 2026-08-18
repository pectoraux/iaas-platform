-- Phase 12B Slice 3: Allocation → Commitment → Execution → Assignment
--
-- Adds the explicit cross-layer relationships and DB-level idempotency
-- constraints required for the control-plane orchestration layer:
--
--   1. Execution.networkVersionId — binds the Execution to the immutable
--      NetworkVersion the AllocationDecision was scheduled against.
--   2. CapacityCommitment.allocationReservationId — explicit FK linking a
--      commitment back to the AllocationReservation that produced it
--      (architectural improvement: explicit FKs, not sourceType/sourceId
--      semantic lookups).
--   3. CapacityCommitment @@unique([tenantId, sourceType, sourceId]) —
--      DB-level idempotency for commitment creation (closes the concurrent-
--      insert race window that the app-level findFirst could not fully
--      prevent).
--   4. ExecutionAssignment @@unique([capacityCommitmentId]) — DB-level
--      "one assignment per commitment" (the VPP 1:1 pattern, now structural).
--
-- All new columns are NULLable for backward compatibility with existing
-- VPP/Compute rows. The unique constraints respect SQL NULL semantics
-- (NULL sourceId / NULL capacityCommitmentId rows are not constrained).

-- 1. Execution.networkVersionId
ALTER TABLE "Execution" ADD COLUMN "networkVersionId" TEXT;

-- 2. CapacityCommitment.allocationReservationId
ALTER TABLE "CapacityCommitment" ADD COLUMN "allocationReservationId" TEXT;

-- 3. CapacityCommitment DB-level idempotency.
--    NOTE: a partial unique index would be ideal (WHERE "sourceId" IS NOT NULL),
--    but Prisma's @@unique maps to a full unique index. SQL NULL semantics
--    make the full index safe for legacy rows (multiple NULLs are allowed).
CREATE UNIQUE INDEX "CapacityCommitment_tenantId_sourceType_sourceId_key"
  ON "CapacityCommitment" ("tenantId", "sourceType", "sourceId");

-- 4. ExecutionAssignment DB-level "one assignment per commitment".
--    Same NULL-safety reasoning: legacy rows with NULL capacityCommitmentId
--    are not constrained.
CREATE UNIQUE INDEX "ExecutionAssignment_capacityCommitmentId_key"
  ON "ExecutionAssignment" ("capacityCommitmentId");

-- Foreign keys (Prisma does not emit ADD CONSTRAINT in db push, so we add
-- them explicitly for migration discipline).
ALTER TABLE "Execution"
  ADD CONSTRAINT "Execution_networkVersionId_fkey"
  FOREIGN KEY ("networkVersionId") REFERENCES "NetworkVersion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CapacityCommitment"
  ADD CONSTRAINT "CapacityCommitment_allocationReservationId_fkey"
  FOREIGN KEY ("allocationReservationId") REFERENCES "AllocationReservation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Helpful non-unique indexes for the new FK columns.
CREATE INDEX IF NOT EXISTS "Execution_networkVersionId_idx"
  ON "Execution" ("networkVersionId");
CREATE INDEX IF NOT EXISTS "CapacityCommitment_allocationReservationId_idx"
  ON "CapacityCommitment" ("allocationReservationId");
