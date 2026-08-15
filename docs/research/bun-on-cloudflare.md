# Bun on Cloudflare: current state (late 2025)

Research date: late 2025. Sources: bun.sh docs, github.com/oven-sh, github.com/cloudflare (workers-sdk, workerd, cloudflare-docs), developers.cloudflare.com, blog.cloudflare.com, plus a local scan of the installed `@earendil-works/pi-coding-agent@0.84.1` package.

**Executive summary:** Bun does not run on Cloudflare Workers/workerd, Cloudflare has officially and repeatedly declined to support Bun as a Workers runtime, and there is no Bun-API compatibility layer in workerd (only Node.js compat). The only sanctioned way to run the Bun *runtime* on Cloudflare's network is **Cloudflare Containers** (public beta since June 2025), whose official base image ships Bun 1.x. A Bun *app* can be bundled to standards-based JS and deployed to Workers, but it then runs on V8/workerd, not Bun.

---

## 1. Does `bun build` have a target for Cloudflare workerd?

**No — not in a released version of Bun.**

- The official bundler docs list exactly three targets: `--target browser|bun|node`.
  - "Targets: `--target browser|bun|node`" and "`--target` string, default: `browser` — Intended execution environment for the bundle. One of `browser`, `bun`, or `node`."
  - https://bun.sh/docs/bundler
- There is no `--target=workerd` or `--target=cloudflare`. A proposal exists but was **never merged**:
  - oven-sh/bun#24193 "Add --target=cloudflare support to bundler" — **closed, merged: false** (verified via GitHub API: `state: closed | merged: False | merged_at: None`). It would have added `cloudflare` to the `Target` enum with export conditions `["workerd", "worker", "browser"]`, matching Wrangler's resolution.
  - https://github.com/oven-sh/bun/pull/24193
- Even the `node` target explicitly does not polyfill Bun APIs: "Bun does not polyfill the `Bun` global or the built-in `bun:*` modules." — https://bun.sh/docs/bundler
- `bun build --compile` produces a **standalone executable with the Bun runtime embedded** — it does not emit a workerd-deployable artifact and cannot run on workerd (workerd executes JS/WASM, not native executables).
- `Bun.serve` has no workerd output mode; it is a Bun-runtime API. Bundling code that uses `Bun.serve`/`Bun.file`/`Bun.spawn`/`bun:sqlite` does not transform them into workerd-valid code — those APIs simply don't exist in workerd.

## 2. Official Cloudflare × Bun announcements / partnerships

There is **no partnership and no official announcement of Bun support in workerd**. What exists is the opposite — explicit official decline, plus Bun as a *build-time tool*:

- **workerd issue #1160 (2023)** — Kenton Varda (workerd creator): "There's no chance we'd adopt a third-party runtime for our environment." Also: swapping V8 for JavaScriptCore "would be a significant long term effort... Not saying no but also can't say that it's at all a priority for us any time soon."
  - https://github.com/cloudflare/workerd/issues/1160
- **workers-sdk issue #5621 (2024)** — maintainer: "it's highly unlikely we'll ever support Bun as a runtime for Cloudflare Workers (which run using our own runtime, the open-source `workerd`). Additionally, we don't support Wrangler (the CLI tool) running in Bun... I can't see us changing that stance anytime soon." Reason cited: Wrangler/Miniflare rely on Node-internal V8 serialization APIs that Bun (JavaScriptCore-based) can't provide.
  - https://github.com/cloudflare/workers-sdk/issues/5621
- **workers-sdk PR #8039 "Remove Bun support" (Feb–Apr 2025)** — removed Bun from `create-cloudflare` (C3): "Bun is not supported by Wrangler or Miniflare."
  - https://github.com/cloudflare/workers-sdk/pull/8039
- **workers-sdk PR #8889 (Apr 2025)** — adds a Wrangler warning when running under the Bun runtime: "Bun is not supported by Wrangler or Miniflare."
  - https://github.com/cloudflare/workers-sdk/pull/8889
- **workers-sdk PR #11177 (Nov 2025)** — adds Bun *package-manager detection* for analytics only, and explicitly states: "It does not improve support for bun, which remains officially unsupported."
  - https://github.com/cloudflare/workers-sdk/pull/11177
- **cloudflare-docs issue #22525 "What is the official support policy for Bun?" (May 2025)** — raised by a contributor because Bun was re-added to docs; closed after Cloudflare removed it again (PR #22555 "Remove Bun"). The policy: Bun is not a supported runtime for Wrangler/Workers.
  - https://github.com/cloudflare/cloudflare-docs/issues/22525
- Wrangler install docs state: "We support running the Wrangler CLI with the Current, Active, and Maintenance versions of Node.js. Your Worker will always be executed in `workerd`."
  - https://developers.cloudflare.com/workers/wrangler/install-and-update/

