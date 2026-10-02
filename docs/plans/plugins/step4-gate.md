# Step 4 gate — MCP Apps on stock Pi 0.99.1

Verdict: every item has a stock path. No Pi patch.

All four items use one stock hook. `createMcpExtension({ createTransport })`
(`dist/extensions/mcp/index.d.ts` `McpExtensionOptions.createTransport`) is used for every connection
at `index.js:327`, and `McpServerConnection.connectOnce` calls it at `runtime.js:294`. Ziggy passes a
factory that builds Pi's own transport with `createDefaultTransport` (`runtime.js:50-70`), then wraps
it in a tap (`src/extensions/mcp-apps.ts`). The default factory is not exported from the package
root, so it is imported from the dist path, as `McpOAuthCredentialStore` already is. `McpTransport`
is `start/send/close/onMessage/onError/onClose/setProtocolVersion?`
(`@earendil-works/pi-mcp/dist/transports/transport.d.ts`).

| Item | Mechanism | Evidence |
| --- | --- | --- |
| (a) `_meta.ui` and visibility | The tap reads each `tools/list` response, matching the request id seen in `send`, and records each tool's `_meta.ui.resourceUri` (or the legacy `_meta["ui/resourceUri"]`) and `_meta.ui.visibility` per server. | Pi's client keeps whole tool objects (`pi-mcp client.js:188-190`). Pi sends `tools/list` through the transport (`client.js:247`). Pagination and `list_changed` refreshes use the same path (`runtime.js:307`). |
| (b) the `io.modelcontextprotocol/ui` capability | The tap rewrites the outgoing `initialize` request to add `capabilities.extensions["io.modelcontextprotocol/ui"] = { mimeTypes: ["text/html;profile=mcp-app"] }`. | Pi builds `McpClient` with no `capabilities` (`runtime.js:283-288`). `connect` sends `{...options.capabilities}` (`client.js:124-135`). |
| (c) app-only tools hidden (G7) | The tap removes tools whose visibility lacks `"model"` from `tools/list` results before Pi's client sees them. Pi never registers them, so they are absent from direct, deferred (tool search) and codemode exposure alike. | `registerTools` makes one definition per listed tool (`index.js:171-213`). Codemode and tool search read only the registered tools. |
| (d) app `tools/call` and `resources/read` | The tap sends Ziggy's own JSON-RPC requests on the live transport, with string ids `ziggy-app-<n>`. It keeps their responses from reaching Pi's client, which would otherwise report an unknown id (`client.js:307-311`). It sends only after `notifications/initialized`. Results arrive raw, including `_meta` (CSP), and are not spilled. | Pi's numeric ids never collide with these (`client.js:247`). Pi's `read_mcp_resource` strips `_meta` and spills large content (`resources.js:247-248`), and `fetchResources` hides app resources (`runtime.js:89-98`), so neither is used. |

## Deviations

- App calls do not go through Pi's tool pipeline (`tool_call`/`tool_result` hooks). On stock Pi an
  app-only tool cannot be in the pipeline without the model being able to reach it. Pi also has no
  public way to run a tool through the hooks outside a tool's own `execute`
  (`ExtensionToolContext.executeTool`, `core/extensions/types.d.ts:262-281`), and
  `getToolDefinition().execute` skips them too. Ziggy applies the same secret redaction as
  `mcp-redact` to app results itself. The plan's line "through the session's Pi tool pipeline as
  `mcp__<server>__<tool>`" is replaced by the tap path, which enforces the same restrictions: the
  owning server only, and only tools whose visibility includes `"app"`.
- Model-called tools that carry `_meta.ui` are recorded through a `tool_result` hook, registered after
  the redactor, that adds `details.app` (server, tool, resourceUri, input, capped result). Pi
  persists `details` in the transcript, so live events and history read the same record.
- Codemode is Pi's default exposure for plugin servers, and only the script's own result is
  persisted. The hook keeps the view record of a nested MCP call (matched by `parentToolCallId`,
  at most 32 pending) and adds it to the codemode result's `details.app`; nested live events get none.

## Limits

- An app call made while Pi's connection is down fails until Pi reconnects (Pi reconnects lazily on
  its next call). Ziggy does not open a second connection, which for stdio would start a second
  server process (G8).
- A server that changes its tool list after an app call has started is checked against the list as
  it stood when the call was made.
- A codemode script that opens several views shows only the last one.
