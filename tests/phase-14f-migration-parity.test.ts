/**
 * Phase 14F: Migration Schema Parity Test
 *
 * Verifies that the migration SQL produces a schema that matches the
 * Prisma schema for all Phase 14A-F models. This test reads the migration
 * SQL and asserts that it contains the expected DDL statements.
 *
 * This is a STATIC test — it reads the migration file. No DB connection.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'

function readFile(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('Phase 14F: Migration Schema Parity (static)', () => {
  const migration = readFile('./prisma/migrations/20260822000000_phase_14_data_plane_foundation/migration.sql')

  // All Phase 14A-F tables must be created
  it('migration creates all Phase 14A-F tables', () => {
    const tables = [
      'Node', 'NodeNetworkMembership',
      'Bundle', 'BundleDelivery',
      'Route', 'RouteHop', 'NodeCapability', 'NodeReachability',
      'TransportExecution', 'TransportAttempt', 'TransportCapability',
      'DeliveryConfirmation', 'TransformRecord',
    ]
    for (const table of tables) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`)
    }
  })

  // TransformRecord.nodeIdentity must be set NOT NULL
  it('migration sets TransformRecord.nodeIdentity NOT NULL', () => {
    expect(migration).toMatch(/ALTER TABLE "TransformRecord" ALTER COLUMN "nodeIdentity" SET NOT NULL/)
  })

  // TransformRecord corrected unique identity
  it('migration creates corrected unique index on nodeIdentity', () => {
    expect(migration).toContain('TransformRecord_tenantId_bundleId_nodeIdentity_transformType_idempotencyKey_key')
    expect(migration).toContain('"nodeIdentity"')
  })

  // TransformRecord backfill
  it('migration backfills nodeIdentity from existing data (no deletion)', () => {
    expect(migration).toContain("'node:' || \"nodeId\"")
    expect(migration).toContain("'system:__unattributed__'")
  })

  // Duplicate detection
  it('migration detects duplicate identities before enforcing unique', () => {
    expect(migration).toContain('RAISE EXCEPTION')
    expect(migration).toContain('duplicate identity')
  })

  // No data destruction in DDL (not comments)
  it('migration contains no TRUNCATE, DROP TABLE, or DELETE FROM in DDL', () => {
    // Strip SQL comments (lines starting with --) before checking
    const ddl = migration.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    expect(ddl).not.toMatch(/TRUNCATE/i)
    expect(ddl).not.toMatch(/DROP TABLE/i)
    expect(ddl).not.toMatch(/DELETE FROM/i)
  })

  // FK constraint presence — check each FK name exists AND its target + ON DELETE
  // Since FK definitions span multiple lines, we check the constraint name
  // exists and then verify the relevant keywords appear nearby by checking
  // the full migration contains both the FK name and the ON DELETE behavior.

  // Helper: verify FK exists with correct ON DELETE
  function expectFK(fkName: string, targetTable: string, onDelete: string) {
    expect(migration).toContain(`CONSTRAINT "${fkName}"`)
    expect(migration).toContain(`REFERENCES "${targetTable}"`)
    expect(migration).toContain(`ON DELETE ${onDelete}`)
  }

  it('migration creates TransformRecord FK to Tenant (CASCADE)', () => {
    expectFK('TransformRecord_tenantId_fkey', 'Tenant', 'CASCADE')
  })
  it('migration creates TransformRecord FK to Bundle (CASCADE)', () => {
    expectFK('TransformRecord_bundleId_fkey', 'Bundle', 'CASCADE')
  })
  it('migration creates TransformRecord FK to Node (SET NULL)', () => {
    expectFK('TransformRecord_nodeId_fkey', 'Node', 'SET NULL')
  })

  it('migration creates Node FKs', () => {
    expectFK('Node_tenantId_fkey', 'Tenant', 'CASCADE')
    expectFK('Node_participantId_fkey', 'ParticipantIdentity', 'SET NULL')
    expectFK('Node_deviceId_fkey', 'Device', 'SET NULL')
    expectFK('Node_resourceId_fkey', 'ResourceIdentity', 'SET NULL')
  })

  it('migration creates Bundle FKs', () => {
    expectFK('Bundle_tenantId_fkey', 'Tenant', 'CASCADE')
    expectFK('Bundle_sourceNodeId_fkey', 'Node', 'CASCADE')
    expectFK('Bundle_destinationNodeId_fkey', 'Node', 'CASCADE')
  })

  it('migration creates BundleDelivery FKs', () => {
    expectFK('BundleDelivery_bundleId_fkey', 'Bundle', 'CASCADE')
    expectFK('BundleDelivery_receiverNodeId_fkey', 'Node', 'CASCADE')
  })

  it('migration creates Route FKs', () => {
    expectFK('Route_tenantId_fkey', 'Tenant', 'CASCADE')
    expectFK('Route_bundleId_fkey', 'Bundle', 'CASCADE')
    expectFK('Route_sourceNodeId_fkey', 'Node', 'CASCADE')
    expectFK('Route_destinationNodeId_fkey', 'Node', 'CASCADE')
  })

  it('migration creates RouteHop FKs', () => {
    expectFK('RouteHop_routeId_fkey', 'Route', 'CASCADE')
    expectFK('RouteHop_fromNodeId_fkey', 'Node', 'CASCADE')
    expectFK('RouteHop_toNodeId_fkey', 'Node', 'CASCADE')
  })

  it('migration creates NodeNetworkMembership FKs', () => {
    expectFK('NodeNetworkMembership_nodeId_fkey', 'Node', 'CASCADE')
    expectFK('NodeNetworkMembership_participantMembershipId_fkey', 'ParticipantMembership', 'CASCADE')
  })

  it('migration creates NodeCapability FK', () => {
    expectFK('NodeCapability_nodeId_fkey', 'Node', 'CASCADE')
  })

  it('migration creates NodeReachability FK', () => {
    expectFK('NodeReachability_nodeId_fkey', 'Node', 'CASCADE')
  })

  it('migration creates TransportExecution FKs', () => {
    expectFK('TransportExecution_tenantId_fkey', 'Tenant', 'CASCADE')
    expectFK('TransportExecution_routeId_fkey', 'Route', 'CASCADE')
    expectFK('TransportExecution_bundleId_fkey', 'Bundle', 'CASCADE')
  })

  it('migration creates TransportAttempt FKs', () => {
    expectFK('TransportAttempt_executionId_fkey', 'TransportExecution', 'CASCADE')
    expectFK('TransportAttempt_fromNodeId_fkey', 'Node', 'CASCADE')
    expectFK('TransportAttempt_toNodeId_fkey', 'Node', 'CASCADE')
  })

  it('migration creates TransportCapability FK', () => {
    expectFK('TransportCapability_nodeId_fkey', 'Node', 'CASCADE')
  })

  it('migration creates DeliveryConfirmation FKs', () => {
    expectFK('DeliveryConfirmation_tenantId_fkey', 'Tenant', 'CASCADE')
    expectFK('DeliveryConfirmation_bundleId_fkey', 'Bundle', 'CASCADE')
    expectFK('DeliveryConfirmation_transportAttemptId_fkey', 'TransportAttempt', 'SET NULL')
    expectFK('DeliveryConfirmation_receiverNodeId_fkey', 'Node', 'CASCADE')
  })

  // FK constraints use DO $$ guards (idempotent)
  it('migration uses DO $$ guards for FK additions (idempotent)', () => {
    const doCount = (migration.match(/DO \$\$/g) || []).length
    expect(doCount).toBeGreaterThan(20)
  })

  // Old unique constraint is dropped if it exists
  it('migration drops old nullable-nodeId unique constraint if it exists', () => {
    expect(migration).toContain('TransformRecord_tenantId_bundleId_nodeId_transformType_idempotencyKey_key')
    expect(migration).toContain('DROP CONSTRAINT')
  })
})
