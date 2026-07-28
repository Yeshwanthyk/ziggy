# Pi MCP adapter: Ziggy integration note

Source snapshot: `/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter` at
`e588296e28b36a22b081d40fcfba76f418d6f84e` (package `2.15.0`). This is a
read-only feasibility note, not an installation or compatibility proof.

## What the adapter provides

Its default model is one Pi tool named `mcp`, not one Pi tool per MCP capability.
The tool accepts `search`, `describe`, `connect`, `instructions`, and `tool`
operations, so the model discovers a remote tool before calling it
([`index.ts:599-743`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/index.ts:599)).
That keeps the initial tool surface small; direct tools are optional and selectively
promoted from cached metadata ([`README.md:330-412`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/README.md:330)).

Discovery is deliberately decoupled from connection. Per-server metadata is cached
at `<Pi agent dir>/mcp-cache.json` (seven-day, identity-hashed validity), then
reconstructed into proxy/direct-tool metadata without a live server
([`metadata-cache.ts:32-39`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/metadata-cache.ts:32),
[`metadata-cache.ts:103-118`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/metadata-cache.ts:103),
[`init.ts:227-261`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/init.ts:227)).
`lazy` is the default lifecycle, so a server connects on first actual use;
`eager` and `keep-alive` connect at startup, and `lazy-keep-alive` persists after
its first use ([`types.ts:319-360`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/types.ts:319),
[`init.ts:256-261`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/init.ts:256)).

## Isolation and lifecycle

The file-backed default is unsuitable for a Profile-isolated Ziggy integration.
It reads, in ascending precedence, shared globals, Pi global, `.mcp.json`, and
`.pi/mcp.json` ([`config.ts:309-376`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/config.ts:309));
host configs are off by default but can be enabled through config
([`config.ts:221-259`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/config.ts:221)).
Setting `PI_CODING_AGENT_DIR=profilePath` would relocate only its Pi-global config,
cache, and default OAuth legacy directory, not stop the other shared/project reads
([`agent-dir.ts:4-19`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/agent-dir.ts:4)).

Use `createMcpAdapter({ config })` instead. It clones a complete supplied config
and skips every ambient file/import/flag source ([`index.ts:786-796`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/index.ts:786),
[`init.ts:99-113`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/init.ts:99)); the
maintainer documents that as an isolated per-factory/per-session snapshot
([`README.md:114-137`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/README.md:114)).
For hard per-Profile cache isolation as well, Ziggy would need to set the process
agent-dir before adapter initialization or upstream must add a cache-path option;
the factory API itself has no cache path. Do not solve this with the default export.

The extension owns a generation-scoped abortable runtime. On `session_start` it
stops the previous owner before initializing a fresh state; on `session_shutdown`
it aborts, flushes metadata, closes connections/UI, and shuts down OAuth
([`index.ts:257-395`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/index.ts:257)).
The lifecycle manager health-checks keep-alive servers, closes idle non-keep-alive
ones, and makes shutdown idempotent ([`lifecycle.ts:57-150`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/lifecycle.ts:57)).
For Streamable HTTP only, a narrowly recognized expired-session signal causes one
reconnect and one retry; generic errors and cancellation do not
([`session-recovery.ts:52-150`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/session-recovery.ts:52)).

## Security and output boundaries

OAuth tokens are stored in the OS credential store under a hash of the server
name, bound to the server URL, and legacy plaintext tokens are imported then
deleted ([`mcp-auth.ts:139-148`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/mcp-auth.ts:139),
[`mcp-auth.ts:217-275`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/mcp-auth.ts:217)).
It has flow-local PKCE/CSRF state; manual auth, auto-auth, sampling, elicitation,
and server-provided UI are capabilities the adapter adds, not guarantees that a
headless Ziggy run should enable ([`mcp-auth-flow.ts:70-139`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/mcp-auth-flow.ts:70),
[`init.ts:123-140`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/init.ts:123)).

The output guard is on by default: text is capped at 50 KiB/2,000 lines, oversized
results spill to a 0600 temp file, and proxy result details cap raw JSON at 16 KiB;
images pass through unchanged ([`mcp-output-guard.ts:7-10`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/mcp-output-guard.ts:7),
[`mcp-output-guard.ts:85-150`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/mcp-output-guard.ts:85),
[`README.md:294-310`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/README.md:294)).
This bounds context, but it does not make tool output safe or trustworthy; MCP
instructions/output remain untrusted model input, and the uncollected temp output
may contain secrets.

## Ziggy compatibility and smallest slice

Ziggy already builds a Profile-scoped Pi runtime with default discovery disabled,
then admits explicit Profile paths plus an inline memory extension
([`src/adapters/pi/pi-agent.ts:514-554`](/Users/yesh/code/personal/ziggy/src/adapters/pi/pi-agent.ts:514)).
The adapter can fit at that same `extensionFactories` seam, but it has not been
validated there.

The exact risk is version/API drift: Ziggy pins Pi `0.82.0`
([`package.json:15-19`](/Users/yesh/code/personal/ziggy/package.json:15)), while
the adapter tests/develops against `@earendil-works/pi-coding-agent@0.79.10` and
declares no peer range for that package ([`package.json:124-144`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/package.json:124)).
It depends on extension hooks, TypeBox tool schemas, `getAllTools`, active-tool
management, and optional `unregisterTool`; 0.82.0 exposes the first set but does
not declare `unregisterTool` in its `ExtensionAPI`
([`types.d.ts:847-929`](/Users/yesh/code/personal/ziggy/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:847)).
The adapter has a fallback deactivation path, but its package also declares
Node >=20 and was not exercised under Ziggy's Bun runtime
([`package.json:21-25`](/tmp/pi-mcp-adapter-latest.xmCYHf/pi-mcp-adapter/package.json:21)).

Recommendation: first add no UI, no direct tools, no auto-auth, and one Profile
declared stdio server through `createMcpAdapter({ config })` as a second inline
extension. Keep `hostConfigDiscovery: "off"`, `lifecycle: "lazy"`, and the
output guard on. Acceptance is narrowly vertical: Profile A can search/describe
cached metadata and call its server through only `mcp`; Profile B and all ambient
MCP files are invisible; a new/switch/shutdown session leaves no live child
process. Before widening, add a focused 0.82.0 compile/runtime probe for extension
registration, `session_start`/`session_shutdown`, proxy invocation, cancellation,
and reload/switch cleanup. This adapter solves MCP transport, discovery, auth, and
lifecycle plumbing; it does not solve Ziggy's Profile policy, permissions/trust
model, server selection UX, or per-Profile credential namespace.
