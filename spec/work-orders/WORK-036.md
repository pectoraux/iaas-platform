# WORK-036 — Observability and Evidence Boundary

Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: WORK-034, WORK-035
Implementer: Z.ai

Objective: establish canonical Telemetry/Metric/Log/Trace observation contracts and an explicit Evidence boundary feeding Verification/Attestation.

Scope: observation contracts, source/time/context metadata, evidence envelopes, verification inputs, provenance tests.

Acceptance: OBS-001-AC01..03; OBS-002-AC01..03.

Constraints: observation is not truth; raw telemetry/log/trace cannot self-attest; existing Event/VerificationResult/Attestation authority remains intact.

Verification: negative bypass tests, evidence provenance tests, deterministic verification inputs, PostgreSQL integration where durable.

Stop: no observability-to-settlement shortcut and no telemetry record promoted directly to Attestation.
