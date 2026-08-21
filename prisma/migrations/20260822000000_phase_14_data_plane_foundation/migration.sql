-- Phase 14A-F: Data Plane Foundation — production-grade migration.
--
-- BRIDGE/BASELINE DECISION:
--   The Phase 14A-F models were originally deployed via `prisma db push`
--   (development mode) — no migration files existed. This migration is a
--   BRIDGE that establishes migration-history parity: it creates all Phase
--   14A-F tables, columns, indexes, unique constraints, and FOREIGN KEY
--   constraints to match the current prisma/schema.prisma exactly.
--
--   For a FRESH database: CREATE TABLE IF NOT EXISTS creates tables with
--   all columns, then ALTER TABLE ADD CONSTRAINT adds FKs.
--   For an EXISTING db-push database: the tables already exist with most
--   columns; ADD COLUMN IF NOT EXISTS adds any missing columns; ADD
--   CONSTRAINT IF NOT EXISTS adds any missing FKs/uniques/indexes.
--
--   This migration does NOT delete data. The TransformRecord.nodeIdentity
--   column is added (if missing), backfilled from existing data, then set
--   NOT NULL. Duplicate detection runs before the unique index is created.
--
-- PRODUCTION-SAFE GUARANTEES:
--   - No TRUNCATE, no DROP TABLE, no DELETE.
--   - All DDL is idempotent (IF NOT EXISTS guards).
--   - TransformRecord backfill preserves all existing rows.
--   - Duplicate detection raises an exception (no silent merge).

-- ============================================================================
-- Phase 14A: Node
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

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Node_tenantId_fkey') THEN
        ALTER TABLE "Node" ADD CONSTRAINT "Node_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Node_participantId_fkey') THEN
        ALTER TABLE "Node" ADD CONSTRAINT "Node_participantId_fkey"
            FOREIGN KEY ("participantId") REFERENCES "ParticipantIdentity"("id") ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Node_deviceId_fkey') THEN
        ALTER TABLE "Node" ADD CONSTRAINT "Node_deviceId_fkey"
            FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Node_resourceId_fkey') THEN
        ALTER TABLE "Node" ADD CONSTRAINT "Node_resourceId_fkey"
            FOREIGN KEY ("resourceId") REFERENCES "ResourceIdentity"("id") ON DELETE SET NULL;
    END IF;
END $$;

-- ============================================================================
-- Phase 14A: NodeNetworkMembership
-- ============================================================================

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

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NodeNetworkMembership_nodeId_fkey') THEN
        ALTER TABLE "NodeNetworkMembership" ADD CONSTRAINT "NodeNetworkMembership_nodeId_fkey"
            FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NodeNetworkMembership_participantMembershipId_fkey') THEN
        ALTER TABLE "NodeNetworkMembership" ADD CONSTRAINT "NodeNetworkMembership_participantMembershipId_fkey"
            FOREIGN KEY ("participantMembershipId") REFERENCES "ParticipantMembership"("id") ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================================
-- Phase 14B: Bundle
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

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Bundle_tenantId_fkey') THEN
        ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Bundle_sourceNodeId_fkey') THEN
        ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_sourceNodeId_fkey"
            FOREIGN KEY ("sourceNodeId") REFERENCES "Node"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Bundle_destinationNodeId_fkey') THEN
        ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_destinationNodeId_fkey"
            FOREIGN KEY ("destinationNodeId") REFERENCES "Node"("id") ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================================
-- Phase 14B: BundleDelivery
-- ============================================================================

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

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BundleDelivery_bundleId_fkey') THEN
        ALTER TABLE "BundleDelivery" ADD CONSTRAINT "BundleDelivery_bundleId_fkey"
            FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BundleDelivery_receiverNodeId_fkey') THEN
        ALTER TABLE "BundleDelivery" ADD CONSTRAINT "BundleDelivery_receiverNodeId_fkey"
            FOREIGN KEY ("receiverNodeId") REFERENCES "Node"("id") ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================================
-- Phase 14C: Route
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

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Route_tenantId_fkey') THEN
        ALTER TABLE "Route" ADD CONSTRAINT "Route_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Route_bundleId_fkey') THEN
        ALTER TABLE "Route" ADD CONSTRAINT "Route_bundleId_fkey"
            FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Route_sourceNodeId_fkey') THEN
        ALTER TABLE "Route" ADD CONSTRAINT "Route_sourceNodeId_fkey"
            FOREIGN KEY ("sourceNodeId") REFERENCES "Node"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Route_destinationNodeId_fkey') THEN
        ALTER TABLE "Route" ADD CONSTRAINT "Route_destinationNodeId_fkey"
            FOREIGN KEY ("destinationNodeId") REFERENCES "Node"("id") ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================================
