import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, rejectWaitlistEntry } from '@/lib/services/auth.service'
import { toApiError } from '@/lib/domain/errors'
import { randomUUID } from 'crypto'

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const rid = req.headers.get('x-request-id') ?? randomUUID()
  try {
    const admin = requireAdmin(req)
    const { id } = await ctx.params
    await rejectWaitlistEntry(id, admin.userId)
    return NextResponse.json({ ok: true }, { headers: { 'x-request-id': rid } })
  } catch (err) {
    const apiErr = toApiError(err)
    return NextResponse.json(apiErr.error, { status: apiErr.statusCode, headers: { 'x-request-id': rid } })
  }
}
