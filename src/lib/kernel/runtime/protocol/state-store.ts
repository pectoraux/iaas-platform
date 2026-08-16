// =============================================================================
// Kernel: In-Memory Protocol State Store (Phase 9A)
// =============================================================================
// A deterministic, versioned key-value state store. This is the simplest
// implementation — no persistence, no disk, just in-memory maps.
//
// DETERMINISM:
//   The state hash is computed from the entries in canonical (sorted-key)
//   order. Two snapshots with the same entries have the same hash,
//   regardless of insertion order. This is the fundamental protocol
//   invariant: given the same state, execution is deterministic.
//
// Phase 9B will add persistent storage. Phase 9A proves the contract in memory.
// =============================================================================

import { createHash } from 'crypto'
import type { ProtocolStateStore, ProtocolStateSnapshot } from './types'

/**
 * In-memory implementation of ProtocolStateStore.
 *
 * Maintains:
 *   - A current committed state (versioned snapshot)
 *   - A staged set of changes (pending put/delete operations)
 *   - A history of all committed snapshots (for deterministic replay)
 *
 * The hash is SHA-256 of the canonical JSON representation of the entries
 * (sorted keys). This ensures determinism.
 */
export class InMemoryProtocolStateStore implements ProtocolStateStore {
  private currentEntries: Map<string, string> = new Map()
  private stagedEntries: Map<string, string | null> = new Map() // null = delete
  private history: ProtocolStateSnapshot[] = []
  private version = 0

  constructor(initialEntries?: Record<string, string>) {
    if (initialEntries) {
      for (const [key, value] of Object.entries(initialEntries)) {
        this.currentEntries.set(key, value)
      }
    }
    // Create the genesis snapshot (version 0).
    const genesis = this.createSnapshot()
    this.history.push(genesis)
  }

  getState(): ProtocolStateSnapshot {
    return this.history[this.history.length - 1]
  }

  get(key: string): string | undefined {
    // Check staged changes first.
    if (this.stagedEntries.has(key)) {
      const staged = this.stagedEntries.get(key)!
      return staged === null ? undefined : staged
    }
    return this.currentEntries.get(key)
  }

  put(key: string, value: string): void {
    this.stagedEntries.set(key, value)
  }

  delete(key: string): void {
    this.stagedEntries.set(key, null) // null = delete
  }

  commit(): ProtocolStateSnapshot {
    // Apply staged changes to current entries.
    for (const [key, value] of this.stagedEntries) {
      if (value === null) {
        this.currentEntries.delete(key)
      } else {
        this.currentEntries.set(key, value)
      }
    }
    this.stagedEntries.clear()
    this.version++

    const snapshot = this.createSnapshot()
    this.history.push(snapshot)
    return snapshot
  }

  rollback(): void {
    this.stagedEntries.clear()
  }

  getSnapshot(version: number): ProtocolStateSnapshot | undefined {
    return this.history.find((s) => s.version === version)
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private createSnapshot(): ProtocolStateSnapshot {
    // Create a read-only copy of the current entries.
    const entries = new Map(this.currentEntries)
    const hash = this.computeHash(entries)
    return {
      version: this.version,
      hash,
      entries,
    }
  }

  /**
   * Compute a deterministic hash from the entries.
   * The entries are serialized in canonical (sorted-key) JSON form,
   * then SHA-256 hashed. This ensures two stores with the same entries
   * produce the same hash, regardless of insertion order.
   */
  private computeHash(entries: Map<string, string>): string {
    const sortedKeys = Array.from(entries.keys()).sort()
    const canonical: Record<string, string> = {}
    for (const key of sortedKeys) {
      canonical[key] = entries.get(key)!
    }
    const json = JSON.stringify(canonical)
    return createHash('sha256').update(json).digest('hex')
  }
}
