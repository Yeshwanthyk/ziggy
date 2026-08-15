# Cloudflare Computer (@cloudflare/computer): capabilities, limits, and fit for running a Bun agent runtime

Research date: 2026-08-15. All claims verified against primary sources; every section carries URLs. Complements
`docs/research/cloudflare-hosted-ziggy.md` (Aug 2025) and `docs/research/cloudflare-platform-constraints.md`.

## TL;DR verdict

**No — @cloudflare/computer cannot run ziggy as-is, and it is not the right primitive for that job.**

Cloudflare Computer is a *preview-stage open-source agent-runtime library*: a durable, SQLite-backed virtual
filesystem living inside a Durable Object, plus pluggable execution backends (full-Linux container, Worker shell,
Worker JavaScript). It is **not** a "run my existing service" platform. It is an *on-demand exec surface for agents*
whose container is a transient sandbox that is stopped when idle, has an ephemeral disk, cannot be reached inbound
from end users, and whose host DO cannot yet hibernate. ziggy's load-bearing requirements — resident `serve`
process, hours-long outbound WebSockets to Discord/Slack, real POSIX files with `process.pid`-fenced `bun:sqlite`,
`Bun.spawn`/`node:child_process` subprocess trees — conflict with every one of those lifecycle facts.

Also correct the premise: **the announcement is 2026-08-03 (Agents Week), not "late 2025"** — see §1. Cloudflare
Containers (the layer Computer builds on) went GA 2026-04-13; the earlier "computer for agents" product is
**Cloudflare Sandboxes** (`@cloudflare/sandbox`, GA 2026-04-13), which is a *different* package.

---

## 1. What is Cloudflare Computer exactly? Status, date, and relationship to "Cloudflare Containers"

**Definition (from the announcement blog):** an "early preview" of `@cloudflare/computer`, "an agent runtime where
the details and mechanics of what code runs in an isolate, a container sandbox, or a web browser are handled by the
platform. Each agent gets a computer, the runtime optimizes for efficiency, and scalability."
— https://blog.cloudflare.com/cloudflare-computer/

From the GitHub README, the precise shape: "Cloudflare Computer is a virtual filesystem that lives inside a Durable
Object. The Durable Object holds the authoritative state in SQLite and exposes one pluggable execution surface
through `workspace.runtime`." — https://github.com/cloudflare/computer

**Status:** early preview / open-source experiment, explicitly NOT production-ready. The repo README and the npm
package both carry: "**PREVIEW ONLY** … APIs are unstable and the design is subject to change. Suitable for
experiments, exploration and prototypes. It is NOT suitable for production use at this time."
— https://github.com/cloudflare/computer ; https://www.npmjs.com/package/@cloudflare/computer

**Announced:** 2026-08-03 during Cloudflare Agents Week (announcement blog + changelog both dated 2026-08-03).
— https://developers.cloudflare.com/changelog/post/2026-08-03-cloudflare-computer/ ; npm publish timeline confirms:
placeholder `0.0.0` on 2026-07-29, `0.1.0` on 2026-08-03, latest `0.2.0` on 2026-08-11
— https://registry.npmjs.org/@cloudflare/computer

**Relationship to "Cloudflare Containers" — NOT a rebrand; a separate, higher layer that optionally uses Containers:**

- **Cloudflare Containers** is the underlying compute platform: your Dockerfile-built Linux image runs in a Linux VM,
  managed by a Durable Object, fronted by a Worker. It shipped in **public beta 2025-06-24** and went **GA 2026-04-13**.
  — https://blog.cloudflare.com/containers-are-available-in-public-beta-for-simple-global-and-programmable/ ;
  https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/
- **@cloudflare/computer** is an agent-runtime *library* (preview) that wraps the "harness in a DO + attached
  container as a tool" architecture Cloudflare itself uses: "From day one, Cloudflare's architecture has been
  designed to run the agent harness in the isolate (in a Durable Object) and call an attached container on-demand
  as a tool." — https://blog.cloudflare.com/cloudflare-computer/
- Containers are **optional** for Computer: only the `container-shell` backend needs one. The other two backends
  (Worker shell via just-bash, Worker JavaScript via Dynamic Workers) run with no container at all.
  — https://github.com/cloudflare/computer/blob/main/packages/computer/README.md
