import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/services/auth.service'
import { randomUUID } from 'crypto'

export async function GET(req: NextRequest) {
  const rid = req.headers.get('x-request-id') ?? randomUUID()
  const session = getSessionFromRequest(req)
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401, headers: { 'x-request-id': rid } })
  }
  return NextResponse.json({ authenticated: true, user: session }, { headers: { 'x-request-id': rid } })
}
