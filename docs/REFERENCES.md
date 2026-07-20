# References

An annotated index of every external repository consulted while designing ziggy, so future agents
(and the user) can always go back to the source instead of relying on secondhand summaries. Each
entry lists the canonical URL, the local cache path used during research, what the repo is, and
exactly which ziggy primitives/decisions it informs — with specific files worth (re-)reading.

Refresh any of these local caches with the `opensrc` CLI (`opensrc --help`) rather than re-cloning
by hand.

See also: [DECISIONS.md](./DECISIONS.md) (what was decided using this material) and
[docs/research/](./research/) (the full write-ups these summaries point into).

---

## pi-mono (earendil-works)

- **URL:** https://github.com/badlogic/pi-mono
- **Local:** `/Users/yesh/Documents/personal/reference/pi-mono`
- **What:** Monorepo containing `pi-ai` (provider wire layer), `pi-agent-core` (agent loop
  reference), `pi-coding-agent`, `pi-orchestrator`, `pi-tui`.
- **Informs:** D6 (loop ownership), D7 (providers), D12 (TUI), D2/D8 (Bun-binary extension
  loading precedent).
- **Read:**
  - `packages/ai/src/api/*` — per-provider wire modules (lazy-loaded `*.lazy.ts`), the model for
    D6/D7's "consume pi-ai per-call only" decision.
  - `packages/ai/src/auth/oauth/*` — OAuth flows incl. `anthropic.ts` PKCE and the
    `openai-codex-responses` Codex-subscription auth path that made D7's delegated-engine idea
    unnecessary.
  - `packages/agent/src/agent-loop.ts`, `types.ts` — `AgentEvent` discriminated union,
    `steer()`/`follow-up()` mailbox shape ziggy re-implements natively (not imported) per D6.
  - `packages/tui` — differential-rendering TUI library, dependency for ziggy's `tui` package
    (D12).
  - `docs/session-format.md` — session JSONL tree format, reference point for ziggy's own
    append-only session log shape (D5/S1).
  - `packages/coding-agent/src/core/extensions/loader.ts` — precedent for loading extension code
    at runtime inside a Bun-compiled binary (`jiti`-based); cross-check against the ziggy-specific
    empirical test in `docs/research/bun-compiled-plugin-loading.md` before copying any approach,
    since that test used raw dynamic `import()` rather than `jiti`.
- **Full write-up:** `docs/research/pi-mono.md`, `docs/research/pi-ai-provider-layer.md`.

## openclaw

- **URL:** https://github.com/openclaw/openclaw
- **Local:** `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main`
- **What:** Personal-agent runtime with workspace files, heartbeat-driven automation, and a
  plugin registry.
- **Informs:** D3 (memory — what to avoid), D10 (heartbeat — what to avoid), D16 (context
  assembly), D8 (what NOT to copy in extensions).
