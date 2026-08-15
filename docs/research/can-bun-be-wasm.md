# Can Bun be WASM? (state of the world, late 2025 → mid-2026)

Research date: current. Verified against live primary sources: bun.sh / bun.com docs, the
oven-sh/bun and WebKit repos, Bytecode Alliance projects, Cloudflare docs, StackBlitz/Shopify
engineering posts. Companion note: `docs/research/bun-on-cloudflare.md` covers the Cloudflare
runtime angle in depth; this note is specifically about **compiling Bun to WebAssembly/WASI**.

**TL;DR:** No. `bun build` cannot emit WASM, there is no WASI build of the Bun runtime and no
roadmap for one (maintainers explicitly decline), and compiling the Bun runtime (Zig +
JavaScriptCore + native code) to WASM is technically possible in principle but is a multi-year
effort nobody has attempted — every existing "JS runtime in WASM" precedent (WebContainers' Node,
Javy's QuickJS, StarlingMonkey's SpiderMonkey) was built by dedicated teams and drops the exact
capabilities (subprocesses, real fs, native sqlite, sockets/TLS) that make Bun useful. The Bun
runtime's own source greets `--target wasm` with: **"invalid target, WebAssembly is not
supported. Sorry!"**.

---

## 1. Does `bun build` support a WASM output target? — No.

**Bundler targets** (`Bun.build`, `bun build`): exactly three — `browser | bun | node`. There is no
`wasm` target, no `neutral` (the esbuild-comparison doc notes Bun dropped esbuild's `neutral`):

- "Targets: `--target browser|bun|node`" — https://bun.sh/docs/bundler
- "`platform` | `target` | Supports `"bun"`, `"node"` and `"browser"` (the default). Does not support `"neutral"`." — https://bun.sh/docs/bundler/esbuild

**`bun build --compile` targets**: only native Bun-runtime executables for linux/darwin/windows.
The full `CompileTarget` union has no wasm member:

- Supported-targets table (`bun-linux-x64` … `bun-windows-arm64`) — https://bun.com/docs/bundler/executables
- `type CompileTarget = "bun-darwin-…" | "bun-linux-…" | "bun-windows-…"` — https://bun.com/reference/bun/Build/CompileTarget

**The source of truth explicitly rejects wasm.** `src/options_types/CompileTarget.zig`:

- `isSupported`: `switch (this.os) { .windows => …, .mac => true, .linux => true, .freebsd => true, .wasm => false }`
- target parse: `if (this.arch == .wasm or this.os == .wasm) { return error.InvalidTarget; }`
- user-facing error: `else if (strings.containsComptime(input, "wasm")) { Output.errGeneric("invalid target, WebAssembly is not supported. Sorry!", …) }`
- Doc comment explains why: `bun build --compile` "downloads and extracts the bun binary for the target platform … from the npm registry" — i.e. compile mode *embeds the real Bun runtime binary*, so a wasm target would require a wasm Bun binary that doesn't exist.

https://github.com/oven-sh/bun/blob/main/src/options_types/CompileTarget.zig (same logic in the
new Rust port `src/options_types/compile_target.rs`).

**What Bun *does* do with wasm** (so the "no" is precise):
- Bundles `.wasm` files as inert **assets** (`.node` `.wasm` "treated as assets") — https://bun.sh/docs/bundler
- **Runs** WASI/WASM modules: `bun run app.wasm` works, and `bun build` can embed wasm files into standalone executables — https://bun.sh/docs/bundler/executables ("Embedding binary files" section)
- Hosts wasm apps via its `node:wasi` implementation — see §2.

Direction of travel is one-way: **Bun consumes wasm; it never produces it.**

## 2. Does the Bun runtime have a WASI/WASM build or plan? — No build; no plan.

**Bun is a WASI *host*, not a WASI *guest*.** Bun can *run* WASI modules:

