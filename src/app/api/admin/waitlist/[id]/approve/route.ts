import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, approveWaitlistEntry } from '@/lib/services/auth.service'
import { toApiError } from '@/lib/domain/errors'
import { randomUUID } from 'crypto'

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const rid = req.headers.get('x-request-id') ?? randomUUID()
  try {
    const admin = requireAdmin(req)
    const { id } = await ctx.params
    const body = await req.json().catch(() => ({}))
    const result = await approveWaitlistEntry(id, admin.userId, {
      role: body.role,
      tenantName: body.tenantName,
      displayName: body.displayName,
    })
    return NextResponse.json(result, { headers: { 'x-request-id': rid } })
  } catch (err) {
    const apiErr = toApiError(err)
    return NextResponse.json(apiErr.error, { status: apiErr.statusCode, headers: { 'x-request-id': rid } })
  }
}
