import { NextRequest, NextResponse } from 'next/server'
import { runE2EFlow } from '@/lib/services/dashboard.service'
import { toApiError } from '@/lib/domain/errors'
import { randomUUID } from 'crypto'
import { requireAdmin } from '@/lib/services/auth.service'

/**
 * POST /api/v1/dashboard/e2e
 *
 * Runs the complete Event → Settlement vertical slice in its own fresh tenant.
 * Requires admin authentication. Returns every id along the chain.
 */
export async function POST(req: NextRequest) {
  const rid = req.headers.get('x-request-id') ?? randomUUID()
  try {
    // Require admin session.
    const session = requireAdmin(req)

    const text = await req.text()
    const body = text ? JSON.parse(text) : {}
    const result = await runE2EFlow({
      templateKey: body.templateKey,
      tenantSlug: body.tenantSlug,
      payload: body.payload,
    })
    void session // session verified
    return NextResponse.json(result, { headers: { 'x-request-id': rid } })
  } catch (err) {
    const apiErr = toApiError(err)
    console.error(`[api] POST /api/v1/dashboard/e2e rid=${rid}`, err)
    return NextResponse.json(apiErr.error, { status: apiErr.statusCode, headers: { 'x-request-id': rid } })
  }
}
