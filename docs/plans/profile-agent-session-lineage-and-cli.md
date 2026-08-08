# Profile agent session lineage and complete CLI plan

## Orientation

Ziggy already has the right core parts.

Pi owns models, authentication, agent sessions, tools, and transcripts. Ziggy owns the visible
Profile files and the rules that connect those Pi parts.

This plan fixes two product gaps.

First, every Profile agent run must use a saved Pi session. A Profile agent that is called by an
existing chat must be a saved child of that chat. The parent keeps the call, final result, usage,
and child link. The child keeps its full isolated transcript.

Second, the CLI must expose the parts that already exist. A new operator must be able to create a
ready Profile, select a model, inspect agents and automations, inspect sessions, check health, and
start Ziggy without editing machine-owned files by hand.

The plan does not copy Hermes' runtime. It keeps Pi as the only agent and session authority.

## Settled decisions

### Session ownership

- Every production agent execution uses `SessionManager.create` or another persistent Pi session
  manager.
- Production code does not use `SessionManager.inMemory` for a Profile agent run.
- Tests may use in-memory sessions.
- A direct agent run is a saved root session.
- An agent called by a TUI, gateway, print, or other Pi session is a saved child session.
- Pi JSONL stores the full transcript.
- Ziggy does not copy a transcript into SQLite, Markdown, or another database.
- The parent session stores the `agent_run` call, final result, nested usage, and child session
  reference.
- The child session header stores Pi's `parentSession` path.
- The child transcript does not enter the parent model context.
- Ziggy does not replay an interrupted or crashed child run.

### Profile agent ownership

- `agents/<id>.md` remains the only Profile agent policy authority.
- A Profile agent can narrow its role, model, reasoning level, and tool list.
- A Profile agent does not own another Profile, memory store, auth store, scheduler, or runtime.
- A child cannot call `memory_write`, `agent_run`, or `agent_discuss`.
- A discussion child remains reasoning-only.
- Recursive and background agent trees remain out of scope.

### Face parity

- TUI, one-shot print, gateway chats, and automations use the same Profile agent discovery and
  selection rules.
- A leading `@agent-id` selects one agent.
- The parent model may call `agent_run` when no `@` mention is present and one agent clearly fits.
- The parent model may call `agent_discuss` when two to four views help.
- A face can change presentation. It cannot change agent meaning or policy.

### CLI and init

- `src/main.ts` remains the only production Effect execution edge.
- CLI input is decoded once before application work.
- The CLI uses narrow commands. It does not add a generic configuration editor.
- `ziggy init` becomes guided by default in an interactive terminal.
- `ziggy init --minimal` keeps the current safe `SOUL.md`-only behavior.
- Guided init creates only missing human-owned files and safe empty folders.
- Guided init configures authentication, model, and reasoning through Pi's public APIs.
- Guided init runs the same checks as `ziggy doctor` before it reports success.
- Init never overwrites `SOUL.md`, an agent, an automation, memory, or credentials.
- Init does not create an active default automation.
- Init does not create an opinionated default agent.
- `agents/` and `automations/` are created as empty folders.
- Pi creates sessions and machine state only when those parts are used.

## Scope

This plan includes:

- saved Profile agent child sessions;
- parent and child session links;
- common agent tools and `@` behavior across all faces;
- a direct saved agent run;
- a small CLI parser and stable help;
- version output;
- guided and minimal Profile init;
- model status, list, and selection;
- agent create, list, show, validate, and run;
- automation create, list, and validate;
- session list and metadata inspection;
- Profile doctor checks;
- a delivery-neutral `serve` command over the current resident owner.

This plan excludes:

- a custom agent loop;
- a Ziggy session format;
- a second transcript database;
- transcript search or indexing;
- session deletion or repair;
- resuming a child under the wrong agent policy;
- automatic memory or skill changes;
- recursive agents;
- a background job fleet;
- a daemon attach protocol;
- JSON CLI output until a real scripting need appears;
- gateway or delivery redesign.