- **Do not confuse it with Cloudflare Sandboxes either.** Sandboxes (`@cloudflare/sandbox`) is a separate, GA'd
  "computer for agents" SDK *also* built on Containers (exec/gitClone/writeFile, PTY, code interpreters, background
  processes + preview URLs, file watching, R2 snapshots) — GA 2026-04-13. The two are different packages and are not
  documented as wrapping each other. — https://blog.cloudflare.com/sandbox-ga/ ; https://developers.cloudflare.com/sandbox/

So the three-layer stack is: **Containers (GA platform) → Sandboxes (GA agent-computer product) and
@cloudflare/computer (preview agent-computer library)**, both sitting on Containers, and Computer adding the
durable DO-backed workspace as its defining feature.

## 2. What can you run on it?

- **Isolate backends (no container):** `just-bash` shell translation in a Dynamic Worker, or ECMAScript modules in a
  fresh Dynamic Worker. Not arbitrary OS binaries — text/file/JS workloads only.
  — https://github.com/cloudflare/computer ; https://github.com/cloudflare/computer/blob/main/packages/computer/README.md
- **Container backend:** a *full Linux environment* — "real binaries, `npm`, `node`, network" — via Cloudflare
  Containers. The image is yours: the repo's canonical images are `debian:stable-slim` + the `computerd` daemon +
  Node 22 from NodeSource (their `examples/container/Dockerfile` and `examples/think/Dockerfile`).
  — https://github.com/cloudflare/computer/blob/main/examples/container/Dockerfile ;
  https://github.com/cloudflare/computer/blob/main/packages/computer/README.md
- **Arbitrary Docker images / OS:** the underlying Containers platform accepts any image that "must be able to run on
  the `linux/amd64` architecture, but aside from that, has few limitations" (image referenced as a Dockerfile or a
  registry reference; Docker builds the image locally on deploy).
  — https://developers.cloudflare.com/containers/get-started/
- **Precompiled Bun standalone (`bun build --compile`):** nothing prohibits it at the *image* level — a compiled Bun
  binary is just a `linux/amd64` binary you can `COPY` into your image and run. But see the execution-model caveat in
  §7: in Computer's container backend, `computerd` is the container's entrypoint (PID 1); your binary runs as an
  *exec'd command* against the FUSE-mounted workspace, not as the resident process of the container. There is no
  documented "run my own daemon as the container's main process" mode in the Computer package. (Plain Containers
  without Computer *does* let you set your own `entrypoint` — that's a different layer, see
  https://developers.cloudflare.com/containers/container-class/.)
- **Any OS:** no. `linux/amd64` only for Containers. — https://developers.cloudflare.com/containers/get-started/

## 3. Persistent storage

**A Computer's filesystem is durable — but the durability lives in the Durable Object, not the container.**

- The Workspace is "a virtual filesystem backed by SQLite" that "can be instantiated on any Durable Object"; the DO's
  SQLite storage is the source of truth: "`workspace.fs` … is durable across DO restarts, backed by the DO's own
  SQLite storage." — https://blog.cloudflare.com/cloudflare-computer/ ;
  https://github.com/cloudflare/computer/blob/main/packages/computer/README.md
- The container sees that filesystem through a **FUSE mount**: "a container runtime that uses Cloudflare Containers to
  provide a full Linux environment. Here, the filesystem is provided via a Filesystem in Userspace (FUSE) mount, which
  ensures files are available to the container and changes are synced back." A `computerd` daemon inside the container
  owns the FUSE mount and syncs changes over a capnweb RPC channel. — https://blog.cloudflare.com/cloudflare-computer/ ;
  https://github.com/cloudflare/computer
- **The container-side copy is process-lifetime in-memory:** "the **container's VFS is process-lifetime in-memory**,
  while the **DO's VFS is durable SQLite**. A container restart loses container-side state. Sync … is what brings
  state back on the next push/pull round." — https://github.com/cloudflare/computer/blob/main/docs/11_lifecycle.md
- **Limits:** "~10 GB per workspace (it shares storage with the DO). The container-side filesystem is held in memory.
  Aim for agent-scale workspaces, not full monorepos." — https://github.com/cloudflare/computer/blob/main/packages/computer/README.md
- **Underlying container disk is ephemeral** (fresh from image on every start; "Snapshots are coming soon" at the
  Containers layer). — https://developers.cloudflare.com/containers/platform-details/architecture/
- **Cost:** storage is DO SQLite storage on the Workers Paid plan (DO storage billed per GB-month) + container
  disk/memory while active. — https://developers.cloudflare.com/containers/pricing/

## 4. Networking

**Inbound:**
- Containers are private-by-default and Worker-fronted: "Because all Container requests are passed through a Worker,
  end-users cannot make non-HTTP TCP or UDP requests to a Container instance." — https://developers.cloudflare.com/containers/platform-details/architecture/
- A Computer workspace is inside a DO, so inbound = whatever the DO's `fetch`/WebSocket handlers offer (agent
  frontends, WebSocket upgrade through a Worker). Clients can reach the agent over HTTP/WebSocket *through a Worker
  fronting the DO* — that is the standard Agents SDK model. — https://developers.cloudflare.com/agents/
