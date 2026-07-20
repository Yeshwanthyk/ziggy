# Per-turn context anatomy and memory — synthesis

This is the research the user explicitly required before any ziggy design writing began: how much
context gets sent per turn in comparable systems, what's stable vs. volatile, how memory gets
written, and how idle/scheduled runs avoid burning tokens. It grounds D16 (per-turn context
design) and D3 (memory), and is the primary evidence for "ziggy is going to ensure no token waste."

Date: 2026-07-19
Sources: hermes-agent (`agent/prompt_builder.py`, `tools/memory_tool.py`, `cron/scheduler.py`,
`hermes_cli/config.py`) and openclaw (`src/agents/system-prompt.ts`,
`packages/ai/src/utils/system-prompt-cache-boundary.ts`, `src/cron/heartbeat-policy.ts`) — same
local paths as `docs/research/openclaw-hermes.md`.

## 1. Hermes: three-tier prompt, session-start freeze

Hermes' prompt builder (`agent/prompt_builder.py`) assembles a system prompt from ordered
sections: persona (`SOUL.md`), project context (single-winner priority chain, "only ONE project
context type is loaded", line 2000), then memory sections. The load-bearing design property is
**freeze at session start**: the persona/memory/project-context snapshot embedded in the system
prompt is fixed for the life of the session's prompt-cache lineage — writes to `MEMORY.md`/
`USER.md` land on disk immediately (so they're durable and visible to the _next_ session or a
concurrent reader), but the _current_ session's already-built system prompt does not re-read them
mid-session. This is what makes prompt caching (`cacheRetention`/provider-side prefix caching)
actually work: a stable prefix means repeated turns reuse the cached prefix instead of paying
full-prompt cost every turn. Ziggy's own "frozen snapshot at session start" memory design (D3) is
this exact mechanism, generalized: SOUL.md/MEMORY.md/USER.md are read once when a Session starts,
baked into that session's stable prefix, and only refresh at the next session boundary.

Freshness/date markers are kept coarse (date-only, not timestamp-precision) specifically so they
don't churn the stable prefix on every turn within a day — a timestamp-precision marker would
invalidate the cached prefix every single turn.

## 2. Hermes: memory caps and write-time enforcement

Confirmed exact constants (`hermes_cli/config.py:2292-2293`, `tools/memory_tool.py:130,804-805`):

```python
memory_char_limit = 2200   # ~800 tokens at 2.75 chars/token
user_char_limit = 1375     # ~500 tokens at 2.75 chars/token
```

Two files, two caps — `MEMORY.md`-equivalent (retained facts/notes) and `USER.md`-equivalent (user
profile), directly mirrored in ziggy's D3. The memory tool's own docstring states the contract at
the point of failure (`memory_tool.py:1080`): _"IF FULL: an add is rejected with the current
entries shown. Reissue as ONE batch that ..."_ — writes that would overflow the cap are **rejected
outright**, not silently truncated, and the model is shown current contents so it can consolidate.
Batched writes are all-or-nothing (line 514: "a single poisoned op rejects the whole batch").
`add`/`replace`/`remove` are the three operations (lines 388, 457) — one tool, three verbs, exactly
ziggy's single memory tool design.

**Why rejection, not truncation, matters**: truncation silently drops data at an arbitrary byte
boundary with no record that anything was lost. Rejection forces the write to fail loudly, in a
way the model (and, on inspection, a human) can see and correct — the file's contents are always
exactly what was explicitly, successfully written, never a silently mangled tail-cut. This is the
single most load-bearing memory-design lesson ziggy takes from hermes, and it's why D3 is worded as
"hard character caps enforced by rejection at write time," not "hard character caps with
truncation."

## 3. Hermes: wake-gate mechanism — the token-waste eliminator

`cron/scheduler.py` implements the wake-gate hermes borrowed from "nanoclaw #1232" (source
comment, `_parse_wake_gate` docstring). Mechanism, read directly from source:

```python
def _parse_wake_gate(script_output: str) -> bool:
    """... if the last stdout line is JSON like {"wakeAgent": false}, the agent
    is skipped entirely — no LLM run, no delivery. Any other output (non-JSON,
    missing flag, gate absent, or wakeAgent: true) means wake the agent normally."""
    if not script_output:
        return True
    stripped_lines = [line for line in script_output.splitlines() if line.strip()]
    if not stripped_lines:
        return True
    last_line = stripped_lines[-1].strip()
    try:
        gate = json.loads(last_line)
    except (json.JSONDecodeError, ValueError):
        return True
    if not isinstance(gate, dict):
        return True
    return gate.get("wakeAgent", True) is not False
```

Two call sites, both **before** the LLM path is even constructed:

1. **`no_agent` jobs** (script-only, no LLM at all): the wake-gate check happens "BEFORE importing
   run_agent / constructing SessionDB so a pure-script tick never pays for the agent machinery it
   isn't going to use" (source comment, lines 2682-2687). If the gate returns false, the run is
   recorded as silent (`SILENT_MARKER`, no delivery) — this is a genuine $0-LLM-tokens tick.
2. **LLM-path jobs with a pre-check script**: the wake-gate script runs "BEFORE building the prompt
   so a `{"wakeAgent": false}` response can short-circuit the whole agent run" (comment, lines
   2858-2860) — again, before `AIAgent`/`SessionDB` construction, before any prompt assembly, before
   any model call. A false gate produces a silent doc and skips straight to "agent skipped."

