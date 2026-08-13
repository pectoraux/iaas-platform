import { NextResponse } from 'next/server'
import { processEventOutbox, processSettlementOutbox } from '@/lib/services/worker.service'

/**
 * Internal worker endpoint: drains BOTH outboxes (events + settlements).
 * In production this would be a BullMQ worker consuming Redis. For Vercel
 * serverless, it's triggered by the client (after ingestion) or a cron job.
 */
export async function POST() {
  const events = await processEventOutbox()
  const settlements = await processSettlementOutbox()
  return NextResponse.json({
    events,
    settlements,
    total_processed: events.processed + settlements.processed,
  })
}

export async function GET() {
  return POST()
}
