// =============================================================================
// Tenant context + isolation guard.
//
// CRITICAL SECURITY RULE: tenant_id is NEVER trusted from the request body.
// It is resolved from the authenticated session (JWT cookie). Admin users can
// switch tenants via the X-Tenant-Id header; non-admin users are locked to
// their session's tenantId.
//
// Every tenant-owned query MUST pass through assertTenantScope to enforce
// isolation.
// =============================================================================

import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ForbiddenError, UnauthorizedError } from './errors'
import { type SessionUser } from './auth'
import { getSessionFromRequest } from '@/lib/services/auth.service'

export interface TenantContext {
  tenantId: string
  actorId?: string
  user: SessionUser
  isAdmin: boolean
}

/**
 * Resolve a tenant context from the authenticated session.
 *
 * - Requires a valid session cookie (JWT).
 * - Admin users can specify a tenant via X-Tenant-Id header (switching).
 * - Non-admin users are locked to their session's tenantId.
 * - If a non-admin has no tenantId, they get a 403 (no tenant access).
 */
export async function resolveTenantContext(
  req: NextRequest,
): Promise<TenantContext> {
  const session = getSessionFromRequest(req)
  if (!session) throw new UnauthorizedError('Authentication required')

  // Admin can switch tenants via header.
  if (session.role === 'admin') {
    const tenantHeader = req.headers.get('x-tenant-id')
    if (tenantHeader) {
      const tenant = await db.tenant.findFirst({
        where: { OR: [{ id: tenantHeader }, { slug: tenantHeader }] },
      })
      if (!tenant) throw new UnauthorizedError(`Unknown tenant: ${tenantHeader}`)
      if (tenant.status !== 'active') throw new ForbiddenError('Tenant is not active')
      return { tenantId: tenant.id, actorId: session.userId, user: session, isAdmin: true }
    }
    // Admin without explicit tenant — use first active tenant as default.
    const first = await db.tenant.findFirst({ where: { status: 'active' }, orderBy: { createdAt: 'asc' } })
    if (!first) throw new UnauthorizedError('No tenants exist yet')
    return { tenantId: first.id, actorId: session.userId, user: session, isAdmin: true }
  }

  // Non-admin: locked to session tenantId.
  if (!session.tenantId) {
    throw new ForbiddenError('Your account is not associated with a tenant')
  }
  return { tenantId: session.tenantId, actorId: session.userId, user: session, isAdmin: false }
}

/**
 * Hard isolation guard. Asserts that `resourceTenantId` matches the context's
 * tenant. Used wherever a resource is loaded by id from client input.
 */
export function assertTenantScope(ctx: TenantContext, resourceTenantId: string) {
  if (ctx.tenantId !== resourceTenantId) {
    throw new ForbiddenError('Tenant isolation violated')
  }
}
