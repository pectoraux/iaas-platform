import { NextRequest, NextResponse } from 'next/server'
import { joinWaitlist } from '@/lib/services/auth.service'
import { toApiError } from '@/lib/domain/errors'
import { randomUUID } from 'crypto'

export async function POST(req: NextRequest) {
  const rid = req.headers.get('x-request-id') ?? randomUUID()
  try {
    const body = await req.json().catch(() => ({}))
    const result = await joinWaitlist({
      email: body.email ?? '',
      requestedRole: body.requestedRole ?? 'owner',
      reason: body.reason,
    })
    return NextResponse.json(result, { status: 201, headers: { 'x-request-id': rid } })
  } catch (err) {
    const apiErr = toApiError(err)
    return NextResponse.json(apiErr.error, { status: apiErr.statusCode, headers: { 'x-request-id': rid } })
  }
}
