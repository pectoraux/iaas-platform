-- Phase 12B Slice 2: Change AllocationReservation unique constraint
-- from (decisionId, capabilityType) to (decisionId, capabilityType, unit)
-- to support multi-dimensional capabilities (e.g., compute/GPU + compute/cores).

-- Drop the old unique constraint and create the new one.
-- The constraint name follows Prisma's naming convention.
DROP INDEX IF EXISTS "AllocationReservation_decisionId_capabilityType_key";
CREATE UNIQUE INDEX "AllocationReservation_decisionId_capabilityType_unit_key"
  ON "AllocationReservation" ("decisionId", "capabilityType", "unit");
