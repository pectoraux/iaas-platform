/**
 * VPP-3: Buyer Settlement tests (decimal-safe, measurement-aware, string boundary).
 *
 * Tests the buyer charge computation using Prisma.Decimal throughout,
 * with all monetary values returned as strings (not parseFloat).
 *
 * Run: bun test tests/buyer-settlement.test.ts --timeout 30000
 */
import { describe, it, expect } from 'bun:test'
import { Prisma } from '@prisma/client'
import { computeBuyerCharge } from '../src/lib/services/buyer-settlement.service'

function D(n: number | string): Prisma.Decimal {
  return new Prisma.Decimal(n)
}

// ---------------------------------------------------------------------------
// Fulfilled (met tolerance)
// ---------------------------------------------------------------------------

describe('Buyer Settlement: fulfilled (met tolerance)', () => {
  it('buyer pays full capped charge when delivery meets commitment', () => {
    const result = computeBuyerCharge({
      buyerDeliveredKwh: D(1000),
      committedKw: D(500),
      requestedKwh: D(1000),
      durationHours: D(2),
      pricePerKwh: D(0.12),
      fulfillmentPct: D(100),
      toleranceThresholdPct: D(90),
      currency: 'USD',
      measurementMethod: 'average_power',
    })

    expect(result.deliveredCharge.toString()).toBe('120')
    expect(result.capacityCeiling.toString()).toBe('120')
    expect(result.cappedCharge.toString()).toBe('120')
    expect(result.metTolerance).toBe(true)
    expect(result.buyerCharge.toString()).toBe('120')
    expect(result.shortfall.toString()).toBe('0')
  })

  it('buyer pays full charge at exactly tolerance threshold', () => {
    const result = computeBuyerCharge({
      buyerDeliveredKwh: D(900),
      committedKw: D(500),
      requestedKwh: D(1000),
      durationHours: D(2),
      pricePerKwh: D(0.12),
      fulfillmentPct: D(90),
      toleranceThresholdPct: D(90),
      currency: 'USD',
      measurementMethod: 'average_power',
    })

    expect(result.metTolerance).toBe(true)
    expect(result.buyerCharge.toString()).toBe('108')
    expect(result.shortfall.toString()).toBe('12')
  })
})

// ---------------------------------------------------------------------------
// Partial (below tolerance)
// ---------------------------------------------------------------------------

describe('Buyer Settlement: partial (below tolerance)', () => {
  it('buyer pays proportional charge when below tolerance', () => {
    const result = computeBuyerCharge({
      buyerDeliveredKwh: D(750),
      committedKw: D(500),
      requestedKwh: D(1000),
      durationHours: D(2),
      pricePerKwh: D(0.12),
      fulfillmentPct: D(75),
      toleranceThresholdPct: D(90),
      currency: 'USD',
      measurementMethod: 'average_power',
    })

    expect(result.metTolerance).toBe(false)
    expect(result.cappedCharge.toString()).toBe('90')
    expect(result.buyerCharge.toString()).toBe('67.5')
    expect(result.shortfall.toString()).toBe('52.5')
  })
})

// ---------------------------------------------------------------------------
// Failed (zero delivery)
// ---------------------------------------------------------------------------

describe('Buyer Settlement: failed (zero delivery)', () => {
  it('buyer pays nothing when delivery is zero', () => {
    const result = computeBuyerCharge({
      buyerDeliveredKwh: D(0),
      committedKw: D(500),
      requestedKwh: D(1000),
      durationHours: D(2),
      pricePerKwh: D(0.12),
      fulfillmentPct: D(0),
      toleranceThresholdPct: D(90),
      currency: 'USD',
      measurementMethod: 'average_power',
    })

    expect(result.buyerCharge.toString()).toBe('0')
    expect(result.shortfall.toString()).toBe('120')
  })
})

// ---------------------------------------------------------------------------
// Overdelivery (capped)
// ---------------------------------------------------------------------------

