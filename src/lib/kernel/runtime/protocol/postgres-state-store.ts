// =============================================================================
// Kernel: PostgreSQL Protocol State Store (Phase 9B.2)
// =============================================================================
// A persistent, deterministic, versioned key-value state store backed by
// PostgreSQL.
//
// Phase 9B.2: No shared mutable staging buffer. The commit method receives
// the write set directly from the caller. Two concurrent transactions using
// the same store CANNOT interleave their mutations.
//
// OPTIMISTIC CONCURRENCY:
//   commit(expectedVersion, writeSet) inserts a new row with version =
//   expectedVersion + 1. The UNIQUE(networkVersionId, version) constraint
//   ensures only one transaction can commit to a given version.
//
// DETERMINISM:
//   The state hash is SHA-256 of canonical JSON (sorted keys).
//
// RESTART PROOF:
//   The store loads the latest snapshot from the database on construction.
// =============================================================================

import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import type { ProtocolStateStore, ProtocolStateSnapshot, WriteSet } from './types'
import { StaleVersionError } from './types'

export class PostgresProtocolStateStore implements ProtocolStateStore {
  readonly networkVersionId: string
  private currentSnapshot: ProtocolStateSnapshot | null = null

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
    return state.entries.get(key)
  }

  async commit(expectedVersion: number, writeSet: WriteSet, transactionHash?: string): Promise<ProtocolStateSnapshot> {
    const currentState = await this.getState()

    if (expectedVersion !== currentState.version) {
      throw new StaleVersionError(expectedVersion, currentState.version)
    }

    const newEntries = new Map(currentState.entries)
    for (const entry of writeSet) {
      if (entry.op === 'put') {
        newEntries.set(entry.key, entry.value)
      } else {
        newEntries.delete(entry.key)
      }
    }

    const newVersion = expectedVersion + 1
    const stateJson = this.serializeEntries(newEntries)
    const stateHash = this.computeHash(newEntries)
    const previousStateHash = currentState.hash

    try {
      await db.$transaction(async (tx) => {
        await tx.protocolStateSnapshot.create({
          data: {
            networkVersionId: this.networkVersionId,
            version: newVersion,
            stateJson,
            stateHash,
          },
        })

        if (transactionHash) {
          await tx.protocolTransition.create({
            data: {
              networkVersionId: this.networkVersionId,
              version: newVersion,
              transactionHash,
              previousStateHash,
              resultStateHash: stateHash,
            },
          })
        }
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.currentSnapshot = await this.loadLatestSnapshot()
        throw new StaleVersionError(expectedVersion, this.currentSnapshot.version)
      }
      throw err
    }

    this.currentSnapshot = {
      version: newVersion,
      hash: stateHash,
      entries: newEntries,
    }

    return this.currentSnapshot
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

  private async loadLatestSnapshot(): Promise<ProtocolStateSnapshot> {
    const latest = await db.protocolStateSnapshot.findFirst({
      where: { networkVersionId: this.networkVersionId },
      orderBy: { version: 'desc' },
    })

    if (!latest) {
      const emptyEntries = new Map<string, string>()
      const genesisHash = this.computeHash(emptyEntries)

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

      return { version: 0, hash: genesisHash, entries: emptyEntries }
    }

    return this.deserializeSnapshot(latest.version, latest.stateJson, latest.stateHash)
  }

  private serializeEntries(entries: Map<string, string>): string {
    const sortedKeys = Array.from(entries.keys()).sort()
    const canonical: Record<string, string> = {}
    for (const key of sortedKeys) {
      canonical[key] = entries.get(key)!
    }
    return JSON.stringify(canonical)
  }

  private deserializeSnapshot(version: number, stateJson: string, stateHash: string): ProtocolStateSnapshot {
    const parsed = JSON.parse(stateJson) as Record<string, string>
    const entries = new Map(Object.entries(parsed))
    return { version, hash: stateHash, entries }
  }

  private computeHash(entries: Map<string, string>): string {
    return createHash('sha256').update(this.serializeEntries(entries)).digest('hex')
  }
}
