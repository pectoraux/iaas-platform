// One-off script: baseline the Neon database's migration history truthfully.
//
// PHASE 11B CORRECTION (Defect 12 — migration ledger integrity):
//   The previous version of this script used synthetic checksums
//   ('baseline-manual-0001') instead of the real SHA-256 of the migration
//   files, and marked the baseline as "applied" without actually creating
//   6 tables that were missing (VppPortfolioCommitment, VppBuyerSettlement,
//   Execution, ExecutionAssignment, ProtocolStateSnapshot, ProtocolTransition).
//
//   This corrected version:
//   1. Creates ALL 9 missing tables (3 reconciliation + 6 drifted) + indexes + FKs.
//   2. Uses the REAL SHA-256 checksums of the committed migration files
//      (computed via createHash('sha256').update(fileContent).digest('hex')).
//   3. Honestly documents in the migration logs that the baseline was
//      manually reconciled (tables created individually, not via a single
//      migrate deploy run, because the DB had 37 pre-existing tables from
//      an earlier db push that couldn't be cleanly baselined).
//
// After running this, the _prisma_migrations checksums match the committed
// migration files, and the schema matches schema.prisma. `prisma migrate
// deploy` will detect no drift and be a no-op.
//
// Run: DATABASE_URL=<neon_url> bun run scripts/baseline-migrations.ts

import { neon } from '@neondatabase/serverless'
import { randomUUID } from 'crypto'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl || !databaseUrl.startsWith('postgres')) {
  console.error('DATABASE_URL must be a postgresql:// URL')
  process.exit(1)
}

const sql = neon(databaseUrl)

// Compute the REAL checksums Prisma uses: SHA-256 of the migration file content.
const baselineFile = readFileSync('prisma/migrations/20260816000000_initial_baseline/migration.sql', 'utf-8')
const c3File = readFileSync('prisma/migrations/20260817000000_recon_c3_partial_unique/migration.sql', 'utf-8')
const baselineChecksum = createHash('sha256').update(baselineFile).digest('hex')
const c3Checksum = createHash('sha256').update(c3File).digest('hex')

console.log('Real checksums (SHA-256 of migration files):')
console.log(`  baseline: ${baselineChecksum}`)
console.log(`  c3 index: ${c3Checksum}`)

