# Phase 11A — Protocol Specification (Hybrid Reconciliation Boundary)

| Field | Value |
|---|---|
| Phase | 11A — Protocol Specification |
| Artifact type | Specification (not implementation) |
| Supersedes | Phase 10.5D in-memory commitment model |
| Implementation gate | Phase 11B |
| Status | **Draft for audit** |
| Repo HEAD at authoring | `48e8c13` (`main`) |

---

## 0. How to read this document

This document is a **specification**, not a status report and not an implementation.
It defines:

1. What the hybrid reconciliation boundary **must** guarantee (invariants).
2. The **object model** that carries physical→protocol handoff.
3. The **durable persistence / recovery** contract for that object model.
4. The **crash-safe sequencing** that makes the handoff durable.
5. The **cause taxonomy** that reconciliation must preserve.
6. The **completeness criteria** that must hold before the protocol may be called
   economically or operationally complete.

Where the current repository (`48e8c13`) already satisfies a clause, it is marked
`[IMPLEMENTED]`. Where it does not, it is marked `[GAP]`. Nothing in this document
is a claim of completion; the `[GAP]` markers are the load-bearing parts of the
specification and are the primary input to Phase 11B.

---

## 1. Honest status record — Phase 10.5D (`48e8c13`)

This section corrects the over-strong claim carried by the commit message
*"`fix(phase-10.5d): EXECUTION_FAILED status + durable PendingProtocolCommitment`"*.
The word "durable" in that message is not supported by the repository.

| Claim | Actual repository status at `48e8c13` |
|---|---|
| `EXECUTION_FAILED` batch status implemented | ✅ `[IMPLEMENTED]` — `protocol-runtime.ts:317-328` stops at first failure, returns `EXECUTION_FAILED` with receipts up to and including the first failure |
| `EXECUTED` means all transactions succeeded | ✅ `[IMPLEMENTED]` — same site; status is `EXECUTED` only when no receipt has `success === false` |
| Consensus rejection explicitly represented | ✅ `[IMPLEMENTED]` — `REJECTED_BY_CONSENSUS`, `INVALID_FINALITY_CERTIFICATE`, `NO_TRANSACTIONS` are distinct `BatchExecutionStatus` values (`types.ts:427-432`) |
| Hybrid physical↔protocol mismatch detectable | ✅ `[IMPLEMENTED]` — `executeHybrid()` returns a `commitment` with a `status` field (`hybrid-runtime.ts:252-293`) |
| `PendingProtocolCommitment` type exists | ✅ `[IMPLEMENTED]` — `types.ts:478-493` |
| Commitment lifecycle fields exist | ✅ `[IMPLEMENTED]` — `status`, `createdAt`, `resolvedAt?`, `batchResult?` (`types.ts:486-492`) |
| Commitment durably persisted | ❌ `[GAP]` — no `db.*` write, no store, no journal; created in memory at `hybrid-runtime.ts:269-275` and mutated in place at `:281-290` |
| Commitment recoverable after process restart | ❌ `[GAP]` — no load path exists; no Prisma model exists for it |
| Crash-safe physical→protocol handoff | ❌ `[GAP]` — physical execution (`:258`) precedes the in-memory commitment creation (`:269`); there is no durable write between them |
| Reconciliation cause preserved precisely | ⚠️ `[PARTIAL]` — `hybrid-runtime.ts:284-290` collapses every non-`EXECUTED` `BatchExecutionStatus` into `RECONCILIATION_REQUIRED`; the precise cause is discarded |

**Corrected status statement for Phase 10.5D:**

> Phase 10.5D — execution-failure semantics complete; reconciliation lifecycle
> modeled and detectable; durable persistence/recovery **not yet implemented**.

Phase 10.5D is therefore **not closed** as "durable reconciliation." It is closed
only for batch execution-failure semantics. The durable reconciliation contract
is specified in this document and implemented in a later phase.

This status correction is the precondition for Phase 11A. The remainder of this
document defines what "durable reconciliation" must mean before it may be
claimed.

---

## 2. Foundational invariants (carried forward, frozen)

These are restated because the reconciliation boundary is built on top of them
and must not weaken any of them. They are unchanged from Phase 9A–10.