- **Read:**
  - `src/agents/system-prompt.ts`, `workspace.ts` — `CONTEXT_FILE_ORDER` and
    `SYSTEM_PROMPT_CACHE_BOUNDARY`, the stable/volatile prompt split D16 adapts.
  - `src/skills/loading/skill-contract.ts` — Agent Skills format ziggy's manifest tier (D8)
    reuses.
  - `src/infra/heartbeat-runner.ts` — the always-on heartbeat model D10 explicitly rejects (still
    burns tokens/logic pre-skip, unlike hermes's wake-gate).
  - **What not to copy:** the plugin registry (capability sprawl D8 deliberately avoids) and the
    full cron subsystem (superseded by D9's simpler frontmatter-file automations); also note the
    "dreaming" vector-consolidation memory approach D3 rejected in favor of hard caps.
- **Full write-up:** `docs/research/openclaw-hermes.md`.

## hermes-agent (NousResearch)

- **URL:** https://github.com/NousResearch/hermes-agent
- **Local:** `/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main`
- **What:** Personal-agent runtime with a three-tier prompt, hard-capped file memory, and
  cron wake-gates — the closest existing precedent to several of ziggy's core mechanisms.
- **Informs:** D3 (memory reject-at-cap + frozen snapshot), D9 (wake-gates, fresh-session model),
  D16 (three-tier prompt).
- **Read:**
  - `agent/system_prompt.py`, `agent/prompt_builder.py` — the three-tier (stable/context/volatile)
    system prompt D16 is modeled on.
  - `tools/memory_tool.py` — hard character caps + rejection-not-truncation, the direct source for
    D3's memory tool design.
  - `cron/scheduler.py` (~line 2311, `_parse_wake_gate`, the `no_agent` job type) — the wake-gate
    mechanism D9/D10 adopt: a pre-check that skips agent construction entirely, not just output.
  - Skills trust tiers — background for D8's approval-gated escape hatch.
- **Full write-up:** `docs/research/openclaw-hermes.md`, `docs/research/per-turn-context-and-memory.md`.

## flue

- **URL:** https://github.com/withastro/flue
- **Local:** `/Users/yesh/.opensrc/repos/github.com/withastro/flue/main`
- **What:** Agent-runtime framework with a strict adapter-contract model and dependency-free
  client packages, proven via shared contract tests.
- **Informs:** D13 (repo layout, hub-and-spoke dependency direction), D5 (gateways as dependency-
  free leaf clients), D8 (blueprints mechanism), general engineering discipline (contract testing,
  `AGENTS.md` vocabulary practice).
- **Read:**
  - `packages/runtime/src/{agent.ts,agent-definition.ts,session.ts,harness.ts,adapter.ts,types.ts,
errors.ts,result.ts}` — the `Harness`/`Adapter`/`PersistenceAdapter` "waist" contract, the
    direct model for keeping ziggy's `protocol` package the single hub other packages depend on.
  - `packages/*/adapters/**/*.test.ts` — the shared contract-test pattern ("ONE adapter contract
    for every backend, proven by shared contract tests") ziggy's S0 contract-test harness and S7
    Cloudflare "world" adapter both follow.
  - `blueprints/` — the markdown-blueprint-as-edit-script mechanism D8 adopts for long-tail
    integrations.
  - Root config (`turbo.json`, `biome.json`, `knip.json`, `tsdown` configs) — reference for
    exports-subpath discipline, though ziggy uses oxlint/oxfmt rather than biome (see AGENTS.md).
- **Full write-up:** `docs/research/flue.md`.

## eve

- **URL:** https://github.com/vercel/eve
- **Local:** `/Users/yesh/.opensrc/repos/github.com/vercel/eve/main`
- **What:** Agent runtime built around filesystem-as-config, a session→turn→step event-sourced
  model, and a local/cloud "world" durability seam.
- **Informs:** [NORTH-STAR.md](./NORTH-STAR.md) (Profile path-as-identity, no separate name field),
  D5 (event replay and resume-vs-stream handle separation), D9 (wake-gate then Run scheduling),
  D8 (Extension namespacing), and [s7-elsewhere.md](./plans/s7-elsewhere.md) (Cloudflare world seam).
- **Read:**
  - Core primitives doc/source for agent/instructions/tools/skills/channels/connections/sandbox/
    schedules/hooks/subagents/state/extensions — the broadest primitive vocabulary surveyed; ziggy
    deliberately narrows this to seven (see [AGENTS.md](../AGENTS.md)).
  - World abstraction (local vs. Vercel Workflow split) — the direct model for ziggy's own
    local-now/Cloudflare-later durability seam ([NORTH-STAR.md](./NORTH-STAR.md),
    [s7-elsewhere.md](./plans/s7-elsewhere.md)).
  - Session→turn→step nesting and NDJSON event-stream replay — precedent for D5's replay-by-
    sequence-number design.
  - Channel resume-token vs. stream/inspect-handle separation — the specific fix for the class of
    bug merlin hit with Telegram (decoupled session-key/memory-scope resolution); D5 keeps these
    two handles distinct for the same reason.
  - Extension packaging: namespace mounting, override-by-shadow-file, per-capability version
    contracts — background for D8, though ziggy's tiered model is narrower.
- **Full write-up:** `docs/research/eve.md`.

## codex (app-server)

- **URL:** https://github.com/openai/codex (subtree `codex-rs/app-server`,
  `codex-rs/app-server-protocol`, `codex-rs/app-server-transport`, `codex-rs/app-server-daemon`,
  `codex-rs/login`)
- **Local:** `/Users/yesh/.opensrc/repos/github.com/openai/codex/main`
- **What:** OpenAI Codex's local attach-protocol server — the one reference in this whole design
  with a working, production Rust implementation to read directly rather than infer from docs.
- **Informs:** D5 (ziggy's own attach protocol is modeled on this), D7 (explicitly _not_ used as a
  provider-integration target — see the nuance under D5/D7 and CONSTITUTION.md invariant 4).
- **Read:**
  - `codex-rs/app-server/src/thread_state.rs` (`ThreadStateManagerInner`, per-thread async task,
    `connection_ids: HashSet` fan-out, 30-minute thread lifetime after last unsubscribe) — the
    direct model for D5's disconnect≠kill + subscription fan-out.
  - `codex-rs/app-server/src/outgoing_message.rs` — event envelope / notification shape.
  - `codex-rs/app-server-protocol/src/protocol/common.rs` — full method/notification surface:
    thread/turn lifecycle, ~60 event-notification variants, approvals as server→client requests
    with first-response-wins + `resolved` broadcast.
  - `codex-rs/login` — OAuth/PKCE, device-code, `auth.json`/keyring storage, `AuthMode` variants —
    read for background only; ziggy does not re-implement this since pi-ai's
    `openai-codex-responses` module already covers Codex-subscription auth (D7).
  - Key finding to remember: there is **no raw single-model-call path** in app-server, only
    `turn/start` (full agentic turns) — this is exactly why D7 concluded app-server can't be a
    thin per-call provider and pi-ai's own OAuth-backed wire module is the right integration point
    instead.
- **Full write-up:** `docs/research/codex-app-server.md` (includes the recommended minimal
  protocol subset for ziggy v1 and what to explicitly skip: multi-account, experimental capability
  gating, websocket/remote transport, dynamic-tools-as-MCP-elicitation, granular approval
  taxonomy, v1/v2-parallel versioning).

## Effect

- **URL:** https://github.com/Effect-TS/effect
- **Pinned ref:** tag `effect@4.0.0-beta.99`, commit `6184a7dc53cb9310e299b65ad6d6c712c2cbf202`
  (branch `main`)
- **Local:** to be vendored as a git submodule at `vendor/effect` in S0 (not yet added as of this
  writing — see `plans/s0-foundation.md`)
- **What:** The v4-beta effect-system runtime ziggy's daemon/loop is built on.
- **Informs:** D15, and by extension every stage that writes core runtime code (S0-S7).
- **Read:**
  - `ai-docs/src/` — narrative guides + checked examples, the primary "how do I do X in v4" source.
  - `migration/` — v3→v4 migration notes; useful when cross-referencing older Effect blog posts or
    Stack Overflow answers that are v3-era and no longer accurate.
  - `packages/effect/src/` — source + JSDoc, ground truth when the guides are ambiguous.
  - `packages/platform-bun/src/` — `BunRuntime`, `BunServices`, `BunHttpServer`, `BunSocket`/
    `BunSocketServer`, `BunFileSystem`, `BunChildProcessSpawner` — the concrete adapters D4/D5/D8
    are built on.
- **Full write-up:** `docs/research/effect-v4-status.md`.

## merlin (private, evidence only)

- **Local only:** `/Users/yesh/code/personal/merlin` — private, not a public reference, **never
  imported into ziggy** (see D1).
- **What:** The user's prior personal-agent project exploring the same vision; source of the
  six-primitive glossary origin and several hard-won lessons.
- **Informs:** D1 (why clean-slate), and negatively informs CONSTITUTION.md invariants 2-4 (each
  invariant traces to a specific merlin failure mode).
- **Read:**
  - `docs/adr/0001` through `0006` — architecture decision records; read for the _questions_ they
    raised, not their answers.
  - `plans/ziggy-core-shaping.md`, `plans/ziggy-core-frame.md`, `plans/ziggy-foundation-roadmap.md`
    — merlin's own prior attempts at this exact planning exercise; useful as a diff against this
    session's decisions, not as a base to build from.
  - `docs/evidence/`, `reports/stack-context.md` — supporting evidence for the ADRs.
  - `reports/telegram-memory-deep-dive.md` — the specific incident behind D5/eve's resume-vs-stream
    handle separation: a decoupled session-key/memory-scope resolution caused Telegram replies to
    land against the wrong memory context.
- **Full write-up:** `docs/research/merlin-evidence.md` (explicitly labeled evidence-only).

---

## In-repo research reports

These are the durable, ziggy-repo-local write-ups distilled from the sources above. Prefer these
first; fall back to the source repos only when you need more detail than the report captures.

- [`docs/research/extension-mechanisms.md`](./research/extension-mechanisms.md) — pi/openclaw/
  hermes/flue/eve extension-mechanism comparison (source for D8).
- [`docs/research/bun-compiled-plugin-loading.md`](./research/bun-compiled-plugin-loading.md) —
  empirical Bun 1.3.13 `--compile` runtime-plugin-loading test matrix (source for D2/D8).
- [`docs/research/effect-v4-status.md`](./research/effect-v4-status.md) — Effect v4 beta.99 status,
  package layout, Bun adapters, API changes, pin/submodule recommendation (source for D15).
- [`docs/research/pi-mono.md`](./research/pi-mono.md) — pi-mono package architecture.
- [`docs/research/merlin-evidence.md`](./research/merlin-evidence.md) — merlin lessons,
  evidence-only.
- [`docs/research/openclaw-hermes.md`](./research/openclaw-hermes.md) — openclaw vs. hermes
  comparative report.
- [`docs/research/flue.md`](./research/flue.md) — flue domain model + overview.
- [`docs/research/eve.md`](./research/eve.md) — eve primitives + world/session model.
- [`docs/research/codex-app-server.md`](./research/codex-app-server.md) — codex app-server protocol
  deep dive.
- [`docs/research/pi-ai-provider-layer.md`](./research/pi-ai-provider-layer.md) — pi-ai dependency
  assessment.
- [`docs/research/per-turn-context-and-memory.md`](./research/per-turn-context-and-memory.md) —
  context assembly + memory + wake-gate synthesis.