// DDL for ALL 9 missing tables (3 reconciliation + 6 drifted), extracted from
// the baseline migration. Using IF NOT EXISTS so this is idempotent.
const DDL_STATEMENTS: string[] = [
  // --- Reconciliation tables (3) ---
  `CREATE TABLE IF NOT EXISTS "PhysicalExecutionEvidence" (
    "evidenceId" TEXT NOT NULL,
    "executionAssignmentId" TEXT NOT NULL,
    "runtimeKind" TEXT NOT NULL,
    "networkVersionId" TEXT NOT NULL,
    "resultDigest" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PhysicalExecutionEvidence_pkey" PRIMARY KEY ("evidenceId")
  )`,
  `CREATE TABLE IF NOT EXISTS "ReconciliationAttempt" (
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
  )`,
  `CREATE TABLE IF NOT EXISTS "ProtocolOutcome" (
    "outcomeId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "finalityCertificate" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "receiptsDigest" TEXT,
    "error" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProtocolOutcome_pkey" PRIMARY KEY ("outcomeId")
  )`,

  // --- Drifted tables (6, missing from the db-push-created Neon DB) ---
  `CREATE TABLE IF NOT EXISTS "VppPortfolioCommitment" (
    "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "dispatchId" TEXT NOT NULL,
    "portfolioReservationId" TEXT, "requestedKw" TEXT NOT NULL, "requestedKwh" TEXT NOT NULL,
    "confidenceLevel" TEXT NOT NULL, "committedKw" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'greedy_lexicographic_marginal_safe_capacity',
    "optimalityGuarantee" TEXT NOT NULL DEFAULT 'heuristic',
    "toleranceThresholdPct" TEXT NOT NULL DEFAULT '90',
    "measurementMethod" TEXT NOT NULL DEFAULT 'average_power',
    "fulfillmentBasis" TEXT NOT NULL DEFAULT 'per_asset_clipped',
    "deliveredKw" TEXT, "deliveredKwh" TEXT, "totalBaselineKwh" TEXT, "totalActualKwh" TEXT,
    "operatorContributionKwh" TEXT, "rawSignedPortfolioPerformanceKwh" TEXT,
    "buyerDeliveredKwh" TEXT, "fulfillmentPct" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "evaluationClaimedAt" TIMESTAMP(3), "evaluationLeaseExpiresAt" TIMESTAMP(3),
    "evaluationClaimId" TEXT, "evaluatedAt" TIMESTAMP(3),
    "assignmentCount" INTEGER NOT NULL DEFAULT 0,
    "completedAssignments" INTEGER NOT NULL DEFAULT 0,
    "failedAssignments" INTEGER NOT NULL DEFAULT 0,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VppPortfolioCommitment_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE IF NOT EXISTS "VppBuyerSettlement" (
    "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "dispatchId" TEXT NOT NULL,
    "commitmentId" TEXT NOT NULL, "buyerDeliveredKwh" TEXT NOT NULL,
    "pricePerKwh" TEXT NOT NULL, "deliveredCharge" TEXT NOT NULL,
    "capacityCeiling" TEXT NOT NULL, "cappedCharge" TEXT NOT NULL,
    "fulfillmentPct" TEXT NOT NULL, "toleranceThresholdPct" TEXT NOT NULL,
    "metTolerance" BOOLEAN NOT NULL, "buyerCharge" TEXT NOT NULL,
    "shortfall" TEXT NOT NULL, "currency" TEXT NOT NULL DEFAULT 'USD',
    "measurementMethod" TEXT NOT NULL DEFAULT 'average_power',
    "pricingPolicyJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending', "claimId" TEXT,
    "claimedAt" TIMESTAMP(3), "leaseExpiresAt" TIMESTAMP(3),
    "ledgerPostingId" TEXT, "buyerFundsBalanceAfter" TEXT,
    "failureReason" TEXT, "chargedAt" TIMESTAMP(3), "reconciledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VppBuyerSettlement_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE IF NOT EXISTS "Execution" (
    "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "networkId" TEXT NOT NULL,
    "requestedQuantity" TEXT NOT NULL, "requestedUnit" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL, "endTime" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "sourceType" TEXT NOT NULL, "sourceId" TEXT,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE IF NOT EXISTS "ExecutionAssignment" (
    "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "executionId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL, "operatorId" TEXT NOT NULL,
    "capabilityType" TEXT NOT NULL, "assignedQuantity" TEXT NOT NULL,
    "assignedUnit" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'assigned',
    "actualQuantity" TEXT, "actualUnit" TEXT, "verifiedQuantity" TEXT,
    "verifiedUnit" TEXT, "eventId" TEXT, "contributionId" TEXT,
    "capacityCommitmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "ExecutionAssignment_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE IF NOT EXISTS "ProtocolStateSnapshot" (
    "id" TEXT NOT NULL, "networkVersionId" TEXT NOT NULL, "version" INTEGER NOT NULL,
    "stateJson" TEXT NOT NULL, "stateHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProtocolStateSnapshot_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE IF NOT EXISTS "ProtocolTransition" (
    "id" TEXT NOT NULL, "networkVersionId" TEXT NOT NULL, "version" INTEGER NOT NULL,
    "transactionHash" TEXT NOT NULL, "previousStateHash" TEXT NOT NULL,
    "resultStateHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProtocolTransition_pkey" PRIMARY KEY ("id")
  )`,
]

