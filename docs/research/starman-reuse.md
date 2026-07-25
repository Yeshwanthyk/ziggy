# Starman reuse survey

Surveyed `/Users/yesh/code/personal/starman` read-only at branch `audit-remediation`,
HEAD `89b8ad510a5effe7ad0aaff90d3466785e28e2b7`. Paths below are relative to that
repository. The worktree was already dirty; findings describe live file contents.

The agent loop, provider abstraction, session engine, daemon/attach machinery, TUI,
protocol code, lint tooling, and verification/evidence tooling are intentionally excluded.

## 1. Profile init / SOUL.md scaffolding

`packages/ziggy/src/profile-initialization.ts` (~510 LOC; relevant code at lines 22-69,
142-220, 257-440) embeds three SOUL templates, creates the profile directories and
`SOUL.md`, canonicalizes the path, rejects symlinks/wrong file kinds, and uses exclusive
atomic creation. Existing files—including edited `SOUL.md`, bytes, and modes—are preserved;
concurrent initializers converge without clobbering. `tests/scenarios/s3-profile-initialization.test.ts`
(~556 LOC) proves the idempotency and race behavior. `packages/ziggy/src/profile-config.ts`
(~237 LOC) strictly validates an existing `ziggy.jsonc` before mutation and preserves its bytes.

Dependencies: Node `fs`/`path`/`crypto`, Effect, `@ziggy/core` filesystem/atomic-file helpers,
profile-config, and bundled-extension lifecycle code. The latter is not reusable here.

Verdict: adapt — keep path safety, preflight, exclusive atomic creation, and do-not-clobber
policy; strip profile-config and bundled-extension bootstrap to Ziggy’s smaller Pi-owned shape.

## 2. Memory document handling

`packages/core/src/memory/tool.ts` (~451 LOC) implements `add`/`replace`/`remove` over
`profile/memory/MEMORY.md` and `USER.md`. Entries use `\n§\n`; duplicate adds are idempotent,
replace/remove require one match, delimiter injection and empty entries are rejected, and
limits are 2,200 and 1,375 Unicode code points. Overflow is rejected, never truncated. The
tool computes a batch, supplies expected old contents, and retries conflicts up to eight times.

`packages/core/src/world/memory-journal.ts` (~311 LOC) provides a prepared/committed
`.batch-journal.json` with recovery: prepared batches roll back to old values; committed
batches reapply new values. `packages/core/src/world/filesystem-node-adapter.ts` (~386 LOC)
and `packages/core/src/kernel/atomic-file.ts` (~105 LOC) perform strict UTF-8 reads,
symlink rejection, mode `0600` atomic replacement, and directory syncing.

Dependencies: Effect; `@ziggy/protocol` and Ziggy World interfaces in the tool; Node
`fs/promises`/`path` in the adapter. `tests/core/memory.test.ts` is ~525 LOC.

Verdict: adapt — retain the caps, delimiter validation, reject-on-overflow, optimistic
precondition, and journal algorithm; implement them against a small Ziggy filesystem service.

## 3. Telegram / channel adapter

`packages/gateway-telegram/src/telegram-api.ts` (~371 LOC) is a raw Telegram Bot API client:
strict Effect Schemas, `getUpdates`, `sendMessage`, `editMessageText`, callback answers,
error classification, and message normalization. `packages/gateway-telegram/src/config.ts`
(~58 LOC) validates credentials/config and defaults long polling to 30 seconds. There is no
grammY, node-telegram-bot-api, or other Telegram SDK dependency: the package depends on
Effect and Ziggy’s protocol types. Transport is long polling, not webhook (`getUpdates`).

`packages/ziggy/src/telegram-host.ts` (~515 LOC) is host orchestration and therefore tightly
coupled; `packages/ziggy/src/telegram-broadcast.ts` (~136 LOC) is the cleaner delivery adapter.
The owner check lives in `packages/core/src/gateway/owner-link.ts` (~177 LOC): a six-digit,
10-minute, one-use link binds `gatewayId + senderId`; later requests compare that identity.
Direct chats receive `primary` Memory access, groups receive `conversation` access. Unauthorized
identities fail closed.

