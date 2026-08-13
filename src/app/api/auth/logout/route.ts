import { NextRequest, NextResponse } from 'next/server'
import { clearCookieConfig } from '@/lib/domain/auth'
import { randomUUID } from 'crypto'

export async function POST(req: NextRequest) {
  const rid = req.headers.get('x-request-id') ?? randomUUID()
  const res = NextResponse.json({ ok: true }, { headers: { 'x-request-id': rid } })
  res.cookies.set(clearCookieConfig().name, '', clearCookieConfig())
  return res
}