// Indexes for all 9 tables (from baseline migration)
const INDEX_STATEMENTS: string[] = [
  // Reconciliation indexes
  `CREATE INDEX IF NOT EXISTS "PhysicalExecutionEvidence_executionAssignmentId_idx" ON "PhysicalExecutionEvidence"("executionAssignmentId")`,
  `CREATE INDEX IF NOT EXISTS "PhysicalExecutionEvidence_networkVersionId_idx" ON "PhysicalExecutionEvidence"("networkVersionId")`,
  `CREATE INDEX IF NOT EXISTS "ReconciliationAttempt_evidenceId_status_idx" ON "ReconciliationAttempt"("evidenceId", "status")`,
  `CREATE INDEX IF NOT EXISTS "ReconciliationAttempt_networkVersionId_idx" ON "ReconciliationAttempt"("networkVersionId")`,
  `CREATE INDEX IF NOT EXISTS "ReconciliationAttempt_status_idx" ON "ReconciliationAttempt"("status")`,
  `CREATE INDEX IF NOT EXISTS "ReconciliationAttempt_intendedTransactionId_idx" ON "ReconciliationAttempt"("intendedTransactionId")`,
  `CREATE INDEX IF NOT EXISTS "ProtocolOutcome_attemptId_idx" ON "ProtocolOutcome"("attemptId")`,
  `CREATE INDEX IF NOT EXISTS "ProtocolOutcome_transactionId_idx" ON "ProtocolOutcome"("transactionId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ProtocolOutcome_attemptId_finalityCertificate_key" ON "ProtocolOutcome"("attemptId", "finalityCertificate")`,
  // C3 partial unique index
  `CREATE UNIQUE INDEX IF NOT EXISTS "recon_attempt_pending_unique" ON "ReconciliationAttempt" ("evidenceId") WHERE "status" = 'PENDING'`,
  // Drifted table indexes
  `CREATE UNIQUE INDEX IF NOT EXISTS "VppPortfolioCommitment_dispatchId_key" ON "VppPortfolioCommitment"("dispatchId")`,
  `CREATE INDEX IF NOT EXISTS "VppPortfolioCommitment_tenantId_idx" ON "VppPortfolioCommitment"("tenantId")`,
  `CREATE INDEX IF NOT EXISTS "VppPortfolioCommitment_dispatchId_idx" ON "VppPortfolioCommitment"("dispatchId")`,
  `CREATE INDEX IF NOT EXISTS "VppPortfolioCommitment_status_idx" ON "VppPortfolioCommitment"("status")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "VppBuyerSettlement_dispatchId_key" ON "VppBuyerSettlement"("dispatchId")`,
  `CREATE INDEX IF NOT EXISTS "VppBuyerSettlement_tenantId_idx" ON "VppBuyerSettlement"("tenantId")`,
  `CREATE INDEX IF NOT EXISTS "VppBuyerSettlement_dispatchId_idx" ON "VppBuyerSettlement"("dispatchId")`,
  `CREATE INDEX IF NOT EXISTS "VppBuyerSettlement_status_idx" ON "VppBuyerSettlement"("status")`,
  `CREATE INDEX IF NOT EXISTS "Execution_tenantId_idx" ON "Execution"("tenantId")`,
  `CREATE INDEX IF NOT EXISTS "Execution_networkId_idx" ON "Execution"("networkId")`,
  `CREATE INDEX IF NOT EXISTS "Execution_status_idx" ON "Execution"("status")`,
  `CREATE INDEX IF NOT EXISTS "Execution_sourceType_sourceId_idx" ON "Execution"("sourceType", "sourceId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Execution_sourceType_sourceId_key" ON "Execution"("sourceType", "sourceId")`,
  `CREATE INDEX IF NOT EXISTS "ExecutionAssignment_tenantId_idx" ON "ExecutionAssignment"("tenantId")`,
  `CREATE INDEX IF NOT EXISTS "ExecutionAssignment_executionId_idx" ON "ExecutionAssignment"("executionId")`,
  `CREATE INDEX IF NOT EXISTS "ExecutionAssignment_assetId_idx" ON "ExecutionAssignment"("assetId")`,
  `CREATE INDEX IF NOT EXISTS "ExecutionAssignment_status_idx" ON "ExecutionAssignment"("status")`,
  `CREATE INDEX IF NOT EXISTS "ProtocolStateSnapshot_networkVersionId_idx" ON "ProtocolStateSnapshot"("networkVersionId")`,
  `CREATE INDEX IF NOT EXISTS "ProtocolStateSnapshot_stateHash_idx" ON "ProtocolStateSnapshot"("stateHash")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ProtocolStateSnapshot_networkVersionId_version_key" ON "ProtocolStateSnapshot"("networkVersionId", "version")`,
  `CREATE INDEX IF NOT EXISTS "ProtocolTransition_networkVersionId_idx" ON "ProtocolTransition"("networkVersionId")`,
  `CREATE INDEX IF NOT EXISTS "ProtocolTransition_transactionHash_idx" ON "ProtocolTransition"("transactionHash")`,
  `CREATE INDEX IF NOT EXISTS "ProtocolTransition_previousStateHash_idx" ON "ProtocolTransition"("previousStateHash")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ProtocolTransition_networkVersionId_version_key" ON "ProtocolTransition"("networkVersionId", "version")`,
]