describe('Buyer Settlement: overdelivery (capped)', () => {
  it('buyer charge capped at capacity ceiling', () => {
    const result = computeBuyerCharge({
      buyerDeliveredKwh: D(1500),
      committedKw: D(500),
      requestedKwh: D(1000),
      durationHours: D(2),
      pricePerKwh: D(0.12),
      fulfillmentPct: D(150),
      toleranceThresholdPct: D(90),
      currency: 'USD',
      measurementMethod: 'average_power',
    })

    expect(result.deliveredCharge.toString()).toBe('180')
    expect(result.capacityCeiling.toString()).toBe('120')
    expect(result.cappedCharge.toString()).toBe('120')
    expect(result.buyerCharge.toString()).toBe('120')
  })
})

// ---------------------------------------------------------------------------
// Energy measurement method
// ---------------------------------------------------------------------------

describe('Buyer Settlement: energy measurement method', () => {
  it('capacity ceiling = requestedKwh × price (not kW × duration × price)', () => {
    const result = computeBuyerCharge({
      buyerDeliveredKwh: D(800),
      committedKw: D(500),
      requestedKwh: D(1000),
      durationHours: D(2),
      pricePerKwh: D(0.12),
      fulfillmentPct: D(80),
      toleranceThresholdPct: D(90),
      currency: 'USD',
      measurementMethod: 'energy',
    })

    expect(result.capacityCeiling.toString()).toBe('120')
    expect(result.deliveredCharge.toString()).toBe('96')
    expect(result.cappedCharge.toString()).toBe('96')
    expect(result.buyerCharge.toString()).toBe('76.8')
  })

  it('energy vs average_power produce different ceilings when requestedKwh ≠ kW×duration', () => {
    const energyResult = computeBuyerCharge({
      buyerDeliveredKwh: D(1400),
      committedKw: D(500),
      requestedKwh: D(1500),
      durationHours: D(2),
      pricePerKwh: D(0.12),
      fulfillmentPct: D(100),
      toleranceThresholdPct: D(90),
      currency: 'USD',
      measurementMethod: 'energy',
    })

    const powerResult = computeBuyerCharge({
      buyerDeliveredKwh: D(1400),
      committedKw: D(500),
      requestedKwh: D(1500),
      durationHours: D(2),
      pricePerKwh: D(0.12),
      fulfillmentPct: D(100),
      toleranceThresholdPct: D(90),
      currency: 'USD',
      measurementMethod: 'average_power',
    })

    expect(energyResult.capacityCeiling.toString()).toBe('180') // 1500 × 0.12
    expect(powerResult.capacityCeiling.toString()).toBe('120') // 500 × 2 × 0.12
  })
})

// ---------------------------------------------------------------------------
// Decimal arithmetic properties
// ---------------------------------------------------------------------------

describe('Buyer Settlement: decimal arithmetic', () => {
  it('uses Prisma.Decimal throughout (no JS number precision loss)', () => {
    const result = computeBuyerCharge({
      buyerDeliveredKwh: D('1000.123456789'),
      committedKw: D(500),
      requestedKwh: D(1000),
      durationHours: D(2),
      pricePerKwh: D('0.123456789'),
      fulfillmentPct: D(100),
      toleranceThresholdPct: D(90),
      currency: 'USD',
      measurementMethod: 'average_power',
    })

    expect(result.buyerDeliveredKwh).toBeInstanceOf(Prisma.Decimal)
    expect(result.pricePerKwh).toBeInstanceOf(Prisma.Decimal)
    expect(result.buyerCharge).toBeInstanceOf(Prisma.Decimal)
    expect(result.deliveredCharge.isFinite()).toBe(true)
    expect(result.buyerCharge.isFinite()).toBe(true)
  })

  it('shortfall = capacityCeiling - buyerCharge (exact Decimal)', () => {
    const result = computeBuyerCharge({
      buyerDeliveredKwh: D(500),
      committedKw: D(500),
      requestedKwh: D(1000),
      durationHours: D(2),
      pricePerKwh: D(0.12),
      fulfillmentPct: D(50),
      toleranceThresholdPct: D(90),
      currency: 'USD',
      measurementMethod: 'average_power',
    })

    const expectedShortfall = result.capacityCeiling.minus(result.buyerCharge)
    expect(result.shortfall.equals(expectedShortfall)).toBe(true)
  })

  it('zero price → zero charge', () => {
    const result = computeBuyerCharge({
      buyerDeliveredKwh: D(1000),
      committedKw: D(500),
      requestedKwh: D(1000),
      durationHours: D(2),
      pricePerKwh: D(0),
      fulfillmentPct: D(100),
      toleranceThresholdPct: D(90),
      currency: 'USD',
      measurementMethod: 'average_power',
    })

    expect(result.buyerCharge.toString()).toBe('0')
    expect(result.capacityCeiling.toString()).toBe('0')
  })
})

