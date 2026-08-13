// =============================================================================
// Authentication core: password hashing (scrypt), JWT sessions, cookies.
//
// Uses Node.js built-in crypto (no external deps, works on Vercel serverless).
// Secrets are NEVER stored in plaintext — scrypt with random salt.
// =============================================================================

import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'crypto'

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'
const COOKIE_NAME = 'iaas_session'
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000 // 7 days in ms

export type UserRole = 'admin' | 'owner' | 'operator' | 'viewer'

export interface SessionUser {
  userId: string
  email: string
  role: UserRole
  tenantId: string | null
  isDemo: boolean
  displayName: string
}

// ---------------------------------------------------------------------------
// Password hashing — scrypt (built-in, works on Vercel)
// ---------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [salt, hash] = stored.split(':')
    if (!salt || !hash) return false
    const hashBuf = scryptSync(password, salt, 64)
    return timingSafeEqual(Buffer.from(hash, 'hex'), hashBuf)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// JWT — simple HMAC-SHA256 signed tokens (no external deps)
// ---------------------------------------------------------------------------

function base64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url')
}

export function createToken(user: SessionUser): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({
    ...user,
    iat: Date.now(),
    exp: Date.now() + SESSION_MAX_AGE,
  }))
  const sig = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

export function verifyToken(token: string): SessionUser | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [header, payload, sig] = parts
    const expectedSig = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url')
    if (sig !== expectedSig) return null
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (data.exp && Date.now() > data.exp) return null
    return {
      userId: data.userId,
      email: data.email,
      role: data.role,
      tenantId: data.tenantId,
      isDemo: data.isDemo,
      displayName: data.displayName,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Cookie helpers — work with Next.js cookies() API
// ---------------------------------------------------------------------------

export function sessionCookieConfig() {
  return {
    name: COOKIE_NAME,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE / 1000, // seconds
  }
}

export function clearCookieConfig() {
  return {
    name: COOKIE_NAME,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 0,
  }
}

export { COOKIE_NAME, JWT_SECRET }