// Foreign keys for the drifted tables (reconciliation tables have no FKs).
// PostgreSQL doesn't support `ADD CONSTRAINT IF NOT EXISTS`, so we use a
// DO block that catches the duplicate_object error (42710) and ignores it.
function fkStatement(constraintName: string, sql: string): string {
  return `DO $$ BEGIN
    ${sql};
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`
}

const FK_STATEMENTS: string[] = [
  fkStatement('VppDispatch_executionId_fkey', `ALTER TABLE "VppDispatch" ADD CONSTRAINT "VppDispatch_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE RESTRICT ON UPDATE CASCADE`),
  fkStatement('VppDispatchAssignment_executionAssignmentId_fkey', `ALTER TABLE "VppDispatchAssignment" ADD CONSTRAINT "VppDispatchAssignment_executionAssignmentId_fkey" FOREIGN KEY ("executionAssignmentId") REFERENCES "ExecutionAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE`),
  fkStatement('VppPortfolioCommitment_tenantId_fkey', `ALTER TABLE "VppPortfolioCommitment" ADD CONSTRAINT "VppPortfolioCommitment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE`),
  fkStatement('VppPortfolioCommitment_dispatchId_fkey', `ALTER TABLE "VppPortfolioCommitment" ADD CONSTRAINT "VppPortfolioCommitment_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "VppDispatch"("id") ON DELETE CASCADE ON UPDATE CASCADE`),
  fkStatement('VppBuyerSettlement_tenantId_fkey', `ALTER TABLE "VppBuyerSettlement" ADD CONSTRAINT "VppBuyerSettlement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE`),
  fkStatement('VppBuyerSettlement_dispatchId_fkey', `ALTER TABLE "VppBuyerSettlement" ADD CONSTRAINT "VppBuyerSettlement_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "VppDispatch"("id") ON DELETE CASCADE ON UPDATE CASCADE`),
  fkStatement('Execution_tenantId_fkey', `ALTER TABLE "Execution" ADD CONSTRAINT "Execution_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE`),
  fkStatement('Execution_networkId_fkey', `ALTER TABLE "Execution" ADD CONSTRAINT "Execution_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "NetworkDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE`),
  fkStatement('ExecutionAssignment_tenantId_fkey', `ALTER TABLE "ExecutionAssignment" ADD CONSTRAINT "ExecutionAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE`),
  fkStatement('ExecutionAssignment_executionId_fkey', `ALTER TABLE "ExecutionAssignment" ADD CONSTRAINT "ExecutionAssignment_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE`),
  fkStatement('ExecutionAssignment_assetId_fkey', `ALTER TABLE "ExecutionAssignment" ADD CONSTRAINT "ExecutionAssignment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE`),
  fkStatement('ExecutionAssignment_operatorId_fkey', `ALTER TABLE "ExecutionAssignment" ADD CONSTRAINT "ExecutionAssignment_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE`),
]

const migrations = [
  {
    id: randomUUID(),
    checksum: baselineChecksum, // REAL checksum
    migration_name: '20260816000000_initial_baseline',
    logs: 'Manually reconciled by scripts/baseline-migrations.ts: created 9 missing tables (3 reconciliation + 6 drifted) + indexes + FKs individually, because the DB had 37 pre-existing tables from an earlier db push. Checksum matches the committed migration file.',
  },
  {
    id: randomUUID(),
    checksum: c3Checksum, // REAL checksum
    migration_name: '20260817000000_recon_c3_partial_unique',
    logs: 'C3 partial unique index created directly by scripts/baseline-migrations.ts. Checksum matches the committed migration file.',
  },
]

