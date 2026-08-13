import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { markProcessed } from '@/lib/domain/events'

/**
 * Internal worker endpoint: drains the domain-event outbox.
 * In production this would be a BullMQ worker; here it's a callable endpoint
 * so the dashboard can trigger processing. It marks events as processed
 * (side effects already emitted inline during the originating operation).
 */
export const POST = async () => {
  const pending = await db.domainEvent.findMany({
    where: { processed: false },
    take: 100,
    orderBy: { occurredAt: 'asc' },
  })
  for (const evt of pending) {
    // The domain logic already ran inline; this just marks the outbox row processed.
    // A real worker would dispatch to downstream consumers here.
    await markProcessed(evt.id)
  }
  return NextResponse.json({ processed: pending.length })
}
