import { NextRequest, NextResponse } from 'next/server'
import { listWaitlist, approveWaitlistEntry } from '@/lib/services/auth.service'
import { requireAdmin } from '@/lib/services/auth.service'
import { toApiError } from '@/lib/domain/errors'
import { randomUUID } from 'crypto'

export async function GET(req: NextRequest) {
  const rid = req.headers.get('x-request-id') ?? randomUUID()
  try {
    requireAdmin(req)
    const url = new URL(req.url)
    const status = url.searchParams.get('status') ?? undefined
    const entries = await listWaitlist(status)
    return NextResponse.json(entries, { headers: { 'x-request-id': rid } })
  } catch (err) {
    const apiErr = toApiError(err)
    return NextResponse.json(apiErr.error, { status: apiErr.statusCode, headers: { 'x-request-id': rid } })
  }
}

export async function POST(req: NextRequest) {
  const rid = req.headers.get('x-request-id') ?? randomUUID()
  try {
    const admin = requireAdmin(req)
    const body = await req.json().catch(() => ({}))
    const result = await approveWaitlistEntry(body.waitlistId, admin.userId, {
      role: body.role,
      tenantName: body.tenantName,
      displayName: body.displayName,
    })
    return NextResponse.json(result, { status: 201, headers: { 'x-request-id': rid } })
  } catch (err) {
    const apiErr = toApiError(err)
    return NextResponse.json(apiErr.error, { status: apiErr.statusCode, headers: { 'x-request-id': rid } })
  }
}
