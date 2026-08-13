// =============================================================================
// Tenant service.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, ValidationError } from '@/lib/domain/errors'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'

export interface CreateTenantInput {
  name: string
  slug: string
  plan?: string
}

function slugify(s: string): string {
  const cleaned = s.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (!cleaned) throw new ValidationError('Invalid slug')
  return cleaned
}

export async function createTenant(input: CreateTenantInput, actorId?: string) {
  const slug = slugify(input.slug)
  const existing = await db.tenant.findUnique({ where: { slug } })
  if (existing) throw new ConflictError(`Tenant slug already exists: ${slug}`)

  const tenant = await db.tenant.create({
    data: { name: input.name, slug, plan: input.plan ?? 'starter', status: 'active' },
  })
  await appendAudit({
    tenantId: tenant.id,
    actorId,
    eventType: AuditEvents.TenantCreated,
    resourceType: 'tenant',
    resourceId: tenant.id,
    metadata: { name: tenant.name, slug, plan: tenant.plan },
  })
  return tenant
}

export async function listTenants() {
  return db.tenant.findMany({ orderBy: { createdAt: 'desc' } })
}

export async function getTenant(id: string) {
  return db.tenant.findUnique({ where: { id } })
}