```
canonical identity (recursive key sort)
    ↓
nonce-aware deterministic ordering (ready-queue topological)
    ↓
finality certificate (SHA-256 of ordered tx IDs)
    ↓
ProtocolRuntime.submitTransaction  (propose → validateProposal → finalize → executeBatch)
    ↓
certificate verification (recompute + compare before execution)
    ↓
deterministic execution (pure executor.apply → WriteSet)
    ↓
isolated WriteSet (caller-owned, no shared staging)
    ↓
OCC state commit (expectedVersion + P2002 unique constraint)
    ↓
transition journal (atomic with snapshot)
```

**Architectural rules that bound this specification:**

1. Kernel ← runtime ← vertical (never VPP → kernel).
2. Infrastructure ≠ Protocol (the bridge is the only converter).
3. Consensus ≠ Execution (consensus orders; the executor transitions).
4. Vertical semantics ≠ Kernel semantics (handlers in bootstrap, not the executor).
5. `submitTransaction()` is the canonical protocol path (no bypass).
6. `ProtocolRuntime.deps` is private (not leaked to `HybridRuntime`).
7. PostgreSQL is the canonical system of record. "Durable" in this architecture
   means "written through the same kind of atomic, OCC-guarded, journaled
   PostgreSQL path that `PostgresProtocolStateStore` uses." An in-memory object
   is not durable, regardless of how many lifecycle fields it carries.

Rule 7 is the one Phase 10.5D violated in spirit while appearing to satisfy in
naming. This specification makes the rule explicit and binding.

---

## 3. Scope of Phase 11A

**In scope (this document):**

- The object model for physical→protocol handoff.
- The durable persistence and recovery contract for that model.
- The crash-safe sequencing between physical execution and protocol commit.
- The reconciliation cause taxonomy.
- The completeness criteria that gate "economically/operationally complete."

**Out of scope (deferred):**

- A full reconciliation *engine* (schedulers, retry backoff, dead-letter queues,
  operator escalation UI). The user has explicitly stated Phase 11A must not be
  blocked on building a large reconciliation subsystem; it must only *specify*
  the persistence/recovery semantics.
- Changes to the consensus algorithm itself.
- Changes to the executor's determinism contract.
- New verticals.

**Relationship to Phase 11B:** Phase 11B is the implementation of the durable
contract specified here. **No clause in this document is satisfied by code at
`48e8c13` unless it carries an explicit `[IMPLEMENTED]` marker.** The `[GAP]`
markers enumerate the Phase 11B work.

---

## 4. Protocol object model

Phase 10.5D used a single `PendingProtocolCommitment` that doubled as evidence,
intent, outcome, and reconciliation state. That conflation is the root cause of
three of the audit findings (no identity, no replay, cause collapsed). Phase 11A
separates the handoff into four primitives, each with a single responsibility.

```
   PhysicalExecutionEvidence
              ↓ (durably recorded first)
   PendingCommitment
              ↓ (protocol submission attempted)
   ProtocolOutcome
              ↓ (precise cause preserved)
   ReconciliationState
```

Each primitive is content-addressed where it represents a fact, and lifecycle-
tagged where it represents a process. No primitive stores another primitive's
guts by reference; each stores **hashes and IDs** so the record is a durable
protocol artifact, not an in-memory DTO.

### 4.1 PhysicalExecutionEvidence

**Responsibility:** Prove that a physical action occurred in the infrastructure
world. This is the bridge between "the real world did something" and "the
protocol may owe a state transition."

**Identity:** Content-addressed. `evidenceId = SHA-256(canonical(executionAssignmentId, resultDigest, occurredAt))`.
The same physical result always yields the same evidence ID. This is what makes
re-submission idempotent after a crash.

**Fields (specification, not TypeScript):**

| Field | Meaning | Determinism |
|---|---|---|
| `evidenceId` | Content hash above | deterministic |
| `executionAssignmentId` | The infrastructure assignment that produced it | deterministic (kernel FK) |
| `runtimeKind` | `'hybrid'` (the only kind that produces evidence today) | deterministic |
| `networkVersionId` | Protocol scope this evidence is intended for | deterministic |
| `resultDigest` | SHA-256 of the canonical `RuntimeExecuteResult` (quantity, unit, success, telemetry hash) | deterministic |
| `occurredAt` | Wall-clock of physical completion | non-deterministic (recorded once) |