## Current gaps

### Child sessions

The TUI saves its main Pi session. Its `agent_run` tool creates the child with
`SessionManager.inMemory` in `src/adapters/pi/specialist.ts`.

The parent therefore saves the tool call and final result. It does not save the full child
transcript.

The explicit `ZiggyAgent.runSpecialist` path creates an in-memory host in
`src/adapters/pi/pi-agent.ts`. The child is also in memory. Tagged automations use this path and
save no Pi transcript for the specialist run.

### Face parity

`createProfileRuntime` only installs agent tools when `includeTuiSpecialists` is true.

The TUI receives:

- the agent catalog;
- `agent_run`;
- `agent_discuss`;
- `@` completion;
- `/agents`.

One-shot print and gateway chats do not receive the same tools. Automations use a separate direct
route for a leading `@agent-id`.

### CLI

`src/main.ts` contains one large switch over raw `process.argv` values.

Unknown first words become Profile names. This means `ziggy --help`, `ziggy help`, and
`ziggy version` try to open Profiles.

There is no model command, top-level agent command, direct automation-definition list, session
command, or doctor command.

### Init

Current init creates `SOUL.md` only. This is safe, but it does not leave the Profile ready to run.
The operator must configure auth and model settings separately. The live Hermes comparison had to
write Ziggy's `settings.json` by hand.

Current init also treats any existing `SOUL.md` path as initialized before it checks that the path
is a regular file. Registry errors are silently ignored.

## Authoritative state

| Fact | Authority | Other stored form |
| --- | --- | --- |
| Profile identity and behavior | `SOUL.md` | None |
| Profile agent policy | `agents/<id>.md` | Parsed value in one runtime |
| Automation definition | `automations/<id>.md` | Scheduler discovery projection only |
| Parent conversation | Parent Pi JSONL | CLI metadata projection only |
| Child agent transcript | Child Pi JSONL | None |
| Parent-to-child relation | Child `parentSession` header and parent tool-result details | CLI session projection |
| Provider auth and models | Pi `ModelRuntime` stores | CLI status projection |
| Default model and reasoning | Pi `SettingsManager` in Profile `settings.json` | CLI status projection |
| Automation run state | Scheduler SQLite | Text status and runs projection |
| Memory facts | Profile Markdown memory files | Prompt injection only |

No fact in this table gets a second writable authority.

## Required invariants

1. A model call cannot start before its persistent Pi session file exists.
2. A nested Profile agent run has one saved parent and one saved child.
3. The child header points to the parent session file.
4. The parent tool result points to the child session ID and file.
5. The parent receives only the bounded result and usage in model context.
6. The child stores its complete Pi message and tool history.
7. Parent cancellation aborts the child.
8. Child cleanup runs after success, failure, or interruption.
9. A saved failed or aborted child remains inspectable.
10. Ziggy never replays a child after process failure.
11. Agent model and tool policy resolves the same way in every face.
12. An invalid or unknown leading `@agent-id` fails before a provider call.
13. Init never changes an existing human-owned file.
14. Read-only CLI commands do not create Profile runtime state.
15. CLI commands never print secrets or transcript content unless a later explicit transcript
    command is designed.

## Target execution flows

### TUI or gateway chooses an agent

```text
user message
→ shared leading-mention validation
→ saved parent Pi session
→ parent model sees the Profile agent catalog and agent_run tool
→ agent_run selects the Profile agent policy
→ create saved child Pi session with parentSession
→ run child with its role, model, reasoning, and tool allowlist
→ save child transcript
→ return final answer, usage, and child reference
→ save parent tool result
→ parent model writes the final reply
```

A leading `@agent-id` adds a strong selection instruction. It does not bypass the parent model.

Without `@`, the parent model can call `agent_run` when the task fits. It can answer directly when
no agent is useful.

### Bounded discussion

