# ACP server surface for Ziggy

Research date: 2026-08-15. This is a source report for the smallest Ziggy
server face that can be launched by Zed and by Buzz's ACP harness. It does not
replace Ziggy's client-neutral `ZiggyAgent` application service.

## Current protocol and SDK

- ACP's current stable wire protocol is **v1** (`protocolVersion: 1`). The
  version is negotiated in `initialize`; package/schema release numbers are
  not protocol versions. See the [ACP versioning and protocol repository](https://github.com/agentclientprotocol/agent-client-protocol#versioning).
- The current official TypeScript package is
  [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk),
  latest `1.3.0` as checked on 2026-08-15. The pinned source is the
  [v1.3.0 `src/acp.ts`](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.3.0/src/acp.ts)
  and [generated v1.3.0 schema](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.3.0/src/schema/types.gen.ts).
  Import the stable root (`@agentclientprotocol/sdk`); the package's v2 entry
  point is explicitly experimental and is not this integration.
- New code should use the SDK's fluent `agent()` API with typed
  `onRequest`/`onNotification` handlers. The older `AgentSideConnection` and
  `ClientSideConnection` classes remain available but are deprecated; this is
  documented in the [official TypeScript library guide](https://agentclientprotocol.com/libraries/typescript).

## Framing: NDJSON, not headers

ACP encodes JSON-RPC 2.0 messages as UTF-8. For the stdio transport, the
client launches the agent subprocess; each request, notification, or response
is one JSON object terminated by `\n`, with no embedded raw newlines. The agent
must write only valid ACP messages to stdout; logs belong on stderr. ACP v1
does **not** use `Content-Length`/LSP-style headers. The official transport
specification is [v1 Transports](https://agentclientprotocol.com/protocol/v1/transports),
and the SDK adapter is `ndJsonStream(output, input)` in the pinned
[`src/acp.ts`](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.3.0/src/acp.ts).
Streamable HTTP is still described as a draft; do not add it to the first Ziggy
face.

## v1 method and type surface

The following are the only agent-side handlers needed for a first prompt-only
face. Names and types below are the SDK's generated v1 names.

| Wire method | SDK type | Direction/shape | First-face behavior |
| --- | --- | --- | --- |
| `initialize` | `InitializeRequest` → `InitializeResponse` | request/response; request has `protocolVersion`, optional `clientCapabilities`, optional `clientInfo` | Require/negotiate protocol 1; return `agentInfo` and baseline capabilities. |
| `session/new` | `NewSessionRequest` → `NewSessionResponse` | request has absolute `cwd` and required `mcpServers: []`; response has unique `sessionId` | Open one Ziggy chat/session for this ACP connection and cwd. |
| `session/prompt` | `PromptRequest` → `PromptResponse` | request has `sessionId` and `prompt: ContentBlock[]`; response has `stopReason` | Accept baseline text/resource-link blocks, forward to the existing chat handle, and await settlement. |
| `session/cancel` | `CancelNotification` | notification with `sessionId`; no response | Abort the active turn for that session. Return `stopReason: "cancelled"` for the pending prompt. |
| `session/update` | `SessionNotification` containing `SessionUpdate` | agent → client notification; no response | Emit `agent_message_chunk` notifications for streamed assistant text (and optionally tool/plan updates). |

`session/update` is not an agent request handler: register it conceptually as
an outbound client notification through the agent context, for example
`ctx.client.notify(methods.client.session.update, { sessionId, update })`.
`SessionUpdate` is a tagged union; useful first-slice tags are
`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, and
`usage_update`. A prompt completes with `PromptResponse.stopReason`, normally
`end_turn`; valid alternatives include `max_tokens`, `max_turn_requests`,
`refusal`, and `cancelled`. See [Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn).

The SDK's minimal registration shape is therefore equivalent to:

```ts
const app = agent({ name: "ziggy" })
  .onRequest(methods.agent.initialize, handleInitialize)
  .onRequest(methods.agent.session.new, handleSessionNew)
  .onRequest(methods.agent.session.prompt, handlePrompt)
  .onNotification(methods.agent.session.cancel, handleCancel);

app.connect(ndJsonStream(stdoutWritable, stdinReadable));
```

The exact handler signatures are inferred from the method literals:
`AgentRequestContext<InitializeRequest>`,
`AgentRequestContext<NewSessionRequest>`,
`AgentRequestContext<PromptRequest>`, and
`AgentNotificationContext<CancelNotification>`. Use `context.signal` to bind
request cancellation to Pi/Ziggy work, while an ACP `session/cancel` handler
uses the session's active-turn ownership to call `handle.abort()`.

## Required and optional capabilities

ACP treats advertised capabilities as opt-in: omitted capabilities are
unsupported, and implementations must tolerate any combination of peer
capabilities. The [official initialization contract]
(https://agentclientprotocol.com/protocol/v1/initialization) says:

- The client **must** initialize before creating a session, sending the latest
  protocol version it supports. Ziggy should accept/return version 1 and close
  on an incompatible negotiated version.
- `clientCapabilities` is optional for a prompt-only Ziggy server. Ziggy need
  not call client `fs/*`, `terminal/*`, permission, or elicitation methods in
  the first slice; it can accept the client's advertised capabilities without
  implementing those callbacks.
- The agent baseline is `session/new`, `session/prompt`, `session/cancel`, and
  `session/update`. The baseline prompt content types are text and resource
  links. Do not advertise `loadSession`, images, audio, embedded resources,
  MCP, modes, or config options until Ziggy implements their behavior.
- Returning `agentCapabilities: {}` (plus `agentInfo`) is sufficient for the
  first face. In particular, omit `loadSession`; advertising it requires
  implementing `session/load` and replaying the session as `session/update`
  notifications. The [session setup contract](https://agentclientprotocol.com/protocol/v1/session-setup)
  requires clients to check that capability before calling `session/load`.

## Smallest Ziggy face

Add a process-owned `ziggy acp <profile>` face that:

1. Resolves/validates the Profile once, then connects stdin/stdout through the
   SDK's `ndJsonStream`. Stdout is protocol-only; diagnostics go to stderr.
2. Handles `initialize` with protocol 1, `agentInfo`, and no optional agent
   capabilities. The client may send capabilities; Ziggy records them only if
   later behavior needs them.
3. Handles `session/new` by creating a client-neutral Ziggy chat for the
   absolute `cwd`, with `mcpServers` ignored/rejected unless MCP support is
   deliberately added. Keep ACP sessions separate from resident gateway
   ownership and use the Profile's existing session persistence policy.
4. Handles `session/prompt` by accepting baseline text/resource-link blocks
   (and rejecting image/audio/embedded-resource blocks that were not
   advertised), forwarding to `ZiggyAgent`, and translating streamed assistant
   events into `session/update` `agent_message_chunk` notifications. Resolve
   the request only after the turn settles with `end_turn`.
5. Handles `session/cancel` by aborting the active turn and resolving the
   original prompt with `cancelled`, as required by [prompt cancellation]
   (https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation).

Zed needs no Ziggy-specific protocol: configure a custom external agent in
`settings.json` with command `ziggy` and args `["acp", "<profile>"]` (the
[official Zed custom-agent configuration](https://zed.dev/docs/ai/external-agents#custom-agents)
launches ACP agents as separate processes). Buzz uses the same `ziggy acp
<profile>` subprocess through its ACP harness. This is the settled integration
decision: **Buzz uses ACP; Ziggy does not implement a direct Buzz gateway**.
No Buzz-specific wire methods or gateway owner are required in this face.

Not in the smallest face: `session/load`/resume replay, `session/list` or
delete, authentication, MCP forwarding, client filesystem/terminal callbacks,
HTTP/WebSocket transports, or a second Ziggy management protocol.

## Sources and local constraints

- [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP v1 initialization](https://agentclientprotocol.com/protocol/v1/initialization)
- [ACP v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP v1 prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)
- [ACP v1 transports](https://agentclientprotocol.com/protocol/v1/transports)
- [Official TypeScript SDK repository](https://github.com/agentclientprotocol/typescript-sdk/tree/v1.3.0)
- Ziggy's client-neutral runtime contract: [`docs/research/minimal-ziggy-scout.md`](minimal-ziggy-scout.md)
- Settled ACP face plan and Buzz decision: [`docs/plans/open-ziggy-readiness.md`](../plans/open-ziggy-readiness.md#chunk-4---ziggy-acp)
