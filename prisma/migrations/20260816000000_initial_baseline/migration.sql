-- Phase 11B baseline migration (Defect 11 fix — database lifecycle).
--
-- This migration creates the FULL schema from an empty database. It was
-- generated via `prisma migrate diff --from-empty --to-schema-datamodel
-- prisma/schema.prisma`. It establishes the migration baseline so that a
-- fresh PostgreSQL database can be provisioned entirely via `prisma migrate
-- deploy` — no `db push` required.
--
-- CONTEXT: the reconciliation tables (PhysicalExecutionEvidence,
-- ReconciliationAttempt, ProtocolOutcome) were originally created via
-- `db push` during Phase 11B implementation. The C3 partial-index migration
-- (20260817000000) assumed those tables existed, which broke fresh-DB
-- provisioning. This baseline migration fixes that by creating ALL tables
-- before the C3 index migration runs.
--
-- For databases previously created via `db push`: run
--   prisma migrate resolve --applied 20260816000000_initial_baseline
--   prisma migrate resolve --applied 20260817000000_recon_c3_partial_unique
-- to mark both migrations as applied without re-executing them, then
-- `prisma migrate deploy` will be a no-op. For fresh databases, `migrate deploy`
-- runs both migrations in order.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "plan" TEXT NOT NULL DEFAULT 'starter',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetworkDefinition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "vertical" TEXT NOT NULL DEFAULT 'generic',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NetworkDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetworkVersion" (
    "id" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "configurationJson" TEXT NOT NULL,
    "baselinePolicyJson" TEXT,
    "runtimeKind" TEXT NOT NULL DEFAULT 'infrastructure',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NetworkVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "displayName" TEXT NOT NULL,
    "trustScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'registered',
    "location" TEXT,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetNetworkAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "capabilityType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedQuantity" TEXT,
    "verifiedUnit" TEXT,

    CONSTRAINT "AssetNetworkAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "deviceType" TEXT NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "status" TEXT NOT NULL DEFAULT 'provisioned',
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceCredential" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "credentialType" TEXT NOT NULL DEFAULT 'hmac_sha256',
    "verificationKey" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "provisioningSecretHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),

    CONSTRAINT "DeviceCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Capability" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "networkVersionId" TEXT,
    "capabilityType" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "fieldsJson" TEXT NOT NULL DEFAULT '{}',
    "unit" TEXT NOT NULL DEFAULT 'unit',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "networkVersionId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "deviceId" TEXT,
    "capabilityType" TEXT NOT NULL,
    "externalEventId" TEXT,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequence" INTEGER,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "signature" TEXT,
    "idempotencyKey" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationResult" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "verifierVersion" TEXT NOT NULL,
    "checksJson" TEXT NOT NULL DEFAULT '[]',
    "overallStatus" TEXT NOT NULL,
    "risk" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attestation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "claimType" TEXT NOT NULL,
    "quantity" DECIMAL(20,8) NOT NULL,
    "unit" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'verified',
    "verificationPolicyVersion" INTEGER NOT NULL,
    "verifierVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attestation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contribution" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "networkVersionId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "quantity" DECIMAL(20,8) NOT NULL,
    "unit" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "attestationIdsJson" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'created',
    "policyVersion" INTEGER NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapacityResource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "capabilityType" TEXT NOT NULL,
    "physicalCapacity" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapacityResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapacityReservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "reservedAmount" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "remainingAmount" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapacityReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapacityCommitment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "committedAmount" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CapacityCommitment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapacityUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "commitmentId" TEXT NOT NULL,
    "quantity" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "attestationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapacityUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "networkVersionId" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "rate" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "ruleVersion" INTEGER NOT NULL DEFAULT 1,
    "configJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reward" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "ruleVersion" INTEGER NOT NULL,
    "ruleId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'calculated',
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerPosting" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "postingType" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerPosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "postingId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "entryType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "rewardId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'created',
    "idempotencyKey" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'payswap_sandbox',
    "providerPayoutId" TEXT,
    "failureReason" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorId" TEXT,
    "eventType" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resourceId" TEXT,
    "responseJson" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processingStatus" TEXT NOT NULL DEFAULT 'pending',
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "processingClaimId" TEXT,

    CONSTRAINT "DomainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "tenantId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Waitlist" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "requestedRole" TEXT NOT NULL DEFAULT 'owner',
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedById" TEXT,
    "createdUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "Waitlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VppBuyerProgram" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "networkVersionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "rewardRuleId" TEXT NOT NULL,
    "dispatchWindowStart" TEXT NOT NULL,
    "dispatchWindowEnd" TEXT NOT NULL,
    "pricePerKwh" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "minCapacityKw" TEXT NOT NULL,
    "maxCapacityKw" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VppBuyerProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VppCapacityReservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "capabilityType" TEXT NOT NULL,
    "reservedKw" TEXT NOT NULL,
    "reservedKwh" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VppCapacityReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VppDispatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "requestedKw" TEXT NOT NULL,
    "requestedKwh" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "reason" TEXT,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VppDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VppDispatchAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "executionAssignmentId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "capabilityType" TEXT NOT NULL,
    "assignedKw" TEXT NOT NULL,
    "assignedKwh" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'assigned',
    "economicStage" TEXT NOT NULL DEFAULT 'none',
    "actualKwh" TEXT,
    "baselineKwh" TEXT,
    "performanceKwh" TEXT,
    "eventId" TEXT,
    "contributionId" TEXT,
    "capacityCommitmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "VppDispatchAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VppBaseline" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "baselineKw" TEXT NOT NULL,
    "baselineKwh" TEXT NOT NULL,
    "actualKw" TEXT NOT NULL,
    "actualKwh" TEXT NOT NULL,
    "performanceKwh" TEXT NOT NULL,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VppBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BaselineEvaluation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "networkVersionId" TEXT,
    "evaluationId" TEXT NOT NULL,
    "simulatorVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "engineVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "scenarioDatasetHash" TEXT NOT NULL,
    "numScenarios" INTEGER NOT NULL,
    "criteriaJson" TEXT NOT NULL,
    "metricsJson" TEXT NOT NULL,
    "selectedStrategy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BaselineEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VppPortfolioCommitment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "portfolioReservationId" TEXT,
    "requestedKw" TEXT NOT NULL,
    "requestedKwh" TEXT NOT NULL,
    "confidenceLevel" TEXT NOT NULL,
    "committedKw" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'greedy_lexicographic_marginal_safe_capacity',
    "optimalityGuarantee" TEXT NOT NULL DEFAULT 'heuristic',
    "toleranceThresholdPct" TEXT NOT NULL DEFAULT '90',
    "measurementMethod" TEXT NOT NULL DEFAULT 'average_power',
    "fulfillmentBasis" TEXT NOT NULL DEFAULT 'per_asset_clipped',
    "deliveredKw" TEXT,
    "deliveredKwh" TEXT,
    "totalBaselineKwh" TEXT,
    "totalActualKwh" TEXT,
    "operatorContributionKwh" TEXT,
    "rawSignedPortfolioPerformanceKwh" TEXT,
    "buyerDeliveredKwh" TEXT,
    "fulfillmentPct" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "evaluationClaimedAt" TIMESTAMP(3),
    "evaluationLeaseExpiresAt" TIMESTAMP(3),
    "evaluationClaimId" TEXT,
    "evaluatedAt" TIMESTAMP(3),
    "assignmentCount" INTEGER NOT NULL DEFAULT 0,
    "completedAssignments" INTEGER NOT NULL DEFAULT 0,
    "failedAssignments" INTEGER NOT NULL DEFAULT 0,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VppPortfolioCommitment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VppBuyerSettlement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "commitmentId" TEXT NOT NULL,
    "buyerDeliveredKwh" TEXT NOT NULL,
    "pricePerKwh" TEXT NOT NULL,
    "deliveredCharge" TEXT NOT NULL,
    "capacityCeiling" TEXT NOT NULL,
    "cappedCharge" TEXT NOT NULL,
    "fulfillmentPct" TEXT NOT NULL,
    "toleranceThresholdPct" TEXT NOT NULL,
    "metTolerance" BOOLEAN NOT NULL,
    "buyerCharge" TEXT NOT NULL,
    "shortfall" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "measurementMethod" TEXT NOT NULL DEFAULT 'average_power',
    "pricingPolicyJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "claimId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "ledgerPostingId" TEXT,
    "buyerFundsBalanceAfter" TEXT,
    "failureReason" TEXT,
    "chargedAt" TIMESTAMP(3),
    "reconciledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VppBuyerSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Execution" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "requestedQuantity" TEXT NOT NULL,
    "requestedUnit" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "capabilityType" TEXT NOT NULL,
    "assignedQuantity" TEXT NOT NULL,
    "assignedUnit" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'assigned',
    "actualQuantity" TEXT,
    "actualUnit" TEXT,
    "verifiedQuantity" TEXT,
    "verifiedUnit" TEXT,
    "eventId" TEXT,
    "contributionId" TEXT,
    "capacityCommitmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ExecutionAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtocolStateSnapshot" (
    "id" TEXT NOT NULL,
    "networkVersionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "stateJson" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtocolStateSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtocolTransition" (
    "id" TEXT NOT NULL,
    "networkVersionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "previousStateHash" TEXT NOT NULL,
    "resultStateHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtocolTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhysicalExecutionEvidence" (
    "evidenceId" TEXT NOT NULL,
    "executionAssignmentId" TEXT NOT NULL,
    "runtimeKind" TEXT NOT NULL,
    "networkVersionId" TEXT NOT NULL,
    "resultDigest" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhysicalExecutionEvidence_pkey" PRIMARY KEY ("evidenceId")
);

-- CreateTable
CREATE TABLE "ReconciliationAttempt" (
    "attemptId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "networkVersionId" TEXT NOT NULL,
    "intendedTransactionId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "nonce" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "outcomeId" TEXT,

    CONSTRAINT "ReconciliationAttempt_pkey" PRIMARY KEY ("attemptId")
);

-- CreateTable
CREATE TABLE "ProtocolOutcome" (
    "outcomeId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "finalityCertificate" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "receiptsDigest" TEXT,
    "error" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtocolOutcome_pkey" PRIMARY KEY ("outcomeId")
);

-- CreateTable
CREATE TABLE "_AttestationToContribution" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_AttestationToContribution_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE INDEX "Tenant_slug_idx" ON "Tenant"("slug");

-- CreateIndex
CREATE INDEX "Organization_tenantId_idx" ON "Organization"("tenantId");

-- CreateIndex
CREATE INDEX "NetworkDefinition_tenantId_idx" ON "NetworkDefinition"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "NetworkDefinition_tenantId_slug_key" ON "NetworkDefinition"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "NetworkVersion_networkId_idx" ON "NetworkVersion"("networkId");

-- CreateIndex
CREATE UNIQUE INDEX "NetworkVersion_networkId_version_key" ON "NetworkVersion"("networkId", "version");

-- CreateIndex
CREATE INDEX "Operator_tenantId_idx" ON "Operator"("tenantId");

-- CreateIndex
CREATE INDEX "Operator_organizationId_idx" ON "Operator"("organizationId");

-- CreateIndex
CREATE INDEX "Asset_tenantId_idx" ON "Asset"("tenantId");

-- CreateIndex
CREATE INDEX "Asset_operatorId_idx" ON "Asset"("operatorId");

-- CreateIndex
CREATE INDEX "AssetNetworkAssignment_tenantId_idx" ON "AssetNetworkAssignment"("tenantId");

-- CreateIndex
CREATE INDEX "AssetNetworkAssignment_assetId_idx" ON "AssetNetworkAssignment"("assetId");

-- CreateIndex
CREATE INDEX "AssetNetworkAssignment_networkId_idx" ON "AssetNetworkAssignment"("networkId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetNetworkAssignment_assetId_networkId_capabilityType_key" ON "AssetNetworkAssignment"("assetId", "networkId", "capabilityType");

-- CreateIndex
CREATE INDEX "Device_tenantId_idx" ON "Device"("tenantId");

-- CreateIndex
CREATE INDEX "Device_assetId_idx" ON "Device"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCredential_deviceId_key" ON "DeviceCredential"("deviceId");

-- CreateIndex
CREATE INDEX "DeviceCredential_tenantId_idx" ON "DeviceCredential"("tenantId");

-- CreateIndex
CREATE INDEX "Capability_tenantId_idx" ON "Capability"("tenantId");

-- CreateIndex
CREATE INDEX "Capability_capabilityType_idx" ON "Capability"("capabilityType");

-- CreateIndex
CREATE INDEX "Event_tenantId_idx" ON "Event"("tenantId");

-- CreateIndex
CREATE INDEX "Event_assetId_idx" ON "Event"("assetId");

-- CreateIndex
CREATE INDEX "Event_deviceId_idx" ON "Event"("deviceId");

-- CreateIndex
CREATE INDEX "Event_status_idx" ON "Event"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Event_tenantId_externalEventId_key" ON "Event"("tenantId", "externalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationResult_eventId_key" ON "VerificationResult"("eventId");

-- CreateIndex
CREATE INDEX "VerificationResult_tenantId_idx" ON "VerificationResult"("tenantId");

-- CreateIndex
CREATE INDEX "VerificationResult_overallStatus_idx" ON "VerificationResult"("overallStatus");

-- CreateIndex
CREATE INDEX "Attestation_tenantId_idx" ON "Attestation"("tenantId");

-- CreateIndex
CREATE INDEX "Attestation_eventId_idx" ON "Attestation"("eventId");

-- CreateIndex
CREATE INDEX "Contribution_tenantId_idx" ON "Contribution"("tenantId");

-- CreateIndex
CREATE INDEX "Contribution_operatorId_idx" ON "Contribution"("operatorId");

-- CreateIndex
CREATE INDEX "Contribution_assetId_idx" ON "Contribution"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "Contribution_tenantId_idempotencyKey_key" ON "Contribution"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CapacityResource_tenantId_idx" ON "CapacityResource"("tenantId");

-- CreateIndex
CREATE INDEX "CapacityResource_assetId_capabilityType_idx" ON "CapacityResource"("assetId", "capabilityType");

-- CreateIndex
CREATE UNIQUE INDEX "CapacityResource_assetId_networkId_capabilityType_key" ON "CapacityResource"("assetId", "networkId", "capabilityType");

-- CreateIndex
CREATE INDEX "CapacityReservation_tenantId_idx" ON "CapacityReservation"("tenantId");

-- CreateIndex
CREATE INDEX "CapacityReservation_resourceId_idx" ON "CapacityReservation"("resourceId");

-- CreateIndex
CREATE INDEX "CapacityReservation_sourceType_sourceId_idx" ON "CapacityReservation"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "CapacityCommitment_tenantId_idx" ON "CapacityCommitment"("tenantId");

-- CreateIndex
CREATE INDEX "CapacityCommitment_reservationId_idx" ON "CapacityCommitment"("reservationId");

-- CreateIndex
CREATE INDEX "CapacityCommitment_sourceType_sourceId_idx" ON "CapacityCommitment"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "CapacityUsage_tenantId_idx" ON "CapacityUsage"("tenantId");

-- CreateIndex
CREATE INDEX "CapacityUsage_sourceType_sourceId_idx" ON "CapacityUsage"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "CapacityUsage_commitmentId_key" ON "CapacityUsage"("commitmentId");

-- CreateIndex
CREATE INDEX "RewardRule_tenantId_idx" ON "RewardRule"("tenantId");

-- CreateIndex
CREATE INDEX "RewardRule_networkVersionId_idx" ON "RewardRule"("networkVersionId");

-- CreateIndex
CREATE INDEX "Reward_tenantId_idx" ON "Reward"("tenantId");

-- CreateIndex
CREATE INDEX "Reward_contributionId_idx" ON "Reward"("contributionId");

-- CreateIndex
CREATE UNIQUE INDEX "Reward_tenantId_idempotencyKey_key" ON "Reward"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerAccount_tenantId_idx" ON "LedgerAccount"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_tenantId_ownerId_ownerType_accountType_curren_key" ON "LedgerAccount"("tenantId", "ownerId", "ownerType", "accountType", "currency");

-- CreateIndex
CREATE INDEX "LedgerPosting_tenantId_idx" ON "LedgerPosting"("tenantId");

-- CreateIndex
CREATE INDEX "LedgerPosting_referenceType_referenceId_idx" ON "LedgerPosting"("referenceType", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerPosting_tenantId_idempotencyKey_key" ON "LedgerPosting"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_tenantId_idx" ON "LedgerEntry"("tenantId");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_idx" ON "LedgerEntry"("accountId");

-- CreateIndex
CREATE INDEX "LedgerEntry_postingId_idx" ON "LedgerEntry"("postingId");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_rewardId_key" ON "Settlement"("rewardId");

-- CreateIndex
CREATE INDEX "Settlement_tenantId_idx" ON "Settlement"("tenantId");

-- CreateIndex
CREATE INDEX "Settlement_status_idx" ON "Settlement"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_tenantId_idempotencyKey_key" ON "Settlement"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_idx" ON "AuditLog"("tenantId");

-- CreateIndex
CREATE INDEX "AuditLog_eventType_idx" ON "AuditLog"("eventType");

-- CreateIndex
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "AuditLog"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_tenantId_idx" ON "IdempotencyRecord"("tenantId");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_status_idx" ON "IdempotencyRecord"("status");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_tenantId_key_resourceType_key" ON "IdempotencyRecord"("tenantId", "key", "resourceType");

-- CreateIndex
CREATE INDEX "DomainEvent_tenantId_idx" ON "DomainEvent"("tenantId");

-- CreateIndex
CREATE INDEX "DomainEvent_eventType_idx" ON "DomainEvent"("eventType");

-- CreateIndex
CREATE INDEX "DomainEvent_processed_idx" ON "DomainEvent"("processed");

-- CreateIndex
CREATE INDEX "DomainEvent_processingStatus_idx" ON "DomainEvent"("processingStatus");

-- CreateIndex
CREATE INDEX "DomainEvent_leaseExpiresAt_idx" ON "DomainEvent"("leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformUser_email_key" ON "PlatformUser"("email");

-- CreateIndex
CREATE INDEX "PlatformUser_tenantId_idx" ON "PlatformUser"("tenantId");

-- CreateIndex
CREATE INDEX "PlatformUser_role_idx" ON "PlatformUser"("role");

-- CreateIndex
CREATE UNIQUE INDEX "Waitlist_email_key" ON "Waitlist"("email");

-- CreateIndex
CREATE INDEX "Waitlist_status_idx" ON "Waitlist"("status");

-- CreateIndex
CREATE INDEX "Waitlist_email_idx" ON "Waitlist"("email");

-- CreateIndex
CREATE INDEX "VppBuyerProgram_tenantId_idx" ON "VppBuyerProgram"("tenantId");

-- CreateIndex
CREATE INDEX "VppBuyerProgram_networkId_idx" ON "VppBuyerProgram"("networkId");

-- CreateIndex
CREATE INDEX "VppBuyerProgram_networkVersionId_idx" ON "VppBuyerProgram"("networkVersionId");

-- CreateIndex
CREATE INDEX "VppCapacityReservation_tenantId_idx" ON "VppCapacityReservation"("tenantId");

-- CreateIndex
CREATE INDEX "VppCapacityReservation_programId_idx" ON "VppCapacityReservation"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "VppDispatch_executionId_key" ON "VppDispatch"("executionId");

-- CreateIndex
CREATE INDEX "VppDispatch_tenantId_idx" ON "VppDispatch"("tenantId");

-- CreateIndex
CREATE INDEX "VppDispatch_programId_idx" ON "VppDispatch"("programId");

-- CreateIndex
CREATE INDEX "VppDispatch_executionId_idx" ON "VppDispatch"("executionId");

-- CreateIndex
CREATE INDEX "VppDispatch_status_idx" ON "VppDispatch"("status");

-- CreateIndex
CREATE UNIQUE INDEX "VppDispatchAssignment_executionAssignmentId_key" ON "VppDispatchAssignment"("executionAssignmentId");

-- CreateIndex
CREATE INDEX "VppDispatchAssignment_tenantId_idx" ON "VppDispatchAssignment"("tenantId");

-- CreateIndex
CREATE INDEX "VppDispatchAssignment_dispatchId_idx" ON "VppDispatchAssignment"("dispatchId");

-- CreateIndex
CREATE INDEX "VppDispatchAssignment_executionAssignmentId_idx" ON "VppDispatchAssignment"("executionAssignmentId");

-- CreateIndex
CREATE INDEX "VppDispatchAssignment_assetId_idx" ON "VppDispatchAssignment"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "VppBaseline_assignmentId_key" ON "VppBaseline"("assignmentId");

-- CreateIndex
CREATE INDEX "VppBaseline_tenantId_idx" ON "VppBaseline"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "BaselineEvaluation_evaluationId_key" ON "BaselineEvaluation"("evaluationId");

-- CreateIndex
CREATE INDEX "BaselineEvaluation_tenantId_idx" ON "BaselineEvaluation"("tenantId");

-- CreateIndex
CREATE INDEX "BaselineEvaluation_networkVersionId_idx" ON "BaselineEvaluation"("networkVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "VppPortfolioCommitment_dispatchId_key" ON "VppPortfolioCommitment"("dispatchId");

-- CreateIndex
CREATE INDEX "VppPortfolioCommitment_tenantId_idx" ON "VppPortfolioCommitment"("tenantId");

-- CreateIndex
CREATE INDEX "VppPortfolioCommitment_dispatchId_idx" ON "VppPortfolioCommitment"("dispatchId");

-- CreateIndex
CREATE INDEX "VppPortfolioCommitment_status_idx" ON "VppPortfolioCommitment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "VppBuyerSettlement_dispatchId_key" ON "VppBuyerSettlement"("dispatchId");

-- CreateIndex
CREATE INDEX "VppBuyerSettlement_tenantId_idx" ON "VppBuyerSettlement"("tenantId");

-- CreateIndex
CREATE INDEX "VppBuyerSettlement_dispatchId_idx" ON "VppBuyerSettlement"("dispatchId");

-- CreateIndex
CREATE INDEX "VppBuyerSettlement_status_idx" ON "VppBuyerSettlement"("status");

-- CreateIndex
CREATE INDEX "Execution_tenantId_idx" ON "Execution"("tenantId");

-- CreateIndex
CREATE INDEX "Execution_networkId_idx" ON "Execution"("networkId");

-- CreateIndex
CREATE INDEX "Execution_status_idx" ON "Execution"("status");

-- CreateIndex
CREATE INDEX "Execution_sourceType_sourceId_idx" ON "Execution"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_sourceType_sourceId_key" ON "Execution"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "ExecutionAssignment_tenantId_idx" ON "ExecutionAssignment"("tenantId");

-- CreateIndex
CREATE INDEX "ExecutionAssignment_executionId_idx" ON "ExecutionAssignment"("executionId");

-- CreateIndex
CREATE INDEX "ExecutionAssignment_assetId_idx" ON "ExecutionAssignment"("assetId");

-- CreateIndex
CREATE INDEX "ExecutionAssignment_status_idx" ON "ExecutionAssignment"("status");

-- CreateIndex
CREATE INDEX "ProtocolStateSnapshot_networkVersionId_idx" ON "ProtocolStateSnapshot"("networkVersionId");

-- CreateIndex
CREATE INDEX "ProtocolStateSnapshot_stateHash_idx" ON "ProtocolStateSnapshot"("stateHash");

-- CreateIndex
CREATE UNIQUE INDEX "ProtocolStateSnapshot_networkVersionId_version_key" ON "ProtocolStateSnapshot"("networkVersionId", "version");

-- CreateIndex
CREATE INDEX "ProtocolTransition_networkVersionId_idx" ON "ProtocolTransition"("networkVersionId");

-- CreateIndex
CREATE INDEX "ProtocolTransition_transactionHash_idx" ON "ProtocolTransition"("transactionHash");

-- CreateIndex
CREATE INDEX "ProtocolTransition_previousStateHash_idx" ON "ProtocolTransition"("previousStateHash");

-- CreateIndex
CREATE UNIQUE INDEX "ProtocolTransition_networkVersionId_version_key" ON "ProtocolTransition"("networkVersionId", "version");

-- CreateIndex
CREATE INDEX "PhysicalExecutionEvidence_executionAssignmentId_idx" ON "PhysicalExecutionEvidence"("executionAssignmentId");

-- CreateIndex
CREATE INDEX "PhysicalExecutionEvidence_networkVersionId_idx" ON "PhysicalExecutionEvidence"("networkVersionId");

-- CreateIndex
CREATE INDEX "ReconciliationAttempt_evidenceId_status_idx" ON "ReconciliationAttempt"("evidenceId", "status");

-- CreateIndex
CREATE INDEX "ReconciliationAttempt_networkVersionId_idx" ON "ReconciliationAttempt"("networkVersionId");

-- CreateIndex
CREATE INDEX "ReconciliationAttempt_status_idx" ON "ReconciliationAttempt"("status");

-- CreateIndex
CREATE INDEX "ReconciliationAttempt_intendedTransactionId_idx" ON "ReconciliationAttempt"("intendedTransactionId");

-- CreateIndex
CREATE INDEX "ProtocolOutcome_attemptId_idx" ON "ProtocolOutcome"("attemptId");

-- CreateIndex
CREATE INDEX "ProtocolOutcome_transactionId_idx" ON "ProtocolOutcome"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "ProtocolOutcome_attemptId_finalityCertificate_key" ON "ProtocolOutcome"("attemptId", "finalityCertificate");

-- CreateIndex
CREATE INDEX "_AttestationToContribution_B_index" ON "_AttestationToContribution"("B");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetworkDefinition" ADD CONSTRAINT "NetworkDefinition_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetworkVersion" ADD CONSTRAINT "NetworkVersion_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "NetworkDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operator" ADD CONSTRAINT "Operator_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operator" ADD CONSTRAINT "Operator_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetNetworkAssignment" ADD CONSTRAINT "AssetNetworkAssignment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetNetworkAssignment" ADD CONSTRAINT "AssetNetworkAssignment_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "NetworkDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceCredential" ADD CONSTRAINT "DeviceCredential_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Capability" ADD CONSTRAINT "Capability_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Capability" ADD CONSTRAINT "Capability_networkVersionId_fkey" FOREIGN KEY ("networkVersionId") REFERENCES "NetworkVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_networkVersionId_fkey" FOREIGN KEY ("networkVersionId") REFERENCES "NetworkVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationResult" ADD CONSTRAINT "VerificationResult_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attestation" ADD CONSTRAINT "Attestation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attestation" ADD CONSTRAINT "Attestation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_networkVersionId_fkey" FOREIGN KEY ("networkVersionId") REFERENCES "NetworkVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "Capability"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityResource" ADD CONSTRAINT "CapacityResource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityResource" ADD CONSTRAINT "CapacityResource_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityResource" ADD CONSTRAINT "CapacityResource_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "NetworkDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityReservation" ADD CONSTRAINT "CapacityReservation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityReservation" ADD CONSTRAINT "CapacityReservation_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "CapacityResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityCommitment" ADD CONSTRAINT "CapacityCommitment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityCommitment" ADD CONSTRAINT "CapacityCommitment_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "CapacityReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityUsage" ADD CONSTRAINT "CapacityUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityUsage" ADD CONSTRAINT "CapacityUsage_commitmentId_fkey" FOREIGN KEY ("commitmentId") REFERENCES "CapacityCommitment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardRule" ADD CONSTRAINT "RewardRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardRule" ADD CONSTRAINT "RewardRule_networkVersionId_fkey" FOREIGN KEY ("networkVersionId") REFERENCES "NetworkVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RewardRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerPosting" ADD CONSTRAINT "LedgerPosting_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_postingId_fkey" FOREIGN KEY ("postingId") REFERENCES "LedgerPosting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "Reward"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainEvent" ADD CONSTRAINT "DomainEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformUser" ADD CONSTRAINT "PlatformUser_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitlist" ADD CONSTRAINT "Waitlist_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "PlatformUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppBuyerProgram" ADD CONSTRAINT "VppBuyerProgram_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppBuyerProgram" ADD CONSTRAINT "VppBuyerProgram_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "NetworkDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppBuyerProgram" ADD CONSTRAINT "VppBuyerProgram_networkVersionId_fkey" FOREIGN KEY ("networkVersionId") REFERENCES "NetworkVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppBuyerProgram" ADD CONSTRAINT "VppBuyerProgram_rewardRuleId_fkey" FOREIGN KEY ("rewardRuleId") REFERENCES "RewardRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppCapacityReservation" ADD CONSTRAINT "VppCapacityReservation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppCapacityReservation" ADD CONSTRAINT "VppCapacityReservation_programId_fkey" FOREIGN KEY ("programId") REFERENCES "VppBuyerProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppCapacityReservation" ADD CONSTRAINT "VppCapacityReservation_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppCapacityReservation" ADD CONSTRAINT "VppCapacityReservation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppDispatch" ADD CONSTRAINT "VppDispatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppDispatch" ADD CONSTRAINT "VppDispatch_programId_fkey" FOREIGN KEY ("programId") REFERENCES "VppBuyerProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppDispatch" ADD CONSTRAINT "VppDispatch_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppDispatchAssignment" ADD CONSTRAINT "VppDispatchAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppDispatchAssignment" ADD CONSTRAINT "VppDispatchAssignment_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "VppDispatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppDispatchAssignment" ADD CONSTRAINT "VppDispatchAssignment_executionAssignmentId_fkey" FOREIGN KEY ("executionAssignmentId") REFERENCES "ExecutionAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppDispatchAssignment" ADD CONSTRAINT "VppDispatchAssignment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppDispatchAssignment" ADD CONSTRAINT "VppDispatchAssignment_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppBaseline" ADD CONSTRAINT "VppBaseline_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppBaseline" ADD CONSTRAINT "VppBaseline_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "VppDispatchAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BaselineEvaluation" ADD CONSTRAINT "BaselineEvaluation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BaselineEvaluation" ADD CONSTRAINT "BaselineEvaluation_networkVersionId_fkey" FOREIGN KEY ("networkVersionId") REFERENCES "NetworkVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppPortfolioCommitment" ADD CONSTRAINT "VppPortfolioCommitment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppPortfolioCommitment" ADD CONSTRAINT "VppPortfolioCommitment_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "VppDispatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppBuyerSettlement" ADD CONSTRAINT "VppBuyerSettlement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VppBuyerSettlement" ADD CONSTRAINT "VppBuyerSettlement_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "VppDispatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "NetworkDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionAssignment" ADD CONSTRAINT "ExecutionAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionAssignment" ADD CONSTRAINT "ExecutionAssignment_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionAssignment" ADD CONSTRAINT "ExecutionAssignment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionAssignment" ADD CONSTRAINT "ExecutionAssignment_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AttestationToContribution" ADD CONSTRAINT "_AttestationToContribution_A_fkey" FOREIGN KEY ("A") REFERENCES "Attestation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AttestationToContribution" ADD CONSTRAINT "_AttestationToContribution_B_fkey" FOREIGN KEY ("B") REFERENCES "Contribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