```text
saved parent session
→ agent_discuss call
→ create one saved child session for each participant call
→ link every child to the same parent
→ run at most 2 rounds with 2–4 agents
→ save each isolated transcript
→ return a bounded discussion transcript and every child reference
→ parent model writes the synthesis
```

A participant cannot use tools or call another agent.

### Direct CLI agent run

```text
ziggy agents run <profile> <agent> <prompt>
→ validate Profile and agent
→ resolve Profile defaults and agent overrides
→ create one saved root specialist session
→ run the prompt
→ print the final answer
→ leave the session available to sessions list/show
```

This path does not create an empty parent session. The specialist session is the root execution.

### Tagged automation

```text
scheduler or manual wake
→ claim and start the automation run
→ read and validate the automation file
→ pass the wake gate
→ leading @agent-id selects one Profile agent
→ create one fresh saved root specialist session under the automation run path
→ run and save the full transcript
→ print the local result
→ deliver configured targets
→ finish the scheduler run projection
```

An untagged automation creates one fresh saved Profile chat session. That session has the same
agent tools as other faces. Its model may call a saved child agent when useful.

The automation database stores run state. It does not store the transcript.

### Guided init

```text
ziggy init <profile>
→ resolve and inspect the target
→ create missing Profile directory
→ create SOUL.md only when absent
→ create missing agents/ and automations/ folders
→ register the Profile
→ inspect Pi provider auth
→ prompt for provider and login when needed
→ list authenticated Pi models
→ select model and reasoning level
→ persist through Pi SettingsManager and flush
→ run doctor checks
→ print Profile path, selected model, and launch command
```

Running init again resumes missing setup. It does not reset completed setup.

## Target CLI

### Entry and help

```text
ziggy
ziggy <name|path>
ziggy tui [<name|path>]
ziggy help [command]
ziggy --help
ziggy -h
ziggy version
ziggy --version
ziggy -V
```

`ziggy tui` is the unambiguous form. The existing Profile shorthand remains for non-reserved first
words.

### Profile setup

```text
ziggy init <name|path> [--minimal]
ziggy init <name|path> \
  [--provider <id>] [--model <id>] [--thinking <level>] [--non-interactive]
ziggy profiles
ziggy doctor <name|path>
```

Rules:

- Interactive init guides missing choices.
- `--minimal` performs safe file initialization only.
- `--non-interactive` requires enough flags or existing config to finish without prompts.
- A partial Profile remains intact when setup fails.
- Init reports which step failed and the command that resumes it.

### Auth and models

```text
ziggy auth <name|path>
ziggy auth <name|path> <provider> [--type api_key|oauth]
ziggy models status <name|path>
ziggy models list <name|path> [--provider <id>]
ziggy models set <name|path> <provider>/<model> [--thinking <level>]
```

`models status` prints the effective provider, model, reasoning level, and auth state.

`models set` validates the model through Pi. It writes settings through Pi. It flushes before the
command exits.

### Profile agents

```text
ziggy agents create <name|path> <agent-id>
ziggy agents list <name|path>
ziggy agents show <name|path> <agent-id>
ziggy agents validate <name|path> [agent-id]
ziggy agents run <name|path> <agent-id> <prompt...>
```

`agents create` writes a valid minimal file with exclusive creation. It does not overwrite an
existing file. The template inherits the Profile model and has no tools until the user adds them.

`agents show` prints metadata and the Profile-relative path. It does not print the full instruction
body by default because the file itself is the editing surface.

`agents run` creates a saved root Pi session.

### Automations

```text
ziggy automations create <name|path> <automation-id>
ziggy automations list <name|path>
ziggy automations validate <name|path> [automation-id]
ziggy automations status <name|path>
ziggy automations runs <name|path> [automation-id]
ziggy wake <name|path> <automation-id>
```

`automations create` writes a valid manual-only starter file with exclusive creation. It contains a
schedule, timezone, `broadcast: none`, and no gate. The scheduler therefore refuses scheduled model
work until the user adds a gate. The command explains this after creation.

