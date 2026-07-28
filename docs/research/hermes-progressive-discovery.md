# Hermes progressive discovery at `3af7b867`

Read-only source report for the Hermes Agent checkout at
`/tmp/hermes-agent-latest.ZdILQP/hermes-agent`, exact commit
`3af7b867fdc18f170209cd82a6236c095d559184`. Paths and line numbers below are
relative to that checkout.

## Executive finding

Hermes has two distinct progressive-disclosure systems:

1. **Skills are instruction documents.** A compact, categorized catalog of
   names and short descriptions is placed in the system prompt. The model loads
   a matching `SKILL.md` through `skill_view`, then optionally loads referenced
   files through the same tool. Users can also force a skill into a turn with a
   slash command or preload it for the whole session. Skills do not become new
   callable functions. Refs: `tools/skills_tool.py:1-67`;
   `agent/prompt_builder.py:1514-1537,1713-1765`.
2. **Tools are callable schemas plus handlers.** Core Hermes tools stay eager.
   Every available MCP tool and non-core plugin tool is replaced by the fixed
   `tool_search`, `tool_describe`, and `tool_call` bridge whenever tool search
   is not disabled. The bridge catalog is rebuilt from the current,
   session-scoped tool definitions rather than retained as session state. Refs:
   `tools/tool_search.py:1-35,202-248,770-840`;
   `model_tools.py:1130-1209`.

Plugins/extensions are packaging and registration mechanisms, not a third kind
of model capability. A plugin can contribute a qualified skill such as
`plugin:skill`, a registered tool, or both. Plugin skills go through
`skill_view`; non-core plugin tools go behind the tool bridge. MCP resources and
prompts are exposed, when supported and enabled, as ordinary generated utility
tools and therefore also participate in tool disclosure. Refs:
`tools/skills_tool.py:854-958,961-1020`;
`tools/mcp_tool.py:5383-5405,5559-5599`.

## Skills: catalog, trigger, preload, and load

### Catalog metadata

`~/.hermes/skills/` is the profile-scoped source of truth. Hermes also scans
configured external directories, with the local copy winning name collisions.
An active skill is a directory containing `SKILL.md`; nested
`references/`, `templates/`, `assets/`, and `scripts/` are explicitly excluded
from active discovery and remain load-on-demand data. Refs:
`tools/skills_tool.py:139-158,669-777`;
`agent/skill_utils.py:517-525,809-820`.

The public `skills_list` surface returns only name, description, and category.
Its scanner reads at most the first 4,000 characters of each `SKILL.md`, parses
frontmatter, derives a body description if necessary, caps the list description
at 1,024 characters, sorts results, and does not probe credentials or terminal
backends while listing. A missing credential does not hide a skill. Refs:
`tools/skills_tool.py:161-164,669-790,813-848`;
`tests/tools/test_skills_tool.py:826-884`.

The system-prompt catalog is more compact than `skills_list`: its description
cap is 60 characters. It groups skills by category and can demote selected
categories to names-only, but intentionally keeps every offered skill name
visible. The prompt tells the model to scan the catalog before replying and
load any relevant entry with `skill_view`. It is only attached when the
session actually has a skills tool. Refs:
`agent/skill_utils.py:782-806`;
`agent/prompt_builder.py:1691-1711,1713-1765`;
`agent/system_prompt.py:299-329`.

Skill offer-time admission is contextual:

- `platforms` is a hard OS compatibility gate for the prompt index,
  `skills_list`, slash commands, and `skill_view`.
- `environments` is an offer-time relevance filter for known contexts such as
  Kanban, Docker, and s6. Explicit `skill_view` and `--skills` loads bypass
  this relevance filter.
- `fallback_for_tools` / `fallback_for_toolsets` hides a fallback when its
  primary capability exists; `requires_tools` / `requires_toolsets` hides a
  skill when its dependency is absent.
- global and per-platform disabled lists remove a skill from offer surfaces
  and also block explicit local loading and preloading.

