# WORK-034 — Generic Economic Metering and Attribution

Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: WORK-028, WORK-030
Implementer: Z.ai

Objective: add generic verified usage measurement, economic attribution, and pricing policy without contaminating operational truth.

Scope: UsageMeasurement, MeteringRule, EconomicAttribution, PricingPolicy, integration to existing Contribution/Reward/Ledger/Settlement boundaries.

Acceptance: ECON-001-AC01..03; ECON-002-AC01..03; ECON-003-AC01..03.

Constraints: economics only consumes verified facts; no economic object may rewrite operational Event/Execution/Route/Transport/Resource state; pricing is versioned policy.

Verification: provenance/historical immutability tests, deterministic policy tests, anti-dependency/static checks, PostgreSQL reconciliation.

Stop: no second ledger and no economics-owned operational authority.
