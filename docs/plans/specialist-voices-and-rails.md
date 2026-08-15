# Specialist voices and GUI rails

Gateway chat stays one bot. The parent already has `agent_run` and `agent_discuss`. If someone asks for a review, the model should call `agent_run` on `reviewer` when that file exists. Slack `@` will not complete specialist names. That is settled.

What is missing: you cannot **see** the specialist speak on Slack, and a Bot Mode GUI cannot **open** a specialist as its own local chat.

`ChatHandle` already exists. This packet uses it. It does not build Electron, a serve socket, or a second Slack app.

Research: `docs/research/openclaw-hermes-mention-autocomplete.md`. Substrate: `docs/plans/shared-chat-handle.md`.

## Terms

| Word | Meaning |
| --- | --- |
| **Bot** | One Profile folder (`SOUL.md`). |
| **Specialist** | `agents/<id>.md` inside that bot. |
| **Voice** | A labeled post from the same bot user: `**reviewer:** …`. |
| **Rail** | One local `ChatHandle` for one specialist. Session: `sessions/local/agents/<id>/`. |

## Orientation

Keep files as the source of specialists. Keep live turns in one `serve`. Keep Slack, Discord, Telegram, TUI, and a later GUI on `ChatHandle`. Do not attach a GUI to `sessions/slack/…`.

Gateway addressing is model-guided. The system prompt already lists specialists and tells the parent to `agent_run` when one matches. Leading `@agent-id` stays a TUI hint only. Do not add Slack slash or native `@` pickers in this packet.

Visible talk is a face concern. `agent_discuss` already has each participant's answer before the parent synthesizes. Post those answers as they finish. Then the parent may still wrap up.

A GUI rail is a different session, not a mention. List specialists with `ProfileAgents.list`. Open one with specialist policy (model, tools, body) under `sessions/local/agents/<id>/`. Continue that folder. Never a fresh UUID per turn (that is `ziggy agents run`).

## Settled decisions

- No Slack/Discord native `@` autocomplete. No extra Slack apps.
- Gateway pull-in = existing `agent_run` / `agent_discuss`, by sense of the ask.
- Same bot user posts voices. Labels in the text.
- Discuss: show each turn in order. Not only a hidden parent summary.
- GUI: one rail per specialist, local sessions only.
- Child specialists still cannot use `memory_write`, `agent_run`, or `agent_discuss`.
- One `serve` process. Per-chat serialize, not global.
- Automations stay files + `wake`.

## Scope

In:

- `ChatEvent` voice
- Emit voice from `agent_discuss` (each participant) and `agent_run` (the child answer)
- Slack, then Discord and Telegram, post those voices
- `openSpecialistChat` + list for a later GUI
- Prompt guidance only if the current text does not say “match the ask to a specialist”

Out:

- Slack slash `/reviewer`
- Native `@reviewer` picker
- Bot Mode GUI / Electron / serve socket
- Cross-Profile live bus
- Changing `sessions/slack/` layout
- Making `ziggy agents run` continue a rail (it stays one-shot UUID)

## Target flow

```text
Gateway
  user: "review this plan"
  parent → agent_run(reviewer, …)
  face posts **reviewer:** <child answer>     # as soon as the child settles
  parent may post a short wrap

  user: "discuss this with reviewer and writer"
  parent → agent_discuss(…)
  face posts **reviewer:** … then **writer:** … as each finishes
  parent may post a wrap

GUI (later, in-process or next socket packet)
  ProfileAgents.list → rails
  openSpecialistChat(reviewer)
    → ChatHandle on sessions/local/agents/reviewer/
    → prompt / abort / subscribe
```

## Vertical slices

Each slice is demoable. Ship in order.

### Slice 1 — See discuss turns on Slack

**Delivers:** “Discuss this with reviewer and writer” posts `**reviewer:** …` then `**writer:** …` in the Slack thread as each child finishes. Same bot. Parent turn still completes after.

**Where:** `ChatEvent` in `src/application/agent.ts` (`kind: "voice"`, `agentId`, `text`). Projector in `src/adapters/pi/pi-agent.ts`. `runDiscussion` in `src/adapters/pi/specialist.ts` notifies after each participant. Slack `onProgress` / subscribe in `src/application/slack-gateway.ts` posts one labeled message per voice. Do not put voices only on the thinking-steps card.

**Depends on:** shipped `ChatHandle`.

