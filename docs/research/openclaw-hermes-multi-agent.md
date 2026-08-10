# Multi-agent routing in OpenClaw and Hermes Agent

Source-only review of repository snapshots fetched with the installed `opensrc` CLI.
`opensrc --help` identifies GitHub repositories as `owner/repo`; the correct specs are
`openclaw/openclaw` and `NousResearch/hermes-agent` (not the similarly named npm
packages). Findings are pinned to:

- OpenClaw [`fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771`](https://github.com/openclaw/openclaw/tree/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771)
- Hermes Agent [`36cb5ae5530a75def7df3195e49b7a4aa2add482`](https://github.com/NousResearch/hermes-agent/tree/36cb5ae5530a75def7df3195e49b7a4aa2add482)

## Summary

| Concern            | OpenClaw                                                                                    | Hermes Agent                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Durable agent unit | Named `agents.entries.<id>` inside one Gateway                                              | Named Profile: a separate `HERMES_HOME`                                                                                 |
| Operator selection | `openclaw agent --agent <id>`; `agents add/bind/list`                                       | `<profile> chat`, `hermes -p <profile> …`, or sticky `profile use`                                                      |
| Inbound selection  | Ordered bindings over channel/account/peer/guild/team/roles; Telegram topic override        | Normally one credential/gateway per Profile; optional multiplexing and `profile_routes` over platform/guild/chat/thread |
| Chat `@name`       | Bot/native mention or regex wake gate after routing; not a general agent-name router        | Real Telegram bot usernames select bot/Profile processes; not a general `@profile` router                               |
| Isolation          | Per-agent workspace, agent directory, SQLite store, and `agent:<id>:…` keys                 | Per-Profile home; multiplex mode shares one process/store but namespaces keys and scopes runtime resources              |
| Default            | Configured default, otherwise built-in `main`; missing binding targets fall back to default | Active/default Profile; unmatched or missing route targets fall back to default home                                    |

## OpenClaw

### Selection, identity, and per-agent settings

The management UX is explicit: `openclaw agents add`, `list --bindings`, `bind`,
`unbind`, `set-identity`, and `delete`. Creation accepts per-agent workspace, model,
agent directory, and repeatable `channel[:accountId]` bindings; `openclaw agent
--agent ops …` overrides bindings for a direct run. See
[`docs/cli/agents.md:18-70`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/docs/cli/agents.md#L18-L70) and
[`docs/cli/agent.md:125-170`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/docs/cli/agent.md#L125-L170).

`AgentConfig` carries `id`, default/name/description, workspace and `agentDir`,
model and model policy, skills, memory, identity, group-chat mention patterns,
subagent policy, sandbox, params, tools, and runtime. Prompt/persona files
(`AGENTS.md`, `SOUL.md`, optional `USER.md`) live in the agent workspace. Identity
adds name/theme/emoji/avatar; local avatars must stay under the workspace even
through symlinks and are size-limited. See
[`src/config/types.agents.ts:72-169`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/src/config/types.agents.ts#L72-L169),
[`docs/concepts/multi-agent.md:13-45`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/docs/concepts/multi-agent.md#L13-L45), and
[`docs/cli/agents.md:145-173`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/docs/cli/agents.md#L145-L173).

### Routing and fallback

A route binding names an `agentId` and matches channel plus optional account,
peer, guild, team, or Discord roles. Missing `accountId` means only the default
account; `"*"` means every account. The resolver tests tiers in this order:
exact peer, parent peer, peer wildcard, guild+roles, guild, team, account, channel;
the first match in a tier wins. No match selects the default agent. See
[`src/config/types.agents.ts:27-70`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/src/config/types.agents.ts#L27-L70) and
[`src/routing/resolve-route.ts:650-819`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/src/routing/resolve-route.ts#L650-L819).

A blank or unknown binding target is resolved to the configured default when an
agent list exists; with no configured list, OpenClaw preserves the sanitized ID.
Thus stale binding targets fail soft rather than rejecting the message.
[`src/routing/resolve-route.ts:156-174`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/src/routing/resolve-route.ts#L156-L174)

### State and session isolation

Each agent has a distinct workspace, state directory, and SQLite session store at
`~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`; secondary workspaces
default to `<stateDir>/workspace-<agentId>`. Session keys are agent-prefixed.
Groups use `agent:<id>:<channel>:<kind>:<peer>`, while direct messages default to
the shared per-agent main session unless `dmScope` is changed to a per-peer,
per-channel-peer, or per-account-channel-peer mode. See
[`docs/concepts/multi-agent.md:47-68`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/docs/concepts/multi-agent.md#L47-L68) and
[`src/routing/session-key.ts:195-263`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/src/routing/session-key.ts#L195-L263).

The boundary is not absolute: a workspace is a default cwd, not a sandbox;
plugin-owned global storage is not automatically split; and a secondary agent
may read through to the main agent's OAuth credential when refresh fails. True
separation requires sandboxing, per-agent plugin scope, and independent login.
[`docs/concepts/multi-agent.md:29-45`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/docs/concepts/multi-agent.md#L29-L45)

### Telegram and `@agent` behavior

With multiple Telegram bots, each token is configured as an account and an
account binding selects its agent. A native `@botusername` mention addresses the
agent already selected for that bot/account even when the persona name differs.
Per-agent `mentionPatterns` are likewise activation gates: the code first receives
`routeAgentId`, then builds that agent's regexes and decides whether to skip the
message; it does not turn captured text into another agent ID. See
[`docs/channels/telegram.md:152-167`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/docs/channels/telegram.md#L152-L167),
[`extensions/telegram/src/bot-message-context.body.ts:176-197`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/extensions/telegram/src/bot-message-context.body.ts#L176-L197), and
[`extensions/telegram/src/bot-message-context.body.ts:350-403`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/extensions/telegram/src/bot-message-context.body.ts#L350-L403).

Telegram forum topics are the notable static override: a topic may declare
`agentId`, yielding keys such as `agent:zu:telegram:group:…:topic:3`. The route
code sanitizes but deliberately preserves that ID even if it is absent from the
current config, so topic sessions remain stable rather than taking the generic
missing-agent fallback. See
[`docs/channels/telegram.md:583-612`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/docs/channels/telegram.md#L583-L612) and
[`extensions/telegram/src/conversation-route.ts:53-109`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/extensions/telegram/src/conversation-route.ts#L53-L109).

### Validation and delegation security

Agent config and binding objects use strict Zod schemas; IDs are filesystem-safe,
64-character identifiers, and configured entries require exactly one
`default: true`. ACP conversation bindings require a concrete peer. Telegram is
fail-closed for groups by default, validates DM allowlist combinations, and uses
numeric sender allowlists. See
[`src/config/zod-schema.agents.ts:1-109`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/src/config/zod-schema.agents.ts#L1-L109),
[`packages/normalization-core/src/agent-id.ts:1-28`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/packages/normalization-core/src/agent-id.ts#L1-L28), and
[`docs/channels/telegram.md:154-204`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/docs/channels/telegram.md#L154-L204).

OpenClaw does support explicit named delegation, but through
`sessions_spawn(agentId)`, not arbitrary `@agent` prose. Cross-agent targets must
be admitted by `subagents.allowAgents`; `requireAgentId` can forbid implicit
same-agent spawning, and sandboxed callers face additional target restrictions.
[`docs/tools/subagents.md:378-405`](https://github.com/openclaw/openclaw/blob/fb81d03d8eb2f2784f7a7ab64c31f1b8dc81f771/docs/tools/subagents.md#L378-L405)

## Hermes Agent

### Selection, identity, and per-Profile settings

Hermes calls the durable agent unit a **Profile**. Human-facing selection is a
generated command alias (`coder chat`), `hermes -p coder chat`, or a sticky
`hermes profile use coder`; the prompt and banner display the active Profile.
[`website/docs/user-guide/profiles.md:11-20`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/website/docs/user-guide/profiles.md#L11-L20),
[`website/docs/user-guide/profiles.md:83-124`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/website/docs/user-guide/profiles.md#L83-L124)

A Profile owns `config.yaml` (model/provider/toolsets/settings), `.env` (API keys
and bot tokens), `SOUL.md` (persona/system instructions), memories, skills,
sessions, cron, and state DB. `terminal.cwd` separately selects the tool working
directory. A Profile description is metadata for Kanban/orchestration, not a chat
mention alias. Clone mode copies config, credentials, SOUL, and skills but excludes
session and state history. See
[`website/docs/user-guide/profiles.md:31-69`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/website/docs/user-guide/profiles.md#L31-L69) and
[`website/docs/user-guide/profiles.md:116-205`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/website/docs/user-guide/profiles.md#L116-L205).

### Gateway binding, routing, and fallback

The default deployment is one process and one bot credential per Profile. The
opt-in `gateway.multiplex_profiles: true` instead makes the default gateway serve
all Profiles. It binds inbound traffic by the owning credential, `/p/<profile>/`
HTTP prefix, or `gateway.profile_routes`. The latter matches platform plus
optional guild/chat/thread; weights are guild 2, chat 4, thread 8, all declared
fields are ANDed, parent channels match child threads, and the first route after
stable specificity sorting wins. See
[`website/docs/user-guide/multi-profile-gateways.md:59-108`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/website/docs/user-guide/multi-profile-gateways.md#L59-L108) and
[`gateway/profile_routing.py:51-166`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/gateway/profile_routing.py#L51-L166).

No route means active/default Profile. Invalid route entries are skipped; route
matching exceptions return default; and a syntactically valid route whose Profile
does not exist logs a warning and falls back to global/default `HERMES_HOME`.
Unknown HTTP profile prefixes instead return 404. See
[`gateway/run.py:23905-24004`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/gateway/run.py#L23905-L24004) and
[`website/docs/user-guide/multi-profile-gateways.md:132-180`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/website/docs/user-guide/multi-profile-gateways.md#L132-L180).

### State and session isolation

In normal mode, setting `HERMES_HOME=~/.hermes/profiles/<name>` scopes config,
sessions, memory, skills, DB, gateway state, logs, and cron. In multiplex mode,
there is one `SessionStore` created from the multiplexer config, but keys use
`agent:<profile>:…`; default retains `agent:main:…`. Each turn enters the routed
Profile's runtime scope for config, skills, memory, SOUL, provider keys, and other
resources. See
[`website/docs/user-guide/profiles.md:272-301`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/website/docs/user-guide/profiles.md#L272-L301),
[`gateway/run.py:5790-5815`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/gateway/run.py#L5790-L5815), and
[`gateway/session.py:1039-1074`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/gateway/session.py#L1039-L1074).

A Profile is not a sandbox. Local tools retain the OS user's filesystem access,
and host subprocesses share the real `HOME` and its CLI credentials by default;
`terminal.home_mode: profile` opts into a Profile-specific subprocess home.
[`website/docs/user-guide/profiles.md:125-149`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/website/docs/user-guide/profiles.md#L125-L149),
[`website/docs/user-guide/profiles.md:276-301`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/website/docs/user-guide/profiles.md#L276-L301)

### Telegram and `@agent` behavior

The documented multi-bot UX assigns one Telegram token to each Profile. With
`require_mention: true` and default-on `exclusive_bot_mentions`, a message naming
one or more real bot usernames is processed only by those bot/Profile adapters;
other bots reject it before reply/wake-word fallbacks. If `require_mention` is
false, unmentioned visible group traffic retains open-group behavior, so the
deterministic multi-bot setup explicitly enables it. See
[`website/docs/user-guide/messaging/telegram.md:530-572`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/website/docs/user-guide/messaging/telegram.md#L530-L572).

The adapter trusts Telegram mention/command entities and uses only a narrow
entity-less `@…bot` fallback. It checks explicit other-bot mentions before
allowed-chat, reply, and regex wake gates; text messages reject unauthorized
users before batching, transcript observation, or event construction. See
[`plugins/platforms/telegram/adapter.py:8100-8278`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/plugins/platforms/telegram/adapter.py#L8100-L8278) and
[`plugins/platforms/telegram/adapter.py:8654-8807`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/plugins/platforms/telegram/adapter.py#L8654-L8807).

This is native `@botusername` selection, not one shared bot parsing arbitrary
`@profile` names. A shared bot can route a Telegram group to a Profile only by
configured `chat_id` metadata in `profile_routes`; there is no mention field in
that route model.
[`website/docs/user-guide/multi-profile-gateways.md:218-261`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/website/docs/user-guide/multi-profile-gateways.md#L218-L261)

### Validation and delegation security

Profile IDs are lowercase filesystem-safe names up to 64 characters; reserved
names, Hermes subcommands, path separators/traversal, and command alias collisions
are rejected. Route parsing reuses this validation. Duplicate platform tokens
across Profiles fail startup. Multiplex credential reads are context-scoped and
fail closed rather than falling back to another Profile's process environment.
See
[`hermes_cli/profiles.py:250-409`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/hermes_cli/profiles.py#L250-L409),
[`website/docs/user-guide/multi-profile-gateways.md:184-201`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/website/docs/user-guide/multi-profile-gateways.md#L184-L201), and
[`agent/secret_scope.py:133-181`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/agent/secret_scope.py#L133-L181).

Hermes subagents are a separate mechanism. `delegate_task` accepts goal/context,
a task array, and `leaf`/`orchestrator` roles, but no Profile or agent ID; children
are generic isolated workers rather than named Profile targets. Therefore it also
does not implement an arbitrary `@agent` invocation grammar.
[`tools/delegate_tool.py:3774-3912`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/tools/delegate_tool.py#L3774-L3912)

## Bottom line

OpenClaw's native abstraction is the finer-grained **agent inside one Gateway**,
with rich deterministic bindings and explicit cross-agent spawn allowlists.
Hermes' native abstraction is the broader **Profile/home/process boundary**, with
optional multiplexing and simpler chat-metadata routes. Both support native bot
mentions as activation/addressing, but neither treats free-form `@agent-name`
text as a general durable-agent selector. Implementing that UX would require a
new parser/alias registry, authorization policy, unknown/ambiguous-target rules,
and an explicit turn/thread/session binding lifetime.