This is precisely the mechanism behind ziggy's D10 (no heartbeat) and the user's explicit
requirement ("hermes waitGate for automations... ziggy is going to ensure no token waste"): a cheap
subprocess pre-check, not the LLM itself, decides whether an automation tick is worth an LLM call
at all. Ziggy's automations (S5) adopt this exactly — a `wake-gate` command in the automation's
frontmatter, checked before the daemon spends anything on model context assembly or a provider
call.

## 4. OpenClaw: two-tier context + post-call heartbeat suppression (contrast, not a match)

OpenClaw's `CONTEXT_FILE_ORDER` + `SYSTEM_PROMPT_CACHE_BOUNDARY` (see
`docs/research/openclaw-hermes.md` §2) is the same stable/volatile split idea as hermes, done via
an explicit marker string rather than a session-start freeze. `heartbeat.md` is deliberately kept
out of the stable prefix (`DYNAMIC_CONTEXT_FILE_BASENAMES`).

OpenClaw's heartbeat gate is architecturally different from hermes' wake-gate, and this difference
is important to name precisely: **`src/cron/heartbeat-policy.ts`'s `shouldSkipHeartbeatOnlyDelivery`
runs _after_ the LLM call**, not before. It inspects the _delivery payloads the model already
produced_ and decides whether they're heartbeat-only acknowledgement noise worth suppressing from
the user (`hasOutboundReplyContent`, `stripHeartbeatToken`) — the model still ran, tokens were still
spent, only the _delivery_ (not the LLM call) is skipped. This is a **post-call suppression**, not
a **pre-call gate**. It solves a different problem (don't spam the user with "heartbeat OK"
messages) than hermes' wake-gate solves (don't spend tokens on ticks that don't need attention).

This distinction is exactly why ziggy adopts hermes' model, not openclaw's, for D10: openclaw's
heartbeat design still implies a recurring LLM invocation per tick (an "always-on heartbeat" the
user explicitly rejected — "i dont want heartbeat... i also like hermes waitGate for automations").
Hermes' wake-gate is the one that actually achieves zero-token idle cost; openclaw's is a UX
politeness filter on top of a design that still calls the model on schedule.

## 5. Memory write paths: tool-driven (both) vs. compaction-triggered flush (neither, confirmed absent)

Both systems' primary memory write path is **tool-driven**: the model itself decides to call the
memory tool (`add`/`replace`/`remove` in hermes) mid-conversation, based on what the user said —
this is the mechanism the user asked for verbatim ("memory automatically saves with tool based on
what the user is saying"). No evidence was found in either codebase's memory-tool source of an
automatic pre-compaction "flush working memory to long-term storage" step comparable to a
dreaming/consolidation pipeline running as a scheduled or compaction-triggered job — hermes' memory
writes are exclusively synchronous, in-turn tool calls with the reject-at-cap contract above. Ziggy
should not assume such a mechanism exists to borrow from; D3's single in-turn memory tool is the
whole write path, matching both systems' actual (not aspirational) behavior.

## 6. Token-overhead comparison and ziggy's target

Reference-system fixed per-turn overhead is dominated by tool-schema size, not by
persona/memory/context file content — hermes' memory caps alone (2200 + 1375 chars ≈ 800 + 500
tokens) are a small fraction of typical 8,000-20,000 token stable-prefix totals in mature systems
carrying 40+ tool definitions (openclaw and hermes both ship large built-in tool catalogs: shell,
file edit, web fetch/search, skill invocation, memory, scheduling/cron management, gateway/channel
tools, and more, each with a JSON-schema definition that becomes part of every single request).

Ziggy's target (D16): **1,000-3,000 token fixed overhead**, achieved primarily by _keeping the
toolset itself small and static_ — not by being cleverer about compressing persona/memory content,
which is already cheap. A small number of core tools (memory add/replace/remove, extension/skill
invocation, basic session control) plus manifest-declared extension tools that are only included in
a given session's schema set when that extension is actually enabled, keeps the fixed tool-schema
cost near the low end of what hermes/openclaw carry unconditionally on every request.

## 7. Ziggy synthesis (what D16 and D3 actually encode)

- **Stable prefix**: static tool schemas (small, enabled-extensions-only) + frozen SOUL.md/
  MEMORY.md/USER.md snapshot taken at session start + date-only (not timestamp) freshness markers.
  Structural freeze (a snapshot object built once), not a marker-string scan — openclaw's
  boundary-marker approach is unnecessary when the split is enforced by how the prompt gets built,
  not by post-hoc string splitting.
- **Volatile suffix**: conversation history/compaction and anything that genuinely changes every
  turn.
- **Memory**: file-based, `MEMORY.md` + `USER.md` at v1, hard character caps, single
  `add/replace/remove` tool, rejection-at-write-time (never truncation), frozen snapshot per
  session (writes hit disk immediately; the _prompt string_ only refreshes at the next session
  boundary).
- **No heartbeat**: automations use hermes' pre-call wake-gate (cheap subprocess check, JSON
  `{"wakeAgent": false}` on its last stdout line skips the entire run before any model context is
  assembled or any provider call is made) — not openclaw's post-call delivery-suppression model,
  which still pays for an LLM call every tick.