Refs: `agent/skill_utils.py:210-222,225-322,616-620`;
`agent/prompt_builder.py:1441-1495,1545-1589`;
`tools/skills_tool.py:643-666,1268-1290`;
`agent/skill_commands.py:743-806`.

### Three load paths

**Model-selected load.** The catalog instructs the model to call
`skill_view(name)`. The tool validates that the name is relative and
non-traversing, resolves local, external, or qualified plugin skills, reads the
entire `SKILL.md`, returns full content and metadata, and lists supporting files.
`skill_view(name, file_path)` reads a specific support file only after both
`..` rejection and a resolved-path-within-skill check. There is deliberately no
offset/limit pagination. Refs: `tools/skills_tool.py:179-203,961-1020`;
`tools/skills_tool.py:1221-1402,1404-1474`.

**Manual turn trigger.** Every discovered skill becomes a slash command.
`build_skill_invocation_message` loads the payload, records usage, and inserts a
user-message scaffold stating that the user invoked the skill and that its full
content is active. Hermes can stack up to five leading slash skills in one
turn. Refs: `agent/skill_commands.py:565-609,612-740`.

**Session preload.** CLI `--skills` and `HERMES_TUI_SKILLS` call
`build_preloaded_skills_prompt`, which loads each non-disabled skill and appends
the resulting instruction block to the system prompt for the session. Partial
misses degrade gracefully; if every requested skill is missing, startup fails
loudly. Refs: `agent/skill_commands.py:743-808`;
`cli.py:16862-16906`; `tui_gateway/server.py:5701-5730`.

All three paths ultimately use the same payload rendering. It can substitute
declared config values, optionally expand inline shell, exposes the absolute
skill directory, surfaces setup status, and enumerates linked files. Refs:
`agent/skill_commands.py:267-367`.

## Skill readiness and secret setup

Credential requirements are metadata, not discovery admission. New
`required_environment_variables` and legacy `prerequisites.env_vars` normalize
to the same structure. On `skill_view`, Hermes checks the profile `.env`,
optionally invokes a secure capture callback, then returns the skill even when
setup was skipped or remains incomplete. The result includes
`readiness_status`, missing environment variables and credential files, and a
setup note. Refs: `tools/skills_tool.py:206-221,336-405`;
`tools/skills_tool.py:1483-1506,1564-1621`;
`tests/tools/test_skills_tool.py:586-678,886-1018`.

Available declared environment variables are registered for passthrough to
terminal and `execute_code` sandboxes. Credential files are separately
registered for remote sandbox mounting. Remote backends receive an explicit
warning that requirements must exist inside that environment too. Messaging
surfaces do not solicit secrets in ordinary chat when secure capture is
unavailable; they direct setup to the local CLI or profile `.env`. Refs:
`tools/skills_tool.py:1508-1547,1618-1621`;
`website/docs/user-guide/features/skills.md:249-279`.

This keeps the catalog truthful: “the workflow exists” and “the workflow is
ready to run here” are different facts.

## Tool assembly and progressive dispatch

### Registration and availability

Built-in tool modules self-register schema, handler, toolset, optional
`check_fn`, and runtime metadata in the central registry. MCP startup discovers
servers, applies per-server include/exclude filters, converts each schema,
rejects collisions with built-ins, and registers tools under `mcp-{server}`.
Non-core plugin tools use the same registry. Refs:
`tools/registry.py:1-15,67-84,365-457`;
`tools/mcp_tool.py:5491-5557,5602-5610,5767-5813`.

Availability is decided before progressive disclosure. `get_definitions`
includes only tools whose `check_fn` succeeds. Probe results have a 30-second
TTL; a fresh failure within 60 seconds of a success is treated as transient and
re-probed rather than immediately stripping the capability. This matters for
Docker, browser, and other externally probed toolsets. Refs:
`tools/registry.py:119-214,530-577`.

