# S4 Extension reviews

This directory contains exactly one `<candidate-id>.json` review for each Merlin-ledger row that
has `deliveryStatus: "landed"`, targets an S4-owned Extension, core Skill, or Blueprint, and has a
`port`, `merge`, or `blueprint` disposition. Planned rows do not get placeholder reviews. The
`extension-integrity` gate derives and enforces this set from the ledger.

Reviews conform to `verification/schemas/s4-extension-review-v1.schema.json`. They are independent,
bind a clean Git revision and canonical reviewed-input digest, set exact file/dependency/permission/
subprocess/state/support budgets, and name registered deterministic S4 capability scenarios.
