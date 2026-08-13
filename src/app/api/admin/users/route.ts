import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, listUsers } from '@/lib/services/auth.service'
import { toApiError } from '@/lib/domain/errors'
import { randomUUID } from 'crypto'

export async function GET(req: NextRequest) {
  const rid = req.headers.get('x-request-id') ?? randomUUID()
  try {
    requireAdmin(req)
    const users = await listUsers()
    return NextResponse.json(users, { headers: { 'x-request-id': rid } })
  } catch (err) {
    const apiErr = toApiError(err)
    return NextResponse.json(apiErr.error, { status: apiErr.statusCode, headers: { 'x-request-id': rid } })
  }
}
