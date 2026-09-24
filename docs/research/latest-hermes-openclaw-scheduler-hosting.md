# Latest Hermes/OpenClaw scheduler hosting

**Checked:** 2026-09-20 UTC. “Latest” means the upstream `main` HEAD observed during this
research, not a release tag.

## Direct answer

| Project | Background-service process | Scheduler-only mode | Web/UI relationship |
|---|---|---|---|
| **Hermes** | `hermes gateway run` hosts the built-in cron ticker, gateway runtime, and configured messaging adapters in one process. | No dedicated scheduler-only service was found. A zero-platform gateway is supported, so cron can run without configured channels. | The normal `hermes dashboard`/web server is a separate process. Its desktop backend has a special local cron ticker when it is not backed by a gateway. |
| **OpenClaw** | `openclaw gateway` hosts the Gateway control plane, channel connections, HTTP/WebSocket/Control UI surfaces, and Gateway cron service in one process. Cron startup is lazy/post-ready, but not a separate OS service. | No scheduler-only daemon was found. `OPENCLAW_SKIP_CHANNELS=1` is a channel-suppressed control-plane/WebChat-only Gateway, not scheduler-only; `OPENCLAW_SKIP_CRON=1` disables cron. | The Control UI and HTTP surfaces use the same Gateway port; they are not a separate web-server service by default. |
| **Ziggy** | `ziggy serve` intentionally hosts the scheduler, UI server, and configured Telegram/Discord/Slack loops together. | No second scheduler process. | This is closest to OpenClaw’s single Gateway host; it differs from Hermes’s optional dashboard split. |

## Exact upstream snapshots and freshness check