**Invariants:**

- E1. Evidence is **immutable** after creation. There is no update path.
- E2. Evidence is **content-addressed**: two computations of the evidence for the
  same assignment + result + network version MUST produce the same `evidenceId`.
- E3. Evidence is created **at or before** the durable write of its
  `PendingCommitment`. There is no state in which a commitment exists without
  its evidence having been durably recorded (the commitment *references* the
  evidence by ID).

**Status at `48e8c13`:** `[GAP]`. No `PhysicalExecutionEvidence` type exists.
The `RuntimeExecuteResult` is currently stored whole inside
`PendingProtocolCommitment.infrastructureResult` (`types.ts:482`), with no
content address and no separation of evidence from intent.

### 4.2 PendingCommitment

**Responsibility:** Durable record that links a `PhysicalExecutionEvidence` to a
protocol transaction that **should** be derived from it. This is the "I owe the
protocol a transition" record. It is the crash barrier.

**Identity:** Own UUID (`commitmentId`) for human/operational addressing, PLUS a
deterministic derived key `(evidenceId, intendedTransactionId)` so that crash
recovery can detect a re-derivation of the same intent without double-counting.

**Fields:**

| Field | Meaning |
|---|---|
| `commitmentId` | UUID, operational handle |
| `evidenceId` | FK to `PhysicalExecutionEvidence` (durable) |
| `networkVersionId` | Protocol scope |
| `intendedTransactionId` | The deterministic `ProtocolTransaction.id` the bridge WILL derive (computed from evidence, not from the live result) |
| `status` | `PENDING` \| `RECONCILED` \| `<precise cause>` (see §7) |
| `createdAt` | When the commitment was durably written |
| `resolvedAt?` | When the protocol outcome was durably recorded, if ever |
| `protocolOutcomeRef?` | FK to the recorded `ProtocolOutcome` (by outcome ID), if resolved |

**Critical difference from 10.5D:** the commitment does **not** store the whole
`RuntimeExecuteResult` or the whole `ProtocolTransaction`. It stores `evidenceId`
(a hash) and `intendedTransactionId` (a hash). The full objects remain in their
own tables (evidence table; protocol transition journal). The commitment is a
*durable linkage record*, not a bag of objects.

**Invariants:**

- C1. A commitment in `PENDING` status means: the physical action occurred and
  is durably evidenced, AND the protocol outcome is not yet durably recorded.
- C2. The `intendedTransactionId` is computed **from the evidence**, not from a
  re-execution of the bridge. Because evidence is content-addressed and the
  bridge is a pure function of the result, `intendedTransactionId` is
  deterministic. This is what makes crash re-derivation safe.
- C3. There is at most one `PENDING` commitment per `evidenceId`. Enforced by a
  `UNIQUE(evidenceId)` constraint on the commitments in `PENDING`/non-terminal
  states (or equivalently a partial unique index). Re-deriving the same evidence
  after a crash must find the existing commitment, not create a duplicate.
- C4. A commitment never transitions backwards. `PENDING → {RECONCILED,
  <cause>}` is the only forward edge. Terminal causes are not auto-retried by the
  kernel; retry is an operator/reconciliation-engine decision (out of scope per
  §3).

**Status at `48e8c13`:** `[GAP]`. The type exists (`types.ts:478-493`) but stores
whole objects, has no `evidenceId`, no `intendedTransactionId`, no uniqueness
constraint, and is never persisted.

### 4.3 ProtocolOutcome

**Responsibility:** Durable record of what the protocol layer returned for a
given `intendedTransactionId`. This is the captured `BatchExecutionResult`,
preserved **with its precise `BatchExecutionStatus`**, never collapsed.

**Identity:** `outcomeId = SHA-256(commitmentId, intendedTransactionId,
finalityCertificate, status)`.

**Fields:**