`automations list` reads Markdown files directly. It does not read scheduler status as a substitute.
Each row shows the ID, validity, schedule, and `scheduled` or `manual-only` gate state.

`automations validate` reports every file error in stable path order. It does not run gates or
create scheduler state.

### Sessions

```text
ziggy sessions list <name|path>
ziggy sessions show <name|path> <session-id|relative-path>
```

List output includes:

- Profile-relative path;
- session ID;
- root or child kind;
- created time;
- entry count;
- parent session ID when present;
- child count;
- final state when it can be derived from Pi entries.

Show output includes metadata, model changes, reasoning changes, total usage, parent reference, and
child references. It does not print prompts, replies, thinking, or tool output.

Child resume is not included. A child must not reopen under the wrong Profile agent policy.

### Resident process

```text
ziggy serve <name|path>
ziggy gateway <name|path>
```

`serve` becomes the preferred name. It runs the existing resident Profile owner, scheduler, and any
configured channel loops.

`gateway` remains a compatibility alias during this plan.

## Implementation chunks

### Chunk 1 — Freeze the Profile agent and session contract

**Behavior delivered**

The architecture documents state the parent and child session rule. Profile Agent becomes a named
primitive with clear ownership.

**Files and symbols**

- Update `docs/research/minimal-ziggy-scout.md`.
- Update `docs/plans/primitive-status.md`.
- Update `docs/plans/cli-polish.md` to point to this plan.
- Add a client-neutral `SessionReference` and Profile agent run result in
  `src/domain/agent.ts` if implementation needs shared typed output.

**Boundary**

Pi owns the session file. Ziggy owns the relation policy and visible command meaning.

**Verification**

- Documentation has one session authority.
- The contract does not require a Ziggy transcript format.
- `git diff --check` passes.

**Risk**

A session reference must not become a second session registry. It is only an ID and path projection.

### Chunk 2 — Save nested Profile agent sessions

**Behavior delivered**

Every `agent_run` and discussion participant gets a persistent Pi child session.

**Files and symbols**

- Change `SpecialistParent`, `childRuntime`, `useSpecialistChild`, and
  `SpecialistRunResult` in `src/adapters/pi/specialist.ts`.
- Add one pure child-session-directory helper in `src/adapters/pi/pi-agent.ts` or a focused Pi
  session module.
- Extend `SpecialistToolDetails` and discussion participant details with the child reference.
- Update renderers to show the child session ID in expanded output.
- Update `src/adapters/pi/specialist.test.ts`.
- Update `src/adapters/pi/pi-agent.test.ts` with a real SDK persistence proof.

**Execution path**

The tool reads the parent session ID and file. It creates the child with:

```text
SessionManager.create(profilePath, childDirectory, { parentSession: parentFile })
```

The model call starts only after the child manager is persistent. The child result returns its ID
and file. Pi stores those details in the parent tool result.

**State transition**

```text
no child
→ child session file created
→ child running
→ child completed | failed | aborted
→ parent tool result saved
```

A process crash can leave an incomplete child. The file remains evidence. Ziggy does not replay it.

**Dependencies**

Chunk 1.

**Verification**

- Child session has `isPersisted() === true`.
- Child header `parentSession` equals the parent file.
- Parent tool result contains child ID and path.
- Child transcript contains its user prompt, assistant output, and tool results.
- Parent context contains only the bounded tool result.
- Abort disposes the child and leaves an inspectable session.
- Discussion saves one child for every participant call.

**Risk**

Paths can move with a Profile. Pi already stores absolute `cwd` and parent session paths. Do not add
a second relocation system in this slice.

### Chunk 3 — Remove the in-memory standalone host

**Behavior delivered**

Direct Profile agent runs and tagged automations save one useful root session. They do not create an
empty host plus a hidden child.

**Files and symbols**

- Refactor specialist selection in `src/adapters/pi/specialist.ts` so it accepts a resolved Profile
  execution environment rather than requiring an active parent session.