**Where Bun IS officially supported: as a build tool, not a runtime.**

- **Workers Builds / Pages build image** preinstalls **Bun 1.2.15** (overridable via `BUN_VERSION`) for build-time use (install/build commands).
  - https://developers.cloudflare.com/workers/ci-cd/builds/build-image/
- **Cloudflare Containers (public beta, launched June 2025)** — arbitrary Docker images; the official Cloudflare Sandbox base image includes "Bun 1.x (JavaScript/TypeScript runtime)" and legacy startup scripts `exec bun /container-server/dist/index.js` are supported for backwards compatibility.
  - https://blog.cloudflare.com/containers-are-available-in-public-beta-for-simple-global-and-programmable/
  - https://developers.cloudflare.com/sandbox/configuration/dockerfile/
  - https://developers.cloudflare.com/containers/

## 3. The exact gap: why a Bun app can't run on workerd

Workerd runs **V8 with Cloudflare's own APIs**; Bun is a separate runtime (JavaScriptCore + Zig) with its own API surface. The gaps, in order:

1. **Bun APIs don't exist in workerd.** `Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.serve`, `Bun.env`, `Bun.hash`, `Bun.password`, `Bun.sql`, the `Bun` global, `bun:sqlite`, the Bun shell (`$`), and `Bun.build` output modes have no workerd equivalents. There is no `bun_compat` flag. workerd's compat surface is `nodejs_compat` (+ `nodejs_compat_v2`), which covers **Node.js** APIs only — see https://developers.cloudflare.com/workers/runtime-apis/nodejs/.
2. **Node.js compat doesn't fill it either.** The one near-Bun overlap, `ncrypto`, is shared code both runtimes use for Node-compatible crypto ("used – not only by Workers but Bun as well") — code sharing, not runtime support. https://blog.cloudflare.com/nodejs-workers-2025/
3. **No compatibility layer rewrites Bun APIs.** Nothing in workerd, Wrangler, or `@cloudflare/unenv-preset` translates `Bun.*` calls. The only community equivalent is a **build-time** transformer (see §5). Cloudflare's Node compat polyfills come from `unenv`, and even those are Node-targeted, not Bun-targeted.
4. **Sandbox model.** Bun's serverless-relevant primitives (subprocess spawning, real files, TCP) are exactly what workerd forbids for security. Even where workerd implements `node:fs`, it's a memory-backed virtual FS (see §4).

## 4. pi-coding-agent under workerd's node compatibility layer

Package scanned: installed `@earendil-works/pi-coding-agent@0.84.1` (`dist/`). It is a Node/Bun-compatible CLI: Ink-style TUI, `node:fs`, `node:child_process`, `node:path`, readline/tty, and heavy subprocess use. Import counts across `dist/`:

- `node:fs` ×22, `fs` ×17, `node:fs/promises` ×10, `fs/promises` ×5
- `node:path` ×27, `path` ×19
- `node:os` ×11, `os` ×4
- `node:crypto` ×6, `crypto` ×3
- `node:child_process` ×6, `child_process` ×10
- `node:readline` ×3 (+ `readline` ×1), plus `stdin.setRawMode`, `stdin.isTTY`, `stdout.isTTY`
- `node:worker_threads` ×2, `node:events`, `node:string_decoder`, `node:url`, `url`
- Third-party with system deps: `cross-spawn` (spawns real processes), `proper-lockfile` (fs-based locking), `glob`, `minimatch`, `ignore`, `semver`, `chalk`
- Subprocess model: `dist/core/exec.js` (`import { spawn } from "node:child_process"`), `dist/core/tools/bash.js` (runs bash), 10× `.fork(` (TUI spawns agent subprocesses), `dist/utils/child-process.js` wraps cross-spawn.

**Could it run under workerd's node compat as-is? No.** Specific breaks, against the current official docs:

| pi dependency | workerd status (late 2025) | Verdict |
|---|---|---|
| `node:child_process`, `cross-spawn`, `spawn`/`fork`/`exec` | **No real support.** Not even an importable stub until compat date `2026-03-17`, and stubs are non-functional ("can be imported or required, but does not provide a working implementation"). workerd has no process spawning. | ❌ Fatal — pi's entire tool-execution model (bash tool, exec, git, spawning agent subprocesses) breaks |
| `node:readline`, `node:tty`, `stdin.setRawMode`, `isTTY` | Same: stub only from `2026-03-17`, non-functional. Workers have no TTY/stdin concept. | ❌ Fatal — interactive TUI cannot run |
| `node:worker_threads` | Stub only from `2026-03-17`, non-functional. | ❌ |
| `node:fs` / `fs/promises` | "🟢 supported" **but** it's a memory-based virtual FS: read-only `/bundle`, ephemeral per-request `/tmp`, `/dev` devices; all synchronous; no `watch`; timestamps = epoch; max file 128 MB. pi reads/writes arbitrary project files, `.pi/` config, logs. | ❌ Fatal — no real filesystem, no persistence |
| `node:path`, `node:os`, `node:events`, `node:crypto`, `node:string_decoder`, `node:url` | 🟢 supported natively. | ✅ (these would load) |
| `node:process` | 🟢 supported (env/bindings), but semantics differ (no real argv/stdio, no long-lived process). | ⚠️ |
| Execution model | Workers are short-lived, request-driven, no stdin, CPU-time limited; an interactive CLI/session host doesn't fit. | ❌ Fatal — architectural |

