# Ziggy signal desk

This is a framework-free, responsive reference client for Ziggy. It keeps the conversation in the
foreground and exposes the Profile's agent, model, automation, memory, and extension projections
through `@ziggy/gateway-client`.

## Fixture mode

Open `index.html` after a browser build. Fixture mode is the default, so no Profile files or
credentials are needed. Loading, busy, stopping, watch-only, reconnecting, offline, empty,
validation, request, ownership, and reconciliation states are directly exercisable through a
URL query:

Fixture changes are intentionally local to this tab. Pinned rows use browser storage only in
fixture mode; a live resident is asked to persist pin and unpin commands through the gateway.
The state hook stays out of the product chrome and is selected through the `state` URL query so
the page remains useful as a clean reference surface:

```text
index.html?state=reconciliation
```

## Build and smoke test

From the repository root:

```sh
bun clients/example-web/build.mjs
open clients/example-web/index.html
```

For a live resident, choose `Connection` and paste the WebSocket endpoint and runtime token
provided by the local host. The browser only uses the gateway client; it never reads Profile files,
Pi sessions, or local configuration itself. To start in live connection mode, use
`index.html?mode=live`.

Sent mutating requests are never retried automatically. If the connection closes after send but
before its response, the SDK reports `ZiggyRequestOutcomeUnknownError`; callers reconcile
authoritative state before deciding whether a new user intent should issue another command.

The page is intentionally static and can also be served by any local static server:

```sh
python3 -m http.server 4173 --directory clients/example-web
```

Then open <http://127.0.0.1:4173/>.

## Interaction notes

- `/` focuses conversation search and `N` opens a fresh thread.
- `⌘ Enter` (or `Ctrl Enter`) submits the composer.
- Mobile widths turn the navigation rail into a sheet and the context drawer into a full-height
  details sheet. The composer includes the safe-area inset and keeps primary targets touch-sized.
- Blob identities are deterministic UI assets. They do not represent Profile authority.