- **Hermes:** `NousResearch/hermes-agent` `main` at
  [`30de041b011aa3d3830a7ffa05815e2cb2f063be`](https://github.com/NousResearch/hermes-agent/tree/30de041b011aa3d3830a7ffa05815e2cb2f063be).
- **OpenClaw:** `openclaw/openclaw` `main` at
  [`b15a0a2319f16adfe8b43aa9ccd02273c25d95e5`](https://github.com/openclaw/openclaw/tree/b15a0a2319f16adfe8b43aa9ccd02273c25d95e5).

I used `opensrc fetch NousResearch/hermes-agent` and `opensrc fetch openclaw/openclaw`,
refreshed both cache entries, then compared the relevant cached files byte-for-byte with fresh
`git clone --depth=1` checkouts. The clones matched the upstream `refs/heads/main` values above
(Hermes checked at 01:39:10Z; OpenClaw at 01:37:41Z). Both upstream branches move quickly, so
these pins are the reproducible answer for those observations; “latest” can change after them.

## Hermes findings

The default provider is explicitly an **in-process 60-second ticker**. Provider resolution falls
back to it when a configured external provider is absent or unavailable:
[provider resolution and `InProcessCronScheduler`](https://github.com/NousResearch/hermes-agent/blob/30de041b011aa3d3830a7ffa05815e2cb2f063be/cron/scheduler_provider.py#L363-L422).

Gateway startup creates and starts that scheduler after `GatewayRunner.start()` has started the
configured platform adapters; readiness is only reported after adapters, cron, and housekeeping
are running:
[startup and cron lifecycle](https://github.com/NousResearch/hermes-agent/blob/30de041b011aa3d3830a7ffa05815e2cb2f063be/gateway/run.py#L5301-L5457).
The runner describes itself as starting “all configured platform adapters”
[here](https://github.com/NousResearch/hermes-agent/blob/30de041b011aa3d3830a7ffa05815e2cb2f063be/gateway/run_startup.py#L1420-L1484).
Shutdown stops the scheduler cooperatively in the same gateway process
[here](https://github.com/NousResearch/hermes-agent/blob/30de041b011aa3d3830a7ffa05815e2cb2f063be/gateway/run.py#L5275-L5287).

Hermes explicitly supports a **zero-platform gateway**: its service helper says “cron runs” even
without messaging configuration, and describes the running service as “cron jobs + messaging
platforms” [here](https://github.com/NousResearch/hermes-agent/blob/30de041b011aa3d3830a7ffa05815e2cb2f063be/hermes_cli/gateway.py#L2647-L2692).
That is a gateway with no channels, not a separate `scheduler`/`cron-only` daemon. Hermes can
load an external cron provider, but the gateway still owns execution/delivery wiring; the current
code warns that such a provider fires through this gateway’s loopback `api_server`
[here](https://github.com/NousResearch/hermes-agent/blob/30de041b011aa3d3830a7ffa05815e2cb2f063be/gateway/run.py#L5184-L5243).

The OS service definitions launch **the gateway command**, not a scheduler command: systemd uses
`... hermes_cli.main ... gateway run` with restart policy
[here](https://github.com/NousResearch/hermes-agent/blob/30de041b011aa3d3830a7ffa05815e2cb2f063be/hermes_cli/gateway.py#L2983-L3060), and launchd wraps the gateway arguments with `RunAtLoad`/`KeepAlive`
[here](https://github.com/NousResearch/hermes-agent/blob/30de041b011aa3d3830a7ffa05815e2cb2f063be/hermes_cli/gateway.py#L3952-L4052).

Hermes’s web surface is a separate concern: the CLI documents `hermes dashboard` as a web UI
server [here](https://github.com/NousResearch/hermes-agent/blob/30de041b011aa3d3830a7ffa05815e2cb2f063be/hermes_cli/_parser.py#L120-L122), and `cmd_dashboard` starts `start_server` in that process
[here](https://github.com/NousResearch/hermes-agent/blob/30de041b011aa3d3830a7ffa05815e2cb2f063be/hermes_cli/main.py#L2648-L2695).
There is an important caveat: the desktop dashboard backend is not a gateway, so it starts its
own local ticker and stands down for profiles already owned by a gateway
[here](https://github.com/NousResearch/hermes-agent/blob/30de041b011aa3d3830a7ffa05815e2cb2f063be/hermes_cli/web_server.py#L77-L135).
The headless `hermes serve` backend is also a web-server process, not the gateway
[here](https://github.com/NousResearch/hermes-agent/blob/30de041b011aa3d3830a7ffa05815e2cb2f063be/hermes_cli/web_server.py#L1376-L1397).

## OpenClaw findings

OpenClaw’s official runtime model says there is **one always-on process** for routing, control
plane, and channel connections, with one multiplexed port for WebSocket control/RPC, HTTP APIs,
plugin routes, and Control UI/hooks
[official Gateway runtime model](https://github.com/openclaw/openclaw/blob/b15a0a2319f16adfe8b43aa9ccd02273c25d95e5/docs/gateway/index.md#L67-L75).
Its automation docs call automations the built-in scheduler, which can deliver to a chat channel,
webhook, or nowhere [docs](https://github.com/openclaw/openclaw/blob/b15a0a2319f16adfe8b43aa9ccd02273c25d95e5/docs/automation/cron-jobs.md#L12-L14).

The source makes the process boundary explicit: `server-cron-lazy.ts` builds one cron service per
Gateway process and shares concurrent loads [source](https://github.com/openclaw/openclaw/blob/b15a0a2319f16adfe8b43aa9ccd02273c25d95e5/src/gateway/server-cron-lazy.ts#L35-L90).
Its `start()` invokes the cron service in that process
[here](https://github.com/openclaw/openclaw/blob/b15a0a2319f16adfe8b43aa9ccd02273c25d95e5/src/gateway/server-cron-lazy.ts#L120-L208), and Gateway post-ready startup schedules that same service
[here](https://github.com/openclaw/openclaw/blob/b15a0a2319f16adfe8b43aa9ccd02273c25d95e5/src/gateway/server-runtime-services.ts#L59-L90)
and [here](https://github.com/openclaw/openclaw/blob/b15a0a2319f16adfe8b43aa9ccd02273c25d95e5/src/gateway/server-runtime-services.ts#L112-L166).
Channel startup is in the same post-attach lifecycle
[here](https://github.com/openclaw/openclaw/blob/b15a0a2319f16adfe8b43aa9ccd02273c25d95e5/src/gateway/server-startup-post-attach.ts#L440-L517).

There is no inspected scheduler-only service definition or CLI mode. The supported separation is
coarser: `OPENCLAW_SKIP_CHANNELS=1` skips channel startup/reload for an embedding host that wants
a control-plane or WebChat-only Gateway
[official embedding docs](https://github.com/openclaw/openclaw/blob/b15a0a2319f16adfe8b43aa9ccd02273c25d95e5/docs/gateway/embedding.md#L18-L56).
That does not remove the Gateway process or turn it into a cron-only daemon. Conversely,
`OPENCLAW_SKIP_CRON=1` disables cron in the lazy loader
[here](https://github.com/openclaw/openclaw/blob/b15a0a2319f16adfe8b43aa9ccd02273c25d95e5/src/gateway/server-cron-lazy.ts#L35-L41).

The supervised service is likewise one Gateway service: the official docs describe the macOS
per-user LaunchAgent and Linux systemd user service
[here](https://github.com/openclaw/openclaw/blob/b15a0a2319f16adfe8b43aa9ccd02273c25d95e5/docs/gateway/index.md#L188-L282), while the generated definitions supply launchd `RunAtLoad`/`KeepAlive`
[here](https://github.com/openclaw/openclaw/blob/b15a0a2319f16adfe8b43aa9ccd02273c25d95e5/src/daemon/launchd-plist.ts#L12-L25)
and systemd restart/timeout policy
[here](https://github.com/openclaw/openclaw/blob/b15a0a2319f16adfe8b43aa9ccd02273c25d95e5/src/daemon/systemd-unit.ts#L10-L28).
The generated program-argument resolver builds `gateway --port ...`, not a scheduler executable
[here](https://github.com/openclaw/openclaw/blob/b15a0a2319f16adfe8b43aa9ccd02273c25d95e5/src/daemon/program-args.ts#L228-L245), and the documented unit shows the same Gateway entrypoint
[here](https://github.com/openclaw/openclaw/blob/b15a0a2319f16adfe8b43aa9ccd02273c25d95e5/docs/gateway/index.md#L257-L282).

## Ziggy comparison and limits

Ziggy’s own operational contract says `ziggy serve` is the only production scheduler host and owns
the scheduler plus configured Telegram, Discord, and Slack loops
[`docs/operations/serve.md`](../operations/serve.md#L1-L9). Its resident gateway starts the scheduler,
UI server, and configured channel loops as sibling branches in one Effect scope
[`src/application/resident-gateway.ts`](../../src/application/resident-gateway.ts#L245-L320).

This was static source/docs inspection plus cache freshness verification. I did not install or run
the upstream services, exercise a real channel, or validate an OS manager’s live process tree.
Therefore the conclusion is about the inspected startup wiring and generated service definitions,
not a claim about every downstream package, release build, or locally customized unit.
