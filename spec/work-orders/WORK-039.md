# WORK-039 — Reference Network Universal Conformance Suite

Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependencies: WORK-026, WORK-027, WORK-028, WORK-029, WORK-034, WORK-035, WORK-036
Implementer: Z.ai

Objective: prove the same generic IAAS architecture expresses compute, storage, wireless/bandwidth, DTN/transit/local-first, manufacturing/industrial, mobility, energy/VPP, protocol/blockchain-style, and community-finance networks.

Scope: reference NetworkDefinitions/Manifests, composition cases, allocation policies, transport cases, economic cases, static import checks.

Acceptance: REF-001-AC01..04.

Constraints: reference networks are validation cases, never new kernel primitives; vertical-specific behavior stays in capabilities/policies/adapters/extensions.

Verification: executable reference fixtures and architecture anti-dependency checks.

Stop: any fixture requiring generic kernel modification or a vertical-specific generic service.
