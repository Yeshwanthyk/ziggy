# Node.js on WASI ("node-wasi"): what works and what breaks

Research date: late 2025 (verified through Aug 2026). Sources: nodejs.org docs, github.com/nodejs (node, uvwasi, undici, help), WebAssembly/WASI (spec, wasi-cli, wasi-sockets), wasmtime.dev, bytecodealliance.org, webcontainers.io, blog.stackblitz.com, v8.dev.

**Executive summary:** There is **no official "node-wasi" build** — no Node.js release where the Node.js runtime itself is compiled to WASI. The only official thing named close to it, the `node:wasi` module, is the *opposite direction*: Node.js *hosting* WASI guest modules, Stability 1 Experimental, WASI preview1 only. Running Node.js itself on WASI is a **community experiment** (WebContainers/StackBlitz in browsers; a Node v22 WASI build under Wasmer reported in nodejs/help#3774). On WASI, the syscall surface has **no sockets, no process spawn, no terminal, no threads API** — even the newest WASI 0.3 adds native async, not process spawning. A node-wasi build therefore cannot do `child_process`, `net/tls/http/https/dgram`, `undici/fetch`, `worker_threads`, `tty` raw mode, or load native `.node` addons. `fs` works through preopens. A stripped "agent loop" (pure JS + fs + no network + no subprocess + no TUI) is the only thing that could run — which is not a coding agent.

---

## 1. Official status of Node.js on WASI — is there a published "node-wasi" build?

**No official Node.js-on-WASI build exists.** What exists officially:

- **`node:wasi` is Node hosting WASI guests, not Node-on-WASI.** "The WASI API provides an implementation of the WebAssembly System Interface specification. WASI gives WebAssembly applications access to the underlying operating system via a collection of POSIX-like functions." Stability: **1 - Experimental**. The only `version` values supported are `unstable` and `preview1`. The docs also warn this is **not a security sandbox**: "The current Node.js threat model does not provide secure sandboxing as is present in some WASI runtimes… the file system sandboxing can be escaped with various techniques."
  - https://nodejs.org/api/wasi.html
- **The implementation is `uvwasi`, a WASI-preview1 syscall layer over libuv**, vendored into Node as `deps/uvwasi`. "This documentation is based on the WASI preview 1 snapshot."
  - https://github.com/nodejs/uvwasi
- **WASI preview2 is not supported in Node core, with no committed date.** uvwasi issue #255 ("Solidify plan for WASI Preview 2") proposes either upstreaming bytecodealliance/jco or implementing preview2 interfaces in uvwasi; the current working preview2 path is jco's `preview2-shim` (JS-level host bindings — for hosting guests, not for Node itself as a guest). Node issue #55396 "Will Node.js support WASI preview 2 anytime soon?" remains closed/answered-in-the-negative in practice.
  - https://github.com/nodejs/uvwasi/issues/255
  - https://github.com/nodejs/node/issues/55396
- **WebAssembly is an official Node technical priority, but framed as Node hosting WASM**, not Node running on WASM: "Node.js must provide good support for running WebAssembly components along with the JavaScript that makes up the rest of the solution. This includes implementations of 'host' APIs like WASI."
  - https://github.com/nodejs/node/blob/main/doc/contributing/technical-priorities.md
- **`BUILDING.md` lists no wasm/wasi build target** (only native platforms: Linux, macOS, Windows, AIX, FreeBSD…).
  - https://github.com/nodejs/node/blob/main/BUILDING.md
- **The historical "node-wasi" repo (devsnek/node-wasi) was the pre-core WASI *module*, not a Node build** — "This module and WASI are still in early development!" with 0.0.x releases. Its functionality was folded into core as `node:wasi`.
  - https://github.com/devsnek/node-wasi/releases

**WASI version timeline relevant here:** Node's `node:wasi` = WASI **preview1** (2023 snapshot) only. WASI preview2 (0.2.x, 2024) adds sockets/filesystem/etc. as component-model interfaces. WASI 0.3 (preview 3) went through dated snapshots in 2025 (`0.3.0-rc-2025-08-15`, `0.3.0-rc-2025-09-16`; Wasmtime 37 experimental, Sept 2025) and the official 0.3.0 was released June 11, 2026 — it adds native async and `wasi:cli/terminal`, **not process spawning**. Node core supports none of it.
  - https://github.com/WebAssembly/WASI/issues/666
  - https://wasi.dev/releases/wasi-p3

---

## 2. Which Node built-in modules are unavailable/non-functional on node-wasi

WASI preview1's syscall surface (what a node-wasi build could call) is: args/env, stdin/stdout/stderr, clocks, random, filesystem (via preopens), `poll_oneoff`, `sched_yield`, `proc_exit`/`proc_raise`. Everything else is absent. Per-module:

| Module | Status on node-wasi (preview1) |
|---|---|
| `net`, `tls`, `http`/`https`, `dgram` | **Unavailable.** preview1 has no socket-creation syscalls (`socket`/`connect`/`bind`/`listen`). uvwasi's README lists `sock_recv`/`sock_send`/`sock_shutdown` as *additions/modifications to the preview1 snapshot* — they operate on pre-existing socket fds, but nothing in preview1 can create one. Sockets arrive only in WASI preview2's `wasi:sockets` (TCP/UDP/DNS), which Node core doesn't implement. TLS needs `wasi:tls` (0.3-era draft; initial Wasmtime support in v44). |
| `child_process` | **Unavailable** — see §4. No spawn/fork syscall anywhere in preview1/2/0.3. |
| `worker_threads` | **Unavailable in practice.** WASI preview1 defines no threads. The wasm threads proposal (shared memory) is phase 4 and supported by Wasmtime, but Node's `worker_threads` on a wasm Node build has no published working implementation; browser builds shim it onto Web Workers (see §7). |
| `fs` | **Works, capability-style via preopens.** Node's `WASI` constructor maps guest virtual dirs to host paths: `preopens: { '/local': '/some/real/path' }`. Read/write is allowed inside preopened dirs; nothing outside is visible. Not a security boundary (see §1 warning). uvwasi implements it over libuv. |
| `undici`/`fetch` | **Unavailable on WASI.** Fetch needs sockets + TLS (see §5). The llhttp HTTP parser inside undici is itself WASM, so the parser is fine — the socket layer is not. |
| `tty` | **Unavailable.** preview1 has no terminal/PTY concept (the `ENOTTY` errno exists; there is no `isatty`/termios). WASI 0.3 adds a minimal `wasi:cli/terminal`, but Node core has no WASI-terminal support. |
| `readline` | **Partial.** `readline` is pure JS over streams and works over piped stdio; but `readline/promises` + TUI-style **raw-mode key handling** requires `tty` semantics and does not work on WASI. |
| `dns` | Unavailable (no sockets, no name lookup in preview1; preview2 adds `wasi:ip-name-lookup`). |
| `cluster` | Unavailable (needs spawn + real processes). |
| `crypto` (OpenSSL-based) | Depends on the build; browser wasm builds replace it with WebCrypto/JS shims. Not a WASI-level guarantee. |

Sources:
- Node WASI API + preopens + security caveats: https://nodejs.org/api/wasi.html
- uvwasi syscall list incl. socket extensions to preview1: https://github.com/nodejs/uvwasi
- WASI sockets proposal (TCP/UDP/DNS, "deny-by-default firewalling"): https://github.com/WebAssembly/wasi-sockets
- WASI 0.3 (native async; `wasi:cli` with terminal; sockets consolidated; **no spawn**): https://wasi.dev/releases/wasi-p3
- jco preview2-shim (the only preview2 path for Node today, hosting-guests side): https://github.com/bytecodealliance/jco/tree/main/packages/preview2-shim

---

## 3. Can native `.node` addons load on node-wasi?

**No.** Confirmed from the largest production node-on-wasm deployment:

- WebContainers (StackBlitz) runs Node.js recompiled to WebAssembly, and **loading native addons is disabled by default via `--no-addons`**: "Currently, WebContainers can only execute languages that are natively supported on the Web… It is not possible to run native addons which are usually implemented using native languages such as C++, unless they can be compiled to WebAssembly." A user's `require()` of an addon yields: `Error: Cannot load native addon because loading addons is disabled`.
  - https://webcontainers.io/guides/troubleshooting
  - https://github.com/stackblitz/webcontainer-core/issues/1460
- The exception proves the rule: sharp works in WebContainers only because the entire N-API stack was **recompiled to WASM** (emnapi — N-API on Emscripten), including sync-load hacks, not because `.node` binaries load. "Sharp uses a native Node.js addon… The native addon is built for Windows, Linux, and macOS, but none can run in the browser, so Sharp couldn't run in StackBlitz either."
  - https://blog.stackblitz.com/posts/bringing-sharp-to-wasm-and-webcontainers/
- Community wasm/wasi Node builds likewise ship without addon support (nodejs/help#3774: JIT disabled, wasm-internal support removed).
  - https://github.com/nodejs/help/issues/3774

So: `.node` binaries compiled for host platforms cannot load in any wasm build. A dependency must either be pure JS or have a WASM/N-API-recompiled variant (emnapi) — per module.

---

## 4. Can `child_process` spawn real OS processes on node-wasi?

**No — and this is the deepest structural gap.**

- WASI preview1: no `fork`/`posix_spawn`-equivalent syscall exists in the snapshot. Nothing to map `spawn()`/`exec()`/`fork()` onto.
- WASI preview2 (0.2) and WASI 0.3 (2026): **still no process-management or spawning API**. Per wasi.dev's release docs, the current proposal list covers args/stdio/env/exit but "no process-management or process-spawning proposal" exists; `wasi:cli/command` components export `run` but get no fork/exec/spawn semantics. The long-standing posix_spawn/CreateProcess request (WebAssembly/WASI#414) was answered by the component-model team: dynamic (runtime) component instantiation "isn't on any concrete roadmap yet… don't expect this to be available in the near future."
  - https://wasi.dev/releases
  - https://github.com/WebAssembly/WASI/issues/414
- What `spawn` does on node-on-wasm **browser** builds (WebContainers) is *virtualized*: `spawn('npm', [...])` starts another Node instance inside the same wasm runtime — `WebContainerProcess` with `output`/`input` streams and an `exit` promise. It is not an OS process; it cannot run arbitrary host binaries (no `bash`, no `git`, no `ls` from the host).
  - https://webcontainers.io/guides/running-processes

Implication for a coding agent: every shell tool (`bash`/`grep`/`find`/`git`), every `npm install` of extensions, every cross-spawn call — all dead on node-wasi. There is no WASI mechanism, present or planned-through-0.3, to launch host processes.

---

## 5. Does fetch/undici work on node-wasi (it needs sockets)?

**On WASI: no.** Two independent blockers:

1. **No sockets.** preview1 has no socket syscalls at all (see §2). preview2's `wasi:sockets` exists in the standard and is supported by Wasmtime/jco for *guests*, but **Node core's WASI implementation (uvwasi) is preview1-only** — there is no node-wasi build wired to preview2 sockets, and even then TLS would additionally require `wasi:tls`.
2. **undici itself is partly WASM — which is fine.** Node's bundled fetch uses a WebAssembly llhttp parser: "The HTTP parser used by `fetch()` is implemented in WebAssembly for ease of distribution. You can see the same parser used for Node.js core and Undici." So the parser layer would work on wasm; the *socket* and *TLS* layers are what break. (Also relevant: running wasm in Node reserves a ~10GB virtual-address cage for V8's trap handler — `--disable-wasm-trap-handler` exists for constrained environments.)
   - https://github.com/nodejs/undici/issues/4708
   - https://github.com/nodejs/node/issues/56596

In **browser** node-on-wasm builds, fetch/networking are re-routed: WebContainers provides a virtual TCP stack through a Service Worker and maps HTTP servers to preview iframes; outbound fetch can ride the browser's own fetch. That is a platform shim, not WASI.

---

## 6. Practical limits: memory, threads, performance

- **Memory: 4 GiB ceiling on wasm32.** Linear memory is 32-bit-addressed; the wasm32 max is 4GB (V8 shipped 2GB→4GB support: "the new 4GB limit is the largest amount of memory possible with 32-bit pointers"). Emscripten defaults to 2GB unless `ALLOW_MEMORY_GROWTH`/`MAXIMUM_MEMORY` opt in. The `memory64` proposal (phase 4, enabled by default in Wasmtime) lifts the cap but is explicitly rejected for components and has had a long tail of >4GB growth bugs (HEAPU8 views, `memory.grow`); a Node-on-WASI build would realistically be wasm32 → **4GB process ceiling**, with 32-bit pointer overhead on top.
  - https://v8.dev/blog/4gb-wasm-memory
  - https://github.com/emscripten-core/emscripten/issues/19455
  - https://github.com/bytecodealliance/wasmtime/pull/9937
- **Threads: possible in the runtime, unproven for Node.** The wasm `threads` proposal (shared memory + atomics) is phase 4 and supported by Wasmtime (with caveats: shared memories aren't supported in the pooling allocator, fuzzing gaps). But there is no WASI-standard threading API in preview1; `wasi-threads` is legacy/phase 1; the successor "Shared-Everything Threads" is phase 1. Node's `worker_threads` on a wasm Node build has no published working implementation — browser builds map it to Web Workers (WebContainers does this; sharp-on-wasm uses Emscripten PThreads). A node-wasi worker_threads story effectively doesn't exist.
  - https://docs.wasmtime.dev/stability-wasm-proposals.html
  - https://github.com/WebAssembly/wasi-threads
- **Performance: interpreter-only V8, no JIT.** The reported Node v22 WASI build runs with "disabled jit and internal wasm support" — V8 without its JIT is dramatically slower for JS-heavy workloads (an LLM agent loop is JS-heavy). This is a consistent theme across all wasm Node efforts.
  - https://github.com/nodejs/help/issues/3774

---

## 7. Real applications running on node-wasi / node-on-wasm

| Project | What it is | Status |
|---|---|---|
| **WebContainers** (StackBlitz) | Node.js recompiled to WebAssembly running in-browser; virtual FS, virtual TCP via Service Worker, `--no-addons`. Powers the StackBlitz editor and **Bolt.new**. | Production (browser). Proprietary runtime; the Node build is not distributed. |
| **Bolt.new** | AI dev tool running WebContainers in the browser. | Production. |
| **OpenWebContainer** (thecodacus) | Open-source WebContainer-style environment (referenced in nodejs/help#3774). | Community/experimental. |
| **Node v22 → WASI on Wasmer** (sherifIlyas) | "Node v22 was successfully compiled to wasi environment and runs good with all features in wasmer. That was hard journey of several month deep dive to v8 engine" — with JIT disabled; earlier attempts failed with "memory manager issues which corrupts pointers". | Community claim in an issue; no distributable build cited. |
| **node-js-in-the-browser** (adamziel, WordPress Playground) | Ships the actual Node core library with browser syscall polyfills (JS-level port, not a wasm compile). Can run npm/tsc. | Experimental. |
| **v9 / EdgeJS** (maceip) | Bundles apps for a wasm JS-engine runtime in Chromium with napi-bridge; claims child_process/etc. via its own bridge. | Experimental, niche. |
| **nano** (userland-run) | RISC-V user-mode Linux interpreter in wasm running real Linux Node v25 — **emulation**, not WASI. | Experimental. |

Sources: https://blog.stackblitz.com/posts/introducing-webcontainers/ · https://blog.stackblitz.com/posts/webcontainer-api-is-here/ · https://webcontainers.io/guides/troubleshooting · https://github.com/nodejs/help/issues/3774 · https://github.com/adamziel/node-js-in-the-browser · https://github.com/maceip/v9 · https://github.com/userland-run/nano

---

## Verdict: could pi-coding-agent's agent loop run on node-wasi?

Target surface, per project context: `node:child_process` + cross-spawn (shell tools), `node:fs` (sessions/skills), `node:readline`/`tty` raw mode (TUI), undici (HTTP to model providers), native `.node` addons (TUI), and a Photon WASM (image handling).

**What could run, in principle:** pure-JS core, `fs` over preopened directories (sessions/skills JSONL, if the host preopens them), ESM/CJS loading, `readline` over piped stdio (non-raw), and the **Photon WASM** — it's already WebAssembly, the one dependency that survives the move intact.

**What breaks first (in order):**

1. **`child_process` — breaks at first tool call, and there is no path forward.** WASI has no spawn API in preview1, preview2, or 0.3 (the standard's own roadmap defers process spawning indefinitely). Every shell tool (bash/grep/find), every extension `npm install`, dies immediately. Without subprocesses there is no coding agent, period.
2. **undici/fetch — the agent loop cannot talk to a model provider.** No sockets on preview1; preview2 sockets aren't implemented in any Node core; TLS adds another wall. A WASI-hosted agent is a *disconnected* agent.
3. **Native `.node` addons — TUI addons won't load** (node-wasm builds ship `--no-addons`; N-API must be recompiled to WASM via emnapi, per module, and the TUI addons aren't).
4. **tty/readline raw mode — TUI impossible** even if addons were ported (no terminal/termios on WASI; WASI 0.3's `wasi:cli/terminal` is minimal and unused by Node).

**Bottom line:** a hypothetical wasm build of the *unmodified* pi-coding-agent fails the moment it spawns its first tool; strip child_process and you lose the product; strip fetch and the loop is blind; strip tty+addons and the TUI is gone. Even the best-case fictional build — pure JS + preopened fs + preview2 sockets in a custom Node fork — has no published artifact, runs interpreter-only V8, and is capped at 4GB wasm32 memory. Node-on-WASI in late 2025 is a research/embedded curiosity and an in-browser product by one vendor; **it is not a target platform for a host-dependent coding-agent CLI.**