`model_tools.get_tool_definitions` then applies enabled/disabled toolsets,
availability, dynamic schema overrides, and schema sanitization. Its quiet-path
cache key includes toolset scope, registry generation, config file
mtime/size, Kanban/delegation context, and whether raw pre-bridge definitions
were requested. The tool-search transformation is the final assembly step.
Refs: `model_tools.py:288-364,539-586`.

### Classification and thresholds

Core names from `_HERMES_CORE_TOOLS` and unclassifiable tools remain directly
visible. Registered MCP and other non-core registered tools are deferrable.
Bridge names are reserved and cannot recursively defer. Refs:
`tools/tool_search.py:189-248`; `toolsets.py:1-49`.

Source behavior at this commit is:

- `enabled: off`: no bridge; all available tools stay eager.
- `enabled: auto` or `on`: one or more deferrable tools always activates the
  bridge. The old schema-size threshold no longer controls activation.
- `threshold_pct` controls the embedded listing budget:
  `min(context_length * threshold_pct / 100, listing_max_tokens)`.
- Defaults are 5%, 20,000 listing tokens, five search hits, and a maximum of
  20 hits. Numeric limits are clamped; malformed config fails to defaults.

Refs: `tools/tool_search.py:73-153,273-310`.

The docs call Tool Search “opt-in,” but the implementation defaults missing
config to `enabled="auto"` and activates for any deferrable tool. At this
commit, source behavior is therefore default-on whenever MCP/non-core plugin
tools are available. Compare
`website/docs/user-guide/features/tool-search.md:13-16` with
`tools/tool_search.py:108-126,273-293`.

### Listing tiers and prompt cost

Hermes first tries a deterministic grouped manifest containing each deferred
tool name and a first-sentence description clipped to about 60 characters. If
that exceeds budget it tries names-only. If that still exceeds budget, it
collapses the largest server groups first so small co-attached servers retain
their names; the final fallback is one server name and tool count per group. If
even summaries do not fit, only the three bridge schemas remain. Sorting makes
the bridge description byte-stable for an unchanged catalog. Refs:
`tools/tool_search.py:478-623`.

The assembly labels full, names-only, and mixed forms as tier 1; server-summary
or no-listing forms are tier 2. Core schemas plus three bridge schemas are sent
to the model. Because the tool count and listing live in the `tool_search`
description, changing the deferred catalog changes the tools-array prefix.
Refs: `tools/tool_search.py:626-745,753-840`.

This trades schema tokens for runtime turns:

- exact names in the manifest let the model skip search and call
  `tool_describe`;
- otherwise the intended path is search, describe, then call;
- `tool_describe` content lands in conversation history, not the stable system
  prefix;
- cold deferred tools cost one or two additional model round trips;
- any tools-array edit can invalidate provider prompt caching.

Refs: `tools/tool_search.py:646-683,862-914`;
`website/docs/user-guide/features/tool-search.md:95-121,126-147`.

### Search, describe, and call

The catalog indexes normalized tool name, description, and top-level parameter
names. `tool_search` ranks with BM25 and falls back to literal name substring
matching when BM25 yields no positive score. Search descriptions are capped at
400 characters; requested result counts are clamped to config. Refs:
`tools/tool_search.py:341-356,373-470,852-886`.

`tool_describe` returns the exact description and parameter object only if the
name is both deferrable and present in the current scoped definitions.
`tool_call` parses an object or JSON-string argument payload, rejects bridge
recursion and eager/core names, and checks required-key presence against the
registered schema. A blind call missing required keys returns the schema and
does not invoke the tool. Refs:
`tools/tool_search.py:889-914,937-1022`.

`model_tools.handle_function_call` rebuilds the raw catalog with the session's
enabled and disabled toolsets. Search and describe are pure catalog reads. Call
is defense-in-depth checked against that scoped set, probe-validated, then
recursively dispatched under the underlying name. Consequently request
middleware, plugin block/approval hooks, ACP edit approval, dispatch timing,
result normalization, and post hooks see the real tool. The concurrent and
serial executor paths also unwrap before checkpoints, guardrails, UI activity,
and dispatch, while preserving the model-emitted bridge call in the transcript.
Refs: `model_tools.py:1084-1209,1211-1293`;
`agent/tool_executor.py:246-292,416-475,1135-1185`.