- Replace `runSpecialist` in `src/adapters/pi/pi-agent.ts` with a persistent root-agent operation.
- Widen `ZiggyAgent.runSpecialist` in `src/application/agent.ts` to accept a session directory or a
  client-neutral run context and return run metadata, not only text.
- Pass automation ID and run identity from `src/application/automations.ts`.
- Update application and adapter tests.

**Execution path**

A nested call gets defaults from its parent session. A direct call gets the same defaults from Pi's
Profile settings and model runtime. Both use one shared selector.

**Dependencies**

Chunk 2.

**Verification**

- A tagged automation creates exactly one saved specialist root session.
- A direct CLI-ready operation creates exactly one saved root session.
- Agent overrides and Profile fallback produce the same model, reasoning, and tools as nested use.
- No production Profile agent path calls `SessionManager.inMemory`.
- Automation SQLite contains no transcript copy.

**Risk**

Do not duplicate Pi's default-model resolution. Use the same Pi services and settings that create a
normal Profile runtime.

### Chunk 4 — Admit Profile agents in every face

**Behavior delivered**

TUI, print, Telegram, Discord, Slack, and untagged automations all receive the same optional agent
catalog and tools.

**Files and symbols**

- Replace `includeTuiSpecialists` and `tuiAgents` in `createProfileRuntime` in
  `src/adapters/pi/pi-agent.ts` with face-neutral agent admission.
- Split common agent guidance from TUI presentation in
  `src/adapters/pi/ziggy-tui-extension.ts`.
- Keep TUI-only autocomplete, `/agents`, header, and footer in the TUI extension.
- Add one shared leading-mention preparation function near
  `parseLeadingProfileAgentMention` in `src/domain/profile.ts`.
- Apply that function in TUI input, `askOnce`, and `ChatHandle.prompt`.
- Update TUI, Pi adapter, gateway, and automation tests.

**Execution path**

The runtime discovers agents once. When none exist, it adds no agent tools and no catalog prompt.
When agents exist, every face receives the same `agent_run` and `agent_discuss` definitions.

**Dependencies**

Chunks 2 and 3.

**Verification**

- A valid leading `@agent-id` works in TUI, one-shot, and every gateway chat handle.
- Unknown and malformed mentions fail before a provider call.
- A prompt without `@` can cause the model to call `agent_run` in print and gateway paths.
- A Profile with no agents adds no specialist tool context.
- Child recursion remains blocked.
- Existing memory scope tests still pass.

**Risk**

Agent catalogs add prompt tokens. Add the catalog only when the Profile has agents. Keep descriptions
short and do not inject full agent bodies into the parent.

### Chunk 5 — Extract CLI decoding and add help/version

**Behavior delivered**

The CLI has one decoded command value, exact arity, stable help, and clear reserved words.

**Files and symbols**

- Add `src/domain/cli.ts` for schemas and a command union.
- Add `src/faces/cli.ts` for argument decoding and help rendering.
- Add `src/faces/cli.test.ts`.
- Reduce the switch and raw argument handling in `src/main.ts`.
- Read version from `package.json` without adding a package or runtime registry.

**Execution path**

```text
process.argv
→ one CLI decoder
→ typed command
→ application service
→ face renderer
```

`BunRuntime.runMain` remains in `src/main.ts`.

**Dependencies**

None. It can land before or after the session chunks, but the later CLI chunks depend on it.

**Verification**

- Every current command keeps its behavior.
- Extra arguments fail instead of being ignored.
- `help`, `--help`, `-h`, `version`, `--version`, and `-V` work.
- `ziggy tui <profile>` works.
- Unknown reserved command shapes fail with help.
- Existing Profile shorthand still works.

**Risk**

A Profile named `help` becomes ambiguous. `ziggy tui help` remains the explicit escape.

### Chunk 6 — Add Pi-backed model operations

**Behavior delivered**

Operators can inspect and select an effective model without editing `settings.json`.