References: https://developers.cloudflare.com/workers/runtime-apis/nodejs/ (supported list + non-functional stub table) and https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/ (VFS semantics).

Even the distributed binary (`bun build --compile` in the package's `build:binary` script, https://github.com/... package.json) can't help: a compiled Bun executable cannot run on workerd, only on a host with the Bun runtime (or inside a Cloudflare Container, see §5).

## 5. Community projects / official Cloudflare "V8 platform" efforts

- **Cloudflare Containers / Sandbox** — the official escape hatch for "arbitrary runtime" workloads: "Run code written in any programming language, built for any runtime, as part of apps built on Workers." The official base image ships Bun 1.x. This is a separate product (public beta, June 2025), not workerd.
  - https://developers.cloudflare.com/containers/
  - https://developers.cloudflare.com/sandbox/configuration/dockerfile/
  - https://blog.cloudflare.com/containers-are-available-in-public-beta-for-simple-global-and-programmable/
- **Bunflare** (github.com/fhorray/bunflare) — a Bun bundler plugin that rewrites `Bun.*` APIs (`Bun.env`, `bun:sqlite`→D1, `Bun.file`→R2, `Bun.serve`→fetch handler, etc.) **at build time** so the emitted artifact is Workers-compatible. Proof that the gap is only bridged by transpilation, and that hand-rolled shims are partial.
  - https://github.com/fhorray/bunflare
- **Standard workflow pattern** (dev.to / community): develop with Bun, keep code on Web Standards APIs, bundle with `bun build --target bun`, deploy with Wrangler — the deployed code runs on workerd/V8, and anything touching fs/subprocess/sockets "will fail at runtime, not at build time."
  - https://dev.to/pickuma/deploying-bun-apps-on-cloudflare-workers-in-2026-edge-compute-for-the-rest-of-us-1bhp
- **Bun as toolchain only** is common (SST, Alchemy, Hono projects use `bun install`/`bun run` and deploy via Wrangler); that never puts Bun on the Workers runtime.
- **Cloudflare's "V8 platform" stance** is unchanged through 2025: Workers = workerd = V8; maintainers explicitly said "Bun... remains officially unsupported" (Nov 2025, PR #11177). There is no 2025 announcement of Bun-as-a-Workers-runtime; the 2025 Node.js-compat push explicitly targets Node.js, not Bun.

---

## Verdict

**Can a Bun app run on Cloudflare today? No — not as Bun.**

- **On Workers/workerd: No.** workerd runs V8. Cloudflare officially, repeatedly, and as recently as Nov 2025, states Bun is unsupported as a runtime (Wrangler/Miniflare are Node-only; C3 removed Bun support; Bun is "officially unsupported"). There is no Bun API compat layer (`Bun.file`, `Bun.serve`, `Bun.spawn`, `bun:sqlite`, `Bun.env`, Bun shell have no workerd equivalents), and `bun build` has no released `workerd`/`cloudflare` target (PR #24193 was closed unmerged). `nodejs_compat` only helps Node-style code, and even it lacks real fs, subprocess, readline/tty, and worker_threads (non-functional stubs only from 2026-03-17).
- **What you CAN do today:**
  1. Write standard-Web-API code, bundle with Bun, deploy with Wrangler → it runs on workerd, not Bun.
  2. Use Bun as the build-time tool inside Workers Builds (Bun 1.2.15 preinstalled).
  3. Run the actual Bun runtime in a **Cloudflare Container** (official base image ships Bun 1.x).
- **pi-coding-agent cannot run under workerd's node compat as-is**: its `node:child_process`/`cross-spawn`/`fork` subprocess model, readline/tty raw-mode TUI, real-filesystem reads/writes, and long-lived interactive execution model are all incompatible with workerd's sandbox (no processes, memory-only VFS, no stdin, short request-driven lifetimes). Only the pure-Node data modules (`node:path`, `node:os`, `node:crypto`, `node:events`, `node:url`, `node:string_decoder`) would load under `nodejs_compat`. To run pi on Cloudflare you'd have to rewrite it as a Workers-style app (fetch handler + bindings + D1/KV/R2, no subprocesses) or run the compiled binary inside a Cloudflare Container — not on a Worker.
