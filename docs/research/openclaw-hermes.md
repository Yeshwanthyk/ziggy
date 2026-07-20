# OpenClaw vs. Hermes-Agent — comparative survey

Both are mature, shipped "personal agent with gateways/automations/memory" systems — the closest
available reference points for ziggy's actual product shape. Neither is a template to clone; both
are read for which subsystems earn their complexity and which are bloat ziggy should not inherit.

Date: 2026-07-19
Sources: `github.com/openclaw/openclaw` (opensrc: `github.com/openclaw/openclaw@main`, local
`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main`) and `github.com/NousResearch/hermes-agent`
(opensrc: `github.com/NousResearch/hermes-agent@main`, local
`/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main`).

## 1. Core architecture

|                  | OpenClaw                                                                                                               | Hermes-Agent                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Split            | brain (agent/session/cron) + gateway (channel adapters) as distinct subsystems in one monorepo (`packages/*`, `src/*`) | single Python package tree: `agent/` (loop, prompt builder, tools), `gateway/` (channel dispatch), `cron/` (scheduler), `hermes_cli/` (CLI/config/web) |
| Language/runtime | TypeScript, pnpm workspaces                                                                                            | Python                                                                                                                                                 |
| Session identity | per-channel/thread keys, config-driven                                                                                 | per-job/session bindings (`cron/job-session-bindings.ts` equivalent concept exists in openclaw; hermes has its own session DB)                         |
| State dir        | `.openclaw`-style local state + SQLite-backed stores (`sqlite-audit-record-store.ts`, plugin-state migrations)         | Hermes home dir with `hermes_cli/config.py`-driven config, session DB, skills hub                                                                      |
| Config           | large TS config surface (`cli-config.yaml.example`, per-provider AI configs)                                           | `hermes_cli/config.py` (single large module; e.g. default `memory_char_limit`/`user_char_limit` live here)                                             |

## 2. Workspace / persona file sets

**OpenClaw** — `CONTEXT_FILE_ORDER` (`src/agents/system-prompt.ts:74-82`), a fixed priority map
controlling both load order and prompt position:

```ts
const CONTEXT_FILE_ORDER = new Map<string, number>([
  ["agents.md", 10],
  ["soul.md", 20],
  ["identity.md", 30],
  ["user.md", 40],
  ["tools.md", 50],
  ["bootstrap.md", 60],
  ["memory.md", 70],
]);
```

Unrecognized files sort after all known ones (`?? Number.MAX_SAFE_INTEGER`, line 201). A separate
`DYNAMIC_CONTEXT_FILE_BASENAMES = new Set(["heartbeat.md"])` (line 84) marks `heartbeat.md` as
context that is _not_ part of the stable prefix — it changes per invocation and must not poison
the cached prefix, with a default heartbeat prompt baked in as a constant
(`DEFAULT_HEARTBEAT_PROMPT_CONTEXT_BLOCK`, lines 85-86). `SYSTEM_PROMPT_STABLE_PREFIX_CACHE_LIMIT = 64`
(line 87) caps how many stable-prefix variants are cached in memory.

**Hermes** — `SOUL.md` is the persona file; project context is loaded with an explicit,
documented single-winner priority chain (`agent/prompt_builder.py:2000`: _"Priority (first found
wins — only ONE project context type is loaded)"_), assembled into a `# Project Context` prompt
section (line 2066) via `agent/subdirectory_hints.py`. Contributor `AGENTS.md` is treated as
authoritative project context per an explicit fixed-issue comment in the source (line 2028).

**Cache-boundary mechanism (OpenClaw)** — `packages/ai/src/utils/system-prompt-cache-boundary.ts`:
a literal marker string `SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n"`
splits any system prompt into `stablePrefix`/`dynamicSuffix`. `ensureSystemPromptCacheBoundary`
appends the marker when absent "so dynamic additions route into an uncached suffix instead of the
cached prefix" (comment citing issue #85203) — i.e., a hook-supplied prompt override without the
marker is treated as fully dynamic (uncached) rather than accidentally polluting the cached
prefix. `prependSystemPromptAdditionAfterCacheBoundary` inserts additions strictly after the
boundary. This is the direct, literal ancestor of ziggy's own frozen-prefix/volatile-suffix design
(D16) — same idea, ziggy just doesn't need an HTML-comment marker because its boundary is a
structural property of how the prompt is assembled (frozen snapshot object vs. live conversation
array), not a string scan.

## 3. Memory design

**Hermes** — hard character caps, **rejection not truncation**. Confirmed constants
(`hermes_cli/config.py:2292-2293`, `tools/memory_tool.py:804-805`, `agent/agent_init.py:1439-1440`,
mirrored in `optional-skills/migration/openclaw-migration/scripts/openclaw_to_hermes.py:29-30`):

```python
memory_char_limit = 2200   # ~800 tokens at 2.75 chars/token
user_char_limit = 1375     # ~500 tokens at 2.75 chars/token
```

