// =============================================================================
// API helpers: uniform route handler wrapper with tenant resolution,
// structured error handling, correlation IDs, and JSON responses.
// =============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { resolveTenantContext, type TenantContext } from './tenant-context'
import { toApiError, DomainError } from './errors'
import { db } from '@/lib/db'
import { randomUUID } from 'crypto'

type Handler<TParams = Record<string, never>> = (
  ctx: TenantContext,
  req: NextRequest,
  params: TParams,
) => Promise<NextResponse | unknown>

/**
 * Next.js 16 route context. `params` is a Promise in dynamic routes.
 */
export interface RouteContext<TParams = Record<string, string>> {
  params: Promise<TParams>
}

function correlationId(req: NextRequest): string {
  return req.headers.get('x-request-id') ?? randomUUID()
}

function json(body: unknown, status = 200, req?: NextRequest) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (req) headers['x-request-id'] = correlationId(req)
  return NextResponse.json(body, { status, headers })
}

/**
 * Wrap an API route handler. Resolves tenant context from headers, maps
 * domain errors to HTTP status, attaches a correlation id.
 *
 * Supports both static routes (no context) and dynamic routes (Next.js 16
 * passes `{ params: Promise<...> }`).
 *
 * If `requireTenant` is false (bootstrap endpoints like tenant creation or the
 * E2E flow runner), tenant resolution is skipped and ctx.tenantId is empty.
 */
export function apiRoute<TParams = Record<string, never>>(
  handler: Handler<TParams>,
  opts: { requireTenant?: boolean } = { requireTenant: true },
) {
  return async (
    req: NextRequest,
    routeCtx?: RouteContext<Record<string, string>>,
  ): Promise<NextResponse> => {
    const rid = correlationId(req)
    try {
      const tenantCtx = opts.requireTenant === false
        ? { tenantId: '' }
        : await resolveTenantContext(req.headers)
      // Resolve params (Next.js 16: params is a Promise).
      const params = (routeCtx?.params ? await routeCtx.params : ({} as Record<string, string>)) as unknown as TParams
      const result = await handler(tenantCtx, req, params)
      if (result instanceof NextResponse) {
        result.headers.set('x-request-id', rid)
        return result
      }
      return json(result, 200, req)
    } catch (err) {
      const apiErr = toApiError(err)
      if (err instanceof DomainError && err.statusCode === 200) {
        // Idempotency replay — return 200 with the stored body.
        return json((err as any).details ?? { ok: true }, 200, req)
      }
      console.error(`[api] ${req.method} ${req.nextUrl.pathname} rid=${rid}`, err)
      return NextResponse.json(apiErr.error, { status: apiErr.statusCode, headers: { 'x-request-id': rid } })
    }
  }
}

/** Read JSON body safely. */
export async function readJsonBody(req: NextRequest): Promise<unknown> {
  try {
    const text = await req.text()
    if (!text) return {}
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** Extract Idempotency-Key header (required for financially important APIs). */
export function getIdempotencyKey(req: NextRequest, fallback?: string): string {
  const key = req.headers.get('idempotency-key')
  if (key) return key
  if (fallback) return fallback
  throw new DomainError(
    'Idempotency-Key header is required for this operation',
    'MISSING_IDEMPOTENCY_KEY',
    400,
  )
}

/**
 * Health check data. Used by /internal/health.
 */
export async function healthSnapshot() {
  const [
    tenants, networks, operators, assets, devices, events,
    attestations, contributions, rewards, ledgerEntries, settlements, domainEvents,
  ] = await Promise.all([
    db.tenant.count(),
    db.networkDefinition.count(),
    db.operator.count(),
    db.asset.count(),
    db.device.count(),
    db.event.count(),
    db.attestation.count(),
    db.contribution.count(),
    db.reward.count(),
    db.ledgerEntry.count(),
    db.settlement.count(),
    db.domainEvent.count(),
  ])
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    counts: {
      tenants, networks, operators, assets, devices, events,
      attestations, contributions, rewards, ledgerEntries, settlements, domainEvents,
    },
  }
}
