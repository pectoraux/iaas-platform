# WORK-031 — Generic Package Model and Serialization

Status: `DRAFT`
Architecture Version: `IAAS-DOM-ARCH-6`
Dependency: WORK-030
Implementer: Z.ai

Objective: implement one generic IAAS Package model for Network, Transform, Extension, and Adapter kinds.

Scope: manifest, artifact, dependency, capability, compatibility, publisher, integrity, version, canonical serialization.

Acceptance: PKG-001-AC01..03.

Constraints: typed package kinds share one model; archive format is not architecturally frozen; package metadata is never execution authority.

Verification: deterministic serialization, integrity/tamper tests, dependency graph/cycle tests, tenant isolation where applicable.

Stop: do not create separate packaging architectures per artifact type.
