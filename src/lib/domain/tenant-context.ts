// =============================================================================
// Tenant context + isolation guard.
//
// CRITICAL SECURITY RULE: tenant_id is NEVER trusted from the request body.
// It is resolved from the authenticated principal (here: the X-Tenant-Id
// header resolved against the API key, simulated for the MVP). Every tenant-
// owned query MUST pass through `scoped` to enforce isolation.
// =============================================================================

import { db } from '@/lib/db'
import { ForbiddenError, UnauthorizedError } from './errors'

export interface TenantContext {
  tenantId: string
  actorId?: string
}

/**
 * Resolve a tenant context from the request. For the MVP we accept an
 * `X-Tenant-Id` header (the tenant slug or id) and resolve it. In production
 * this would come from the OIDC token / API key.
 */
export async function resolveTenantContext(
  headers: Headers,
): Promise<TenantContext> {
  const tenantHeader = headers.get('x-tenant-id')
  if (!tenantHeader) {
    // Default to the first active tenant so the demo dashboard works without
    // explicit auth, while still requiring the header for write operations
    // that need explicit scoping. We throw if there are zero tenants.
    const first = await db.tenant.findFirst({ where: { status: 'active' }, orderBy: { createdAt: 'asc' } })
    if (!first) throw new UnauthorizedError('No tenant context and no tenants exist')
    return { tenantId: first.id }
  }
  // Accept either id or slug.
  const tenant = await db.tenant.findFirst({
    where: { OR: [{ id: tenantHeader }, { slug: tenantHeader }] },
  })
  if (!tenant) throw new UnauthorizedError(`Unknown tenant: ${tenantHeader}`)
  if (tenant.status !== 'active') throw new ForbiddenError('Tenant is not active')
  const actorId = headers.get('x-actor-id') ?? undefined
  return { tenantId: tenant.id, actorId }
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