## Caching, reload, and change detection

Skills use three related caches:

- `skills_list` holds a 30-second in-process scan cache keyed by directory and
  immediate-category mtimes, disabled set, and platform. The TTL bounds stale
  in-place edits that do not change directory mtimes.
- the system-prompt skill index has an eight-entry in-process LRU keyed by
  directories, tool/toolset availability, platform, disabled set, and compact
  categories;
- a disk snapshot survives restarts and is accepted only when a recursive
  `SKILL.md`/`DESCRIPTION.md` mtime-and-size manifest still matches.

Refs: `tools/skills_tool.py:90-136,680-713`;
`agent/prompt_builder.py:1320-1404,1514-1566`.

`/reload-skills` rescans slash-command discovery and reports added, removed, and
unchanged names. It deliberately does **not** invalidate the current
system-prompt snapshot: runtime name-based invocation works immediately, while
preserving prefix caching. This means a newly added skill can be manually
invoked in the current session even if the already-built catalog prompt does
not advertise it until a fresh prompt/session. Refs:
`agent/skill_commands.py:481-543`;
`tests/agent/test_skill_commands_reload.py:78-108,139-159`.

The tool catalog itself is intentionally stateless and rebuilt from current raw
definitions on each uncached assembly. Registry mutation increments a
generation counter, which invalidates `get_tool_definitions` cache keys and the
executor's session-scope cache. Config mtime/size catches dynamic configuration
changes without per-writer hooks. Refs:
`tools/registry.py:217-239,365-457,459-524`;
`model_tools.py:312-364`; `agent/tool_executor.py:257-292`.

MCP `notifications/tools/list_changed` schedules a background refresh, protected
by a per-server lock. It paginates the fresh list, deregisters only removed
names, replaces unchanged entries in place, and logs the diff. Prompt and
resource change notifications are currently ignored. Long-lived agents need an
additional snapshot refresh because they retain `agent.tools`; the shared
refresh helper re-derives the scoped set, preserves post-build memory/context
engine tools, rejects stale generation races, and atomically swaps tools and
valid names. Refs: `tools/mcp_tool.py:2032-2141,5980-6136`.

## Security and admission boundaries

Skills have separate install-time and load-time defenses:

- external Hub bundles are written to quarantine, scanned across their files,
  and admitted by source trust plus verdict. Community skills with any finding
  are blocked unless forced; trusted sources allow caution but not dangerous
  results. Installed provenance, content hash, scanner information, and files
  are recorded.
- bundle and install paths are normalized; traversal, unsafe lock paths, and
  symlinks are rejected.
- `skill_view` rejects absolute/traversing skill names and support paths. Its
  lightweight injection-pattern check logs a warning but still serves already
  installed content; this is detection, not a load-time block.

Refs: `tools/skills_guard.py:1-23,35-67`;
`tools/skills_hub.py:3563-3670`;
`tools/skills_tool.py:179-203,1233-1260,1292-1319`.

Tool admission is likewise layered:

- the registry rejects accidental plugin/MCP shadowing of built-ins and
  requires explicit operator opt-in for a plugin override;
- MCP include/exclude filters constrain what is registered;
- suspicious MCP descriptions are warning-scanned rather than blocked to avoid
  false-positive outages;
- session toolset scoping is enforced both when building the catalog and again
  immediately before dispatch;
- the unwrapped underlying call still traverses the normal middleware,
  approval, guardrail, and hook pipeline.

Refs: `tools/registry.py:365-457`;
`tools/mcp_tool.py:539-584,5508-5555`;
`model_tools.py:1143-1209,1231-1293`.

## Test and live-test evidence