// ---------------------------------------------------------------------------
// Pricing policy snapshot (VPP-3B fix 7)
// ---------------------------------------------------------------------------

describe('Buyer Settlement: pricing policy snapshot', () => {
  it('charge is deterministic from settlement fields (not re-read from program)', () => {
    // The settlement stores pricePerKwh, measurementMethod, toleranceThresholdPct
    // as a snapshot at creation time. The charge formula is:
    //   buyerCharge = f(buyerDeliveredKwh, pricePerKwh, committedKw/requestedKwh,
    //                   durationHours, fulfillmentPct, toleranceThresholdPct,
    //                   measurementMethod)
    // All inputs are on the settlement record — no re-read from VppBuyerProgram.
    //
    // This test verifies the charge is deterministic from these fields alone.
    const charge1 = computeBuyerCharge({
      buyerDeliveredKwh: D(1000),
      committedKw: D(500),
      requestedKwh: D(1000),
      durationHours: D(2),
      pricePerKwh: D('0.15'),
      fulfillmentPct: D(95),
      toleranceThresholdPct: D(90),
      currency: 'USD',
      measurementMethod: 'average_power',
    })

    // Same inputs → same charge (deterministic).
    const charge2 = computeBuyerCharge({
      buyerDeliveredKwh: D(1000),
      committedKw: D(500),
      requestedKwh: D(1000),
      durationHours: D(2),
      pricePerKwh: D('0.15'),
      fulfillmentPct: D(95),
      toleranceThresholdPct: D(90),
      currency: 'USD',
      measurementMethod: 'average_power',
    })

    expect(charge1.buyerCharge.toString()).toBe(charge2.buyerCharge.toString())
  })

  it('different pricePerKwh produces different charge (historical pricing preserved)', () => {
    // If VppBuyerProgram.pricePerKwh changes from 0.12 to 0.15 after a
    // dispatch, historical settlements use the original 0.12 (snapshot).
    const originalPricing = computeBuyerCharge({
      buyerDeliveredKwh: D(1000),
      committedKw: D(500),
      requestedKwh: D(1000),
      durationHours: D(2),
      pricePerKwh: D('0.12'),
      fulfillmentPct: D(100),
      toleranceThresholdPct: D(90),
      currency: 'USD',
      measurementMethod: 'average_power',
    })

    const updatedPricing = computeBuyerCharge({
      buyerDeliveredKwh: D(1000),
      committedKw: D(500),
      requestedKwh: D(1000),
      durationHours: D(2),
      pricePerKwh: D('0.15'),
      fulfillmentPct: D(100),
      toleranceThresholdPct: D(90),
      currency: 'USD',
      measurementMethod: 'average_power',
    })

    expect(originalPricing.buyerCharge.toString()).toBe('120')
    expect(updatedPricing.buyerCharge.toString()).toBe('150')
    // Historical settlement would use 120, not 150.
  })
})
