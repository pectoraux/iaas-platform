// One-off script: baseline the Neon database's migration history AND create
// the missing reconciliation tables.
//
// The Neon DB was created via `db push` at an earlier phase (pre-11B), so it
// has 37 tables but is MISSING the 3 reconciliation tables
// (PhysicalExecutionEvidence, ReconciliationAttempt, ProtocolOutcome). The
// baseline migration (20260816000000) creates ALL 44 tables, but running it
// against the existing DB would fail on the 37 already-existing tables.
//
// This script uses the Neon serverless driver (HTTP, not raw TCP) to:
//   1. Create the 3 MISSING reconciliation tables + their indexes.
//   2. Create the C3 partial unique index.
//   3. Create the _prisma_migrations table if it doesn't exist.
//   4. Insert both migration records as "already applied" so future
//      `prisma migrate deploy` calls are no-ops.
//
// This is the one-time operational transition documented in spec §8.1.
// After running this, `prisma migrate deploy` (in the Vercel build) will
// succeed because the migration history matches the schema state.
//
// Run: DATABASE_URL=<neon_url> bun run scripts/baseline-migrations.ts

import { neon } from '@neondatabase/serverless'
import { randomUUID } from 'crypto'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl || !databaseUrl.startsWith('postgres')) {
  console.error('DATABASE_URL must be a postgresql:// URL')
  process.exit(1)
}

const sql = neon(databaseUrl)

// The 3 reconciliation tables (extracted from the baseline migration, since
// the full baseline can't run against a DB that already has the other 37 tables).
const RECON_DDL = [
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
  // Indexes (from baseline migration)
  `CREATE INDEX IF NOT EXISTS "PhysicalExecutionEvidence_executionAssignmentId_idx" ON "PhysicalExecutionEvidence"("executionAssignmentId")`,
  `CREATE INDEX IF NOT EXISTS "PhysicalExecutionEvidence_networkVersionId_idx" ON "PhysicalExecutionEvidence"("networkVersionId")`,
  `CREATE INDEX IF NOT EXISTS "ReconciliationAttempt_evidenceId_status_idx" ON "ReconciliationAttempt"("evidenceId", "status")`,
  `CREATE INDEX IF NOT EXISTS "ReconciliationAttempt_networkVersionId_idx" ON "ReconciliationAttempt"("networkVersionId")`,
  `CREATE INDEX IF NOT EXISTS "ReconciliationAttempt_status_idx" ON "ReconciliationAttempt"("status")`,
  `CREATE INDEX IF NOT EXISTS "ReconciliationAttempt_intendedTransactionId_idx" ON "ReconciliationAttempt"("intendedTransactionId")`,
  `CREATE INDEX IF NOT EXISTS "ProtocolOutcome_attemptId_idx" ON "ProtocolOutcome"("attemptId")`,
  `CREATE INDEX IF NOT EXISTS "ProtocolOutcome_transactionId_idx" ON "ProtocolOutcome"("transactionId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ProtocolOutcome_attemptId_finalityCertificate_key" ON "ProtocolOutcome"("attemptId", "finalityCertificate")`,
  // C3 partial unique index (from the C3 migration)
  `CREATE UNIQUE INDEX IF NOT EXISTS "recon_attempt_pending_unique" ON "ReconciliationAttempt" ("evidenceId") WHERE "status" = 'PENDING'`,
]

const migrations = [
  {
    id: randomUUID(),
    checksum: 'baseline-manual-0001',
    migration_name: '20260816000000_initial_baseline',
    logs: 'Marked as applied by scripts/baseline-migrations.ts (db-push legacy transition; reconciliation tables created directly)',
  },
  {
    id: randomUUID(),
    checksum: 'baseline-manual-0002',
    migration_name: '20260817000000_recon_c3_partial_unique',
    logs: 'Marked as applied by scripts/baseline-migrations.ts (C3 index created directly)',
  },
]

async function main() {
  // 1. Create the missing reconciliation tables + indexes + C3 index.
  console.log('Creating reconciliation tables + indexes (IF NOT EXISTS)...')
  for (const ddl of RECON_DDL) {
    await sql.query(ddl)
    console.log('  ✓', ddl.match(/"([^"]+)"/)?.[1] || ddl.slice(0, 60))
  }

  // 2. Create the _prisma_migrations table if it doesn't exist.
  console.log('\nCreating _prisma_migrations table if not exists...')
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
  console.log('  done.')

  // 3. Mark both migrations as applied (idempotent).
  for (const m of migrations) {
    console.log(`Marking migration ${m.migration_name} as applied...`)
    await sql`DELETE FROM "_prisma_migrations" WHERE "migration_name" = ${m.migration_name}`
    await sql`
      INSERT INTO "_prisma_migrations" (
        "id", "checksum", "finished_at", "migration_name", "logs", "applied_steps_count"
      ) VALUES (
        ${m.id}, ${m.checksum}, NOW(), ${m.migration_name}, ${m.logs}, 1
      )
    `
    console.log('  done.')
  }

  // 4. Verification.
  console.log('\n=== Verification ===')
  const tables = await sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename IN ('PhysicalExecutionEvidence', 'ReconciliationAttempt', 'ProtocolOutcome')
    ORDER BY tablename
  `
  console.log('Reconciliation tables:', tables.map((t: any) => t.tablename).join(', '))

  const idx = await sql`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'ReconciliationAttempt' ORDER BY indexname
  `
  console.log('Indexes on ReconciliationAttempt:', idx.map((i: any) => i.indexname).join(', '))

  const rows = await sql`SELECT "migration_name", "finished_at" IS NOT NULL as finished FROM "_prisma_migrations" ORDER BY "migration_name"`
  console.log('_prisma_migrations:')
  for (const r of rows) console.log(`  ${r.migration_name} | finished=${r.finished}`)

  console.log('\nBaseline complete. `prisma migrate deploy` will now be a no-op for these migrations.')
}

main().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})