| Field | Meaning |
|---|---|
| `outcomeId` | Content hash above |
| `commitmentId` | FK back to the commitment |
| `transactionId` | The `ProtocolTransaction.id` actually submitted (equals `intendedTransactionId` if the bridge is deterministic; recording both lets reconciliation detect bridge drift) |
| `finalityCertificate` | The certificate of the finalized batch (or `null` if rejected pre-finalization) |
| `status` | The precise `BatchExecutionStatus` (`EXECUTED` \| `EXECUTION_FAILED` \| `REJECTED_BY_CONSENSUS` \| `INVALID_FINALITY_CERTIFICATE` \| `NO_TRANSACTIONS`) |
| `receiptsDigest?` | SHA-256 of the canonical receipts array (the receipts themselves live in the protocol transition journal; the outcome stores a digest, not the array) |
| `error?` | The error string from the batch result |
| `recordedAt` | When the outcome was durably written |

**Invariants:**

- O1. The `status` field is the **exact** `BatchExecutionStatus` returned by
  `submitTransaction`. It is never rewritten into a coarser value.
- O2. One outcome per `(commitmentId, finalityCertificate)`. A re-submission
  after a crash that produces a different certificate produces a *new* outcome
  row; the history is append-only.
- O3. The outcome does **not** store the receipts array; it stores a digest. The
  receipts are already durably recorded by the protocol transition journal
  (`ProtocolTransition` in `prisma/schema.prisma`). Storing them again would
  duplicate the system of record.

**Status at `48e8c13`:** `[GAP]`. No `ProtocolOutcome` type exists. The
`BatchExecutionResult` is currently held transiently on the in-memory
commitment (`types.ts:492`) and discarded on process exit.

### 4.4 ReconciliationState

**Responsibility:** The resolved classification of a commitment, **derived from**
its `ProtocolOutcome.status` but expressed in terms of the *reconciliation
action* required, not the batch status. This is where the precise cause is
preserved (see §7).

**Identity:** Not content-addressed; it is a lifecycle tag on the commitment.
Stored as the `status` field of `PendingCommitment` after resolution.

**Mapping (outcome.status → reconciliation state):**

| `ProtocolOutcome.status` | `ReconciliationState` | Meaning |
|---|---|---|
| `EXECUTED` | `RECONCILED` | Physical result has a corresponding committed protocol state transition. No action. |
| `EXECUTION_FAILED` | `RECONCILIATION_REQUIRED_EXECUTION_FAILURE` | Batch was finalized and certified but a handler rejected the transition. Physical result is real; protocol state was not advanced. Retry the transition. |
| `REJECTED_BY_CONSENSUS` | `RECONCILIATION_REQUIRED_CONSENSUS_REJECTION` | The proposal never reached finalization (validator authorization failed). Physical result has no accepted protocol commitment. Re-propose or escalate. |
| `INVALID_FINALITY_CERTIFICATE` | `RECONCILIATION_REQUIRED_CERTIFICATE_INVALID` | The finalized batch's certificate did not match the recomputed certificate. The protocol artifact was tampered or mis-derived. Re-derive and re-submit; do not auto-retry. |
| `NO_TRANSACTIONS` | `RECONCILIATION_REQUIRED_INVARIANT_VIOLATION` | The bridge submitted an empty batch. This is a programming/bridge invariant violation, not a transient failure. Must not auto-retry; escalate. |

**Invariants:**

- R1. The mapping is a **pure function** of `ProtocolOutcome.status`. It is
  computed at write time and stored, not re-derived on read, so that a later
  change to the mapping cannot rewrite history.
- R2. No two distinct outcome statuses map to the same reconciliation state.
  This is the anti-conflation invariant: the audit finding that
  `RECONCILIATION_REQUIRED` collapsed four materially different causes is
  structurally impossible under this mapping.
- R3. The state is terminal with respect to the kernel: the kernel does not
  auto-advance a `RECONCILIATION_REQUIRED_*` state to `RECONCILED`. Only a
  subsequent successful submission (producing a new `ProtocolOutcome` with
  `EXECUTED`) may advance it, and that advancement creates a new outcome row
  (O2), it does not rewrite the failed one.

**Status at `48e8c13`:** `[GAP]`. The current `PendingCommitmentStatus`
(`types.ts:457-460`) has exactly three values, and `executeHybrid()`
(`hybrid-runtime.ts:284-290`) maps all four non-`EXECUTED` batch statuses to
`RECONCILIATION_REQUIRED`. This violates R2.

