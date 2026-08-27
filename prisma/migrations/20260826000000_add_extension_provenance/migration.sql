-- WORK-018 (IAAS-DOM-ARCH-4 / DOM-022): ExtensionProvenance
--
-- Adds the immutable durable provenance record for Extension execution.
-- Consumes payloads emitted by ExtensionRuntime through the
-- ExtensionProvenanceSink boundary contract.
--
-- Architectural boundaries (frozen by IAAS-DOM-ARCH-4 §2.4 / DOM-022):
--   - IMMUTABLE after creation — no mutation path, no updatedAt column.
--   - Tenant-scoped — all indexes include tenantId where applicable.
--   - One durable record per (tenantId, executionIdempotencyKey).
--   - SHA-256 fingerprint is globally unique (identical payloads converge 1:1).
--
-- PRODUCTION-SAFE GUARANTEES:
--   - No TRUNCATE, no DROP TABLE, no row removal.
--   - All DDL is idempotent (IF NOT EXISTS guards).
--   - Creates only the ExtensionProvenance table + Tenant back-relation.

-- ============================================================================
-- ExtensionProvenance table
-- ============================================================================

CREATE TABLE IF NOT EXISTS "ExtensionProvenance" (
    "id"                        TEXT NOT NULL,
    "tenantId"                  TEXT NOT NULL,
    "extensionType"             TEXT NOT NULL,
    "extensionVersion"          TEXT NOT NULL,
    "executionIdempotencyKey"   TEXT NOT NULL,
    "inputHash"                 TEXT NOT NULL,
    "outputHash"                TEXT NOT NULL,
    "resultStatus"              TEXT NOT NULL,
    "resourceUsageJson"         TEXT NOT NULL DEFAULT '{}',
    "capabilitiesExercisedJson" TEXT NOT NULL DEFAULT '[]',
    "tenantApprovedCeilingJson" TEXT NOT NULL DEFAULT '{}',
    "failureMetadataJson"       TEXT NOT NULL DEFAULT '{}',
    "fingerprint"               TEXT NOT NULL,
    "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExtensionProvenance_pkey" PRIMARY KEY ("id")
);

-- One durable record per (tenantId, executionIdempotencyKey).
CREATE UNIQUE INDEX IF NOT EXISTS "ExtensionProvenance_tenantId_executionIdempotencyKey_key"
    ON "ExtensionProvenance"("tenantId", "executionIdempotencyKey");

-- Identical payloads converge 1:1 (replay convergence by V4 §2.4 fingerprint).
CREATE UNIQUE INDEX IF NOT EXISTS "ExtensionProvenance_fingerprint_key"
    ON "ExtensionProvenance"("fingerprint");

-- Tenant-scoped indexes for reads.
CREATE INDEX IF NOT EXISTS "ExtensionProvenance_tenantId_idx"
    ON "ExtensionProvenance"("tenantId");
CREATE INDEX IF NOT EXISTS "ExtensionProvenance_extensionType_idx"
    ON "ExtensionProvenance"("extensionType");
CREATE INDEX IF NOT EXISTS "ExtensionProvenance_extensionVersion_idx"
    ON "ExtensionProvenance"("extensionVersion");
CREATE INDEX IF NOT EXISTS "ExtensionProvenance_resultStatus_idx"
    ON "ExtensionProvenance"("resultStatus");
CREATE INDEX IF NOT EXISTS "ExtensionProvenance_fingerprint_idx"
    ON "ExtensionProvenance"("fingerprint");
CREATE INDEX IF NOT EXISTS "ExtensionProvenance_createdAt_idx"
    ON "ExtensionProvenance"("createdAt");

-- ExtensionProvenance foreign key to Tenant (ON DELETE CASCADE — when a
-- tenant is deleted, all its provenance records are deleted too).
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ExtensionProvenance_tenantId_fkey') THEN
        ALTER TABLE "ExtensionProvenance" ADD CONSTRAINT "ExtensionProvenance_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;
    END IF;
END $$;
