-- WORK-026 (IAAS-DOM-ARCH-6 §3.5 / NET-002): NetworkPlan
--
-- Adds the durable immutable resolution artifact ("launch plan") produced by
-- the Network-as-Code compiler from one immutable PUBLISHED NetworkVersion +
-- the authoritative repository state at resolution time.
--
-- Architectural boundaries (frozen by IAAS-DOM-ARCH-6):
--   - The plan is a COMPILED PROJECTION, not a new lifecycle authority: there
--     is NO lifecycle-state column and NO updatedAt — the row is write-once
--     (created by resolution, never updated). Lifecycle authority stays with
--     NetworkInstance (WORK-025); compilation never mutates instance state
--     (NET-002-AC03) and never mutates the source NetworkVersion
--     (NET-002-AC01).
--   - planJson is the CANONICAL deterministic serialization of the resolution
--     result (recursively key-sorted; every array in a canonical order);
--     planChecksum is sha256(planJson). The unique constraint on
--     (tenantId, networkVersionId, planChecksum) makes re-resolution under
--     unchanged repository state idempotent (NET-002-AC04).
--   - A changed repository state yields a different checksum → a NEW plan
--     row; prior plans are retained as immutable point-in-time evidence.
--   - Tenant scope is mandatory (platform tenant-scope invariant).
--   - No composition/federation semantics: no export/import columns, no
--     cross-network references (those are later Work Items).
--
-- PRODUCTION-SAFE GUARANTEES:
--   - No TRUNCATE, no DROP TABLE, no row removal.
--   - All DDL is idempotent (IF NOT EXISTS / pg_constraint guards).
--   - Creates only the NetworkPlan table + indexes + FKs.

-- ============================================================================
-- NetworkPlan table
-- ============================================================================

CREATE TABLE IF NOT EXISTS "NetworkPlan" (
    "id"               TEXT NOT NULL,
    "tenantId"         TEXT NOT NULL,
    "networkVersionId" TEXT NOT NULL,
    "planJson"         TEXT NOT NULL,
    "planChecksum"     TEXT NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NetworkPlan_pkey" PRIMARY KEY ("id")
);

-- Idempotent re-resolution under unchanged repository state: one artifact per
-- (tenant, source version, canonical checksum).
CREATE UNIQUE INDEX IF NOT EXISTS "NetworkPlan_tenantId_networkVersionId_planChecksum_key"
    ON "NetworkPlan"("tenantId", "networkVersionId", "planChecksum");
-- Tenant-scoped reads (platform tenant-scope invariant).
CREATE INDEX IF NOT EXISTS "NetworkPlan_tenantId_idx"
    ON "NetworkPlan"("tenantId");
-- Plan-per-version listing.
CREATE INDEX IF NOT EXISTS "NetworkPlan_networkVersionId_idx"
    ON "NetworkPlan"("networkVersionId");

-- NetworkPlan foreign key to Tenant (ON DELETE CASCADE — tenant deletion
-- removes the tenant's compiled plans).
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NetworkPlan_tenantId_fkey') THEN
        ALTER TABLE "NetworkPlan" ADD CONSTRAINT "NetworkPlan_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;
    END IF;
END $$;

-- NetworkPlan foreign key to NetworkVersion. Required (the plan compiles
-- exactly one immutable published source version) and RESTRICT: a published
-- version carrying plans cannot be deleted. The version is never mutated by
-- compilation.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NetworkPlan_networkVersionId_fkey') THEN
        ALTER TABLE "NetworkPlan" ADD CONSTRAINT "NetworkPlan_networkVersionId_fkey"
            FOREIGN KEY ("networkVersionId") REFERENCES "NetworkVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