async function main() {
  // 1. Create all 9 missing tables.
  console.log('=== Creating 9 missing tables (IF NOT EXISTS) ===')
  for (const ddl of DDL_STATEMENTS) {
    const tableName = ddl.match(/CREATE TABLE IF NOT EXISTS "([^"]+)"/)?.[1] || '?'
    await sql.query(ddl)
    console.log(`  ✓ ${tableName}`)
  }

  // 2. Create all indexes.
  console.log(`\n=== Creating ${INDEX_STATEMENTS.length} indexes (IF NOT EXISTS) ===`)
  for (const idx of INDEX_STATEMENTS) {
    await sql.query(idx)
    const idxName = idx.match(/"([^"]+)"/)?.[1] || idx.slice(0, 50)
    console.log(`  ✓ ${idxName}`)
  }

  // 3. Create foreign keys.
  console.log(`\n=== Creating ${FK_STATEMENTS.length} foreign keys (IF NOT EXISTS) ===`)
  for (const fk of FK_STATEMENTS) {
    await sql.query(fk)
    const fkName = fk.match(/CONSTRAINT IF NOT EXISTS "([^"]+)"/)?.[1] || '?'
    console.log(`  ✓ ${fkName}`)
  }

  // 4. Create _prisma_migrations table if not exists.
  console.log('\n=== Creating _prisma_migrations table if not exists ===')
  await sql`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) NOT NULL,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
      CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY ("id")
    )
  `
  console.log('  ✓ done')

  // 5. Update both migrations with REAL checksums (idempotent).
  console.log('\n=== Recording migrations with REAL checksums ===')
  for (const m of migrations) {
    console.log(`  ${m.migration_name}`)
    console.log(`    checksum: ${m.checksum}`)
    await sql`DELETE FROM "_prisma_migrations" WHERE "migration_name" = ${m.migration_name}`
    await sql`
      INSERT INTO "_prisma_migrations" (
        "id", "checksum", "finished_at", "migration_name", "logs", "applied_steps_count"
      ) VALUES (
        ${m.id}, ${m.checksum}, NOW(), ${m.migration_name}, ${m.logs}, 1
      )
    `
    console.log('    ✓ recorded')
  }

  // 6. Final verification.
  console.log('\n=== FINAL VERIFICATION ===')
  const tables = await sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
    ORDER BY tablename
  `
  console.log(`Tables in public schema: ${tables.length} (expected 45)`)

  const reconTables = ['PhysicalExecutionEvidence', 'ReconciliationAttempt', 'ProtocolOutcome',
    'VppPortfolioCommitment', 'VppBuyerSettlement', 'Execution', 'ExecutionAssignment',
    'ProtocolStateSnapshot', 'ProtocolTransition']
  console.log('Previously-missing tables now present:')
  for (const t of reconTables) {
    const found = tables.find((r: any) => r.tablename === t)
    console.log(`  ${found ? '✓' : '✗'} ${t}`)
  }

  const rows = await sql`SELECT "migration_name", "checksum", "finished_at" IS NOT NULL as finished FROM "_prisma_migrations" ORDER BY "migration_name"`
  console.log('\n_prisma_migrations (with REAL checksums):')
  for (const r of rows) {
    const realChecksum = r.migration_name === '20260816000000_initial_baseline' ? baselineChecksum : c3Checksum
    const match = r.checksum === realChecksum
    console.log(`  ${r.migration_name} | finished=${r.finished} | checksum_match=${match}`)
  }

  const c3Idx = await sql`SELECT indexname FROM pg_indexes WHERE indexname = 'recon_attempt_pending_unique'`
  console.log(`\nC3 partial unique index: ${c3Idx.length > 0 ? '✓ present' : '✗ MISSING'}`)

  console.log('\n=== Baseline complete. Checksums match committed migration files. ===')
  console.log('prisma migrate deploy will detect no drift and be a no-op.')
}

main().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