Verdict: adapt — reuse the raw HTTP boundary, strict response normalization, long-poll retry
taxonomy, and owner-binding policy; don’t port the host’s excluded session/attach machinery.

## 4. Automation / wake-gate logic

`packages/core/src/automations/definition.ts` (~330 LOC) parses
`automations/<id>.md` as strict Markdown frontmatter:

```yaml
---
version: 1
type: prompt              # or no_agent
trigger:
  schedule: "*/15 * * * *"
broadcast:                # optional
  on: result
  gateway:
    gatewayId: telegram
    chatId: "123"
---
Prompt body.
```

IDs are lowercase kebab-case, max 80 characters; unknown fields, bad YAML, bad cron, empty
bodies, and unsupported versions fail closed. The live schema has only cron triggers; the
planning docs mention webhooks, but no webhook trigger is implemented in this parser.

`packages/core/src/automations/run.ts` (~308 LOC) evaluates an injected gate before Session
creation. The only accepted result is `{ wakeAgent: boolean }`: explicit `false` skips with no
agent work; absent gate proceeds; malformed output, failure, and timeout proceed fail-open with
recorded failure. Timeout defaults to 30 seconds. Duplicate `(automation, revision, trigger,
trigger id)` requests share one result. `packages/core/src/automations/scheduler.ts` (~149 LOC)
rechecks the active revision before firing a cron run.

Dependencies: Effect `Schema`/`Cron`; parser and gate types are coupled to Starman run/reload
interfaces. `tests/core/automation-run.test.ts` and `automation-scheduler.test.ts` cover the
negative-gate, fail-open, dedupe, and revision-recheck behavior.

Verdict: adapt — copy the file format, strict parser rules, gate decision table, and trigger
dedupe key; redesign gate configuration because the live schema has no per-file wake-gate field.

## 5. Profile / Memory / Automation schemas and types

`packages/ziggy/src/profile-config.ts` (`ProfileConfigSchema`, ~237 LOC) is the best Profile
precedent: `Schema.Struct`, literal schema version, bounded gateway array, unique IDs, and
inferred `ProfileConfig` type. `packages/core/src/automations/definition.ts`
(`AutomationFrontmatterSchema`, ~330 LOC) similarly uses Effect Schema for frontmatter but keeps
`AutomationDefinition` manual because it adds the file ID and body. `packages/core/src/memory/tool.ts`
(~451 LOC) manually validates its `MemoryOperation` union; `packages/core/src/world/memory-journal.ts`
(~311 LOC) validates journal records manually around a small schema decoder.

Dependencies: Effect Schema; the Profile schema also depends on the Ziggy gateway shape, while
Automation and Memory types depend on Starman file/world contracts.

Verdict: adapt — use schema-first `Schema.Struct`/`Schema.Union` and inferred types for Ziggy’s
Profile, Memory operations, Automation frontmatter, and journal; don’t copy the old interfaces.

## 6. Default prompts and templates

`packages/ziggy/src/profile-initialization.ts:26-68` contains the only strong reusable content:
three concise `SOUL.md` starters—`clear`, `warm`, and `operator`—each with Persona Summary,
Tone Directives, and Default Verbosity. The strings have no external dependencies.

No default `MEMORY.md` or `USER.md` content exists; initialization creates only an empty
`memory/` directory and the documents are lazy-created on first write. The
`extensions/automation-creator/skills/automation-creator/SKILL.md` prompt is only ~14 LOC and
is stale relative to the live Automation schema, so it isn’t worth copying unchanged.

Verdict: copy — reuse the three SOUL prose templates after removing Starman-specific naming or
adapt them into Ziggy’s chosen starter voices; skip the absent Memory templates and stale Skill.
