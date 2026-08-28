# WORK-028 — Allocation Strategy and Temporal Reservation

Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependency: WORK-026
Implementer: Z.ai

Objective: define and implement one AllocationStrategy contract plus generic reservation/availability windows and demand constraints.

Scope: strategy contract, window semantics, overlap/concurrency rules, PostgreSQL persistence and tests.

Acceptance: ALLOC-001-AC01..04; ALLOC-002-AC01..04; ALLOC-003-AC01..02.

Constraints: strategies are policy/configuration, not kernel branches; auction/market is optional; forecasts are advisory; CapacityReservation/Commitment authority remains unchanged.

Verification: deterministic strategy tests, overlapping-window concurrency tests against PostgreSQL, forecast-to-commitment negative tests, static kernel-scope tests.

Stop: any request to put optimization/market logic into generic kernel execution paths.
