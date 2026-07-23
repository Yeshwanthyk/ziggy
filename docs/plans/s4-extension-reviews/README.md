# S4 Extension reviews

The settled review contract is one `<candidate-id>.json` review for each Merlin-ledger row that has
`deliveryStatus: "landed"` and targets an S4-owned Extension with disposition `port`. Planned rows
do not get placeholder reviews. The `extension-integrity` gate will derive and enforce this set
from the ledger.

Reviews conform to `verification/schemas/s4-extension-review-v1.schema.json`. They are independent,
bind a clean Git revision and canonical reviewed-input digest, set exact file/dependency/permission/
subprocess/state/support budgets, and name registered deterministic S4 capability scenarios.

At this planning checkpoint all 39 Extension rows are `planned`, so the settled derived review set
is empty. `hyperframes.json` and `skill-creator.json` remain temporarily because this pass does not
change review files or executable verification. The first S4 transition slice deletes both stale
reviews, removes the superseded Blueprint/core-Skill scenarios, and updates the schema/tooling
before new per-Extension reviews are added as ports land.