- No documented direct inbound TCP/raw-WebSocket-to-container addressing for Computer.

**Outbound:**
- The container backend has "real network" (repo README), but Computer's own egress policy **defaults to blocking**:
  the egress example's `EGRESS_MODE=none` → "{ mode: 'none' } — Blocks outbound network access. This is the default."
  You must explicitly configure `all` (direct) or `custom` (HTTP gateway allowlist). — https://github.com/cloudflare/computer/blob/main/examples/egress/README.md
- At the Containers layer, outbound is governable per-host and only for HTTP(S): "Outbound handlers only intercept
  HTTP and HTTPS traffic. Traffic on ports other than `80` and `443` is never routed through `outbound` … If you set
  `enableInternet = false`, that traffic is denied." — https://developers.cloudflare.com/containers/platform-details/outbound-traffic/
- **Long-lived outbound WebSockets (Discord/Slack, hours):** no documented support for this as a *resident* capability.
  Discord/Slack use `wss://` on port 443, which outbound egress can reach, but the container **sleeps after
  `sleepAfter` (default 10 min) with no incoming requests** (`onActivityExpired()` → `stop()`), and sleep = process
  kill (SIGTERM, 15-min grace, SIGKILL). Outbound traffic does not reset the activity timer; only incoming requests
  do, plus an explicit `renewActivityTimeout()` call from Worker code. So an idle-outbound-only container is killed.
  — https://developers.cloudflare.com/containers/container-class/ ;
  https://developers.cloudflare.com/containers/platform-details/architecture/ ; https://developers.cloudflare.com/containers/faq/
- **Scale-to-zero / wake semantics:** sleeping is *stopping*, not hibernating — "A sleeping container is stopped, and
  the next request starts a fresh instance"; "When a Container instance goes to sleep, the next time it is started, it
  will have a fresh disk as defined by its container image." Processes and connections do **not** survive a wake.
  — https://developers.cloudflare.com/containers/platform-details/architecture/
- For Computer specifically: the DO↔container capnweb WebSocket dies with the container and is rebuilt on next use;
  the DO itself stays warm (see §5). — https://github.com/cloudflare/computer/blob/main/docs/11_lifecycle.md

## 5. Compute model

- **Underlying container sizes (Containers platform):** instance types `lite` (1/16 vCPU, 256 MiB, 2 GB disk) through
  `standard-4` (4 vCPU, 12 GiB, 20 GB); custom types up to 4 vCPU / 12 GiB / 20 GB with a 3 GiB-per-vCPU minimum.
  — https://developers.cloudflare.com/containers/platform-details/limits/
- **Billing:** containers billed "for every 10ms that they are actively running": memory $0.0000025/GiB-s
  (provisioned), CPU $0.000020/active vCPU-s, disk $0.00000007/GB-s, with monthly inclusions on the $5/mo Workers
  Paid plan; "charges stop after the container instance goes to sleep … easy to scale to zero." Egress $0.025–0.05/GB.
  Workers + the per-container Durable Object are billed separately. — https://developers.cloudflare.com/containers/pricing/
- **Wake:** on demand. Requests to the container start it (cold start typically 1–3 s, image/entrypoint dependent);
  requests to a sleeping instance "could be routed to a different location" after restart.
  — https://developers.cloudflare.com/containers/platform-details/architecture/