**Files and symbols**

- Add `src/adapters/pi/models.ts` around `ModelRuntime` and `SettingsManager`.
- Add `src/application/models.ts` as an Effect service.
- Add model result and error schemas in `src/domain/agent.ts` only where callers need distinct
  behavior.
- Add `src/faces/models-cli.ts` and focused tests.
- Wire commands in `src/main.ts`.

**Execution path**

The adapter opens Profile-local auth, model, model-store, and settings paths. It validates the model
through Pi. It calls `setDefaultModelAndProvider`, sets reasoning when requested, calls `flush`, and
checks `drainErrors` before success.

**Dependencies**

Chunk 5.

**Verification**

- Status reports the effective provider, model, reasoning, and auth state.
- List shows only Pi-known models and supports a provider filter.
- Set rejects an unknown model or unsupported reasoning level.
- Set writes through `SettingsManager` and flushes before exit.
- No Ziggy model catalog or JSON parser is added.
- No secrets are printed.

**Risk**

A remote model catalog can be stale or unavailable. Report cached availability clearly. Do not
turn catalog refresh into an unbounded init wait.

### Chunk 7 — Add doctor checks

**Behavior delivered**

One read-only command reports whether a Profile can run correctly.

**Files and symbols**

- Add `src/application/doctor.ts`.
- Add `src/domain/doctor.ts` for ordered check results.
- Add `src/faces/doctor-cli.ts` and tests.
- Reuse existing Profile, auth, model, memory, gateway, agent, automation, skill, extension, and
  session validators.

**Checks in stable order**

1. Profile directory and regular `SOUL.md`.
2. Settings decode and effective Pi model.
3. Provider authentication.
4. Profile agent files, model overrides, reasoning, and tool allowlists.
5. Automation files and missing-gate `manual-only` warnings.
6. Memory files and size caps.
7. Selected extension packages and installed skills.
8. Gateway config files that are present.
9. Session directories, readable Pi headers, and broken parent links.
10. Resident runtime directory readability.

**Dependencies**

Chunks 5 and 6. Session checks can start as a shallow filesystem check and use Chunk 10's adapter
when it lands.

**Verification**

- No errors means exit 0.
- Warnings alone mean exit 0.
- Any error means exit 1.
- One failed check does not hide independent later checks.
- The command creates no files or directories.
- Output order is stable.
- Secrets and transcript content never appear.

**Risk**

Doctor must not become a second validator. Each check calls the existing owning decoder or adapter.

### Chunk 8 — Make init produce a ready Profile

**Behavior delivered**

A first-time operator can run init and then open Ziggy successfully.

**Files and symbols**

- Tighten `initProfile` in `src/application/profiles.ts`.
- Add focused init and registry tests in `src/application/profiles.test.ts`.
- Add `src/application/setup.ts` to coordinate Profiles, Auth, Models, and Doctor.
- Add `src/adapters/terminal/setup-interaction.ts` for terminal choices.
- Reuse `src/adapters/terminal/auth-interaction.ts` for provider login.
- Add init rendering and parser tests in `src/faces/cli.test.ts` or a focused init face test.

**Behavior details**

- Verify an existing `SOUL.md` is a regular file.
- Keep exclusive creation and no-overwrite behavior.
- Create `agents/` and `automations/` only when missing.
- Report registry failure instead of silently swallowing it. A valid Profile can remain created.
- Detect existing auth and model settings.
- Ask only for missing setup.
- Support explicit non-interactive provider, model, and reasoning flags.
- Run doctor at the end.
- Print the exact next launch command.

**Dependencies**

Chunks 5, 6, and 7.

**Verification**

- First guided init produces a doctor-clean Profile when login succeeds.
- Second guided init changes no human-owned file bytes.
- `--minimal` preserves the old safe behavior.
- Existing auth and model choices are not reset.
- A directory or symlink at `SOUL.md` fails honestly.
- A failed login leaves a resumable Profile.
- Non-interactive mode never prompts.
- Setup persistence errors fail before init claims readiness.

