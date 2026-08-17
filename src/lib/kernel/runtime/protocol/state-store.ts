// =============================================================================
// Kernel: In-Memory Protocol State Store (Phase 9B.2)
// =============================================================================
// A deterministic, versioned key-value state store. This is the simplest
// implementation — no persistence, no disk, just in-memory maps.
//
// Phase 9B.2: The store has NO shared mutable staging buffer. The commit
// method receives the write set directly from the caller. This eliminates
// the concurrency bug where two transactions using the same store could
// interleave staged mutations.
//
// DETERMINISM:
//   The state hash is computed from the entries in canonical (sorted-key)
//   order. Two snapshots with the same entries have the same hash,
//   regardless of insertion order. This is the fundamental protocol
//   invariant: given the same state, execution is deterministic.
//
// OPTIMISTIC CONCURRENCY:
//   commit(expectedVersion, writeSet) checks that the current version matches
//   expectedVersion. If not, it throws StaleVersionError.
// =============================================================================

import { createHash } from 'crypto'
import type { ProtocolStateStore, ProtocolStateSnapshot, WriteSet } from './types'
import { StaleVersionError } from './types'

/**
 * In-memory implementation of ProtocolStateStore.
 *
 * Phase 9B.2: No shared mutable staging buffer. The commit method receives
 * the write set directly. Two concurrent transactions using the same store
 * CANNOT interleave their mutations.
 */
export class InMemoryProtocolStateStore implements ProtocolStateStore {
  readonly networkVersionId: string
  private currentEntries: Map<string, string> = new Map()
  private history: ProtocolStateSnapshot[] = []
  private version = 0

  constructor(networkVersionId: string, initialEntries?: Record<string, string>) {
    this.networkVersionId = networkVersionId
    if (initialEntries) {
      for (const [key, value] of Object.entries(initialEntries)) {
        this.currentEntries.set(key, value)
      }
    }
    // Create the genesis snapshot (version 0).
    const genesis = this.createSnapshot()
    this.history.push(genesis)
  }

  async getState(): Promise<ProtocolStateSnapshot> {
    return this.history[this.history.length - 1]
  }

  async get(key: string): Promise<string | undefined> {
    return this.currentEntries.get(key)
  }

  async commit(expectedVersion: number, writeSet: WriteSet, _transactionHash?: string): Promise<ProtocolStateSnapshot> {
    // Optimistic concurrency check: the expected version must match.
    if (expectedVersion !== this.version) {
      throw new StaleVersionError(expectedVersion, this.version)
    }

    // Apply the write set to current entries.
    for (const entry of writeSet) {
      if (entry.op === 'put') {
        this.currentEntries.set(entry.key, entry.value)
      } else {
        this.currentEntries.delete(entry.key)
      }
    }

    this.version++
    const snapshot = this.createSnapshot()
    this.history.push(snapshot)
    return snapshot
  }

  async getSnapshot(version: number): Promise<ProtocolStateSnapshot | undefined> {
    return this.history.find((s) => s.version === version)
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private createSnapshot(): ProtocolStateSnapshot {
    const entries = new Map(this.currentEntries)
    const hash = this.computeHash(entries)
    return { version: this.version, hash, entries }
  }

  private computeHash(entries: Map<string, string>): string {
    const sortedKeys = Array.from(entries.keys()).sort()
    const canonical: Record<string, string> = {}
    for (const key of sortedKeys) {
      canonical[key] = entries.get(key)!
    }
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
  }
}
