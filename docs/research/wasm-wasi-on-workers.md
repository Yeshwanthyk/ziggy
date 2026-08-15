# WASM/WASI on Cloudflare Workers: capabilities and limits

Research as of late 2025. Sources: developers.cloudflare.com, github.com/cloudflare/workerd,
github.com/cloudflare/workers-wasi, blog.cloudflare.com, bytecodealliance.org. Every claim is
followed by its URL.

---

## 1. Can you deploy a WASM module to Cloudflare Workers? What module formats?

**Yes — Workers has run WebAssembly since 2017**, but the supported formats are narrow:

- **WASM core module + JS bindings (the primary, supported format).** You bundle a `.wasm` file
  with your Worker (Wrangler bundles anything ending in `.wasm` or `.wasm?module`), the import
  resolves to a **precompiled `WebAssembly.Module`**, and you instantiate it yourself with
  `WebAssembly.instantiate(module, importObject)`. All imports (I/O, `fetch`, etc.) must be
  supplied by your JavaScript:
  https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/
  https://developers.cloudflare.com/workers/wrangler/bundling/

- **WASI preview 1 (experimental, opt-in).** Provided by the `@cloudflare/workers-wasi` package —
  a JavaScript-side implementation of the `wasi_snapshot_preview1` import namespace that runs
  *inside* your Worker. Not part of the workerd host runtime (see §2):
  https://developers.cloudflare.com/workers/runtime-apis/webassembly/
  https://github.com/cloudflare/workers-wasi
  https://blog.cloudflare.com/announcing-wasi-on-workers/

- **WASI preview 2 / WebAssembly Component Model: not natively supported.** workerd has no
  component-model or preview-2 code, and Workers do not expose `WebAssembly.Component`:
  * `WebAssembly.compile()`, buffer-based `WebAssembly.instantiate()`,
    `compileStreaming()`, and `instantiateStreaming()` are **all disallowed** — only
    precompiled modules from bundled imports can be instantiated:
    https://developers.cloudflare.com/workers/runtime-apis/web-standards/
  * workerd's source tree contains no WASI/component implementation (only a non-functional
    `node:wasi` stub): https://github.com/cloudflare/workerd
  * The only workaround is to build a component off-platform (e.g. with `jco` /
    ComponentizeJS) and **`jco transpile` it back into core modules** before bundling — i.e. the
    component model is a build-time convenience, not a runtime capability:
    https://www.npmjs.com/package/@bytecodealliance/componentize-js
    https://component-model.bytecodealliance.org/language-support/building-a-simple-component/javascript.html

Docs statement: "WASI support is experimental on Cloudflare Workers, with only some syscalls
implemented." https://developers.cloudflare.com/workers/runtime-apis/webassembly/

---

## 2. Does workerd support WASI? Which preview? What syscalls/capabilities?

