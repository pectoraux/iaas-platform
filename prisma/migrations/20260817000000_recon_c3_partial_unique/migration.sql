-- Phase 11B Defect 9 fix: C3 partial unique index as a proper migration.
--
-- C3 (race-proof): at most one PENDING ReconciliationAttempt per evidenceId
-- at a time, enforced at the DATABASE level (not application-level check-then-
-- insert, which is not race-proof under PostgreSQL READ COMMITTED).
--
-- This partial unique index is the canonical PostgreSQL mechanism:
--   - Two concurrent INSERTs of PENDING for the same evidenceId cannot both
--     succeed — one fails with a unique violation (P2002 in Prisma).
--   - Terminal attempts (status != 'PENDING') do NOT conflict with new PENDING
--     attempts, so a retry after failure legitimately creates a new row.
--
-- This migration is the source of truth for the index. The application-startup
-- ensureC3UniqueIndex() method in PostgresReconciliationStore is now a safety
-- net (CREATE UNIQUE INDEX IF NOT EXISTS) for environments that haven't run
-- this migration, NOT the primary creation path.
--
-- See: docs/phase-11a-protocol-specification.md §4.2 C3.

CREATE UNIQUE INDEX IF NOT EXISTS "recon_attempt_pending_unique"
  ON "ReconciliationAttempt" ("evidenceId")
  WHERE "status" = 'PENDING';