- PR #1929 "Support running WASI (WebAssembly) files using `bun run`" — merged 2023-01-29 by Jarred Sumner (2407 additions). This is the `bun run *.wasm` capability. — https://github.com/oven-sh/bun/pull/1929
- Bun implements `node:wasi` (Node-compatible WASI preview1). It's immature and buggy — all still open as of this writing:
  - #12755 `TypeError: wasi.initialize is not a function` (reopened; `node:wasi` lacks `initialize()`/`getImportObject()`) — https://github.com/oven-sh/bun/issues/12755
  - #28534 `WASI.start(...)` fails where `bun run ...` succeeds (missing `getImportObject()`) — https://github.com/oven-sh/bun/issues/28534
  - #20857 BigInt math bug in `wasi.poll_oneoff` — https://github.com/oven-sh/bun/issues/20857
  - #30302 `node:wasi` preopens resolve against cwd instead of the preopen dir (fixed in #30303) — https://github.com/oven-sh/bun/issues/30302
  - PR #27204 "fix(wasi): add missing initialize() and getImportObject() methods" (open) — https://github.com/oven-sh/bun/pull/27204
  - Compare the baseline: Node's own `node:wasi` is "Stability: 1 — Experimental", preview1-only, and explicitly warns it does **not** provide secure sandboxing — https://nodejs.org/api/wasi.html

**Bun-the-runtime compiled to WASM / running in a browser: explicitly declined, no roadmap item.**

- Issue #2471 "Feature request (Browser release)" (wasm build so TS/bundler run client-side): closed. Maintainer (Electroid): **"We do not plan to support running Bun in the browser anytime soon."** Follow-ups a year+ later asking for a plan got no commitment. — https://github.com/oven-sh/bun/issues/2471
- Discussion #10400 "Could bun run in the browser?": open discussion; a commenter notes WebContainers works "by compiling nodejs to WASM. Bun is smaller and faster"; someone filed a separate feature request for **WASM component** support in Bun (composability via WAC) — tangential, no maintainer commitment. — https://github.com/oven-sh/bun/discussions/10400
- Discussion #6205 (AssemblyScript as a Bun language): a contributor answers the wasm-runtime question directly — "WASM is supported. If you mean compiling Bun/JavascriptCore itself to WASM or rolling QuickJS, IMO that's a bad idea, they should focus more on sandboxing/permissions at that point." — https://github.com/oven-sh/bun/discussions/6205

There is no open issue/PR in oven-sh/bun titled around building Bun itself for `wasm32-wasi` or
`wasm32-unknown-unknown`, and nothing on the Bun roadmap (bun.com/blog, releases) mentioning it.

## 3. Is compiling the full Bun runtime to WASM technically feasible today? — In principle, yes; nobody has done it; the blocker is JavaScriptCore.

