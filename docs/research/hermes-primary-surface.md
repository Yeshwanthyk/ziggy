# Hermes Agent primary surface

Primary-source inventory for comparison with Ziggy's folder-as-profile model. Research was
performed against the official Nous Research repository at commit
[`b3aa561faffd64f05436e429a6415d175e534ec9`](https://github.com/NousResearch/hermes-agent/tree/b3aa561faffd64f05436e429a6415d175e534ec9)
and the official documentation stored in that tree. The latest published GitHub release visible
at research time was
[`v2026.8.3`](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.3), while
`main` declared Python package version `0.20.0`; those are distinct version schemes and should not
be conflated. Refs:
[`pyproject.toml`](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/pyproject.toml),
[GitHub releases](https://github.com/NousResearch/hermes-agent/releases).

Only first-party repositories, first-party documentation, and source code are used below. No
credentials were read, copied, displayed, or exercised, and no account or provider flow was run.

## Canonical candidate resolution

| Candidate                                                                                                            | Primary-source facts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Disposition                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent)                                          | The repository calls itself **Hermes Agent**, identifies Nous Research as the builder, links the Nous-owned product/docs site, publishes the `hermes` CLI entrypoint, and owns the installer, runtime, website docs, TUI, desktop app, gateway, profiles, sessions, skills, plugins, and cron source. The GitHub repository metadata points its homepage to `hermes-agent.nousresearch.com`. Refs: [README](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/README.md), [package metadata](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/pyproject.toml), [GitHub repository API](https://api.github.com/repos/NousResearch/hermes-agent). | **Canonical repo and product for this report.**                                                                                                                                                  |
| [`hermes-agent-org/hermes`](https://github.com/hermes-agent-org/hermes)                                              | This is a separately hosted, non-archived repository which GitHub does **not** mark as a fork. Its own README nevertheless says the product is built by Nous Research, links docs and licensing into `NousResearch/hermes-agent`, installs from the Nous repository, and tells contributors to clone the Nous repository. Its last visible commit was `036cbdfa…`, substantially behind the Nous snapshot researched here. Refs: [its README at that commit](https://github.com/hermes-agent-org/hermes/blob/036cbdfa0a3158454a0a2a7a7388cf70353326b4/README.md), [GitHub repository API](https://api.github.com/repos/hermes-agent-org/hermes).                                                                                   | **Plausible name collision, not canonical.** Its exact relationship to Nous is not declared by either cited source, so this report does not label it an official mirror, fork, or impersonation. |
| Other [`NousResearch` repositories containing “hermes”](https://api.github.com/orgs/NousResearch/repos?per_page=100) | First-party examples include [`hermes-agent-self-evolution`](https://github.com/NousResearch/hermes-agent-self-evolution) (an optimization system _for_ Hermes Agent), [`hermes-example-plugins`](https://github.com/NousResearch/hermes-example-plugins) (documentation companions and examples, explicitly not bundled core), and [`hermes-paperclip-adapter`](https://github.com/NousResearch/hermes-paperclip-adapter) (an adapter that runs Hermes as a Paperclip worker).                                                                                                                                                                                                                                                    | **Official companions, not alternate core products.**                                                                                                                                            |

Canonicality is therefore strong but not inferred from repository name alone: it comes from the
convergence of publisher identity, product site, documentation, installer target, package entry
points, and complete runtime source. The existence of `hermes-agent-org/hermes` remains an
explicit ambiguity in discovery results.

## Source-linked claim inventory

### H-01 — Product and installation

- **Product shape.** Hermes Agent is a Python agent product with a shared `AIAgent` core used by
  the classic CLI, Ink TUI, messaging gateway, desktop app, ACP/editor integration, API server,
  batch runner, cron, and Python library. The top-level architecture identifies
  `run_agent.py:AIAgent` as the narrow runtime center. Refs:
  [README](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/README.md),
  [architecture docs](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/developer-guide/architecture.md),
  [`AIAgent` source](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/run_agent.py).
- **CLI entrypoints.** Package metadata installs `hermes`, `hermes-agent`, and `hermes-acp`; the
  ordinary user entrypoint is `hermes`. Refs:
  [`pyproject.toml`](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/pyproject.toml),
  [CLI reference](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/reference/cli-commands.md).
- **Official install paths.** The documented CLI-only install is
  `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash` on Linux/macOS/WSL2 and
  `iex (irm https://hermes-agent.nousresearch.com/install.ps1)` on native Windows. The official
  product site also distributes a desktop installer. Refs:
  [quickstart](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/getting-started/quickstart.md),
  [POSIX installer source](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/scripts/install.sh),
  [PowerShell installer source](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/scripts/install.ps1).
- **Installed layout.** A normal non-root install places source and its managed environment under
  `$HERMES_HOME/hermes-agent` (default `~/.hermes/hermes-agent`) and the command under
  `~/.local/bin`; new Linux root installs use `/usr/local/lib/hermes-agent` and
  `/usr/local/bin/hermes` while profile data remains under `$HERMES_HOME`. The installer supports
  branch/commit selection, but its ordinary path follows `main`, so the one-liner is not itself a
  reproducible release pin. Ref:
  [installer layout and options](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/scripts/install.sh).
- **Setup after installation.** `hermes setup` is the broad wizard; `hermes model` configures an
  inference provider/model; `hermes setup --portal` selects Nous Portal through OAuth and enables
  Nous Tool Gateway integrations. Refs:
  [quickstart](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/getting-started/quickstart.md),
  [provider docs](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/integrations/providers.md).

### H-02 — Profile and visible-file model

- **A profile is a Hermes home directory.** The default is `~/.hermes`; named profiles live under
  the Hermes root's `profiles/<name>` and are selected by `hermes -p <name>` or generated command
  aliases. `HERMES_HOME` is the state boundary. Refs:
  [profiles guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/profiles.md),
  [`get_hermes_home()`](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/hermes_constants.py),
  [profile implementation](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/hermes_cli/profiles.py).
- **A profile is more than visible Markdown.** It can contain `config.yaml`, `.env`, `auth.json`,
  `SOUL.md`, `memories/`, `skills/`, `cron/`, `scripts/`, logs, gateway state, and opaque SQLite
  stores such as `state.db` and `cron/executions.db`. This is a folder-as-agent-state model, but
  not Ziggy's “open the folder and grok the whole assistant from human-owned files” model. Refs:
  [profiles guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/profiles.md),
  [configuration layout](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/configuration.md),
  [session storage](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/sessions.md),
  [cron guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/cron.md).
- **Visible identity and context files.** `SOUL.md` is the profile-global personality file and is
  loaded only from `HERMES_HOME`. Workspace instructions are separately discovered from
  `.hermes.md`/`HERMES.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, and Cursor rule files with a
  documented priority. Refs:
  [context files](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/context-files.md),
  [prompt builder](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/agent/prompt_builder.py).
- **Profile is not workspace or sandbox.** Tool execution starts from `terminal.cwd` or the launch
  directory, not from `HERMES_HOME`; a profile does not constrain filesystem access. The default
  host subprocess policy retains the real OS `HOME`, so user-level CLI credentials remain shared
  across profiles unless `terminal.home_mode: profile` is selected. Ref:
  [profiles: profiles vs workspaces vs sandboxing](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/profiles.md).
- **One writer is the stated safety model.** Official docs warn not to point two agent processes at
  the same profile because automatic memory writes can compound. Multiple independent agents are
  expected to use separate profiles; shared memory should use an external provider. Ref:
  [profiles guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/profiles.md).
- **Profile creation and copying.** `hermes profile create` creates a profile and seeds bundled
  skills plus a default `SOUL.md`; `--clone` copies config, `.env`, `SOUL.md`, memories, and skills
  as specified by current source; `--clone-all` copies broader state while excluding per-profile
  history artifacts. The user docs and current source should both be checked before depending on
  exact clone contents because this surface has evolved. Refs:
  [profiles guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/profiles.md),
  [copy lists and creation code](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/hermes_cli/profiles.py).
- **Profiles can be packaged as installable agents.** A profile distribution is a git repository
  containing distribution-owned identity/configuration such as `SOUL.md`, skills, MCP config, and
  cron definitions. `hermes profile install <git-or-local-source>` creates a local profile while
  excluding credentials, memories, and sessions; imported cron definitions require explicit
  enablement rather than auto-scheduling. Ref:
  [profile distributions](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/profile-distributions.md).

### H-03 — Sessions and memory

- **Session authority is SQLite.** `HERMES_HOME/state.db` stores session metadata, the system prompt
  snapshot, role-aware message history, tool calls/results, usage, source, parent lineage, and an
  FTS5 index. Legacy JSONL files are no longer authoritative. Refs:
  [sessions guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/sessions.md),
  [session storage internals](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/developer-guide/session-storage.md),
  [`SessionDB`](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/hermes_state.py).
- **All faces share that authority.** CLI, TUI, gateway platforms, cron, ACP, API, and batch sessions
  are source-tagged in the same store. Resume, title, search, export, archive, prune, and
  cross-platform handoff are product surfaces over it. Ref:
  [sessions guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/sessions.md).
- **Memory is separate from transcripts.** Built-in durable memory is visible Markdown under
  `HERMES_HOME/memories/`: `MEMORY.md` for agent notes and `USER.md` for a user profile. Current
  default limits are 2,200 and 1,375 characters respectively; overflow rejects rather than
  silently compacting. A frozen snapshot is injected at session start, while writes persist
  immediately and become prompt context on the next session. Ref:
  [persistent memory](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/memory.md).
- **Memory ownership is agent-managed by default.** The model can add, replace, or remove entries.
  `memory.write_approval: true` stages writes for human approval; otherwise foreground and
  background-review writes may land automatically. Skills have a parallel `skills.write_approval`
  gate. This differs from a strict human-owned-files policy even though the files remain visible.
  Refs:
  [memory approval](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/memory.md),
  [skill write approval](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/skills.md).
- **Long-tail recall is transcript search, not a second Markdown memory.** `session_search` performs
  FTS5 discovery/browse/scroll over actual messages in `state.db`; it does not invoke an LLM for
  retrieval. External memory providers are separately pluggable and can augment built-in memory.
  Refs:
  [session search](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/sessions.md),
  [memory providers](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/memory-providers.md).

### H-04 — Agent, subagent, skill, and extension models

- **Primary agent.** `AIAgent` owns prompt assembly, provider/API-mode selection, model calls, tool
  dispatch, retries/fallback, compression, interruption, and persistence. `chat()` is the simple
  wrapper; `run_conversation()` is the full entrypoint. Refs:
  [agent loop docs](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/developer-guide/agent-loop.md),
  [`run_agent.py`](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/run_agent.py).
- **Profiles are independent agents, not named prompt fragments.** Each profile owns a distinct
  `HERMES_HOME`, and the profile docs explicitly frame profiles as separate coding, personal, or
  research agents. In current Hermes, the closest analog to Ziggy Profile specialists is either a
  separate profile or a delegated child, not an `agents/*.md` registry inside one profile. Ref:
  [profiles guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/profiles.md).
- **Subagents are fresh child `AIAgent` instances.** `delegate_task` gives each child isolated
  conversation context and a separate terminal session. Only the supplied goal/context enters the
  child and only the final summary enters the parent. Children inherit the parent's enabled
  toolsets and credentials/provider configuration, but leaf children cannot delegate, clarify,
  mutate shared memory, send messages, or schedule cron. Refs:
  [delegation guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/delegation.md),
  [delegate implementation](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/tools/delegate_tool.py).
- **Parallel and nested delegation.** Batches default to at most three concurrent children.
  Delegation is flat by default; an `orchestrator` role plus a raised `max_spawn_depth` permits
  recursive child trees. Subagents can use a configured provider/model override. Background
  completion delivery is durable, but executing child threads do not survive process restart; an
  interrupted attempt becomes `unknown`, not replayed. Ref:
  [delegation guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/delegation.md).
- **Durable multi-agent work uses profiles plus Kanban.** Separate from `delegate_task`, Hermes
  Kanban assigns durable SQLite-backed tasks to named profiles. A gateway-hosted dispatcher spawns
  each assignee as a full OS process with that profile's identity and persistent memory; comments
  and task/run rows are the peer handoff protocol. This is the persistent specialist-fleet model,
  while delegated children remain anonymous, hierarchical, and process-lifetime. Ref:
  [Kanban multi-agent profile collaboration](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/kanban.md).
- **Public child lifecycle primitive.** Plugins can use a host-owned
  `SubagentLifecycleService` with launch/status/wait/cancel/result/reconnect and opaque handles.
  It is process-lifetime asynchronous execution, not restart-durable work. Ref:
  [subagent lifecycle API](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/developer-guide/subagent-lifecycle-api.md).
- **Skills are procedural memory and progressive instructions.** The profile-scoped source of
  truth is `HERMES_HOME/skills/`; a compact catalog is offered first, `skill_view` loads a complete
  `SKILL.md`, and support files load on demand. Installed skills also become slash commands. The
  agent can create and update skills, subject to an optional human approval gate. Ref:
  [skills guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/skills.md).
- **Extensions are plural surfaces, not one manifest.** General Python plugins can register tools,
  hooks, commands, CLI commands, and skills. Specialized plugin systems cover gateway platforms,
  memory, context engines, model providers, and media backends. MCP servers contribute external
  tools. User and project plugins are discovered from profile/workspace paths, and arbitrary
  third-party general plugins are opt-in through `plugins.enabled`. Refs:
  [plugin guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/plugins.md),
  [MCP guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/mcp.md),
  [plugin source](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/hermes_cli/plugins.py).

### H-05 — Scheduled automation and wake gate

- **Definition and ownership.** Cron jobs are plain JSON definitions under
  `HERMES_HOME/cron/jobs.json`, with output under `cron/output/` and a separate SQLite execution
  ledger at `cron/executions.db`. The ordinary trigger is hosted by the long-running gateway and
  ticks every 60 seconds; the trigger provider is pluggable, including a first-party managed
  Chronos path for scale-to-zero hosting. Refs:
  [cron guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/cron.md),
  [cron internals](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/developer-guide/cron-internals.md),
  [scheduler source](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/cron/scheduler.py).
- **Fresh run model.** Every agent-backed fire creates a fresh `AIAgent` session with no prior cron
  conversation, optionally injects one or more skills, runs the job prompt, persists output, and
  delivers to configured channels. Cron sessions cannot recursively manage cron. Ref:
  [cron guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/cron.md).
- **Wake gate.** A pre-run script can emit a final JSON line `{"wakeAgent": false}`. The scheduler
  then skips agent construction/inference for that tick; omitted `wakeAgent` defaults to true, and
  a true result can pass structured context into the prompt. This directly matches Ziggy's cheap
  wake-gate concern. Ref:
  [cron `wakeAgent` section](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/cron.md).
- **Zero-agent mode.** `no_agent=True` runs a scheduled script and delivers stdout verbatim. Empty
  stdout or `wakeAgent:false` is silent; non-zero exit/timeout alerts. The script subprocess is
  given a sanitized environment and does not inherit provider credentials. Ref:
  [script-only cron mode](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/cron.md).
- **Preflight token gate.** Before agent construction, scheduler preflight validates provider auth,
  attached skill prerequisites, and delivery configuration. A failed preflight records
  `blocked_config`, emits one alert, and makes no LLM call. Ref:
  [cron pre-dispatch validation](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/cron.md).
- **Run semantics.** Attempts move through `claimed` and `running` to immutable `completed`,
  `failed`, or `unknown`. Restart recovery marks a proven-abandoned attempt unknown and does not
  replay it automatically. A file lock prevents overlapping tick batches. Ref:
  [cron execution history](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/cron.md).
- **Model ownership.** Runtime model resolution is per-job pin, then `cron.model`/
  `cron.model_provider`, then global default. If a job relies on a snapshotted global default and
  that default drifts, the default guard skips inference until the operator deliberately pins or
  opts into tracking. The agent-facing `cronjob` tool cannot change per-job model pins. Ref:
  [cron model resolution](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/cron.md).

### H-06 — Runtime loop, tools, and events

- **Loop primitive.** Internally Hermes normalizes conversation state to OpenAI-style
  `system`/`user`/`assistant`/`tool` messages. Each loop iteration prepares the request, calls the
  selected provider, executes returned tool calls, appends ordered results, and repeats until a
  text response or stop condition. Strict role alternation and tool-call/result pairing are
  explicit invariants. Ref:
  [agent loop docs](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/developer-guide/agent-loop.md).
- **Transport modes.** The default core supports `chat_completions`, `codex_responses`, and
  `anthropic_messages`; provider resolution maps provider/model/auth/base URL into one mode. Some
  newer source paths add specialized transports, but these three remain the documented narrow
  waist for the ordinary loop. Refs:
  [agent loop API modes](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/developer-guide/agent-loop.md),
  [runtime provider resolution](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/developer-guide/provider-runtime.md).
- **Tool primitive.** Built-in tool modules self-register a unique name, toolset, OpenAI function
  schema, handler, optional availability check, and display metadata in a singleton registry.
  Toolset admission happens before schema publication. MCP and plugin tools feed the same dispatch
  surface. Refs:
  [tools runtime](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/developer-guide/tools-runtime.md),
  [tool registry source](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/tools/registry.py),
  [dispatch source](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/model_tools.py).
- **Agent-local tools.** `todo`, `memory`, `session_search`, and `delegate_task` are intercepted by
  `AIAgent` because they need live loop/session state; ordinary registered tools dispatch through
  `model_tools` and the registry. Multiple non-interactive calls may execute concurrently, while
  result ordering is restored to model order. Ref:
  [agent loop tool section](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/developer-guide/agent-loop.md).
- **Events are callback/hook families rather than one typed event stream.** `AIAgent` offers
  progress, thinking, reasoning, clarification, step, streaming-delta, generated-tool, and status
  callbacks for faces. Plugins receive pre/post tool, pre/post LLM, session start/end/finalize/
  reset, subagent stop, and pre-gateway-dispatch hooks. Separate gateway `HOOK.yaml` and shell-hook
  systems expose named gateway events. Refs:
  [agent callbacks](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/developer-guide/agent-loop.md),
  [plugin hooks](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/plugins.md),
  [hooks guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/hooks.md).
- **Interruption.** Model calls are interruptible; user input, `/stop`, or signals can abandon an
  in-flight provider result without injecting a partial assistant message. Top-level background
  subagent completion has separate owner/delivery semantics. Ref:
  [agent loop interruption](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/developer-guide/agent-loop.md).

### H-07 — Provider, model, OpenAI/ChatGPT auth boundaries

- **Configuration authority.** Non-secret provider/model/base-URL settings live in
  `HERMES_HOME/config.yaml`; API keys and other secrets live in `.env`; Hermes-owned OAuth state
  lives in `auth.json`. `hermes model` adds/configures providers and runs auth flows, whereas
  in-session `/model` only switches among already configured choices. Refs:
  [configuration guide](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/configuration.md),
  [provider model commands](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/integrations/providers.md).
- **Shared resolver.** CLI, gateway, cron, ACP, and auxiliary calls use the same runtime provider
  resolver. High-level precedence is explicit runtime request, saved config, environment, then
  provider defaults/auto resolution. The result includes provider, API mode, base URL, key/token,
  source, and refresh metadata. Ref:
  [provider runtime docs](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/developer-guide/provider-runtime.md).
- **Direct OpenAI API path.** Provider `openai-api` uses `OPENAI_API_KEY`; optional
  `OPENAI_BASE_URL` applies only to this provider. Model/provider selection persists in
  `config.yaml`. This is API billing/auth, not ChatGPT subscription auth. Ref:
  [providers: OpenAI API direct](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/integrations/providers.md).
- **ChatGPT subscription path.** Provider `openai-codex` uses a device-code ChatGPT OAuth flow,
  stores Hermes-owned tokens in `HERMES_HOME/auth.json`, can import existing Codex CLI credentials
  from `~/.codex/auth.json`, and uses `codex_responses` against the ChatGPT Codex backend. The
  provider plugin declares that transport/base URL. Refs:
  [Codex provider docs](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/integrations/providers.md),
  [provider plugin](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/plugins/model-providers/openai-codex/__init__.py),
  [auth implementation](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/hermes_cli/auth.py).
- **Do not infer plan economics.** The official docs explicitly leave eligible ChatGPT tiers and
  how usage counts against plan Codex limits undocumented. Authentication support does not prove a
  particular entitlement, quota, or billing treatment. Ref:
  [subscription-plan matrix](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/integrations/providers.md).
- **Optional Codex-owned loop.** `model.openai_runtime: codex_app_server` is an opt-in beta that
  delegates OpenAI/Codex turns and built-in shell/patch/sandbox/MCP execution to a local Codex CLI
  app-server. Default Hermes behavior remains its own `AIAgent` loop using `codex_responses`.
  Refs:
  [Codex app-server runtime](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/codex-app-server-runtime.md),
  [Codex runtime source](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/agent/codex_runtime.py).
- **Separate OAuth sessions in app-server mode.** The Codex subprocess reads Codex's own
  `~/.codex/auth.json`; Hermes' `hermes auth add openai-codex` writes Hermes' `auth.json`. Official
  docs recommend both logins and state that Hermes intentionally avoids sharing refresh state to
  prevent clobbering. The app-server path cannot expose Hermes loop-local `delegate_task`,
  `memory`, `session_search`, or `todo`. Ref:
  [Codex app-server prerequisites and limits](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/codex-app-server-runtime.md).
- **Profile auth isolation has explicit exceptions.** Profile docs advertise separate `.env` and
  auth state, but current auth source can fall back from a profile-local `auth.json` to the global
  Hermes root for providers with no local entry. Host tool subprocesses also see the real user
  `HOME` by default, including `~/.codex` and other CLI auth. Strict per-profile external CLI state
  requires `terminal.home_mode: profile` or an explicit `CODEX_HOME`. Refs:
  [global auth fallback source](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/hermes_cli/auth.py),
  [profile HOME boundary](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/profiles.md),
  [Codex multi-profile section](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/codex-app-server-runtime.md).
- **Auxiliary calls are a separate routing boundary.** By default auxiliary work follows the main
  provider/model, including ChatGPT/Codex subscription auth when selected, but each auxiliary task
  can pin its own provider/model. Cron and subagents have their own override layers as described
  above. Refs:
  [auxiliary configuration](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/configuration.md),
  [Codex auxiliary behavior](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/codex-app-server-runtime.md).

### H-08 — “CLA” concept: unresolved term

No first-party source in the researched tree defines a Hermes concept named or abbreviated
**CLA**. A case-insensitive whole-word search of the official source/docs found no product term,
architecture object, file format, or contributor policy under that acronym. The following nearby
concepts must not be silently collapsed into it:

1. **`CLAUDE.md` compatibility.** Hermes discovers Claude Code context files after
   `.hermes.md`/`HERMES.md` and `AGENTS.md`; that is a context-file compatibility feature, not a
   documented “CLA” abstraction. Ref:
   [context files](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/context-files.md).
2. **Closed learning loop / self-improvement.** Official product language says Hermes has a
   “closed learning loop”: bounded memory, background review, session search, and agent-created or
   improved skills. The docs do not name this “CLA” or “Continuous Learning Architecture/Agent.”
   Refs:
   [README](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/README.md),
   [memory background review](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/memory.md),
   [agent-managed skills](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/website/docs/user-guide/features/skills.md).
3. **Contributor License Agreement.** The repository is MIT-licensed, but neither the contribution
   guide nor repository automation in this snapshot documents a CLA requirement. Absence in this
   snapshot is not proof that Nous has no off-repository legal process. Refs:
   [LICENSE](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/LICENSE),
   [CONTRIBUTING.md](https://github.com/NousResearch/hermes-agent/blob/b3aa561faffd64f05436e429a6415d175e534ec9/CONTRIBUTING.md).

Until “CLA” is expanded by the requester, the only defensible claim is **not found as a canonical
Hermes term**.

## Ziggy parity frame

| Ziggy concern                | Hermes primary-source answer                                                                       | Fit / difference                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Folder as Profile            | `HERMES_HOME`, default `~/.hermes`; named homes under `profiles/`                                  | Strong folder boundary, but mixed human and opaque machine state; profile path is not workspace path.       |
| Visible human-owned identity | `SOUL.md`, project context files                                                                   | Visible, but memory and skills are agent-writable by default; approval is optional.                         |
| Profiles                     | Independent config, keys, memory, sessions, skills, cron, gateway                                  | Broader than Ziggy; auth and external CLI `HOME` have documented sharing/fallback exceptions.               |
| Sessions                     | Canonical SQLite + FTS5 with lineage and all-face source tags                                      | Hermes owns a custom session engine; unlike Ziggy's Pi JSONL authority.                                     |
| Memory                       | Bounded `MEMORY.md` + `USER.md`, external providers, session search                                | Strong facts/history separation, but no Ziggy 1:1/group Markdown admission model in the core docs reviewed. |
| Agents/subagents             | Profiles as independent agents; `delegate_task` fresh children; Kanban for durable profile workers | Rich ephemeral and durable coordination; no source-backed `agents/*.md` specialist registry found.          |
| Extensions                   | Skills, Python plugins, MCP, provider/memory/context/platform plugin families                      | Much broader and more dynamic than Ziggy's explicitly selected Pi packages.                                 |
| Scheduled automation         | JSON jobs, gateway-hosted scheduler, execution ledger, fresh sessions, delivery                    | Direct parity candidate; includes exact `wakeAgent:false` zero-LLM gate and script-only jobs.               |
| Runtime loop/tools/events    | `AIAgent`, registry/toolsets, callbacks and multiple hook systems                                  | Hermes owns the loop and event families; no single client-neutral typed event stream is documented.         |
| Provider/model/auth          | Shared resolver; config/.env/auth split; direct OpenAI API and ChatGPT Codex OAuth are separate    | Strong boundary model, with explicit auxiliary/subagent/cron overrides and app-server caveats.              |
| CLA                          | No canonical term found                                                                            | Preserve as unresolved ambiguity.                                                                           |

## Open questions that primary sources do not settle

- The relationship and intent behind `hermes-agent-org/hermes` are not stated by the candidate or
  by Nous Research. Its own links make Nous canonical, but GitHub does not mark it as a fork.
- The exact ChatGPT plans eligible for Hermes' Codex OAuth path and how usage counts against plan
  quotas are explicitly undocumented.
- “CLA” has no canonical expansion in official Hermes sources.
- The public docs describe a rapidly changing product and `main` is ahead of the latest release;
  installation or parity work should pin either a release tag or an exact commit and re-check the
  corresponding source rather than combining claims across versions.
