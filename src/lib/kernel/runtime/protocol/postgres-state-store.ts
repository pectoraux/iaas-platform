// =============================================================================
// Kernel: PostgreSQL Protocol State Store (Phase 9B)
// =============================================================================
// A persistent, deterministic, versioned key-value state store backed by
// PostgreSQL. This is the production implementation — the in-memory store
// is for testing.
//
// PERSISTENCE:
//   State snapshots are stored in the ProtocolStateSnapshot table. Each
//   commit produces exactly one new row with (networkVersionId, version)
//   UNIQUE. This enforces optimistic concurrency at the database level.
//
// OPTIMISTIC CONCURRENCY:
//   commit(expectedVersion) inserts a new row with version = expectedVersion + 1.
//   The UNIQUE(networkVersionId, version) constraint ensures only one
//   transaction can commit to a given version. If two transactions both
//   try to commit to version N+1, the second insert fails with a unique
//   constraint violation → StaleVersionError.
//
// DETERMINISM:
//   The state hash is computed from the entries in canonical (sorted-key)
//   JSON form, then SHA-256 hashed. The same entries always produce the
//   same hash, regardless of insertion order.
//
// RESTART PROOF:
//   The store loads the latest snapshot from the database on construction.
//   If the runtime is destroyed and reconstructed, it reads the same
//   committed state — state survives restart.
// =============================================================================

import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import type { ProtocolStateStore, ProtocolStateSnapshot } from './types'
import { StaleVersionError } from './types'

/**
 * PostgreSQL-backed implementation of ProtocolStateStore.
 *
 * This is the production implementation. It persists state snapshots to the
 * ProtocolStateSnapshot table with optimistic concurrency control.
 */
export class PostgresProtocolStateStore implements ProtocolStateStore {
  readonly networkVersionId: string
  private currentSnapshot: ProtocolStateSnapshot | null = null
  private stagedEntries: Map<string, string | null> = new Map() // null = delete

  /**
   * @param networkVersionId The network version this store is bound to.
   *   The store loads the latest committed snapshot for this version on
   *   construction (restart recovery).
   */
  constructor(networkVersionId: string) {
    this.networkVersionId = networkVersionId
  }

  async getState(): Promise<ProtocolStateSnapshot> {
    if (!this.currentSnapshot) {
      this.currentSnapshot = await this.loadLatestSnapshot()
    }
    return this.currentSnapshot
  }

  async get(key: string): Promise<string | undefined> {
    const state = await this.getState()
    // Check staged changes first.
    if (this.stagedEntries.has(key)) {
      const staged = this.stagedEntries.get(key)!
      return staged === null ? undefined : staged
    }
    return state.entries.get(key)
  }

  put(key: string, value: string): void {
    this.stagedEntries.set(key, value)
  }

  delete(key: string): void {
    this.stagedEntries.set(key, null)
  }

  async commit(expectedVersion: number): Promise<ProtocolStateSnapshot> {
    const currentState = await this.getState()

    // Optimistic concurrency check (application-level).
    if (expectedVersion !== currentState.version) {
      throw new StaleVersionError(expectedVersion, currentState.version)
    }

    // Apply staged changes to produce the new entries.
    const newEntries = new Map(currentState.entries)
    for (const [key, value] of this.stagedEntries) {
      if (value === null) {
        newEntries.delete(key)
      } else {
        newEntries.set(key, value)
      }
    }

    const newVersion = expectedVersion + 1
    const stateJson = this.serializeEntries(newEntries)
    const stateHash = this.computeHash(newEntries)

    // Insert with optimistic concurrency (database-level).
    // The UNIQUE(networkVersionId, version) constraint ensures only one
    // transaction can commit to this version. If another transaction
    // committed first, the insert fails with a unique constraint violation.
    try {
      await db.protocolStateSnapshot.create({
        data: {
          networkVersionId: this.networkVersionId,
          version: newVersion,
          stateJson,
          stateHash,
        },
      })
    } catch (err) {
      // Check for unique constraint violation (P2002 in Prisma).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Another transaction committed first — reload and throw StaleVersionError.
        this.currentSnapshot = await this.loadLatestSnapshot()
        throw new StaleVersionError(expectedVersion, this.currentSnapshot.version)
      }
      throw err
    }

    // Clear staged changes.
    this.stagedEntries.clear()

    // Update the in-memory cache.
    this.currentSnapshot = {
      version: newVersion,
      hash: stateHash,
      entries: newEntries,
    }

    return this.currentSnapshot
  }

  rollback(): void {
    this.stagedEntries.clear()
  }

  async getSnapshot(version: number): Promise<ProtocolStateSnapshot | undefined> {
    const row = await db.protocolStateSnapshot.findUnique({
      where: {
        networkVersionId_version: {
          networkVersionId: this.networkVersionId,
          version,
        },
      },
    })
    if (!row) return undefined
    return this.deserializeSnapshot(row.version, row.stateJson, row.stateHash)
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Load the latest committed snapshot from the database.
   * If no snapshot exists, create a genesis snapshot (version 0, empty state).
   */
  private async loadLatestSnapshot(): Promise<ProtocolStateSnapshot> {
    const latest = await db.protocolStateSnapshot.findFirst({
      where: { networkVersionId: this.networkVersionId },
      orderBy: { version: 'desc' },
    })

    if (!latest) {
      // Genesis snapshot — version 0, empty state.
      const emptyEntries = new Map<string, string>()
      const genesisHash = this.computeHash(emptyEntries)

      // Persist the genesis snapshot.
      try {
        await db.protocolStateSnapshot.create({
          data: {
            networkVersionId: this.networkVersionId,
            version: 0,
            stateJson: '{}',
            stateHash: genesisHash,
          },
        })
      } catch {
        // Another process may have created the genesis snapshot concurrently.
        // Reload it.
        const existing = await db.protocolStateSnapshot.findUnique({
          where: {
            networkVersionId_version: {
              networkVersionId: this.networkVersionId,
              version: 0,
            },
          },
        })
        if (existing) {
          return this.deserializeSnapshot(existing.version, existing.stateJson, existing.stateHash)
        }
      }

      return {
        version: 0,
        hash: genesisHash,
        entries: emptyEntries,
      }
    }

    return this.deserializeSnapshot(latest.version, latest.stateJson, latest.stateHash)
  }

  /**
   * Serialize entries to canonical JSON (sorted keys).
   */
  private serializeEntries(entries: Map<string, string>): string {
    const sortedKeys = Array.from(entries.keys()).sort()
    const canonical: Record<string, string> = {}
    for (const key of sortedKeys) {
      canonical[key] = entries.get(key)!
    }
    return JSON.stringify(canonical)
  }

  /**
   * Deserialize a JSON string back to a ProtocolStateSnapshot.
   */
  private deserializeSnapshot(version: number, stateJson: string, stateHash: string): ProtocolStateSnapshot {
    const parsed = JSON.parse(stateJson) as Record<string, string>
    const entries = new Map(Object.entries(parsed))
    return { version, hash: stateHash, entries }
  }

  /**
   * Compute a deterministic SHA-256 hash from the entries.
   */
  private computeHash(entries: Map<string, string>): string {
    return createHash('sha256').update(this.serializeEntries(entries)).digest('hex')
  }
}
