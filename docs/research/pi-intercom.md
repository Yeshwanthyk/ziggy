# pi-intercom vs Ziggy discuss / live bots

Date: 2026-08-15

Question: Can Ziggy add [nicobailon/pi-intercom](https://github.com/nicobailon/pi-intercom) so two agents discuss in Slack, gateway, TUI, or a GUI?

Primary sources:

- pi-intercom `0.10.1` on `main`: [README](https://github.com/nicobailon/pi-intercom/blob/main/README.md), [index.ts](https://github.com/nicobailon/pi-intercom/blob/main/index.ts) (`sendIncomingMessage` ~L887–911), [types.ts](https://github.com/nicobailon/pi-intercom/blob/main/types.ts), [broker/](https://github.com/nicobailon/pi-intercom/tree/main/broker), [package.json](https://github.com/nicobailon/pi-intercom/blob/main/package.json)
- [pi-messenger](https://github.com/nicobailon/pi-messenger) (file-based shared room; contrast only)
- Ziggy `agent_discuss`: `src/adapters/pi/specialist.ts` (`runDiscussion`, `createAgentDiscussTool`)
- Ziggy chat runtime: `src/adapters/pi/pi-agent.ts` (`bindChatRuntime` `mode: "print"`, `noExtensions: true` + `additionalExtensionPaths`)
- Extension install: `src/adapters/fs/profile-extensions.ts` (shelf ID selects the package; `package.json.name` is independent upstream metadata), `src/adapters/pi/resources.ts`
- Settled chat plan: `docs/plans/shared-chat-handle.md`

## Verdict

Two different products. Do not merge them.

| Want | Ziggy today | Add? |
| --- | --- | --- |
| Two **specialists** in **one** Slack/Discord/Telegram/TUI/GUI chat | `agent_discuss` (parent calls it; human sees **one** parent reply) | Already there when the Profile has `agents/<id>.md` |
| Two **live sessions** (two TUIs, or two GUI bots) talking 1:1 | No | Yes, but not by copying the Unix-socket broker into `serve` |
| Two Slack bot users arguing in one thread | No | Product choice; not what intercom does |

## How pi-intercom works

It is a Pi package (`pi.extensions: ["./index.ts"]`) plus a **machine-local broker process**. Each loaded session registers over a Unix socket (`~/.pi/agent/intercom/broker.sock`, or `$PI_CODING_AGENT_DIR/intercom`). Tools: `intercom` (`list` / `send` / `ask` / `reply` / …); TUI overlay `/intercom` and Alt+M.

Inbound delivery ([index.ts `sendIncomingMessage`](https://github.com/nicobailon/pi-intercom/blob/main/index.ts)):

```ts
pi.sendMessage(
  { customType: "intercom_message", content: "…", display: true, details },
  trigger ? { triggerTurn: true } : { deliverAs: "steer" },
);
```

- Idle → new turn (`triggerTurn: true`) when `inboundTrigger` is `"always"` (default).
- Busy **interactive** → steer; does not abort.
- Busy **non-interactive** (`!hasUI`) → inbound dropped (auto-reply that the peer cannot respond).
- `ask` wait is **client-side**, not a broker RPC. Default timeout 10 minutes. One waiter per session.
- Persistence is each session's Pi JSONL (extension entries). Broker mailbox is RAM only.

Same machine only. Not Slack. Overlay is TUI-only (`mode !== "tui"` no-ops).

## How Ziggy `agent_discuss` works

In-process. Same Profile. Parent tool `agent_discuss` runs 2–4 `agents/<id>.md` children, 1–2 sequential rounds, `allowedTools: []`. Parent synthesizes. Children cannot recurse. Registered whenever `createProfileRuntime` sees `agents.length > 0` (`pi-agent.ts` customTools). Gateways do not strip tools.

| Face | Discuss? |
| --- | --- |
| TUI, Slack, Discord, Telegram, print/`askOnce`, untagged automation (`openChat`) | Yes |
| Future in-process GUI on `openChat` | Yes |
| Tagged automation `@agent-id`, CLI `agents run` | No — no parent session |

The human on Slack sees Squarey (or whoever) reply once. TUI can expand the tool result to read labeled specialist answers. Gateways never post those as two bot identities.

## Fit on Ziggy faces

`openChat` binds extensions with `mode: "print"` (`bindChatRuntime`). Busy print sessions match pi-intercom's `!hasUI` path: inbound is dropped, not steered. Idle gateway chats might still `triggerTurn` via `pi.sendMessage` — unproven, and it would bypass Ziggy's per-`chatKey` semaphore and Slack working-message UX.

Copying npm `pi-intercom` into a Profile is **not** a drop-in:

- Ziggy loads selected `<profile>/extensions/<id>/` by shelf ID; `package.json.name` may remain the upstream name `pi-intercom`. It is not in the catalog; `extensions add` will not fetch npm.
- `noExtensions: true` only blocks ambient `~/.pi` discovery. Admitted packages still load on TUI **and** gateways via `additionalExtensionPaths`.
- Overlay / Alt+M / `/intercom` are TUI-only. Gateways could get the `intercom` **tool** after a forked manifest.
- Broker state is `~/.pi/agent/intercom` via `PI_CODING_AGENT_DIR` / home, **not** Ziggy `agentDir: profilePath`. Two Profiles share one broker. Package-local state should live under `<profile>/.runtime/<id>/`.

## What to add (if we add it)

Keep `agent_discuss` for “two views in this chat.”

Do **not** copy pi-intercom’s Unix-socket broker into `serve`. That is a second process writing sessions Ziggy already owns (Hermes-style race). Do not attach GUI/TUI to `sessions/slack/…`.

For live 1:1 inside one `ziggy serve` (GUI rail, two local chats, later TUI join):

1. **`LiveChatRegistry`** — gateways already hold `Map<chatKey, ChatHandle>`; unify and register `sessions/local/…` too.
2. **`peerSend`** — `prompt` if idle, `steer` / `followUp` / wait-on-semaphore if busy.
3. Later: `listPeers`, `peerAsk` (timeout, one waiter), a protected tool, recursion guard.

Cross-Profile live still waits on the serve socket packet, or stays `ziggy run <other-profile>`. One serve is one Profile today.

Two separate TUI processes (no serve join): that is pi-intercom’s job, only after a **fork** (`@ziggy/pi-intercom` + Profile-scoped broker dir). Treat Slack as send-only until print inbound is designed.

Visible multi-agent **room** (human + two voices in one overlay) is [pi-messenger](https://github.com/nicobailon/pi-messenger), not intercom. Porting that onto Slack would be a new face, not an extension install.

Open product questions: Slack one bot token vs two identities; inbound as user turn vs ephemeral vs extension entry; busy wait vs steer.
