# Cloudflare-hosted Ziggy: feasibility synthesis

Question: can we use Cloudflare Durable Objects (or other Cloudflare primitives) to run Ziggy profiles?

Answer in one line: **the pi/Ziggy agent loop cannot run inside a Worker or Durable Object — but Cloudflare is very useful *around* Ziggy**, and the only way to run the real runtime on Cloudflare's network is Cloudflare Containers (beta) or a hybrid DO-gateway design.

Sources: `docs/research/cloudflare-platform-constraints.md`, `docs/research/bun-on-cloudflare.md`, `docs/research/pi-runtime-requirements.md`, and the ziggy runtime-surface inventory (subagent reports, Aug 2025). All platform facts verified against official docs with per-claim URLs in the source docs.

## Why the agent loop itself cannot move to workerd

Three stacked walls, each fatal on its own:

1. **No Bun on workerd.** `bun build` targets are `browser|bun|node` only; the `--target=cloudflare` PR was closed unmerged. Cloudflare has officially declined Bun as a Workers runtime (Kenton Varda, workerd#1160; workers-sdk#5621). workerd runs V8 isolates; there is no `bun_compat` layer, only `nodejs_compat`.
2. **No subprocesses, ever.** workerd cannot spawn child processes or load native code. Pi's bash/grep/find tools use `node:child_process` + `cross-spawn`; the TUI uses **native `.node` addons** (`@earendil-works/pi-tui` darwin-modifiers / win32-console-mode prebuilds); extensions install via `npm install` spawns. A coding agent without process execution isn't a coding agent.
3. **File identity is the product.** Ziggy's core invariant is "Profile path is identity" — plain visible files on a real POSIX FS: atomic `rename`, `wx` writes, `O_NOFOLLOW` symlink rejection, fsync'd session JSONL, `bun:sqlite` memory locks fenced by `process.pid`. workerd's `node:fs` is a per-request in-memory VFS (read-only `/bundle`, ephemeral `/tmp`, counted against 128 MB). There is no mapping to R2/KV/D1 for these semantics — you'd be rebuilding the Profile model, not running it.

Additional limits if the loop did live on a DO: 128 MB/isolate, 30 s CPU per wake (5 min ceiling), hookless idle eviction (10–140 s), 15-min outbound-connection lifetime, single-threaded serial execution, no raw TTY (TUI face impossible), no `process.pid` fencing, no launchd/systemd resident management, no binary self-update.

## What Cloudflare CAN do for Ziggy (ascending effort)

### 1. Models: AI Gateway / Workers AI — works today, zero code
Pi supports arbitrary OpenAI-compatible endpoints via `~/.pi/agent/models.json` (`baseUrl` + `api: "openai-completions"`). Point a Profile at an AI Gateway URL and get: one URL across many providers, caching, rate limiting, spend analytics, timeouts. Pure configuration, no Ziggy changes. This is the immediate win.

### 2. Reach: Cloudflare Tunnel to a local/on-prem `ziggy serve`
`ziggy serve` is the resident Profile owner (channels + scheduler). Tunnel gives it a stable public URL without port forwarding, so Telegram/Discord webhooks and a remote TUI can reach a Profile running on any machine (or a Container). No code changes.

### 3. Compute: Cloudflare Containers (beta) — the only "run Ziggy on CF" path
The standalone build (`bun build --compile`, `dist/ziggy`) is a real executable; the official Containers base image ships Bun. A Container gives real Bun, real FS, real spawn — the whole runtime moves as-is. Gaps: beta status, container lifecycle/persistence story (state must live on a mounted volume or sync to R2), per-GiB-hour cost, 4 vCPU/12 GiB sizing. This is lift-and-shift, not Durable Objects.

### 4. Persistence/availability: R2 as the Profile's durable home
Profile = a directory of plain files; sessions are append-only JSONL. A Ziggy-owned sync primitive (a small face/service) can push/pull a Profile directory to R2: backup, restore, multi-machine sync, disaster recovery. R2 (5 TiB/object, no egress) is a natural object home for sessions. This keeps "files are the assistant" while adding cloud durability. A future containerized `serve` can mount from R2.

### 5. Connectivity: Durable Objects as the always-on session anchor (hybrid design)
This is the interesting DO use: the client (TUI/web UI) opens a WebSocket to a DO; the DO **hibernates while idle** (no GB-s billing, auto-pong) and acts as the stable connection anchor across client disconnects and device switches. On a message, the DO wakes (30 s CPU budget resets per message) and forwards the prompt to the real Ziggy process — local machine over Tunnel, or a Container — streaming the reply back. Ziggy already has the client-neutral core (`agent.run`, `sessions`, resident gateway); a WebSocket face is a new face in the existing architecture (faces → application → domain), and `agent.openTui`/`runPrintMode` already separate interaction from loop. What a DO cannot do is hold the loop itself; it's a relay/anchor, not a runtime.

### 6. Scheduling: DO Alarms / Cron Triggers instead of the local Effect-forever loop
Automations could be woken by Cron (1-min granularity) or a durable alarm rather than a resident process — but only once the execution target is reachable (local/Container), and the wake-gate (`/bin/sh -c` spawn) still needs a process host.

## The gaps, ranked

1. **No Bun on workerd** — the runtime itself can't deploy to Workers/DOs; only Containers runs Bun.
2. **No subprocesses/native code on workerd** — bash tool, git, tar, extension installs, TUI native addons all impossible; a full serverless agent loop would require rewriting pi's execution model (i.e. a different product).
3. **File semantics vs workerd VFS** — Profile identity, atomic Profile writes, symlink rejection, session JSONL integrity: no R2/KV/D1 equivalent.
4. **Resource ceilings** — 128 MB, 30 s CPU/wake, 15-min outbound cap, single-threaded: long agent turns, large transcripts, and parallel tool calls exceed DO envelopes.
5. **Local-process concepts** — `process.pid` fencing, launchd/systemd residency, `$bunfs` asset materialization, binary self-update: all inherently local.
6. **TTY** — pi's TUI (raw mode + native addons) cannot move; only a proxied/web TUI over a DO-anchored WebSocket.

## Verdict

- **Run Ziggy profiles on a DO: no.** The loop is process-bound (Bun, subprocesses, real FS, TTY).
- **Run Ziggy on Cloudflare at all: only via Containers (beta).**
- **Use Cloudflare around Ziggy: yes, and the good stuff is cheap.** AI Gateway as the model endpoint (today, zero code), Tunnel for reach, R2 for Profile durability/sync, DOs as idle-cost-free WebSocket anchors for remote/always-on access, Cron/Alarms to wake automations.
- The honest architecture if "always-on, remote, zero local daemon" is the goal: **local/Container `ziggy serve` + Tunnel + DO WebSocket anchor + R2-backed Profile sync + AI Gateway for models**. Every primitive has a job; none of them has to run the agent loop.

## Follow-up (2026-08-15): WASM is a dead end; `@cloudflare/computer` is the promising path

### Can we "WASM it"? No — confirmed from three independent angles

- **Bun → WASM** (`can-bun-be-wasm.md`): no `bun build` wasm target (`CompileTarget.zig`
  hard-rejects wasm), no WASI build of the runtime exists or is planned, and a JavaScriptCore
  port is a multi-year project no one has attempted. Even a hypothetical port loses spawn,
  real fs, `bun:sqlite`, native addons, TLS, threads.
- **Node → WASI** (`node-on-wasi.md`): no official node-wasi build; community builds run
  interpreter-only V8 with no `child_process`, no sockets (undici/fetch cannot work — the
  agent could not reach a model provider), no native addons, no raw `tty`.
- **WASI on Workers** (`wasm-wasi-on-workers.md`): experimental JS glue (`workers-wasi`),
  preview 1 only; `sock_*`/`poll_oneoff` are ENOSYS, no spawn syscall, ephemeral in-memory
  littlefs, no native ABI, 128 MB total budget, single-threaded, no runtime compilation.

The blockers were never a compilation problem — they are **capability** problems (subprocesses,
sockets, real fs, native addons, TTY), and WASM on every relevant host (especially workerd)
does not provide them. What WASM does buy: nothing for deploying Ziggy; only pure-compute
leaf modules, which are already portable TypeScript.

### `@cloudflare/computer` — the first real "run it in the cloud" primitive (preview)

Announced 2026-08-03 (Agents Week), early preview, "NOT suitable for production"
(`cloudflare-computer.md`). Architecture: a **Durable Object owns the source-of-truth VFS in
SQLite** (~10 GB/workspace); pluggable exec backends; the **container backend** runs a real
Linux container (`computerd` daemon, FUSE mount of the workspace at `/workspace`, full
userland: real binaries, network, subprocess exec). This is the first Cloudflare primitive
that can hold Ziggy's *execution* slice: bake the compiled `ziggy` binary into the image,
the workspace becomes the Profile directory, and one-shot agent turns (`ziggy run`-style)
run with real subprocesses against a durable store.

Hard caveats for Ziggy (preview status aside):

| Ziggy need | On Computer today |
| --- | --- |
| One-shot turns with spawn (`ziggy run`) | ✅ `runtime.exec` with kill/getExec-by-ID |
| Durable Profile files / session JSONL | ✅ DO SQLite, survives restarts (FUSE ~2× slower, 10 GB cap) |
| `bun:sqlite` stores | ❌ container copy is ephemeral; DO SQLite is a different engine |
| Resident `serve` + Discord/Slack WS | ❌ containers sleep after 10 min idle (sleep = stop, SIGTERM→15 min→SIGKILL); no run-duration guarantee |
| Long-lived inbound connections | ⚠️ only via a Worker fronting the DO; no TCP/UDP to the container |
| Hibernation / durability reconciliation | ❌ designed, "still to ship" (`server.accept()`, not `ctx.acceptWebSocket()`) |

### Updated verdict

- **WASM: no path.**
- **Computer/Containers: the execution path is now real for request-scoped turns.** The
  agent loop still needs a process host; Computer's container backend is the first
  CF-native host that gives the loop spawn + network + durable files. But a *resident*
  always-on `serve` (Discord/Slack WS, scheduler) does not survive container sleep, and
  the TUI remains impossible anywhere serverless (no TTY → proxied/web TUI over the DO anchor).
- Recommended target: **DO-owned durable Profile workspace + container backend for
  `ziggy run`-style turns; local/Tunnel `serve` for always-on channels; web-TUI face over
  the DO anchor; AI Gateway as the model endpoint.** Revisit when Computer ships hibernation,
  durability reconciliation, and a daemon/`startProcess`-style API (Sandboxes has one; Computer
  does not).