**Risk**

Interactive setup must not make scripts hang. Prompt only when stdin and stdout are interactive and
`--non-interactive` is absent.

### Chunk 9 — Add Profile agent CLI commands

**Behavior delivered**

Operators can create, inspect, validate, and directly run Profile agents.

**Files and symbols**

- Add `src/application/profile-agents.ts` over `discoverProfileAgents` and the direct agent run.
- Add a safe exclusive-create function in `src/adapters/fs/profile-agents.ts`.
- Add `src/faces/agents-cli.ts` and tests.
- Wire commands through the typed CLI.

**Dependencies**

Chunks 3, 5, and 6.

**Verification**

- Create writes one valid minimal file and refuses overwrite.
- List order is stable.
- Show returns metadata and relative path.
- Validate reports invalid frontmatter, ID, provider/model pairing, reasoning, and tools.
- Run creates one saved root session and prints one final answer.
- Run failure keeps the saved session.

**Risk**

Do not add a second agent registry. The directory scan remains authoritative.

### Chunk 10 — Add automation definition CLI commands

**Behavior delivered**

Operators can create, list, and validate visible automation files without starting the scheduler.

**Files and symbols**

- Move reusable definition enumeration from
  `src/adapters/bun/automation-sqlite.ts` to `src/adapters/fs/automation-files.ts`.
- Add an application catalog operation in `src/application/automations.ts` or a focused
  `automation-definitions.ts` service.
- Extend `src/faces/automation-cli.ts` and its tests.
- Add an exclusive-create helper for the safe manual-only template.

**Dependencies**

Chunk 5.

**Verification**

- Create refuses overwrite and creates no database.
- The starter definition is valid and has no gate.
- Scheduled execution skips the starter before a model call.
- List and validate create no `.runtime` state.
- One invalid file does not hide valid siblings.
- Output labels missing-gate definitions `manual-only`.

**Risk**

Do not infer definition truth from scheduler SQLite. Markdown remains authoritative.

### Chunk 11 — Add session lineage projections

**Status:** Implemented on `impl/sessions-serve`. The adapter intentionally does not call
`SessionManager.open` because Pi v0.82.0 can migrate and rewrite older files, nor `list` because it
is non-recursive and transcript-oriented. Schema decoding and all Pi JSONL inspection remain inside
`src/adapters/pi/sessions.ts`; application and face layers receive typed metadata only.

**Behavior delivered**

Operators can see root and child Pi sessions without reading transcripts.

**Files and symbols**

- Add `src/adapters/pi/sessions.ts` using `SessionManager`.
- Add `src/application/sessions.ts`.
- Add `src/domain/session.ts` for client-neutral metadata projections if needed.
- Add `src/faces/sessions-cli.ts` and tests.
- Extend doctor to use this adapter.

**Execution path**

The Pi adapter recursively finds known Profile session roots. It opens each session through Pi,
reads header and entry metadata, and builds parent and child projections. It never decodes Pi JSONL
in the application or face layer.

**Dependencies**

Chunks 2, 3, and 5.

**Verification**

- Every valid root and child appears once.
- Parent and child links are correct.
- Missing session directories print `no sessions`.
- Malformed or unreadable sessions fail with a typed error.
- List and show create no files.
- Output contains no prompt, reply, thinking, or tool content.
- Total usage includes Pi assistant usage and nested tool usage without double counting.

**Risk**

A recursive filesystem walk must remain bounded by the Profile session tree. Reject symlinked
session roots and files.

### Chunk 12 — Add the `serve` name and finish docs

**Status:** Implemented on `impl/sessions-serve`. `serve` and the compatibility `gateway` command
route to the same `ResidentGateway.run` operation and receive the same interrupt-only clean
teardown at the sole production execution edge.

**Behavior delivered**

The resident command describes scheduling and channels instead of only gateways.

**Files and symbols**