- **Computer's DO does NOT hibernate today:** "Today's `CloudflareContainerBackend` uses `server.accept()`, which is
  **not** the hibernation API. The DO stays in memory for the lifetime of the WebSocket." Hibernation is designed but
  not shipped ("This section describes a target architecture, not shipped code"). Consequence: an open Workspace keeps
  the DO warm (duration-billed) indefinitely, while its container can still sleep.
  — https://github.com/cloudflare/computer/blob/main/docs/11_lifecycle.md
- **Always-on vs scale-to-zero:** there is no "always-on" guarantee at the Containers layer — "Cloudflare does not
  guarantee that any container instance will run for any set period of time" (host restarts happen on an irregular
  cadence; stop sequence is SIGTERM → up to 15 min → SIGKILL). — https://developers.cloudflare.com/containers/faq/
- **CPU wake budget (if you moved the loop to the DO/Workers side):** DO isolates keep the 30 s CPU per wake budget
  pattern (per prior research in `cloudflare-platform-constraints.md`); the container itself is a real VM with no such
  per-request CPU cap, but it is killed by the sleep lifecycle above.

## 6. Integration with Workers / Durable Objects / Queues

- **Durable Objects are the host:** "An instance of a @cloudflare/computer workspace can be instantiated on any
  Durable Object to provide a virtual filesystem and execution runtime." — https://blog.cloudflare.com/cloudflare-computer/
- **Workers front it:** Workers reach the DO's Workspace over Workers RPC (`env.COMPUTERD.get(id).getWorkspace()` →
  `WorkspaceStub`); the pattern in the lifecycle doc is `using ws = await env.COMPUTERD.get(id).getWorkspace(); using
  handle = await ws.runtime.exec("npm test");`. — https://github.com/cloudflare/computer/blob/main/docs/11_lifecycle.md
- **Agent harness:** the primary documented consumer is `@cloudflare/think` (the Agents SDK harness) — `class Agent
  extends Think` with `new Workspace({ storage: this.ctx.storage })`, optionally wrapped by
  `withWorkspaceContainer(Think)` to add the container backend. — https://blog.cloudflare.com/cloudflare-computer/ ;
  https://developers.cloudflare.com/changelog/post/2026-08-03-cloudflare-computer/
- **AI SDK tools:** `read`, `write`, `edit`, `ls`, `exec` (+ `find`, `grep`, `delete`, `publish` in the package
  README) as AI SDK `ToolSet`; `exec` picks a backend via description. — https://blog.cloudflare.com/cloudflare-computer/ ;
  https://github.com/cloudflare/computer/blob/main/packages/computer/README.md
- **Egress/proxy:** the container's outbound HTTP can be intercepted by Worker code (outbound handlers can "connect to
  Workers bindings like KV, R2, and Durable Objects"). — https://developers.cloudflare.com/containers/platform-details/outbound-traffic/
- **Queues:** no Computer-specific Queue integration is documented; DOs in general can be Queue consumers, but nothing
  in the Computer docs ties Queues to Workspaces. (Do not assume it exists.)

## 7. Spawn / exec inside

- **Yes — spawning subprocesses is the core model.** The container backend "Runs shell commands in full Linux userland
  (real binaries, `npm`, `node`, network)"; `computerd` "runs shell commands and streams stdout/stderr back over
  capnweb" and its exec runner supports `kill`, `getExec` by ID, `disposeExec`. — https://github.com/cloudflare/computer/blob/main/packages/computer/README.md ;
  https://github.com/cloudflare/computer/blob/main/docs/16_code_execution.md ;
  https://github.com/cloudflare/computer/blob/main/docs/07_injected_service.md
