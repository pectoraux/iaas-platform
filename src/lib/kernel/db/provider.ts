// =============================================================================
// Kernel: Database Provider Detection
// =============================================================================
// Vertical-agnostic helper for detecting the active Prisma database provider.
//
// The platform schema is designed for PostgreSQL (row-level locking via
// FOR UPDATE, SKIP LOCKED job claiming). In local/test environments a SQLite
// database may be used instead. SQLite does NOT support:
//   - SELECT ... FOR UPDATE          (syntax error)
//   - SELECT ... FOR UPDATE SKIP LOCKED (syntax error)
//   - ::type casts                   (syntax error)
//   - NOW() / INTERVAL expressions   (not available)
//   - UPDATE ... RETURNING           (not supported via Prisma raw on sqlite)
//
// On SQLite, transaction isolation (SERIALIZABLE via BEGIN IMMEDIATE under
// Prisma interactive transactions) provides the correctness guarantees that
// FOR UPDATE provides on PostgreSQL. The row locks are a concurrency
// OPTIMISATION, not a correctness requirement — the transaction is the
// correctness boundary.
//
// This helper lets service code conditionally skip postgres-only raw SQL
// when running on SQLite, so the SAME service code works in both
// environments without duplicating logic.
// =============================================================================

/** Cached provider detection result. */
let cachedProvider: string | null = null

/**
 * Detect the active Prisma database provider from the DATABASE_URL scheme.
 *
 *   postgresql://...  → 'postgresql'
 *   postgres://...    → 'postgresql'
 *   file:...          → 'sqlite'
 *
 * The result is cached for the process lifetime (the provider does not
 * change at runtime).
 */
export function getActiveProvider(): string {
  if (cachedProvider) return cachedProvider
  const url = process.env.DATABASE_URL ?? ''
  if (url.startsWith('postgres')) {
    cachedProvider = 'postgresql'
  } else if (url.startsWith('file:')) {
    cachedProvider = 'sqlite'
  } else {
    // Default: assume postgresql (the production provider).
    cachedProvider = 'postgresql'
  }
  return cachedProvider
}

/**
 * Returns true if the active provider supports row-level locking
 * (FOR UPDATE / FOR UPDATE SKIP LOCKED). PostgreSQL does; SQLite does not.
 *
 * On SQLite, callers should SKIP the FOR UPDATE raw query — the enclosing
 * Prisma interactive transaction already provides SERIALIZABLE isolation.
 */
export function supportsRowLocking(): boolean {
  return getActiveProvider() === 'postgresql'
}

/**
 * Returns true if the active provider is SQLite.
 */
export function isSqlite(): boolean {
  return getActiveProvider() === 'sqlite'
}
