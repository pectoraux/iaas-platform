# WORK-024 — V6 Freeze-Gate Governance Repair Order

Status: READY
Implementer: Z.ai
Architect / Reviewer: Chief Architect / Architecture Custodian

Z.ai must submit a bounded PR to repair the post-merge governance-lock regression that makes main specification CI red.

Required correction:
- restore the canonical `Domain Architecture Version:` marker required by the existing specification validator, with V5 remaining current while V6 remains candidate;
- preserve the exact frozen-rule wording required by the legacy validator;
- put V6 completion wording in additive governance text;
- preserve V1-V5 historical architecture files byte-for-byte;
- make no production-code, schema, migration, dependency, runtime, or V6 semantic changes.

Acceptance:
1. bun run spec:validate passes.
2. bun run v6:validate passes.
3. V1-V5 history remains byte-for-byte immutable.
4. Diff is limited to the required governance/specification correction.
5. V5 remains CURRENT CANONICAL / FROZEN and V6 remains CANDIDATE until the explicit freeze decision.
6. Full GitHub CI is green.
7. No production implementation starts.
8. Any true architectural contradiction is reported to the Architect instead of silently changing V6.

The PR must contain exact diff scope and evidence mapped to every acceptance criterion. Architect Review decides APPROVE or REQUEST CHANGES. V6 freeze remains a separate subsequent governance decision.