**workerd (the Workers runtime) does not implement WASI natively.** Verified against the source
tree: there is no WASI C++/API code — only `src/node/wasi.ts` (a non-op stub added by
PR #5051 "Add non-op node:wasi module") and a `node:wasi` compat stub in the docs:
https://github.com/cloudflare/workerd (tree: `src/node/wasi.ts`,
https://github.com/cloudflare/workerd/pull/5051)
https://developers.cloudflare.com/workers/runtime-apis/nodejs/

**WASI preview 1 is implemented in JavaScript** by `@cloudflare/workers-wasi`, which supplies the
`wasi_snapshot_preview1` imports at `WebAssembly.instantiate` time:
https://github.com/cloudflare/workers-wasi (source: `src/index.ts`)

Exact syscall surface (from `src/index.ts` of workers-wasi):

| Category | Implemented | Status / notes |
|---|---|---|
| Args | `args_get`, `args_sizes_get` | from `args` option |
| Env | `environ_get`, `environ_sizes_get` | from `env` option (key=value) |
| Clock | `clock_res_get`, `clock_time_get` | REALTIME/MONOTONIC/CPU ids; based on `Date.now()`, resolution 1e6 ns — "unique behavior on the Workers platform for security reasons" |
| Random | `random_get` | `crypto.getRandomValues` |
| Process | `proc_exit` | throws `ProcessExit` |
| | `proc_raise` | **ENOSYS** |
| Sched | `sched_yield` | no-op success |
| Stdio | `fd_read`/`fd_write` (fd 0–2) | mapped to `stdin`/`stdout`/`stderr` Readable/WritableStreams |
| Filesystem | `fd_*`: advise, allocate, close, datasync, fdstat_get/set_flags/set_rights, filestat_get/set_size/set_times, pread, prestat_dir_name, prestat_get, pwrite, read, renumber, seek, sync, tell, write; `path_*`: create_directory, filestat_get/set_times, open, remove_directory, rename, unlink_file | **ephemeral in-memory filesystem** (littlefs) |
| **ENOSYS (return error)** | `fd_readdir`, `path_link`, `path_readlink`, `path_symlink`, `poll_oneoff`, `sock_recv`, `sock_send`, `sock_shutdown` | sockets and I/O multiplexing do not exist |
| **proc_spawn / process spawning** | — | **absent entirely**; WASI preview 1 has no spawn syscall and preview 2 (which defines `proc_spawn`) is not implemented |

**Filesystem preopens:** `preopens` is `string[]` — **guest-visible path labels inside the
in-memory sandbox, not host directories** (default `[]`). There is no host-filesystem mapping and
no read-only mode; the littlefs filesystem is writable (create/rename/unlink are supported).
Timestamps are captured via `Date.now()`.

Quotes:
- "An ephemeral filesystem implementation built on littlefs is included. Both soft and hard links
  are not yet supported." — https://github.com/cloudflare/workers-wasi
- ENOSYS list — https://github.com/cloudflare/workers-wasi

Test-suite coverage is partial: 52/52 of `wasi-test-suite` but only 28/42 of wasmtime's
`wasi-tests` — https://github.com/cloudflare/workers-wasi

`node:wasi` in the Node-compat layer is a **non-functional stub**: the workerd constructor throws
`ERR_METHOD_NOT_IMPLEMENTED('WASI')` ("TODO(later): This is one we actually might want to
implement at some point") — https://github.com/cloudflare/workerd/blob/main/src/node/wasi.ts

---

## 3. CRITICAL: can a WASM/WASI module on Workers spawn subprocesses or load native (.node) addons?

**No — verified on both axes.**

**Subprocesses:**
- No process-spawn capability exists anywhere in the Workers WASM stack: WASI preview 1
  (workers-wasi) exposes only `proc_exit`/`proc_raise`(ENOSYS); WASI preview 2's `proc_spawn`
  is not implemented — https://github.com/cloudflare/workers-wasi
- `node:child_process` is an **import-only non-functional stub** under `nodejs_compat`
  ("A stub can be imported or required, but does not provide a working implementation…")
  https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- Wrangler polyfills for unsupported Node APIs throw on call: `[unenv] <method name> is not
  implemented yet!` — https://developers.cloudflare.com/workers/runtime-apis/nodejs/

**Native (.node) addons:**
- There is no native-code ABI in the sandbox at all. A Worker is a V8 isolate; the platform runs
  only JavaScript and precompiled WASM. Node APIs that "do not fit in a serverless context" are
  excluded from the supported list — https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- The only "native library" mechanism anywhere on the platform is Python Workers: CPython C
  extension modules are **compiled to WASM** and loaded via Emscripten `dlopen`/`dlsym` (which
  Cloudflare explicitly notes WASI "does not yet support") — this is Pyodide's WASM dynamic
  linking, not `.node` addons:
  https://blog.cloudflare.com/python-workers/
- Workers also ban dynamic code (`eval`, `new Function`) and runtime WASM compilation from
  bytes — https://developers.cloudflare.com/workers/runtime-apis/web-standards/

---

## 4. Can a pure WASM module make outbound HTTP calls (fetch)?

**Only via host JavaScript bindings — never via WASI sockets.**

- `sock_recv`, `sock_send`, `sock_shutdown` all return **ENOSYS** in workers-wasi; `poll_oneoff`
  (needed for blocking I/O) is also ENOSYS. There is no socket interface:
  https://github.com/cloudflare/workers-wasi
- The docs position WASM as "computationally intensive operations which do not involve
  significant I/O" — https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/
- Cloudflare's own framing: "WebAssembly does not provide any standard interface for I/O tasks…
  it's up to the developer to handle that event in JavaScript, and directly call functions
  exported from the WebAssembly module" — https://blog.cloudflare.com/announcing-wasi-on-workers/
- Working patterns that bridge to host `fetch` (all JS-binding-based):
  - Rust: the `workers-rs` crate exposes Workers' JS APIs (`fetch`) as JS bindings, not WASI —
    https://blog.cloudflare.com/cloudflare-workers-as-a-serverless-rust-platform/
    https://developers.cloudflare.com/workers/languages/rust/
  - Python (Pyodide): sync HTTP clients like `urllib3` are shimmed onto the host `fetch` API via
    Emscripten (Atomics.wait + SharedArrayBuffer worker thread):
    https://blog.cloudflare.com/python-workers/
  - A plain WASM module receives a `fetch`-like function as a JS import from the Worker's
    `importObject` — https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/

So: outbound HTTP from WASM code = call an imported JS function that uses `fetch()`. WASI
networking is a dead end (ENOSYS).

---

## 5. Memory limits, CPU limits, and WASM-specific limits

- **Memory: 128 MB per isolate** on both Free and Paid, "including the JavaScript heap and
  WebAssembly allocations." Per-isolate, not per-request; exceeding it → Error 1102
  (`exceededMemory`). No separate WASM memory budget — WASM linear memory counts against the
  128 MB: https://developers.cloudflare.com/workers/platform/limits/
- **CPU time: 10 ms/request (Free); Paid default 30 s, configurable to max 5 min** per HTTP
  request. CPU time includes active WASM execution: https://developers.cloudflare.com/workers/platform/limits/
- **Bundle size: 3 MB (Free) / 10 MB (Paid) after gzip; 64 MB before compression.** A WASM module
  ships inside the bundle, so it is bounded by these limits:
  https://developers.cloudflare.com/workers/platform/limits/
- **Startup: global scope must execute within 1 second** (error 10021). The docs warn that WASM
  "typically" makes Workers larger, hurting startup:
  https://developers.cloudflare.com/workers/platform/limits/
- **WASM-specific constraints:**
  - SIMD is supported (matches Chrome/V8 feature set):
    https://developers.cloudflare.com/workers/runtime-apis/webassembly/
  - **Threading is not possible** — "Each Worker runs in a single thread, and the Web Worker API
    is not supported" (no wasm threads, no `SharedArrayBuffer` parallelism for WASM):
    https://developers.cloudflare.com/workers/runtime-apis/webassembly/
  - No runtime compilation from bytes (`WebAssembly.compile`, buffer `instantiate`, streaming
    variants all disallowed) — only precompiled bundled modules:
    https://developers.cloudflare.com/workers/runtime-apis/web-standards/
  - workerd tracks WASM instance memory for the 128 MB accounting (`tracked-wasm-instance.c++`):
    https://github.com/cloudflare/workerd

---

## 6. Running Node.js / Bun / LLMs as WASM on Workers

- **Node.js compiled to WASM: no official support or example — and it is the wrong tool.** The
  supported way to run Node-style apps on Workers is the `nodejs_compat` flag (Workers natively
  implements a subset of Node APIs in JS); several core modules (`node:http2`, `node:vm`,
  `node:wasi`, `node:child_process`, `node:worker_threads`, …) are import-only non-functional
  stubs: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
  The Node community itself confirms there is no portable "node.wasm" of the full runtime
  (V8 can't be compiled to WASM): https://github.com/nodejs/help/issues/3774

- **Bun: no.** `bun build --compile` produces a native standalone executable, not WASM, and
  Workers accept only JS + precompiled WASM: https://bun.sh/docs/bundler/executables

- **CPython in WASM: yes — but via Emscripten, not WASI.** Python Workers embed Pyodide (CPython
  compiled to WASM) in workerd; Cloudflare explicitly rejected the `wasm32-wasi` target because
  "WASI does not yet support the dlopen/dlsym dynamic linking abstractions used by CPython":
  https://blog.cloudflare.com/python-workers/

- **What official WASI examples exist:** CLI-style programs compiled to `wasm32-wasi` and run via
  stdin/stdout streaming — hexyl (hex dump), swc (JS/TS transpiler), zstd (compression):
  https://blog.cloudflare.com/announcing-wasi-on-workers/
  https://github.com/zebp/wasi-example-swc

- **LLM (e.g. llama.cpp) in WASM on Workers: technically possible, not a real/endorsed
  pattern.** No canonical Cloudflare example exists; `llama.cpp` WASM builds target the browser
  (wllama, llama-cpp-wasm): https://github.com/ngxson/wllama
  https://github.com/tangledgroup/llama-cpp-wasm
  The constraints in §5 (no threads, 128 MB total including weights + KV cache, 3–10 MB bundle,
  CPU limits) make server-side llama.cpp serving impractical. The closest *official* AI-in-WASM
  example is MobileNetV2 CNN inference (a guest post) — and it used 8-bit quantized models of
  tens-to-hundreds of KB: https://blog.cloudflare.com/exploring-webassembly-ai-services-on-cloudflare-workers/
  LLMs on Cloudflare run on GPU (Workers AI), not WASM:
  https://blog.cloudflare.com/meta-llama-3-1-available-on-workers-ai/

---

## 7. What is "ComponentizeJS"? Does Cloudflare use it?

**ComponentizeJS** (`@bytecodealliance/componentize-js`) is a Bytecode Alliance tool that "takes
as input a JavaScript source file and a WebAssembly Component WIT World, and outputs a WebAssembly
Component binary" — it does this by **embedding a SpiderMonkey (Mozilla JS engine) runtime
(StarlingMonkey) inside the component** (≈8 MB embedding), with Wizer pre-initialization so the
snapshot starts fast. It is explicitly experimental:
https://github.com/bytecodealliance/ComponentizeJS
https://bytecodealliance.org/articles/making-javascript-run-fast-on-webassembly

**Does Cloudflare use it? No.** There is no Cloudflare blog post or docs reference to
ComponentizeJS, and no component-model support in workerd or the Workers runtime. Workers expose
only core-WASM instantiation (precompiled modules), so the only way to consume a component
artifact on Workers today is `jco transpile` — which converts the component back into an ES-module
wrapper + core WASM modules — i.e., the component model is a *build-time* format, never a runtime
capability on the platform:
https://www.npmjs.com/package/@bytecodealliance/componentize-js
https://component-model.bytecodealliance.org/language-support/building-a-simple-component/javascript.html
https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/

---

## Verdict: Can a full Node/Bun-style application (fs + subprocesses + sockets + native addons) run as WASM on Workers?

**NO.**

1. **No sockets via WASI.** `sock_recv`/`sock_send`/`sock_shutdown`/`poll_oneoff` all return
   ENOSYS; outbound HTTP is possible only by calling JS `fetch` through a host binding — a Node/Bun
   app's `net`/`tls`/`http` stack has no WASI equivalent.
   (https://github.com/cloudflare/workers-wasi)
2. **No process spawning.** WASI preview 1 (the only WASI supported) has no spawn syscall; WASI
   preview 2's `proc_spawn` is not implemented; `node:child_process` is a non-functional stub.
   (https://github.com/cloudflare/workers-wasi, https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
3. **No native (.node) addons.** There is no native ABI in the V8 sandbox; dynamic linking exists
   only for Pyodide's WASM-compiled Python extensions (Emscripten `dlopen`), and WASI's lack of
   `dlopen`/`dlsym` is exactly why Cloudflare avoided it for Python.
   (https://developers.cloudflare.com/workers/runtime-apis/nodejs/, https://blog.cloudflare.com/python-workers/)
4. **No real filesystem.** The WASI filesystem is an ephemeral in-memory littlefs — no host
   directories, no persistence, preopens are just guest path labels — so `fs` with real paths,
   symlinks, or readdir doesn't work (`fd_readdir`/`path_symlink` are ENOSYS).
   (https://github.com/cloudflare/workers-wasi)
5. **Hard resource ceilings.** Single-threaded (no wasm threads/Web Workers), 128 MB total
   memory including WASM linear memory, 10 ms (Free) / up to 5 min (Paid) CPU, 3–10 MB gzip
   bundle, 1 s startup, and no runtime compilation from bytes — a full runtime embedding
   (V8, libuv, addons) cannot fit or run within these.
   (https://developers.cloudflare.com/workers/platform/limits/, https://developers.cloudflare.com/workers/runtime-apis/webassembly/)

What *does* work: compiling compute-heavy, I/O-light libraries to WASM and gluing them to Workers'
native APIs from JS (or Rust via `workers-rs`, or Python via Pyodide), with `nodejs_compat` for
Node-API compatibility.