Two separate stores at those two caps: "personal notes (~2200 chars) and user profile (~1375
chars)" (`hermes_cli/tips.py:168`) — directly the ancestor of ziggy's `MEMORY.md` + `USER.md`
split. The tool's own docstring states the write-time contract explicitly
(`tools/memory_tool.py:1080`): _"IF FULL: an add is rejected with the current entries shown.
Reissue as ONE batch that ..."_ — a write that would exceed the cap is refused outright, with the
current contents shown back to the model so it can consolidate/replace rather than silently losing
data to truncation. `memory_tool.py` implements `add`/`replace`/`remove` as distinct operations
(lines 388, 457), and comments call out that "a single poisoned op rejects the whole batch" (line 514) — batched writes are all-or-nothing, not partially applied. This is the exact mechanism
ziggy's memory design (D3) copies: single `add/replace/remove` tool, hard cap, reject-at-write-time
for auditability.

**OpenClaw** — memory is one of several state categories subject to the same
bounded-store/eviction discipline visible elsewhere in the codebase (LRU-bounded caches with
explicit eviction comments in `src/infra/outbound/directory-cache.ts`, `channel-bootstrap.runtime.ts`,
and cap-triggered eviction handling in `src/infra/state-migrations.plugin-state.ts:427-451`,
which explicitly handles "a concurrent write pushed the store over a cap and evicted a row" as a
recoverable race, restoring the evicted entry where possible). OpenClaw's general posture is
bounded caches with LRU/cap eviction and explicit reconciliation of eviction races, rather than
hermes' single hard reject-at-write-time cap — a softer, more machinery-heavy approach that ziggy
deliberately does not adopt (D3 chose hermes' simpler reject model).

## 4. Skills

Both systems standardize on the **Anthropic Agent Skills format** (markdown + frontmatter,
consistent with what ziggy's own extension "skills" tier uses). Hermes layers a **trust-tier +
scanner + provenance** model on top: `hermes_cli/skills_hub.py:661-662` logs "Scan provenance:
{freshness}; scanner {scan_provenance['scanner_version']}; hash {scan_provenance['bundle_hash']}";
`hermes_cli/web_server.py:12840` surfaces "their trust tier" per skill in a catalog view, and
`hermes_cli/web_server.py:13030` documents a quarantine flow that "Returns the verdict, per-finding
detail, trust tier, and the [scan results]". `hermes_cli/config.py:2433` runs "the keyword/pattern
security scanner on skills the agent" installs. OpenClaw has an equivalent static-analysis command
gate referred to in its own docs/tips as "tirith" (`hermes_cli/tips.py:465` references a
`security.tirith_fail_open` config flag — note this specific reference is inside hermes' own
config, describing hermes' scanner, not an openclaw import; tirith is hermes' scanner name, not
openclaw's). Both systems' scan/trust-tier machinery is heavier than ziggy needs at v1 — ziggy's
S4 install/doctor flow (quarantine → traversal/symlink checks → checksum/signature verify →
parse-without-execute → explicit approval for executable content) borrows the _shape_ of this
discipline without building a persistent trust-tier/scanner subsystem.

**Blueprints (Hermes)** — a first-class, documented mechanism: `tools/blueprints.py`,
`hermes_cli/blueprint_cmd.py`, `cron/blueprint_catalog.py`, with a public catalog page
(`website/docs/reference/automation-blueprints-catalog.mdx`) and UI component
(`web/src/components/AutomationBlueprints.tsx`). Hermes blueprints are specifically **automation**
blueprints — markdown guides for common cron/automation setups a user or agent can apply. This is
one of two blueprint precedents feeding ziggy's own blueprints mechanism (the other being flue's
integration blueprints, see `docs/research/flue.md`) — ziggy generalizes the idea beyond
automations to any long-tail integration.

## 5. Cron / automations

**OpenClaw** — a large, dedicated subsystem: `src/cron/` alone is **~22,700 non-test lines of
TypeScript** (`find src/cron -name '*.ts' -not -name '*.test.ts' | xargs wc -l`; ~42,300 including
its own extensive test suite). File count and names indicate deep machinery: `schedule.ts`/
`schedule-number.ts`/`schedule-identity.ts` (cron-expression parsing/identity), `store.ts`
(persistence), `delivery.ts`/`delivery-plan.ts`/`delivery-defaults.ts`/`delivery-preview.ts`/
`delivery-target-validation.ts`/`delivery-channel-validation.ts`/`delivery-context.ts` (a whole
sub-subsystem just for where/how results get delivered), `isolated-agent.ts` + a same-named
subdirectory (isolated execution context per job), `heartbeat-policy.ts`, `pacing.ts`/`stagger.ts`
(load-spreading across many scheduled jobs), `session-reaper.ts` (cleanup), `retry-hint.ts`,
`webhook-url.ts`, `run-diagnostics.ts`, `task-run-history.ts`, `active-jobs.ts`, and a
`cron-protocol-conformance.test.ts` implying a formal cron wire protocol. This is the concrete
"what not to copy" evidence for ziggy's Automation primitive: openclaw's cron subsystem alone is
larger than ziggy's entire target `core` package. Ziggy's S5 design (fresh-session-per-run,
frontmatter-driven files, `Schedule.cron` from Effect, simple broadcast rules) deliberately forgoes
pacing/stagger/isolated-execution-context/formal-protocol machinery at this scale.

**Hermes** — flat, much smaller: `cron/scheduler.py` is one file containing the wake-gate
mechanism (see `docs/research/per-turn-context-and-memory.md` for the full mechanism) plus
`no_agent` script-only jobs. `gateway/` (channel dispatch, separate from cron) is itself
~45,400 lines across its .py files, dominated by per-platform adapters
(`whatsapp_identity.py`, `stream_dispatch.py`, `stream_events.py`, `systemd_notify.py`, and many
more not enumerated here) — i.e., hermes keeps scheduling flat/simple but its gateway layer is not
small either. Fresh-session-per-run is hermes' model (not continuing a prior automation's session)
— directly adopted by ziggy (D9).

## 6. Gateway adapter contracts and authorization layering

OpenClaw's `test/gateway.multi.e2e.test.ts` / `test/gateway-queued-session-rotation.e2e.test.ts` /
`test/clawrouter-managed-gateway.e2e.test.ts` and `scripts/check-channel-agnostic-boundaries.mjs`
/ `scripts/check-no-deprecated-channel-access.ts` indicate a deliberately enforced
channel-agnostic boundary — a lint/CI-level check exists specifically to prevent gateway-specific
code from leaking into channel-agnostic paths, and vice versa. This is good precedent for ziggy's
S6 requirement that the Telegram gateway package depend only on `protocol` (a structural boundary
ziggy can enforce the same way: a CI check that a gateway package's imports never reach into
`core`). `extensions/cloudflare-ai-gateway`, `extensions/vercel-ai-gateway`, `extensions/qa-channel`
show openclaw treats _some_ gateway/channel integrations as optional extensions rather than
core-shipped adapters — analogous to ziggy treating Telegram as the one first-party gateway at v1
(S6) and leaving others to the blueprint/leaf-package pattern (S7).

Hermes layers gateway identity separately from memory/session authorization — `gateway/whatsapp_identity.py`
is a dedicated identity-resolution module distinct from session/message dispatch
(`stream_dispatch.py`, `stream_events.py`) — the same separation-of-concerns ziggy's S6 identity
design (owner-link vs. session routing) follows.

## 7. What not to copy — bloat inventory

- OpenClaw's `src/cron/` (~22.7k non-test LOC): pacing/stagger, isolated-agent execution contexts,
  a formal cron wire protocol, multi-file delivery-validation pipeline. Ziggy's entire Automation
  primitive should be a small fraction of this.
- Hermes' `gateway/` (~45.4k LOC across many per-platform files) and its trust-tier/scanner/
  quarantine skill-security subsystem: real, useful, but heavier than a v1 single-gateway
  (Telegram-only) ziggy needs — S4's install/doctor flow borrows the _shape_, not the machinery.
- OpenClaw's SQLite-backed audit/plugin-state stores with LRU-cap eviction-and-reconciliation
  logic: ziggy's file-based-everything design (D3/constitutional invariant #6) deliberately avoids
  needing this class of machinery at all.

## 8. Minimal-clone shopping list (what ziggy actually takes)

1. `CONTEXT_FILE_ORDER`-style fixed persona/context file priority (openclaw) → informs ziggy's
   fixed SOUL.md/MEMORY.md/USER.md ordering in the stable prefix.
2. Cache-boundary marker splitting stable-prefix/dynamic-suffix (openclaw) → structural analogue in
   ziggy's frozen-snapshot design (D16), no marker string needed since ziggy's boundary is a data
   structure, not a text scan.
3. Hard character caps + reject-at-write (not truncate), single `add/replace/remove` memory tool,
   all-or-nothing batched writes (hermes) → ziggy's Memory design verbatim (D3).
4. Wake-gate: cheap pre-check script, `{"wakeAgent": false}` short-circuits before any LLM call,
   `no_agent` jobs that never touch the model at all (hermes) → ziggy's D10 no-heartbeat design.
5. Fresh session per automation run (hermes) → ziggy's D9.
6. Agent-Skills-format skills with lightweight install-time verification (parse-without-execute,
   approval-gated executable content) — shape only, not the persistent trust-tier/scanner
   subsystem — → ziggy's S4.
7. Blueprints as markdown integration/automation guides (hermes) + flue's edit-script blueprints →
   ziggy's generalized blueprints mechanism.
8. Channel-agnostic-boundary enforcement as a CI-level structural check (openclaw) → ziggy's S6
   "gateway depends only on protocol" rule should be lint/CI-enforced, not just documented.