**What Bun is made of:** a Zig core (event loop, fs, HTTP, sqlite bindings), **C++ JavaScriptCore** (Apple's JS engine: JITs + GC + WebAssembly engine), native system code (io_uring/epoll on Linux, etc.), and since the bundler rewrite, Rust components. — https://bun.com/docs/runtime ("Bun uses the JavaScriptCore engine, developed by Apple for Safari"), https://github.com/oven-sh/bun

**Why this is hard, specifically:**
- JavaScriptCore has **no supported wasm build**. JSC's wasm story is the reverse — it *hosts* wasm (LLInt interpreter tier, BBQ/OMG JIT tiers, recently an in-place interpreter "IPInt"). Its wasm support still assumes JIT/threads; "WebAssembly won't yet *run* sensibly with JIT off" (WebKit PR #19624). — https://github.com/WebKit/WebKit/pull/19624, https://github.com/WebKit/WebKit/pull/31918
- Zig's good wasm support (the Zig compiler itself builds/runs as WASI) does not cover the C++ engine + OS-dependent subsystems. Porting JSC to wasm means a JITless, single-threaded, browser-sandbox-constrained engine — a research project, and the result would be 10s of MB and dramatically slower. (wingolog's analysis of JSC's wasm engine internals gives the shape of what a wasm build would lose: https://www.wingolog.org/archives/2020/04/14/understanding-webassembly-code-generation-throughput)
- **Precedent that full engines *can* go to wasm — all built by dedicated teams over years:**
  - **StarlingMonkey**: SpiderMonkey-based JS runtime compiled to a WASI 0.2 component (~8–10 MB embedding), **in production for Fastly's JS Compute platform and Fermyon's Spin JS SDK**. — https://github.com/bytecodealliance/StarlingMonkey, https://github.com/bytecodealliance/componentizejs
  - **Javy**: QuickJS compiled to wasm (static ~869 KB, dynamic-linked 1–16 KB), runs Shopify Functions in production. — https://github.com/bytecodealliance/javy, https://shopify.engineering/javascript-in-webassembly-for-shopify-functions
  - **WebContainers**: StackBlitz "compiled Node.js to WASM" into a browser micro-OS (their words: "a WebAssembly-based operating system … powerful enough to run Node.js, entirely inside your browser"). — https://blog.stackblitz.com/posts/introducing-webcontainers/, https://webcontainers.io/
- **No "Bun-in-wasm" experiment exists.** The closest named things are not it: `vgrichina/bun-in-browser` is a WebSocket **reverse proxy** to a real Bun server (no wasm); `bun-ruby.wasm` (the repro in issue #12755) is *Ruby* compiled to wasm running *inside* Bun; `porffor` (mentioned in bun discussions) is a hobbyist JS→wasm compiler, not a Bun port. — https://github.com/vgrichina/bun-in-browser

So: feasible in the same sense that "compile Node to wasm" was feasible (WebContainers proved it),
i.e. a serious multi-year systems project with a dedicated team — not something `bun build`
grows into.

## 4. If Bun-the-runtime were compiled to WASM, what would be lost? — Everything OS-shaped.

| Bun capability | Under WASI preview1 | Under WASI preview2 (component model) |
|---|---|---|
| `Bun.spawn`, `Bun.$` shell, subprocesses | ❌ No process-spawning interface in preview1 | ❌ Still none — `wasi-cli` has no spawn; the process/spawn proposal is not in preview2 (WASIX, wasmer's extension, adds it, but no mainstream host implements it) |
| `Bun.file` / real fs | ⚠️ fd-based, capability-gated via `preopens` only; sandboxed, synchronous | ⚠️ `wasi-filesystem` exists but is capability-based (host grants virtual paths), sync, no inotify/watch, no full POSIX semantics |
| `bun:sqlite` (native SQLite) | ❌ Gone (native code) | ❌ Gone; you'd need SQLite recompiled to wasm (e.g. sqlite3.wasm, as pglite ships) — a rewrite, not a port |
| N-API/native addons | ❌ Gone; must be recompiled to wasm | ❌ Same |
| `Bun.serve` HTTP + WebSockets | ❌ No networking at all in preview1 | ⚠️ `wasi:http` incoming-handler exists (fetch-style); WebSocket upgrade is a separate early proposal, not in preview2; no TLS in `wasi-sockets` |
| TCP/UDP sockets | ❌ None | ⚠️ `wasi-sockets` (TCP/UDP, no TLS); host-granted |
| Threads | ❌ wasm threads not generally available; Cloudflare Workers explicitly: "Threading is not possible in Workers" | ❌ Same |
| What survives | ECMAScript, stdio (fd 0/1/2), clocks, random, env/args | + `wasi-filesystem`, `wasi-http`, `wasi-sockets` — i.e. a WinterCG-ish web-API surface, still no processes |

Sources: WASI preview2 contents (`wasi-io`, `wasi-clocks`, `wasi-random`, `wasi-filesystem`,
`wasi-sockets`, `wasi-cli`, `wasi-http`) — https://github.com/WebAssembly/WASI/blob/main/docs/Preview2.md;
the preview2-shim's sandbox knobs (preopens/env/`enableNetwork`) show exactly what a host can
grant — https://github.com/bytecodealliance/jco/blob/main/packages/preview2-shim/README.md;
Node's `node:wasi` warning that it is not a security sandbox — https://nodejs.org/api/wasi.html.

**On Cloudflare Workers specifically** (the target in question), even the wasm path is throttled:
Workers host wasm **modules** imported from JS; "WASI support is experimental on Cloudflare
Workers, with only some syscalls implemented", no `instantiateStreaming`, no threads, and wasm
binary size counts against the worker's script-size limits. — https://developers.cloudflare.com/workers/runtime-apis/webassembly/, https://developers.cloudflare.com/workers/wrangler/bundling/

## 5. Precedents: Node/Bun-compatible runtimes as WASM — how they fare

- **Node.js itself: no official wasm build.** `node:wasi` lets *wasm programs* run *inside* Node; it is not Node-in-wasm. Deno is similar (preview1 via `node:wasi`, preview2 via `jco`). — https://nodejs.org/api/wasi.html, https://docs.deno.com/runtime/reference/wasm/
- **WebContainers (StackBlitz) — Node compiled to WASM in the browser.** The only production full-Node-in-wasm. Perf: "Builds complete up to 20% faster and package installs >= 5x faster" than local; but it works only because browsers provide ServiceWorker-based virtual TCP and an in-memory VFS, and it took StackBlitz years. **Serverless-hosted? No** — it's client-side compute. — https://blog.stackblitz.com/posts/introducing-webcontainers/, https://blog.stackblitz.com/posts/webcontainer-api-is-here/, https://blog.stackblitz.com/posts/announcing-wasi/
- **Javy (QuickJS → wasm, Shopify/Bytecode Alliance).** Production (Shopify Functions). Shopify measured the same function as JS-in-wasm **~3× slower than Rust-compiled wasm**; the runtime is deliberately API-poor (stdlib-ish JS + stdin/stdout; no fs/network by default) precisely because it must stay small. — https://shopify.engineering/javascript-in-webassembly-for-shopify-functions, https://github.com/bytecodealliance/javy
- **StarlingMonkey + ComponentizeJS (SpiderMonkey → wasm component).** The closest thing to "a full JS runtime as a serverless wasm artifact": ~8–10 MB, WASI 0.2, `fetch` handler model, **in production on Fastly's Compute JS edge platform** and Fermyon Spin. It is WinterCG-ish web APIs only — no child_process, no real fs, no native modules. — https://github.com/bytecodealliance/StarlingMonkey, https://github.com/bytecodealliance/componentizejs
- **wasmer-js / wasmtime running Node:** wasmer-js runs *wasi modules* in Node/browser/Deno (WASI + WASIX; spawn only via WASIX; networking "on the works"); wasmtime is a generic host. Neither ships a wasm *Node* runtime; there is no maintained "Node-on-WASI" binary. — https://github.com/wasmerio/wasmer-js, https://wasmer.io/posts/wasmer-js-a-new-hope
- **The pattern:** every working case is (a) a small/embedding-friendly engine (QuickJS, SpiderMonkey — never JSC/V8), (b) a heavily reduced API surface (web standards only), (c) years of dedicated engineering. No case is "compiled Node/Bun with full OS capabilities."

## Verdict: what "Bun → WASM" would and would not give us

**It would give us (today):** nothing — it doesn't exist and is not on the roadmap. `bun build`
has no wasm target (the error message is literally "invalid target, WebAssembly is not supported.
Sorry!"); there is no WASI build of the Bun runtime; the maintainers decline browser/wasm plans.
Even the *host-side* WASI support Bun does have (`bun run app.wasm`, `node:wasi`) is buggy and
experimental.

**It would give us (if a multi-year port ever happened):** a large (tens of MB, JSC-derived),
slower (JITless, single-threaded) runtime with a WinterCG-style subset — stdio, clocks, random,
env, and (preview2) capability-granted fs + `fetch`-style HTTP. All of Bun's differentiators die:
`Bun.spawn`/shell (no WASI process API), real filesystem, `bun:sqlite`, native addons, TLS,
threads. And it still would not run on Cloudflare Workers: Workers host JS + wasm *modules* with
experimental, partial WASI — you cannot upload a whole runtime as a Worker, and workerd's
`nodejs_compat` already covers more of Node than any wasm Bun would.

**The real options for shipping a Bun app (or ziggy/pi) serverless remain:**
1. **Bundle to standards-based JS** and deploy to Workers/workerd (Bun as toolchain only) — this is the only wasm-free path that runs on Cloudflare; it requires dropping Bun-specific APIs. Fully documented in `docs/research/bun-on-cloudflare.md` — and that note shows **pi-coding-agent cannot survive this**: it needs `child_process`/`fork`, TTY/readline, real fs, long-lived processes.
2. **JS-in-wasm component** on a wasm-component-native host (Fastly Compute, Fermyon Spin, wasmtime serve) via StarlingMonkey/ComponentizeJS — real and production-grade, but SpiderMonkey-based and web-API-only; same pi blockers apply (no subprocesses, no real fs, no TTY).
3. **Run actual Bun** on a VM/container platform (Cloudflare Containers official base image ships Bun 1.x) — the only way to get the Bun runtime itself on Cloudflare's network. — https://developers.cloudflare.com/containers/

**Bottom line for ziggy:** "compile Bun to WASM" is a dead end — it cannot be done with any
current tooling, it would strip exactly the capabilities pi/ziggy rely on (subprocesses, fs, TTY),
and it would not unlock Cloudflare Workers. WASM is the *wrong* direction for running a Bun
runtime serverless; bundling to JS (with its hard API constraints) or a container platform are the
only routes that exist.
