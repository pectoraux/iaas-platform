// =============================================================================
// Auth service — signup (waitlist), login, logout, session resolution,
// admin waitlist approval.
// =============================================================================

import { db } from '@/lib/db'
import { ConflictError, NotFoundError, ValidationError, ForbiddenError } from '@/lib/domain/errors'
import {
  hashPassword,
  verifyPassword,
  createToken,
  type SessionUser,
  type UserRole,
} from '@/lib/domain/auth'
import { createTenant } from './tenant.service'
import { appendAudit, AuditEvents } from '@/lib/domain/audit'
import { randomBytes } from 'crypto'

// ---------------------------------------------------------------------------
// Signup → waitlist
// ---------------------------------------------------------------------------

export interface SignupInput {
  email: string
  requestedRole: UserRole
  reason?: string
}

export async function joinWaitlist(input: SignupInput): Promise<{ id: string; status: string }> {
  const email = input.email.toLowerCase().trim()
  if (!email || !email.includes('@')) throw new ValidationError('Valid email is required')

  // Check if already on waitlist or already a user
  const existingWaitlist = await db.waitlist.findUnique({ where: { email } })
  if (existingWaitlist) {
    if (existingWaitlist.status === 'pending') {
      return { id: existingWaitlist.id, status: 'pending' }
    }
    throw new ConflictError(`Email ${email} was already ${existingWaitlist.status}`)
  }
  const existingUser = await db.platformUser.findUnique({ where: { email } })
  if (existingUser) throw new ConflictError(`Email ${email} already has an account`)

  const entry = await db.waitlist.create({
    data: {
      email,
      requestedRole: input.requestedRole,
      reason: input.reason ?? null,
      status: 'pending',
    },
  })
  return { id: entry.id, status: entry.status }
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export interface LoginResult {
  user: SessionUser
  token: string
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const normalizedEmail = email.toLowerCase().trim()
  const user = await db.platformUser.findUnique({ where: { email: normalizedEmail } })
  if (!user) throw new ValidationError('Invalid email or password')
  if (user.status !== 'active') throw new ForbiddenError(`Account is ${user.status}`)
  if (!verifyPassword(password, user.passwordHash)) {
    throw new ValidationError('Invalid email or password')
  }

  const sessionUser: SessionUser = {
    userId: user.id,
    email: user.email,
    role: user.role as UserRole,
    tenantId: user.tenantId,
    isDemo: user.isDemo,
    displayName: user.displayName,
  }
  const token = createToken(sessionUser)
  return { user: sessionUser, token }
}

// ---------------------------------------------------------------------------
// Session resolution (from cookie)
// ---------------------------------------------------------------------------

import { verifyToken, COOKIE_NAME } from '@/lib/domain/auth'
import { NextRequest } from 'next/server'
import { UnauthorizedError } from '@/lib/domain/errors'

/**
 * Resolve the current session from the request cookie.
 * Returns null if not authenticated.
 */
export function getSessionFromRequest(req: NextRequest): SessionUser | null {
  const token = req.cookies.get(COOKIE_NAME)?.value
  if (!token) return null
  return verifyToken(token)
}

/**
 * Require authentication. Throws UnauthorizedError if no valid session.
 */
export function requireSession(req: NextRequest): SessionUser {
  const session = getSessionFromRequest(req)
  if (!session) throw new UnauthorizedError('Authentication required')
  return session
}

/**
 * Require admin role.
 */
export function requireAdmin(req: NextRequest): SessionUser {
  const session = requireSession(req)
  if (session.role !== 'admin') throw new ForbiddenError('Admin access required')
  return session
}

// ---------------------------------------------------------------------------
// Admin: list / approve / reject waitlist
// ---------------------------------------------------------------------------

export async function listWaitlist(status?: string) {
  return db.waitlist.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: 'desc' },
  })
}

export async function approveWaitlistEntry(
  waitlistId: string,
  adminId: string,
  overrides?: { role?: UserRole; tenantName?: string; displayName?: string },
): Promise<{ user: { id: string; email: string }; temporaryPassword: string }> {
  const entry = await db.waitlist.findUnique({ where: { id: waitlistId } })
  if (!entry) throw new NotFoundError('waitlist', waitlistId)
  if (entry.status !== 'pending') throw new ConflictError(`Waitlist entry is already ${entry.status}`)

  const role = overrides?.role ?? (entry.requestedRole as UserRole)
  const displayName = overrides?.displayName ?? entry.email.split('@')[0]

  // Generate a temporary password the admin communicates to the user.
  const temporaryPassword = generateTemporaryPassword()
  const passwordHash = hashPassword(temporaryPassword)

  // For non-admin roles, create a tenant.
  let tenantId: string | null = null
  if (role !== 'admin') {
    const tenantSlug = `tenant-${randomBytes(4).toString('hex')}`
    const tenant = await createTenant({ name: overrides?.tenantName ?? `${displayName}'s Network`, slug: tenantSlug, plan: 'starter' })
    tenantId = tenant.id
  }

  const user = await db.platformUser.create({
    data: {
      email: entry.email,
      passwordHash,
      role,
      tenantId,
      status: 'active',
      isDemo: false,
      displayName,
    },
  })

  await db.waitlist.update({
    where: { id: waitlistId },
    data: {
      status: 'approved',
      approvedById: adminId,
      createdUserId: user.id,
      reviewedAt: new Date(),
    },
  })

  await appendAudit({
    tenantId: tenantId ?? user.id, // use user id if no tenant
    actorId: adminId,
    eventType: 'waitlist.approved',
    resourceType: 'platform_user',
    resourceId: user.id,
    metadata: { email: user.email, role, tenantId },
  })

  return { user: { id: user.id, email: user.email }, temporaryPassword }
}

export async function rejectWaitlistEntry(waitlistId: string, adminId: string): Promise<void> {
  const entry = await db.waitlist.findUnique({ where: { id: waitlistId } })
  if (!entry) throw new NotFoundError('waitlist', waitlistId)
  if (entry.status !== 'pending') throw new ConflictError(`Waitlist entry is already ${entry.status}`)
  await db.waitlist.update({
    where: { id: waitlistId },
    data: { status: 'rejected', approvedById: adminId, reviewedAt: new Date() },
  })
}

// ---------------------------------------------------------------------------
// User management helpers
// ---------------------------------------------------------------------------

export async function listUsers() {
  return db.platformUser.findMany({
    select: { id: true, email: true, role: true, tenantId: true, status: true, isDemo: true, displayName: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getUserById(id: string) {
  return db.platformUser.findUnique({ where: { id } })
}

function generateTemporaryPassword(): string {
  // Generate a memorable but secure temporary password.
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const segments = Array.from({ length: 3 }, () =>
    Array.from({ length: 6 }, () => chars[randomBytes(1)[0] % chars.length]).join(''),
  )
  return segments.join('-')
}

// Re-export for AuditEvents augmentation
export { AuditEvents }