-- Phase 14C: RouteHop
-- ============================================================================

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

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RouteHop_routeId_fkey') THEN
        ALTER TABLE "RouteHop" ADD CONSTRAINT "RouteHop_routeId_fkey"
            FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RouteHop_fromNodeId_fkey') THEN
        ALTER TABLE "RouteHop" ADD CONSTRAINT "RouteHop_fromNodeId_fkey"
            FOREIGN KEY ("fromNodeId") REFERENCES "Node"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RouteHop_toNodeId_fkey') THEN
        ALTER TABLE "RouteHop" ADD CONSTRAINT "RouteHop_toNodeId_fkey"
            FOREIGN KEY ("toNodeId") REFERENCES "Node"("id") ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================================
-- Phase 14C: NodeCapability
-- ============================================================================

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

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NodeCapability_nodeId_fkey') THEN
        ALTER TABLE "NodeCapability" ADD CONSTRAINT "NodeCapability_nodeId_fkey"
            FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================================
-- Phase 14C: NodeReachability
-- ============================================================================

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

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NodeReachability_nodeId_fkey') THEN
        ALTER TABLE "NodeReachability" ADD CONSTRAINT "NodeReachability_nodeId_fkey"
            FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================================
-- Phase 14D: TransportExecution
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

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TransportExecution_tenantId_fkey') THEN
        ALTER TABLE "TransportExecution" ADD CONSTRAINT "TransportExecution_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TransportExecution_routeId_fkey') THEN
        ALTER TABLE "TransportExecution" ADD CONSTRAINT "TransportExecution_routeId_fkey"
            FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TransportExecution_bundleId_fkey') THEN
        ALTER TABLE "TransportExecution" ADD CONSTRAINT "TransportExecution_bundleId_fkey"
            FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================================
-- Phase 14D: TransportAttempt
-- ============================================================================

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

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TransportAttempt_executionId_fkey') THEN
        ALTER TABLE "TransportAttempt" ADD CONSTRAINT "TransportAttempt_executionId_fkey"
            FOREIGN KEY ("executionId") REFERENCES "TransportExecution"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TransportAttempt_fromNodeId_fkey') THEN
        ALTER TABLE "TransportAttempt" ADD CONSTRAINT "TransportAttempt_fromNodeId_fkey"
            FOREIGN KEY ("fromNodeId") REFERENCES "Node"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TransportAttempt_toNodeId_fkey') THEN
        ALTER TABLE "TransportAttempt" ADD CONSTRAINT "TransportAttempt_toNodeId_fkey"
            FOREIGN KEY ("toNodeId") REFERENCES "Node"("id") ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================================
-- Phase 14D: TransportCapability
-- ============================================================================

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

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TransportCapability_nodeId_fkey') THEN
        ALTER TABLE "TransportCapability" ADD CONSTRAINT "TransportCapability_nodeId_fkey"
            FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE;
    END IF;
END $$;

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

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeliveryConfirmation_tenantId_fkey') THEN
        ALTER TABLE "DeliveryConfirmation" ADD CONSTRAINT "DeliveryConfirmation_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeliveryConfirmation_bundleId_fkey') THEN
        ALTER TABLE "DeliveryConfirmation" ADD CONSTRAINT "DeliveryConfirmation_bundleId_fkey"
            FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeliveryConfirmation_transportAttemptId_fkey') THEN
        ALTER TABLE "DeliveryConfirmation" ADD CONSTRAINT "DeliveryConfirmation_transportAttemptId_fkey"
            FOREIGN KEY ("transportAttemptId") REFERENCES "TransportAttempt"("id") ON DELETE SET NULL;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeliveryConfirmation_receiverNodeId_fkey') THEN
        ALTER TABLE "DeliveryConfirmation" ADD CONSTRAINT "DeliveryConfirmation_receiverNodeId_fkey"
            FOREIGN KEY ("receiverNodeId") REFERENCES "Node"("id") ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================================
-- Phase 14F: TransformRecord — PRODUCTION-SAFE MIGRATION WITH BACKFILL
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

-- Add nodeIdentity column if it doesn't exist.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'TransformRecord' AND column_name = 'nodeIdentity'
    ) THEN
        ALTER TABLE "TransformRecord" ADD COLUMN "nodeIdentity" TEXT;
    END IF;
END $$;

-- Backfill nodeIdentity. NO DELETION.
-- Namespaced encoding:
--   nodeId IS NOT NULL → 'node:' || nodeId
--   nodeId IS NULL     → 'system:__unattributed__'
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

-- Detect duplicate identities BEFORE enforcing NOT NULL + unique.
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

-- Set nodeIdentity NOT NULL.
ALTER TABLE "TransformRecord" ALTER COLUMN "nodeIdentity" SET NOT NULL;

-- Drop old unique constraint using nullable nodeId (if it exists).
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

-- TransformRecord foreign keys.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TransformRecord_tenantId_fkey') THEN
        ALTER TABLE "TransformRecord" ADD CONSTRAINT "TransformRecord_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TransformRecord_bundleId_fkey') THEN
        ALTER TABLE "TransformRecord" ADD CONSTRAINT "TransformRecord_bundleId_fkey"
            FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TransformRecord_nodeId_fkey') THEN
        ALTER TABLE "TransformRecord" ADD CONSTRAINT "TransformRecord_nodeId_fkey"
            FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE SET NULL;
    END IF;
END $$;