The checked-in regression suite covers tier 0/1/2 assembly, per-server
degradation, deterministic listings, bridge integration, core-tool retention,
restricted-session catalog and dispatch scoping, missing-required-argument
schema probes, skill secret capture, platform filtering, and cache-preserving
skill reload. Representative anchors:
`tests/tools/test_tool_search.py:245-358,446-629,638-839`;
`tests/tools/test_skills_tool.py:586-678,763-884,886-1018`;
`tests/agent/test_skill_commands_reload.py:66-159`.

I could not execute those tests in this checkout: neither `.venv` nor `venv`
exists and the available system Python has no `pytest` module. No dependency
installation or network call was attempted.

The repository also contains a real-model harness and checked-in benchmark
artifacts. The harness records bridge calls, underlying calls, result, latency,
and errors across obvious, paraphrased, chained, mixed core/deferred, and
no-tool scenarios. Refs: `scripts/LIVETEST_README.md:1-45`.

The checked-in Unreal benchmark summary reports:

- at the smaller “editor” scale, eager, bare bridge, and listing all completed
  12/12 runs; eager averaged 116,979 input tokens, bridge 146,979, and listing
  163,663;
- at the “full” scale, eager completed 8/8 at 810,578 input tokens, bridge
  16/16 at 160,844, and listing 16/16 at 257,264.

Refs: `mcp-research-data/ue_bench_summary.json:1-49`.

These are checked-in prior live results, not a fresh reproduction, and the run
counts differ by mode. They support the narrow claim that progressive
disclosure can substantially reduce schema cost at very large catalogs while
preserving success in that harness. They do not prove universal model quality.
The adversarial row files also show individual misses, reinforcing that search
query quality and catalog wording remain model-dependent:
`mcp-research-data/ue_hard_rows.json`;
`mcp-research-data/ue_hard_haiku_rows.json`.

## Improvements visible in this source snapshot

This reference checkout is a one-commit shallow graft: `.git/shallow` contains
only `3af7b867…`, and `git rev-list --count HEAD` is `1`. Therefore no
before/after chronology can honestly be reconstructed from its local git
history. The current source and regression comments do prove that the snapshot
contains these newer hardenings:

- July 2026 tiered disclosure now activates for any deferred capability, keeps
  a compact catalog visible when possible, and degrades oversized servers
  independently. Refs: `tools/tool_search.py:12-29,273-310,543-623`.
- restricted sessions can no longer search or invoke tools outside their
  enabled toolsets; the regression test documents the former global-registry
  escape and the fix. Refs:
  `tests/tools/test_tool_search.py:511-629`;
  `model_tools.py:1147-1187`.
- blind deferred calls missing required arguments now return the schema instead
  of failing opaquely downstream. Refs:
  `tools/tool_search.py:937-989`;
  `tests/tools/test_tool_search.py:744-839`.
- skill discovery gained profile-aware paths, bounded scan caching, a
  persistent prompt metadata snapshot, contextual offer filters, secure
  setup-on-load, and cache-preserving manual reload. Refs:
  `tools/skills_tool.py:90-158,669-777`;
  `agent/prompt_builder.py:1320-1404,1514-1566`;
  `agent/skill_commands.py:481-543`.
- dynamic MCP refresh now avoids nuke-and-replace races and live-agent snapshot
  refresh uses registry generations plus atomic publication. Refs:
  `tools/mcp_tool.py:2075-2141,6017-6136`.

Those are source-proven properties of the latest snapshot, but their merge
dates and authoring commits require a non-shallow history and are not claimed
here.

## Narrow lesson for Ziggy/Pi

The transferable lesson is not “copy Hermes’ bridge.” It is to keep
**instruction discovery** and **callable capability discovery** separate, and
to make both derive from the same already-admitted, session-scoped runtime
truth.

For Ziggy/Pi, that means any future progressive layer should preserve Pi as the
owner of the agent loop and tool execution. Ziggy’s useful policy contribution
would be limited to a stable, compact capability index plus explicit loading,
with no session-global catalog that can drift from Pi’s live tool set. If the
available set changes, rebuild only at a safe turn boundary and keep the direct
execution path’s approvals, hooks, and tool identity intact.
