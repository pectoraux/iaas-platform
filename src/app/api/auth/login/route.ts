import { NextRequest, NextResponse } from 'next/server'
import { login } from '@/lib/services/auth.service'
import { toApiError } from '@/lib/domain/errors'
import { sessionCookieConfig } from '@/lib/domain/auth'
import { randomUUID } from 'crypto'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { db } from '@/lib/db'

export async function POST(req: NextRequest) {
  const rid = req.headers.get('x-request-id') ?? randomUUID()
  try {
    const body = await req.json().catch(() => ({}))
    const { user, token } = await login(body.email ?? '', body.password ?? '')

    // Audit login.
    if (user.tenantId) {
      await appendAudit({
        tenantId: user.tenantId,
        actorId: user.userId,
        eventType: AuditEvents.UserLogin,
        resourceType: 'platform_user',
        resourceId: user.userId,
        metadata: { email: user.email, role: user.role },
      })
    } else {
      // Admin without tenant — log to first tenant or skip.
      const t = await db.tenant.findFirst({ orderBy: { createdAt: 'asc' } })
      if (t) {
        await appendAudit({
          tenantId: t.id,
          actorId: user.userId,
          eventType: AuditEvents.UserLogin,
          resourceType: 'platform_user',
          resourceId: user.userId,
          metadata: { email: user.email, role: user.role },
        })
      }
    }

    const res = NextResponse.json({ user }, { headers: { 'x-request-id': rid } })
    res.cookies.set(sessionCookieConfig().name, token, sessionCookieConfig())
    return res
  } catch (err) {
    const apiErr = toApiError(err)
    return NextResponse.json(apiErr.error, { status: apiErr.statusCode, headers: { 'x-request-id': rid } })
  }
}