---

## 5. Durable persistence contract

"Durable" in this architecture is defined by the pattern already established by
`PostgresProtocolStateStore` (`src/lib/kernel/runtime/protocol/postgres-state-store.ts`):
an atomic PostgreSQL transaction, optimistic-concurrency-guarded by a `UNIQUE`
constraint, with a journaled transition record written in the same transaction.
Anything less is not durable.

Phase 11A requires the same bar for the reconciliation primitives.

### 5.1 Required durable store: `ReconciliationStore`

A new kernel-owned store (sibling to `ProtocolStateStore`) with the following
contract. The implementation is Phase 11B; the contract is Phase 11A.

```
interface ReconciliationStore {
  // Atomic: writes evidence + a PENDING commitment referencing it, in one tx.
  // Enforces C3 (at most one PENDING per evidenceId) via UNIQUE(evidenceId).
  // Returns the commitment (PENDING). If a PENDING commitment for this
  // evidenceId already exists, returns the existing one (idempotent).
  recordPending(
    evidence: PhysicalExecutionEvidence,
    intendedTransactionId: string,
  ): Promise<PendingCommitment>

  // Atomic: writes the outcome + advances the commitment status, in one tx.
  // The commitment must currently be PENDING. The outcome is append-only.
  // Returns the updated commitment.
  resolve(
    commitmentId: string,
    outcome: ProtocolOutcome,
  ): Promise<PendingCommitment>

  // Restart recovery: load all commitments still in PENDING.
  // Used by the recovery path in §6.
  loadPending(): Promise<PendingCommitment[]>

  // Operational read: load a commitment by evidenceId (for de-dup at the
  // application layer before physical execution, if desired).
  findByEvidence(evidenceId: string): Promise<PendingCommitment | null>
}
```

### 5.2 Required schema (Phase 11B, specified here)

Three new Prisma models, mirroring the `ProtocolStateSnapshot` /
`ProtocolTransition` pair's atomicity discipline:

- `PhysicalExecutionEvidence` — `evidenceId` (PK, hash), `executionAssignmentId`,
  `runtimeKind`, `networkVersionId`, `resultDigest`, `occurredAt`.
- `PendingCommitment` — `commitmentId` (PK, UUID), `evidenceId` (FK),
  `networkVersionId`, `intendedTransactionId`, `status`, `createdAt`,
  `resolvedAt?`, `outcomeId?`. `@@unique([evidenceId])` is the C3 enforcement.
- `ProtocolOutcome` — `outcomeId` (PK, hash), `commitmentId` (FK),
  `transactionId`, `finalityCertificate?`, `status`, `receiptsDigest?`, `error?`,
  `recordedAt`.

**Atomicity rule:** `recordPending` and `resolve` each execute as a single
`db.$transaction`. No partial writes are observable. This mirrors
`PostgresProtocolStateStore.commit` (`postgres-state-store.ts:71-92`), which
writes the snapshot and the transition journal atomically.

### 5.3 What "durable" rules out

The Phase 10.5D pattern — constructing an object in memory, mutating it, and
returning it — is explicitly **not** a durable pattern, regardless of the
object's field names. The store contract above is the only acceptable form.

---

## 6. Crash-safe sequencing

This section specifies the corrected sequence that resolves the audit's
sequencing finding. The current code's sequence is recorded first for contrast.

### 6.1 Current (incorrect) sequence at `48e8c13`

```
1. InfrastructureRuntime.executeAssignment()     [hybrid-runtime.ts:258]  physical, may have external effects
2. bridge.infrastructureResultToTransaction()    [:261]                  pure
3. construct in-memory PendingProtocolCommitment  [:269]                  NOT durable
4. submitTransaction(transaction)                [:278]                  protocol commit
5. mutate in-memory commitment.status            [:281-290]              NOT durable
```

Crash between 1 and 4: physical action occurred, no durable record of it exists.
Crash between 4 and 5: protocol state advanced, no durable record that the
physical action was the cause, and no durable record of the outcome.

