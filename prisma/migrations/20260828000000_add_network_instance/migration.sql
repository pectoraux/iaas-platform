-- WORK-025 (IAAS-DOM-ARCH-6 §3.3 / NET-001): NetworkInstance
--
-- Adds the durable identity + lifecycle authority for a deployed
-- NetworkInstance: one realized deployment of exactly one immutable PUBLISHED
-- NetworkVersion.
--
-- Architectural boundaries (frozen by IAAS-DOM-ARCH-6):
--   - Identity is DISTINCT from NetworkDefinition/NetworkVersion identity —
--     own durable primary key; many instances may derive from the same
--     published version (no unique constraint on networkVersionId).
--   - lifecycleState is owned by the Network Lifecycle subsystem:
--       planned → provisioning → validating → active ⇌ paused
--       → draining → terminated → archived (terminal)
--     Failure/rollback transitions are explicit (provisioning/validating
--     failure and pre-provisioning abandonment go straight to `terminated`)
--     and NEVER mutate the published NetworkVersion.
--   - Tenant scope is mandatory — tenant-scoped reads/updates only.
--   - Terminal states preserve the row (no deletion path): audit/evidence is
--     retained after termination/archive (V6 §3.3).
--   - No composition/federation semantics: no parent/child instance columns,
--     no export/import binding columns.
--
-- PRODUCTION-SAFE GUARANTEES:
--   - No TRUNCATE, no DROP TABLE, no row removal.
--   - All DDL is idempotent (IF NOT EXISTS / pg_constraint guards).
--   - Creates only the NetworkInstance table + indexes + FKs.

-- ============================================================================
-- NetworkInstance table
-- ============================================================================

CREATE TABLE IF NOT EXISTS "NetworkInstance" (
    "id"               TEXT NOT NULL,
    "tenantId"         TEXT NOT NULL,
    "networkVersionId" TEXT NOT NULL,
    "label"            TEXT,
    "lifecycleState"   TEXT NOT NULL DEFAULT 'planned',
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NetworkInstance_pkey" PRIMARY KEY ("id")
);

-- Tenant-scoped reads (NET-001-AC03).
CREATE INDEX IF NOT EXISTS "NetworkInstance_tenantId_idx"
    ON "NetworkInstance"("tenantId");
CREATE INDEX IF NOT EXISTS "NetworkInstance_tenantId_lifecycleState_idx"
    ON "NetworkInstance"("tenantId", "lifecycleState");
-- Instance-per-version listing (§3.3 "may be one of many instances derived
-- from the same version") — a plain index, NOT a unique constraint.
CREATE INDEX IF NOT EXISTS "NetworkInstance_networkVersionId_idx"
    ON "NetworkInstance"("networkVersionId");

-- NetworkInstance foreign key to Tenant (ON DELETE CASCADE — tenant deletion
-- removes the tenant's instances).
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NetworkInstance_tenantId_fkey') THEN
        ALTER TABLE "NetworkInstance" ADD CONSTRAINT "NetworkInstance_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;
    END IF;
END $$;

-- NetworkInstance foreign key to NetworkVersion. Required (exactly one source
-- version, NET-001-AC01) and RESTRICT: a published version carrying instances
-- cannot be deleted. The version is never mutated by instance lifecycle.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NetworkInstance_networkVersionId_fkey') THEN
        ALTER TABLE "NetworkInstance" ADD CONSTRAINT "NetworkInstance_networkVersionId_fkey"
            FOREIGN KEY ("networkVersionId") REFERENCES "NetworkVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
