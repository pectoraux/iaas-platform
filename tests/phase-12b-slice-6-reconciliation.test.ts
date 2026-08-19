/**
 * Phase 12B Slice 6: durable reconciliation architecture tests.
 *
 * These tests guard the hardening boundary itself. PostgreSQL end-to-end
 * failure injection remains in phase-12b-slice-6-economic.test.ts; this file
 * ensures the reconciler cannot silently acquire vertical dependencies or
 * bypass the existing generic orchestrator.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('Phase 12B Slice 6: Durable Economic Reconciliation', () => {
  it('is vertical-neutral and imports only the generic economic pipeline', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/lib/control-plane/economic-reconciliation.ts'),
      'utf8',
    )

    expect(source).not.toMatch(/vpp\.service/)
    expect(source).not.toMatch(/compute\.service/)
    expect(source).not.toMatch(/storage\.service/)
    expect(source).not.toMatch(/wireless\.service/)
    expect(source).not.toMatch(/factory\.service/)
    expect(source).not.toMatch(/energy/i)
    expect(source).toContain("from './economic-pipeline'")
  })

  it('hydrates every durable economic boundary before resuming', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/lib/control-plane/economic-reconciliation.ts'),
      'utf8',
    )

    for (const marker of [
      'tenantId_externalEventId',
      'tenantId_idempotencyKey',
      'ledgerIdempotencyKey',
      'where: { rewardId: effectiveRewardId }',
      'reconcileEconomicPipelineBase',
    ]) {
      expect(source).toContain(marker)
    }
  })

  it('refuses to fabricate missing evidence during automatic recovery', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/lib/control-plane/economic-reconciliation.ts'),
      'utf8',
    )

    expect(source).toContain('automatic reconciliation cannot safely reconstruct vertical evidence input')
    expect(source).toContain("stage: ECONOMIC_STAGE.RECONCILIATION_REQUIRED")
    expect(source).not.toContain("signingKey: ''")
  })
})