### 6.2 Specified (correct) sequence — Phase 11B target

```
1. InfrastructureRuntime.executeAssignment()        physical; may have external effects
2. Compute PhysicalExecutionEvidence (pure)         content-addressed, deterministic
3. Compute intendedTransactionId (pure)            deterministic from evidence + nonce
4. ReconciliationStore.recordPending(               DURABLE WRITE #1 — atomic, evidence + PENDING commitment
       evidence, intendedTransactionId)            ── crash after this point is safe ──
5. bridge.infrastructureResultToTransaction()      pure (must equal step 3's derivation; see §6.4)
6. submitTransaction(transaction)                  protocol commit (canonical path, unchanged)
7. ReconciliationStore.resolve(                     DURABLE WRITE #2 — atomic, outcome + status advance
       commitmentId, outcome)                       ── crash after this point is fully reconciled ──
```

### 6.3 Crash recovery (restart semantics)

On restart, the runtime calls `ReconciliationStore.loadPending()` and processes
each `PENDING` commitment:

- The physical action **already occurred** (evidence is durable).
- The protocol outcome is **unknown** (the crash was between DURABLE WRITE #1
  and DURABLE WRITE #2, inclusive of step 6 itself).
- Resolution: re-derive the transaction (deterministic from evidence — C2) and
  check whether `intendedTransactionId` already appears in the
  `ProtocolTransition` journal for this `networkVersionId`.
  - If it **does appear**: the protocol commit succeeded before the crash. The
    commitment is advanced to `RECONCILED` via a synthetic `ProtocolOutcome`
    with `status = EXECUTED` and `recordedAt = transition.recordedAt`.
  - If it **does not appear**: the protocol commit did not durably succeed.
    Re-submit via `submitTransaction` (step 6 onward). The transaction ID is
    canonical and nonce-aware, so re-submission is safe and idempotent under
    the foundational identity invariant.

This recovery is **only** correct because of C2 (`intendedTransactionId` is
deterministic from evidence) and the canonical-identity invariant (same inputs
→ same transaction ID → same journal entry). If the bridge were non-deterministic,
recovery could double-count. The spec therefore **requires** the bridge to be a
pure function of `(evidence, networkVersionId, sender, nonce)`.

### 6.4 Bridge determinism requirement

The `HybridBridge.infrastructureResultToTransaction` contract (currently at
`hybrid-runtime.ts:84-90`) must be strengthened: the produced
`ProtocolTransaction.id` must equal the `intendedTransactionId` computed in
step 3 from the evidence. Phase 11B must add a check that aborts the resolution
if `transaction.id !== commitment.intendedTransactionId`, recording a
`RECONCILIATION_REQUIRED_INVARIANT_VIOLATION` outcome. A bridge that derives a
different transaction than its evidence predicted is a bug, and the spec forbids
silently accepting it.

**Status at `48e8c13`:** the bridge is effectively deterministic today (it calls
`computeTransactionId`), but the determinism is **not enforced** at the
reconciliation boundary — there is no check, because there is no reconciliation
boundary. `[GAP]`.

---

## 7. Reconciliation cause taxonomy (anti-conflation)

The audit's third finding: `executeHybrid()` collapses every non-`EXECUTED`
`BatchExecutionStatus` into `RECONCILIATION_REQUIRED`. This loses materially
different information:

- `REJECTED_BY_CONSENSUS` → physical result has no accepted protocol commitment.
- `EXECUTION_FAILED` → protocol batch was accepted and finalized, but a handler
  rejected the state transition.
- `INVALID_FINALITY_CERTIFICATE` → the protocol artifact itself was tampered or
  mis-derived.
- `NO_TRANSACTIONS` → a bridge/programming invariant violation (the bridge
  produced an empty batch).

These are not the same failure. A reconciliation system that treats them
identically will, for example, auto-retry a `NO_TRANSACTIONS` (which is a bug,
not a transient failure) or escalate a `REJECTED_BY_CONSENSUS` the same way as
a `EXECUTION_FAILED` (which has different remediation).

§4.4's mapping table is the specification. It is repeated here as the binding
contract:

```
EXECUTED                     → RECONCILED
EXECUTION_FAILED             → RECONCILIATION_REQUIRED_EXECUTION_FAILURE
REJECTED_BY_CONSENSUS        → RECONCILIATION_REQUIRED_CONSENSUS_REJECTION
INVALID_FINALITY_CERTIFICATE → RECONCILIATION_REQUIRED_CERTIFICATE_INVALID
NO_TRANSACTIONS              → RECONCILIATION_REQUIRED_INVARIANT_VIOLATION
```

**Binding invariant R2:** no two distinct `ProtocolOutcome.status` values map to
the same `ReconciliationState`. This makes the conflation structurally
impossible in any conforming implementation.

---

## 8. Completeness criteria

The protocol may be called **economically and operationally complete** only when
all of the following hold. Each criterion is independently auditable from the
repository (no green-test declaration is sufficient on its own).

1. **`[IMPLEMENTED]`** Batch execution-failure semantics: `EXECUTION_FAILED`
   returned when any transaction fails; `EXECUTED` only when all succeed.
   (Satisfied at `48e8c13`.)

2. **`[GAP]`** Four-primitive object model: `PhysicalExecutionEvidence`,
   `PendingCommitment`, `ProtocolOutcome`, `ReconciliationState` exist as
   distinct types with the fields and invariants in §4.

3. **`[GAP]`** Durable `ReconciliationStore` with the contract in §5.1,
   backed by the three Prisma models in §5.2, using atomic `db.$transaction`
   writes (the same bar as `PostgresProtocolStateStore`).

4. **`[GAP]`** Crash-safe sequencing (§6.2): `recordPending` is durably written
   **before** `submitTransaction` is called. The current ordering (commitment
   created after submission is attempted, in memory) is non-conforming.

5. **`[GAP]`** Crash recovery (§6.3): on restart, `loadPending()` is invoked and
   each `PENDING` commitment is resolved via journal lookup or re-submission,
   idempotently.

6. **`[GAP]`** Anti-conflation (§7): `ReconciliationState` preserves the precise
   `BatchExecutionStatus`. R2 is enforced structurally (no two statuses share a
   state).

7. **`[GAP]`** Bridge determinism enforcement (§6.4): the reconciliation
   boundary aborts and flags `RECONCILIATION_REQUIRED_INVARIANT_VIOLATION` if
   the bridge produces a transaction whose ID differs from the
   `intendedTransactionId` derived from the evidence.

8. **Audit evidence:** the architecture tests must include a crash-recovery
   proof — a `PENDING` commitment survives a simulated process restart and is
   resolved without double-counting and without losing the physical action.
   A test that only exercises the happy path does not satisfy this criterion.

Criterion 1 is the only one satisfied today. Criteria 2–8 are the Phase 11B
work and the gate for "complete."

---

## 9. What is explicitly NOT claimed by this document

- This document does **not** claim Phase 10.5D is complete. It records the
  corrected status in §1.
- This document does **not** specify a reconciliation *engine* (schedulers,
  retry policy, escalation). Per the user's direction, Phase 11A specifies
  persistence/recovery semantics; the engine is a later concern.
- This document does **not** change the consensus algorithm, the executor's
  determinism contract, or the canonical identity invariant. Those remain frozen.
- This document does **not** require a new vertical to do anything. Verticals
  that do not use `HybridRuntime` are unaffected.

---

## 10. Summary of the boundary

```
Phase 10.5D (48e8c13):
  - EXECUTION_FAILED semantics             ✅ complete
  - Reconciliation lifecycle modeled       ✅ detectable (in-memory)
  - Durable persistence/recovery           ❌ NOT implemented

Phase 11A (this document):
  - Specifies the four-primitive object model
  - Specifies the durable ReconciliationStore contract
  - Specifies crash-safe sequencing + recovery
  - Specifies the anti-conflation cause taxonomy
  - Specifies the completeness criteria

Phase 11B (implementation, gated):
  - Implements criteria 2–8 of §8
  - Until 2–8 hold, the protocol is not "economically/operationally complete"
```

The next audit target is the conformance of a Phase 11B implementation against
the §8 criteria — specifically, a crash-recovery proof that a `PENDING`
commitment survives restart and resolves without losing the physical action or
double-counting the protocol transition.