- **Execution is on-demand, not resident:** `workspace.runtime.exec(source, { backend })` returns a handle with
  `result()`, streams, `kill()`. There is no documented daemon/background-process API in Computer's container backend
  (contrast: Sandboxes has `startProcess` + preview URLs — https://blog.cloudflare.com/sandbox-ga/). Long-running
  children are bounded by container lifetime: idle → sleep → SIGTERM → SIGKILL kills everything.
  — https://github.com/cloudflare/computer/blob/main/docs/16_code_execution.md ;
  https://developers.cloudflare.com/containers/faq/
- **Process semantics caveat:** a torn exec is not replayed ("exec dispatch … reports the failure without replaying the
  command") because side effects aren't idempotent; only sync operations resume via rev watermarks.
  — https://github.com/cloudflare/computer/blob/main/docs/11_lifecycle.md
- At the raw Containers layer you *can* spawn from within a running container via `this.ctx.container.exec()`
  (https://developers.cloudflare.com/durable-objects/api/container/), and Docker-in-Docker works
  (`docker:dind-rootless`, no iptables) — https://developers.cloudflare.com/containers/faq/ — but again, resident
  daemons die on sleep.

## 8. Agent-relevant limits

| Limit | Value | Source |
|---|---|---|
| Max runtime | No fixed max, but **no run-duration guarantee**: host restarts on irregular cadence; SIGTERM → ≤15 min grace → SIGKILL | https://developers.cloudflare.com/containers/faq/ |
| Idle timeout | `sleepAfter` default **10 min**; configurable; `onActivityExpired()` stops the container | https://developers.cloudflare.com/containers/container-class/ |
| State across wakes | DO SQLite (fs + sync watermarks) survives; container in-memory VFS + processes are lost and re-baselined; **DO hibernation not yet shipped** (DO stays warm) | https://github.com/cloudflare/computer/blob/main/docs/11_lifecycle.md |
| Workspace size | ~10 GB per workspace | https://github.com/cloudflare/computer/blob/main/packages/computer/README.md |
| Container sizes | 1/16 vCPU/256 MiB … 4 vCPU/12 GiB/20 GB (custom ≤ 4 vCPU/12 GiB/20 GB) | https://developers.cloudflare.com/containers/platform-details/limits/ |
| Cold start | typically 1–3 s (image/entrypoint dependent); images pre-fetched globally | https://developers.cloudflare.com/containers/platform-details/architecture/ |
| Placement/regions | global; nearest location with pre-fetched image; **DO and container are not guaranteed co-located**; after sleep+restart a new request may land elsewhere | https://developers.cloudflare.com/containers/platform-details/architecture/ |
| FUSE I/O perf | computerd FUSE ~2× slower than container ext4 disk on a full `npm install` (124.7 s vs 63.9 s); 30–40× slower on pure large-file reads; faster than disk on metadata-heavy ops | https://github.com/cloudflare/computer/blob/main/docs/19_performance.md |
| Account concurrency (Containers) | 6 TiB concurrent memory, 1,500 vCPU, 30 TB disk | https://developers.cloudflare.com/containers/platform-details/limits/ |

## 9. Official examples of agents / long-running services

- **Announcement blog, bug-triage agent:** `class Agent extends Think` with Workspace + `CloudflareContainerBackend`,
  `createAITools`, git clone + fix + verify loop. — https://blog.cloudflare.com/cloudflare-computer/
- **Repo examples:** `think` (chat agent using the workspace as cwd, reachable from a terminal), `think-compare-runtimes`
  (same agent task on container vs worker runtimes side by side), `mcp` (Code Mode `code` tool + durable workspace +
  Worker shell + full container), `tutorial` (write markdown on host, `pandoc` → PDF in container), `assets` (Workers
  AI image → workspace → shareable link), `artifacts` (generates a Worker project and publishes it), `egress`.
  — https://github.com/cloudflare/computer
- **Cloudflare's own agents** use the same architecture: "This is how we build agents ourselves" (harness in a DO,
  container called on-demand as a tool); internal uses include building/testing/deploying JS apps with isolates.
  — https://blog.cloudflare.com/cloudflare-computer/
- **Long-running services:** no official example runs a *resident* long-lived service on Computer. The GA'd long-running
  agent story on Containers is Sandboxes (background processes + preview URLs + snapshots), which is a different package.
  — https://blog.cloudflare.com/sandbox-ga/

---

## Verdict table: ziggy requirements vs @cloudflare/computer

| ziggy requirement | Supported by Computer? | Notes |
|---|---|---|
| **Bun binary (`bun build --compile`, Bun 1.3.13)** | ⚠️ Partially | Any `linux/amd64` binary can be baked into your container image, but Computer's container runs `computerd` as PID 1 and your binary only as an **exec'd command**; no documented "my binary is the container's main process" mode in the Computer package. Plain Containers (`entrypoint` override) is a different layer. |
| **Real filesystem files (profile dirs, session JSONL, atomic rename, `O_NOFOLLOW`, fsync)** | ⚠️ Partial | Workspace VFS is real-looking (node:fs-compat API + FUSE mount) and durable in DO SQLite, but: ~10 GB cap, FUSE I/O 2× slower than disk on realistic workloads, container-side copy is in-memory/lost on restart, and POSIX subtleties (symlinks/xattrs only in real-FUSE mode) differ from a plain FS. Profile-path-as-identity semantics would need re-validation. |
| **`bun:sqlite`** | ❌ No (as-is) | ziggy's `bun:sqlite` DBs would live either on ephemeral container disk (lost on sleep) or on the FUSE workspace (slow, and sqlite-over-FUSE locking is risky). The DO's SQLite is Cloudflare's storage engine — you'd rewrite persistence against DO storage, not run bun:sqlite. |
| **Spawn subprocesses (`Bun.spawn`, `node:child_process`)** | ✅ Yes (short-lived) | exec of shell commands with full Linux userland, streams, kill/getExec by ID is the core model. But no daemon/background-process API in Computer; children die with the container. |
| **Long-lived outbound WebSockets to Discord/Slack (hours)** | ❌ No | Container sleeps after `sleepAfter` (default 10 min) of no *incoming* activity; sleep = stop (SIGTERM→SIGKILL), processes/connections killed, wake = fresh instance. Outbound traffic doesn't reset the timer. |
| **Resident `serve` process (always-on)** | ❌ No | Containers: "Cloudflare does not guarantee that any container instance will run for any set period of time" + idle-stop. Computer's DO also can't hibernate yet (stays warm — you pay duration while idle). |
| **Inbound client connections (WebSocket/TCP/HTTP)** | ⚠️ Via Worker/DO only | Clients can reach the agent through a Worker fronting the DO (HTTP/WS). End users **cannot** make non-HTTP TCP/UDP calls to the container. A Ziggy channel/gateway face would have to be rebuilt as a DO/Worker surface. |
| **Profile state across restarts** | ⚠️ Conceptual mapping exists | DO SQLite is durable and is Computer's whole point; but it's not your files/schema — it's a re-architecture, not lift-and-shift. |
| **Preview/GA status** | ❌ Preview | "NOT suitable for production use at this time"; APIs unstable; hibernation and full durability reconciliation "still to ship" (per docs/11_lifecycle.md). |

**Bottom line:** @cloudflare/computer is a great fit for the *tool-execution* slice of an agent (durable scratch
files + on-demand exec on containers/isolates). It is not a host for ziggy's resident, connection-holding,
filesystem-identity runtime. If the goal is "run the real ziggy on Cloudflare's network", the layer to watch remains
plain Containers (GA) — the 2025 feasibility findings in `cloudflare-hosted-ziggy.md` still hold — with the added
caveats that even Containers sleep-to-zero, have ephemeral disks, and are Worker-fronted, so the resident-serve +
long-lived-WS requirements still demand a keep-alive/reconnect strategy (or an external always-on host).

## Sources

- Announcement blog: https://blog.cloudflare.com/cloudflare-computer/
- Changelog (preview): https://developers.cloudflare.com/changelog/post/2026-08-03-cloudflare-computer/
- Repo: https://github.com/cloudflare/computer — README, packages/computer/README.md, examples/{container,think,egress}/, docs/{11_lifecycle,16_code_execution,07_injected_service,19_performance,12_worker_backend}.md
- npm: https://www.npmjs.com/package/@cloudflare/computer ; registry metadata: https://registry.npmjs.org/@cloudflare/computer
- Containers GA: https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/ ; beta: https://blog.cloudflare.com/containers-are-available-in-public-beta-for-simple-global-and-programmable/
- Containers docs: https://developers.cloudflare.com/containers/ (pricing, platform-details/limits, platform-details/architecture, platform-details/scaling-and-routing, platform-details/outbound-traffic, container-class, get-started, faq)
- Durable Object container API: https://developers.cloudflare.com/durable-objects/api/container/
- Sandboxes (disambiguation): https://blog.cloudflare.com/sandbox-ga/ ; https://developers.cloudflare.com/sandbox/
- Agents Week review: https://blog.cloudflare.com/agents-week-review-august-2026/
- Prior ziggy research: docs/research/cloudflare-hosted-ziggy.md, docs/research/cloudflare-platform-constraints.md
