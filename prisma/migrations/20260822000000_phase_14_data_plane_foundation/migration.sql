-- Phase 14A-F: Data Plane Foundation — production-safe migration.
--
-- This migration introduces ALL Phase 14A-F models that were previously
-- deployed via `prisma db push` (development mode). It is production-safe:
--   - No existing data is deleted.
--   - The TransformRecord.nodeIdentity column is added as nullable first,
--     backfilled from existing data, then set to NOT NULL.
--   - The unique constraint on TransformRecord uses nodeIdentity (non-null).
--
-- Models covered:
--   14A: Node, NodeNetworkMembership
--   14B: Bundle, BundleDelivery
--   14C: Route, RouteHop, NodeCapability, NodeReachability
--   14D: TransportExecution, TransportAttempt, TransportCapability
--   14E: DeliveryConfirmation
--   14F: TransformRecord
--
-- IMPORTANT: If the tables already exist (from `db push`), this migration
-- uses CREATE TABLE IF NOT EXISTS and ALTER TABLE ... ADD COLUMN IF NOT EXISTS
-- to be idempotent. The TransformRecord.nodeIdentity backfill is guarded by
-- a conditional check.

-- ============================================================================
-- Phase 14A: Node, NodeNetworkMembership
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Node" (
    "id"                      TEXT NOT NULL,
    "tenantId"                TEXT NOT NULL,
    "participantId"           TEXT,
    "deviceId"                TEXT,
    "resourceId"              TEXT,
    "nodeKind"                TEXT NOT NULL,
    "displayName"             TEXT NOT NULL,
    "status"                  TEXT NOT NULL DEFAULT 'registered',
    "protocolEligibilityJson" TEXT NOT NULL DEFAULT '[]',
    "idempotencyKey"          TEXT NOT NULL,
    "payloadHash"             TEXT NOT NULL,
    "metadataJson"            TEXT NOT NULL DEFAULT '{}',
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"               TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Node_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Node_tenantId_participantId_nodeKind_idempotencyKey_key"
    ON "Node"("tenantId", "participantId", "nodeKind", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "Node_tenantId_idx" ON "Node"("tenantId");
CREATE INDEX IF NOT EXISTS "Node_participantId_idx" ON "Node"("participantId");
CREATE INDEX IF NOT EXISTS "Node_deviceId_idx" ON "Node"("deviceId");
CREATE INDEX IF NOT EXISTS "Node_resourceId_idx" ON "Node"("resourceId");
CREATE INDEX IF NOT EXISTS "Node_status_idx" ON "Node"("status");

CREATE TABLE IF NOT EXISTS "NodeNetworkMembership" (
    "id"                      TEXT NOT NULL,
    "nodeId"                  TEXT NOT NULL,
    "networkId"               TEXT NOT NULL,
    "participantMembershipId" TEXT NOT NULL,
    "protocolRole"            TEXT NOT NULL DEFAULT 'participant',
    "status"                  TEXT NOT NULL DEFAULT 'active',
    "joinedAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"               TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NodeNetworkMembership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "NodeNetworkMembership_nodeId_networkId_key"
    ON "NodeNetworkMembership"("nodeId", "networkId");
CREATE INDEX IF NOT EXISTS "NodeNetworkMembership_networkId_idx" ON "NodeNetworkMembership"("networkId");
CREATE INDEX IF NOT EXISTS "NodeNetworkMembership_participantMembershipId_idx" ON "NodeNetworkMembership"("participantMembershipId");
CREATE INDEX IF NOT EXISTS "NodeNetworkMembership_status_idx" ON "NodeNetworkMembership"("status");

-- ============================================================================
-- Phase 14B: Bundle, BundleDelivery
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Bundle" (
    "id"                TEXT NOT NULL,
    "tenantId"          TEXT NOT NULL,
    "sourceNodeId"      TEXT NOT NULL,
    "destinationNodeId" TEXT NOT NULL,
    "nodeKind"          TEXT NOT NULL,
    "payloadType"       TEXT NOT NULL,
    "payloadHash"       TEXT NOT NULL,
    "payloadRef"        TEXT,
    "payloadBytesJson"  TEXT,
    "priority"          INTEGER NOT NULL DEFAULT 0,
    "nonce"             INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey"    TEXT NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'created',
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiryTime"        TIMESTAMP(3) NOT NULL,
    "deliveredAt"       TIMESTAMP(3),
    "metadataJson"      TEXT NOT NULL DEFAULT '{}',
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bundle_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Bundle_tenantId_idx" ON "Bundle"("tenantId");
CREATE INDEX IF NOT EXISTS "Bundle_sourceNodeId_idx" ON "Bundle"("sourceNodeId");
CREATE INDEX IF NOT EXISTS "Bundle_destinationNodeId_idx" ON "Bundle"("destinationNodeId");
CREATE INDEX IF NOT EXISTS "Bundle_status_idx" ON "Bundle"("status");
CREATE INDEX IF NOT EXISTS "Bundle_expiryTime_idx" ON "Bundle"("expiryTime");
CREATE INDEX IF NOT EXISTS "Bundle_priority_idx" ON "Bundle"("priority");

CREATE TABLE IF NOT EXISTS "BundleDelivery" (
    "id"              TEXT NOT NULL,
    "bundleId"        TEXT NOT NULL,
    "receiverNodeId"  TEXT NOT NULL,
    "tenantId"        TEXT NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'stored',
    "attemptCount"    INTEGER NOT NULL DEFAULT 1,
    "firstReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReceivedAt"  TIMESTAMP(3) NOT NULL,
    "deliveredAt"     TIMESTAMP(3),
    "metadataJson"    TEXT NOT NULL DEFAULT '{}',
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BundleDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BundleDelivery_bundleId_receiverNodeId_key"
    ON "BundleDelivery"("bundleId", "receiverNodeId");
CREATE INDEX IF NOT EXISTS "BundleDelivery_bundleId_idx" ON "BundleDelivery"("bundleId");
CREATE INDEX IF NOT EXISTS "BundleDelivery_receiverNodeId_idx" ON "BundleDelivery"("receiverNodeId");
CREATE INDEX IF NOT EXISTS "BundleDelivery_tenantId_idx" ON "BundleDelivery"("tenantId");
CREATE INDEX IF NOT EXISTS "BundleDelivery_status_idx" ON "BundleDelivery"("status");

-- ============================================================================
-- Phase 14C: Route, RouteHop, NodeCapability, NodeReachability
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Route" (
    "id"                TEXT NOT NULL,
    "tenantId"          TEXT NOT NULL,
    "bundleId"          TEXT NOT NULL,
    "sourceNodeId"      TEXT NOT NULL,
    "destinationNodeId" TEXT NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'planned',
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"         TIMESTAMP(3) NOT NULL,
    "completedAt"       TIMESTAMP(3),
    "metadataJson"      TEXT NOT NULL DEFAULT '{}',
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Route_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Route_tenantId_idx" ON "Route"("tenantId");
CREATE INDEX IF NOT EXISTS "Route_bundleId_idx" ON "Route"("bundleId");
CREATE INDEX IF NOT EXISTS "Route_sourceNodeId_idx" ON "Route"("sourceNodeId");
CREATE INDEX IF NOT EXISTS "Route_destinationNodeId_idx" ON "Route"("destinationNodeId");
CREATE INDEX IF NOT EXISTS "Route_status_idx" ON "Route"("status");
CREATE INDEX IF NOT EXISTS "Route_expiresAt_idx" ON "Route"("expiresAt");

CREATE TABLE IF NOT EXISTS "RouteHop" (
    "id"           TEXT NOT NULL,
    "routeId"      TEXT NOT NULL,
    "sequence"     INTEGER NOT NULL,
    "fromNodeId"   TEXT NOT NULL,
    "toNodeId"     TEXT NOT NULL,
    "status"       TEXT NOT NULL DEFAULT 'planned',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "RouteHop_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RouteHop_routeId_sequence_key" ON "RouteHop"("routeId", "sequence");
CREATE INDEX IF NOT EXISTS "RouteHop_routeId_idx" ON "RouteHop"("routeId");
CREATE INDEX IF NOT EXISTS "RouteHop_fromNodeId_idx" ON "RouteHop"("fromNodeId");
CREATE INDEX IF NOT EXISTS "RouteHop_toNodeId_idx" ON "RouteHop"("toNodeId");
CREATE INDEX IF NOT EXISTS "RouteHop_status_idx" ON "RouteHop"("status");

CREATE TABLE IF NOT EXISTS "NodeCapability" (
    "id"         TEXT NOT NULL,
    "tenantId"   TEXT NOT NULL,
    "nodeId"     TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "status"     TEXT NOT NULL DEFAULT 'active',
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NodeCapability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "NodeCapability_nodeId_capability_key" ON "NodeCapability"("nodeId", "capability");
CREATE INDEX IF NOT EXISTS "NodeCapability_nodeId_idx" ON "NodeCapability"("nodeId");
CREATE INDEX IF NOT EXISTS "NodeCapability_capability_idx" ON "NodeCapability"("capability");
CREATE INDEX IF NOT EXISTS "NodeCapability_status_idx" ON "NodeCapability"("status");

CREATE TABLE IF NOT EXISTS "NodeReachability" (
    "id"           TEXT NOT NULL,
    "tenantId"     TEXT NOT NULL,
    "nodeId"       TEXT NOT NULL,
    "reachable"    BOOLEAN NOT NULL DEFAULT false,
    "lastSeen"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latencyHint"  INTEGER,
    "expiresAt"    TIMESTAMP(3) NOT NULL,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NodeReachability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "NodeReachability_nodeId_key" ON "NodeReachability"("nodeId");
CREATE INDEX IF NOT EXISTS "NodeReachability_tenantId_idx" ON "NodeReachability"("tenantId");
CREATE INDEX IF NOT EXISTS "NodeReachability_reachable_idx" ON "NodeReachability"("reachable");
CREATE INDEX IF NOT EXISTS "NodeReachability_expiresAt_idx" ON "NodeReachability"("expiresAt");

-- ============================================================================
-- Phase 14D: TransportExecution, TransportAttempt, TransportCapability
-- ============================================================================

CREATE TABLE IF NOT EXISTS "TransportExecution" (
    "id"             TEXT NOT NULL,
    "tenantId"       TEXT NOT NULL,
    "routeId"        TEXT NOT NULL,
    "bundleId"       TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status"         TEXT NOT NULL DEFAULT 'created',
    "attemptNumber"  INTEGER NOT NULL DEFAULT 1,
    "failureReason"  TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt"      TIMESTAMP(3),
    "completedAt"    TIMESTAMP(3),
    "cancelledAt"    TIMESTAMP(3),
    "metadataJson"   TEXT NOT NULL DEFAULT '{}',
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransportExecution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TransportExecution_tenantId_routeId_bundleId_idempotencyKey_key"
    ON "TransportExecution"("tenantId", "routeId", "bundleId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "TransportExecution_tenantId_idx" ON "TransportExecution"("tenantId");
CREATE INDEX IF NOT EXISTS "TransportExecution_routeId_idx" ON "TransportExecution"("routeId");
CREATE INDEX IF NOT EXISTS "TransportExecution_bundleId_idx" ON "TransportExecution"("bundleId");
CREATE INDEX IF NOT EXISTS "TransportExecution_status_idx" ON "TransportExecution"("status");
CREATE INDEX IF NOT EXISTS "TransportExecution_attemptNumber_idx" ON "TransportExecution"("attemptNumber");

CREATE TABLE IF NOT EXISTS "TransportAttempt" (
    "id"            TEXT NOT NULL,
    "executionId"   TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "fromNodeId"    TEXT NOT NULL,
    "toNodeId"      TEXT NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'created',
    "startedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"   TIMESTAMP(3),
    "errorCode"     TEXT,
    "metadataJson"  TEXT NOT NULL DEFAULT '{}',
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransportAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TransportAttempt_executionId_attemptNumber_key"
    ON "TransportAttempt"("executionId", "attemptNumber");
CREATE INDEX IF NOT EXISTS "TransportAttempt_executionId_idx" ON "TransportAttempt"("executionId");
CREATE INDEX IF NOT EXISTS "TransportAttempt_fromNodeId_idx" ON "TransportAttempt"("fromNodeId");
CREATE INDEX IF NOT EXISTS "TransportAttempt_toNodeId_idx" ON "TransportAttempt"("toNodeId");
CREATE INDEX IF NOT EXISTS "TransportAttempt_status_idx" ON "TransportAttempt"("status");
CREATE INDEX IF NOT EXISTS "TransportAttempt_createdAt_idx" ON "TransportAttempt"("createdAt");

CREATE TABLE IF NOT EXISTS "TransportCapability" (
    "id"         TEXT NOT NULL,
    "tenantId"   TEXT NOT NULL,
    "nodeId"     TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "status"     TEXT NOT NULL DEFAULT 'active',
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransportCapability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TransportCapability_nodeId_capability_key"
    ON "TransportCapability"("nodeId", "capability");
CREATE INDEX IF NOT EXISTS "TransportCapability_nodeId_idx" ON "TransportCapability"("nodeId");
CREATE INDEX IF NOT EXISTS "TransportCapability_capability_idx" ON "TransportCapability"("capability");
CREATE INDEX IF NOT EXISTS "TransportCapability_status_idx" ON "TransportCapability"("status");

-- ============================================================================
-- Phase 14E: DeliveryConfirmation
-- ============================================================================

CREATE TABLE IF NOT EXISTS "DeliveryConfirmation" (
    "id"                 TEXT NOT NULL,
    "tenantId"           TEXT NOT NULL,
    "bundleId"           TEXT NOT NULL,
    "transportAttemptId" TEXT,
    "receiverNodeId"     TEXT NOT NULL,
    "idempotencyKey"     TEXT NOT NULL,
    "confirmationHash"   TEXT NOT NULL,
    "confirmedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadataJson"       TEXT NOT NULL DEFAULT '{}',
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryConfirmation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DeliveryConfirmation_tenantId_bundleId_receiverNodeId_idempotencyKey_key"
    ON "DeliveryConfirmation"("tenantId", "bundleId", "receiverNodeId", "idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "DeliveryConfirmation_transportAttemptId_key"
    ON "DeliveryConfirmation"("transportAttemptId");
CREATE INDEX IF NOT EXISTS "DeliveryConfirmation_tenantId_idx" ON "DeliveryConfirmation"("tenantId");
CREATE INDEX IF NOT EXISTS "DeliveryConfirmation_bundleId_idx" ON "DeliveryConfirmation"("bundleId");
CREATE INDEX IF NOT EXISTS "DeliveryConfirmation_transportAttemptId_idx" ON "DeliveryConfirmation"("transportAttemptId");
CREATE INDEX IF NOT EXISTS "DeliveryConfirmation_receiverNodeId_idx" ON "DeliveryConfirmation"("receiverNodeId");
CREATE INDEX IF NOT EXISTS "DeliveryConfirmation_confirmedAt_idx" ON "DeliveryConfirmation"("confirmedAt");

-- ============================================================================
-- Phase 14F: TransformRecord — PRODUCTION-SAFE MIGRATION
-- ============================================================================
-- The TransformRecord table may already exist (from `db push`).
-- This section handles:
--   1. CREATE TABLE IF NOT EXISTS (for fresh deployments)
--   2. ADD COLUMN nodeIdentity IF NOT EXISTS (for existing deployments via db push)
--   3. BACKFILL nodeIdentity from existing data (no deletion)
--   4. DETECT and REPORT any duplicate system-applied identities
--   5. SET nodeIdentity NOT NULL (after backfill)
--   6. CREATE the corrected unique constraint
-- ============================================================================

CREATE TABLE IF NOT EXISTS "TransformRecord" (
    "id"                 TEXT NOT NULL,
    "tenantId"           TEXT NOT NULL,
    "bundleId"           TEXT NOT NULL,
    "nodeId"             TEXT,
    "nodeIdentity"       TEXT,
    "transformType"      TEXT NOT NULL,
    "transformVersion"   TEXT NOT NULL,
    "inputHash"          TEXT NOT NULL,
    "outputHash"         TEXT NOT NULL,
    "parametersJson"     TEXT NOT NULL DEFAULT '{}',
    "resultStatus"       TEXT NOT NULL DEFAULT 'success',
    "resultMetadataJson" TEXT NOT NULL DEFAULT '{}',
    "idempotencyKey"     TEXT NOT NULL,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransformRecord_pkey" PRIMARY KEY ("id")
);

-- Add nodeIdentity column if it doesn't exist (for existing deployments via db push
-- that created the table without this column).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'TransformRecord' AND column_name = 'nodeIdentity'
    ) THEN
        ALTER TABLE "TransformRecord" ADD COLUMN "nodeIdentity" TEXT;
    END IF;
END $$;

-- Backfill nodeIdentity from existing data. NO DELETION.
-- Uses namespaced encoding:
--   nodeId IS NOT NULL → 'node:' || nodeId
--   nodeId IS NULL     → 'system:__unattributed__'
-- Only updates rows where nodeIdentity is NULL or has the old encoding
-- (bare nodeId or '__system__' sentinel).
UPDATE "TransformRecord"
SET "nodeIdentity" = 'node:' || "nodeId"
WHERE "nodeId" IS NOT NULL
  AND ("nodeIdentity" IS NULL
       OR "nodeIdentity" = '__system__'
       OR ("nodeIdentity" NOT LIKE 'node:%' AND "nodeIdentity" NOT LIKE 'system:%'));

UPDATE "TransformRecord"
SET "nodeIdentity" = 'system:__unattributed__'
WHERE "nodeId" IS NULL
  AND ("nodeIdentity" IS NULL OR "nodeIdentity" = '__system__');

-- Detect and report any duplicate system-applied identities BEFORE enforcing NOT NULL.
-- If duplicates exist (from the old nullable-nodeId bug), they must be resolved
-- manually before the unique constraint can be created. This migration does NOT
-- silently delete or merge them.
-- The query below raises an exception if duplicates are found, providing the
-- specific conflicting identity for manual resolution.
DO $$
DECLARE
    dup_count INTEGER;
    dup_details TEXT;
BEGIN
    SELECT COUNT(*) INTO dup_count
    FROM (
        SELECT "tenantId", "bundleId", "nodeIdentity", "transformType", "idempotencyKey"
        FROM "TransformRecord"
        WHERE "nodeIdentity" IS NOT NULL
        GROUP BY "tenantId", "bundleId", "nodeIdentity", "transformType", "idempotencyKey"
        HAVING COUNT(*) > 1
    ) dups;

    IF dup_count > 0 THEN
        SELECT string_agg(DISTINCT
            "tenantId" || '/' || "bundleId" || '/' || "nodeIdentity" || '/' || "transformType" || '/' || "idempotencyKey",
            ', '
        ) INTO dup_details
        FROM (
            SELECT "tenantId", "bundleId", "nodeIdentity", "transformType", "idempotencyKey"
            FROM "TransformRecord"
            WHERE "nodeIdentity" IS NOT NULL
            GROUP BY "tenantId", "bundleId", "nodeIdentity", "transformType", "idempotencyKey"
            HAVING COUNT(*) > 1
        ) dups;

        RAISE EXCEPTION 'TransformRecord migration blocked: % duplicate identity group(s) found. Resolve manually before retrying: %', dup_count, dup_details;
    END IF;
END $$;

-- Set nodeIdentity NOT NULL (after backfill — all rows now have a value).
ALTER TABLE "TransformRecord" ALTER COLUMN "nodeIdentity" SET NOT NULL;

-- Drop any old unique constraint that used nullable nodeId (if it exists).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'TransformRecord_tenantId_bundleId_nodeId_transformType_idempotencyKey_key'
    ) THEN
        ALTER TABLE "TransformRecord"
        DROP CONSTRAINT "TransformRecord_tenantId_bundleId_nodeId_transformType_idempotencyKey_key";
    END IF;
END $$;

-- Create the corrected unique constraint using non-null nodeIdentity.
CREATE UNIQUE INDEX IF NOT EXISTS "TransformRecord_tenantId_bundleId_nodeIdentity_transformType_idempotencyKey_key"
    ON "TransformRecord"("tenantId", "bundleId", "nodeIdentity", "transformType", "idempotencyKey");

CREATE INDEX IF NOT EXISTS "TransformRecord_tenantId_idx" ON "TransformRecord"("tenantId");
CREATE INDEX IF NOT EXISTS "TransformRecord_bundleId_idx" ON "TransformRecord"("bundleId");
CREATE INDEX IF NOT EXISTS "TransformRecord_nodeId_idx" ON "TransformRecord"("nodeId");
CREATE INDEX IF NOT EXISTS "TransformRecord_nodeIdentity_idx" ON "TransformRecord"("nodeIdentity");
CREATE INDEX IF NOT EXISTS "TransformRecord_transformType_idx" ON "TransformRecord"("transformType");
CREATE INDEX IF NOT EXISTS "TransformRecord_resultStatus_idx" ON "TransformRecord"("resultStatus");
CREATE INDEX IF NOT EXISTS "TransformRecord_createdAt_idx" ON "TransformRecord"("createdAt");