- Route `serve` to `ResidentGateway.run` in `src/main.ts`.
- Keep `gateway` as an alias.
- Apply interrupt-only clean shutdown to both names.
- Update README, help, architecture, primitive status, and `LOG.md`.

**Dependencies**

Chunk 5.

**Verification**

- `serve` starts the scheduler with zero channel configs.
- `serve` starts configured channel branches through the existing owner.
- A second resident still fails through the existing Profile owner lock.
- SIGINT exits cleanly for both `serve` and `gateway`.
- No second daemon or lease is added.

**Risk**

Do not rename the `ResidentGateway` application service during this slice unless the old name causes
a real code problem. Public command clarity does not require an internal migration.

## Verification matrix

| Invariant | Focused proof |
| --- | --- |
| Every nested agent has a saved child | Real Pi SDK test checks child file and `isPersisted()` |
| Parent and child are linked | Child header and parent tool-result details match |
| Child context stays isolated | Parent JSONL lacks child internal messages |
| Cancellation reaches child | Abort test records an aborted child and closes resources |
| No recursive agents | Child active-tool test excludes memory and agent tools |
| All faces share agent policy | TUI, print, chat-handle, and automation tests use one fixture agent |
| Direct agent run is a root | Exactly one saved session and no empty host file |
| Init never overwrites | Before/after hashes for all existing human-owned files |
| Init produces a usable Profile | Guided fixture ends with doctor success and one model probe seam |
| Model writes use Pi | SettingsManager fake/real adapter test and flush proof |
| Definition reads are read-only | Whole Profile tree snapshot before and after list/validate |
| Session reads are read-only | Whole Profile tree snapshot before and after list/show |
| Doctor is read-only | Whole Profile tree snapshot and stable ordered output |
| Resident ownership stays single | Existing owner-lock tests through both command names |

Each chunk runs its focused tests first. Every code chunk then runs:

```sh
bun run check
bun test ./src ./extensions && bun run test:helpers
```

Live provider proof is needed only for the final setup acceptance. Unit and SDK integration tests
must not require real credentials.

## Migration and rollout

No data migration is required.

Existing root Pi sessions remain valid. New child sessions add `parentSession` metadata. Old parent
tool results without child references remain valid historical records.

Session list must show old unlinked sessions as roots or `parent: unknown`. It must not rewrite
them.

Existing Profile agent and automation files remain valid.

Existing `ziggy gateway` scripts keep working. Documentation moves to `ziggy serve` after both names
pass the same tests.

Init remains safe for existing Profiles. Guided setup fills missing machine configuration only.
`--minimal` preserves the old file-only workflow.

Land each chunk as one logical commit. Do not combine the session fix, CLI parser, and init wizard
in one change.

## Observability

The parent tool renderer should show the child session ID in expanded mode.

`ziggy sessions show` should display parent and child links and terminal state. It should not show
transcript text.

Automation run output can add a Profile-relative session reference after the session path is stable.
Do not add transcript or model output to the scheduler database.

Doctor should report broken session links as warnings. An unreadable session file is an error.

## Residual risks

- A process crash can leave an incomplete parent tool call or child session. The record remains
  evidence. This plan does not replay or repair it.
- Pi stores parent session paths. Moving a Profile can make old links stale.
- Adding agent tools to gateways increases prompt size when agents exist.
- Remote model catalogs can be stale during setup.
- A direct child resume needs the original agent policy. This plan does not expose it.
- Empty starter folders are visible on disk but are not tracked by Git unless the user adds files.

## Open decisions

The implementation can start through Chunk 7 without another product decision.

Two setup details can still be changed before Chunk 8:

1. Guided init is the recommended default. The alternative is to keep minimal init as the default
   and require `--setup` for guidance.
2. Empty `agents/` and `automations/` folders are the recommended safe starter content. The
   alternative is one starter agent. An active starter automation is not recommended.

Neither choice changes the session design or the rest of the CLI plan.