**Proof:** Slack thread (or gateway test with a fake handle) shows two labeled posts in order, then the parent string. `agent_discuss` JSONL children unchanged.

**Risk:** Double-post if the parent quotes the same answers. Guidance: parent wrap should not paste the full child text again. Tool result to the model stays as today so the parent can wrap.

### Slice 2 — See one specialist on Slack

**Delivers:** “Review this plan” (and a `reviewer` specialist exists) posts `**reviewer:** …` when `agent_run` finishes. Same voice event as slice 1.

**Where:** `createAgentRunTool` in `src/adapters/pi/specialist.ts`. Optional one-line tighten of `agentPromptGuidance` in `src/adapters/pi/ziggy-tui-extension.ts` (and the same string used for gateway runtimes in `createProfileRuntime`): match the ask to a listed specialist; do not wait for `@`.

**Depends on:** slice 1.

**Proof:** Prompt that clearly matches a specialist description produces a voice post with that id. Unknown or unmatched asks do not invent an id. Leading `@reviewer` still works in TUI; Slack does not need it.

**Risk:** The model may skip `agent_run`. That is already today’s contract (model-guided). Do not add a hard router in this packet.

### Slice 3 — Discord and Telegram voices

**Delivers:** Same labeled posts on the other gateways.

**Where:** `src/application/discord-gateway.ts`, `src/application/gateway.ts`. Reuse the Slack label format. Discord still strips mention-able `@` in model text; labels are `**id:**`, not `<@user>`.

**Depends on:** slice 1 (slice 2 comes along for free).

**Proof:** One discuss on Discord or Telegram shows voices in order.

**Risk:** Rate limits if a four-agent two-round discuss posts eight messages. Keep today’s 2–4 agents and 1–2 rounds.

### Slice 4 — Specialist rails for Bot Mode

**Delivers:** A GUI (or test) can list specialists and open one as a local `ChatHandle`. Chat continues in `sessions/local/agents/<id>/`. Policy comes from `agents/<id>.md`. Blocked tools stay blocked. Not a Slack folder.

**Where:** `ZiggyAgentApi.openSpecialistChat` in `src/application/agent.ts`; implement next to `openChat` / `runSpecialist` in `src/adapters/pi/pi-agent.ts` using `selectSpecialist`. List stays `ProfileAgents.list`. Session directory: `join(profilePath, "sessions", "local", "agents", id)`. `ChatContext` local. `sessionMode: "continue"`.

**Depends on:** shipped `ChatHandle`. Independent of slices 1–3. Can start in parallel after slice 1 is specified, but do not block voices on rails.

**Proof:** `openSpecialistChat` + `prompt` writes JSONL under `sessions/local/agents/<id>/`. A second prompt continues that folder. `openChat` without a specialist id still uses `sessions/local/main/` (or today’s local path). Slack path unchanged.

**Risk:** Two handles on the same specialist folder from two processes. Same rule as parent local chat: only `serve` (or one TUI) owns the live turn. Out-of-process GUI still needs the later socket packet.

## Verification

| Claim | How |
| --- | --- |
| Discuss voices appear in order | Slack (or gateway) test: two voice events, then settled |
| Review-by-sense can show a voice | `agent_run` success emits one voice; no voice on tool error |
| Discord/Telegram same labels | One discuss path per gateway |
| Rails are local and durable | Session files under `sessions/local/agents/<id>/` |
| Slack sessions untouched | No writes under `sessions/slack/` from rails |
| Children still fenced | Existing specialist tool-block tests |

## Rollout

Ship slice 1+2 together on Squarey Slack. Restart `serve`. Slice 3 same week. Slice 4 can land without a GUI: tests + `ProfileAgents.list` are enough for the next GUI packet.

No Profile file migration. Existing `agents/<id>.md` files are the catalog.

## Risks

- Parent wrap plus voices can feel noisy. If it does, a later slice can silence the wrap; do not do that first.
- Voice text must be the child answer, not the tool call preview.
- `onProgress` today is `assistant-text | tool`. Add `voice` there or subscribe; do not invent a second Slack callback style.

## Open decisions (do not block slice 1)

- After voices, keep a parent wrap (default: yes, short) or skip it when every participant already posted.
- Exact label markup (`**reviewer:**` vs `reviewer:`). Pick one in slice 1 and reuse.
- Socket dialect for an out-of-process GUI (next packet, same as shared ChatHandle).
- Whether TUI should also print voices inline (TUI can already expand the tool). Out unless it is free.
